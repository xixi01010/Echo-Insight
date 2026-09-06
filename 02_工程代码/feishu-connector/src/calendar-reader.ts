import {
  createFeishuIdentityRef, type FeishuIdentityContext, type FeishuIdentityRef, type FeishuIdentityType,
} from "../../backend/src/current-user/index.js";
import type { FeishuApiClient, FeishuCalendarEvent } from "./types.js";
import {
  classifySourceReadError, createSourceReadFailure, createSourceReadSuccess, createSourceReadUnavailable,
  isSourceReadable, SourceReadError, type ProjectSourceReader, type ProjectSourceReadContext, type ProjectSourceReadResult,
  sourceReadErrorFromResponseCode,
} from "./source-contract.js";

export interface FeishuCalendarLocator { calendarId: string; eventIds: string[]; syncToken?: string; }
export interface FeishuCalendarEventRecord {
  eventId: string; title?: string; description?: string; startTime?: { date?: string; timestamp?: string; timezone?: string }; endTime?: { date?: string; timestamp?: string; timezone?: string };
  organizer?: FeishuIdentityRef; attendees: Array<{ identity?: FeishuIdentityRef; unresolvedId?: string; type?: string }>; createTime?: string; recurringEventId?: string;
}
export interface FeishuCalendarSourceSnapshot { locator: FeishuCalendarLocator; events: FeishuCalendarEventRecord[]; syncToken: { state: "not-requested" | "positioned" }; }
export interface FeishuCalendarSourceReadInput { context: ProjectSourceReadContext; locator: FeishuCalendarLocator; }
export interface FeishuCalendarReaderOptions { identityContext: FeishuIdentityContext; identityType?: FeishuIdentityType; now?: () => Date; }

/** Reads exactly supplied event IDs in one calendar. Sync-token and event-range discovery stay outside this reader. */
export class FeishuCalendarReader implements ProjectSourceReader<FeishuCalendarSourceReadInput, FeishuCalendarSourceSnapshot> {
  private readonly identityType: FeishuIdentityType;
  private readonly now: () => Date;
  constructor(private readonly client: Pick<FeishuApiClient, "calendar">, private readonly options: FeishuCalendarReaderOptions) { this.identityType = options.identityType ?? "open_id"; this.now = options.now ?? (() => new Date()); }
  async read(input: FeishuCalendarSourceReadInput): Promise<ProjectSourceReadResult<FeishuCalendarSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) return createSourceReadUnavailable({ context: input.context, freshness });
    const eventIds = [...new Set(input.locator.eventIds.map((id) => id.trim()).filter(Boolean))];
    if (input.context.sourceKind !== "feishu-calendar" || !input.locator.calendarId.trim() || eventIds.length === 0) return createSourceReadFailure({ context: input.context, category: "unknown", freshness });
    const api = this.client.calendar?.v4?.calendarEvent;
    if (!api) return createSourceReadFailure({ context: input.context, category: "source-unavailable", freshness });
    try {
      const events = await Promise.all(eventIds.map(async (eventId) => {
        const response = await api.get({ path: { calendar_id: input.locator.calendarId, event_id: eventId }, params: { need_attendee: true, user_id_type: this.identityType } });
        if (response.code !== 0) throw sourceReadErrorFromResponseCode(response.code);
        if (!response.data?.event) throw new SourceReadError("unknown");
        return toEventRecord(response.data.event, eventId, this.options.identityContext, this.identityType);
      }));
      return createSourceReadSuccess({ context: input.context, data: { locator: { calendarId: input.locator.calendarId, eventIds, ...(input.locator.syncToken ? { syncToken: input.locator.syncToken } : {}) }, events, syncToken: { state: input.locator.syncToken ? "positioned" : "not-requested" } }, resources: eventIds.map((resourceId) => ({ sourceRef: input.context.sourceRef, resourceType: "feishu-calendar-event", resourceId })), freshness });
    } catch (error) { return createSourceReadFailure({ context: input.context, category: classifySourceReadError(error), freshness }); }
  }
}
function toEventRecord(event: FeishuCalendarEvent, fallbackId: string, context: FeishuIdentityContext, type: FeishuIdentityType): FeishuCalendarEventRecord {
  const toIdentity = (value: string): FeishuIdentityRef => createFeishuIdentityRef({ type, value, context });
  return { eventId: event.event_id ?? fallbackId, ...(event.summary ? { title: event.summary } : {}), ...(event.description ? { description: event.description } : {}), ...(event.start_time ? { startTime: { ...event.start_time } } : {}), ...(event.end_time ? { endTime: { ...event.end_time } } : {}), ...(event.event_organizer?.user_id ? { organizer: toIdentity(event.event_organizer.user_id) } : {}), attendees: (event.attendees ?? []).map((attendee) => attendee.attendee_id ? { identity: toIdentity(attendee.attendee_id), ...(attendee.type ? { type: attendee.type } : {}) } : { ...(attendee.display_name ? { unresolvedId: attendee.display_name } : {}), ...(attendee.type ? { type: attendee.type } : {}) }), ...(event.create_time ? { createTime: event.create_time } : {}), ...(event.recurring_event_id ? { recurringEventId: event.recurring_event_id } : {}) };
}
