import { randomUUID } from "node:crypto";

import { createFeishuUserAccessClient, type FeishuApiClient } from "../../../feishu-connector/src/index.js";
import type { CurrentUserContext, FeishuSessionUserCredentialProvider } from "../current-user/index.js";
import type { ProjectService } from "../project-service/index.js";
import type { ConfiguredProjectDataSourceLocator, ProjectDataSourceKind } from "./project-data-source-resolver.js";
import { ProjectDataSourceAccessDeniedError, ProjectDataSourceForbiddenError } from "./project-data-source-configuration-service.js";

const SELECTION_TTL_MS = 10 * 60_000;
const MAX_CALENDARS = 50;
const MAX_EVENTS = 50;
const MAX_CHATS = 50;
const DEFAULT_WINDOW_DAYS = 90;

export class ProjectSourceBindingInputError extends Error {
  readonly code = "INVALID_PROJECT_SOURCE_BINDING";
  constructor() {
    super("Project source binding is invalid.");
    this.name = "ProjectSourceBindingInputError";
  }
}

export class ProjectSourceBindingUnavailableError extends Error {
  readonly code = "PROJECT_SOURCE_BINDING_UNAVAILABLE";
  constructor() {
    super("Project source binding is unavailable.");
    this.name = "ProjectSourceBindingUnavailableError";
  }
}

export type ProjectSourceOption = { id: string; label: string };
export type CalendarEventOption = { id: string; title: string; startAt?: string; endAt?: string };
export type ProjectSourceOptionsResponse = { items: ProjectSourceOption[]; hasMore: boolean };
export type CalendarEventOptionsResponse = { items: CalendarEventOption[]; hasMore: boolean };

type StoredSelection = {
  projectId: string;
  userId: string;
  expiresAt: number;
  kind: "calendar" | "chat";
  locator: ConfiguredProjectDataSourceLocator;
};

/**
 * Bounded configuration-time discovery only. It creates opaque, short-lived
 * selections so browser code never receives a Feishu internal locator.
 */
export class ProjectSourceBindingService {
  private readonly selections = new Map<string, StoredSelection>();

  constructor(
    private readonly projectService: ProjectService,
    private readonly credentials: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken"> | undefined,
    private readonly getClient: () => FeishuApiClient,
    private readonly now: () => number = Date.now,
    private readonly generateId: () => string = randomUUID,
  ) {}

  async listCalendars(projectId: string, subject: CurrentUserContext): Promise<ProjectSourceOptionsResponse> {
    await this.requireOwner(projectId, subject.userId);
    const calendarApi = (await this.userClient(subject)).calendar?.v4?.calendar;
    const api = calendarApi?.list;
    if (!api) throw new ProjectSourceBindingUnavailableError();
    const response = await api({ params: { page_size: MAX_CALENDARS } });
    if (response.code !== 0 || !response.data) throw new ProjectSourceBindingUnavailableError();
    let calendars = readCalendarEntries(response.data);
    if (!calendars.length && calendarApi?.primary) {
      const primary = await calendarApi.primary({ params: { user_id_type: "open_id" } });
      if (primary.code !== 0 || !primary.data) throw new ProjectSourceBindingUnavailableError();
      calendars = readPrimaryCalendarEntries(primary.data);
    }
    calendars = calendars.slice(0, MAX_CALENDARS);
    const items = calendars.flatMap((calendar, index) => {
      const calendarId = calendarIdOf(calendar);
      if (!calendarId) return [];
      return [{
        id: this.store(projectId, subject.userId, "calendar", { kind: "feishu-calendar", calendarId, eventIds: [] }),
        label: isPrimaryCalendar(calendar) ? "主日历" : `可访问日历 ${index + 1}`,
      }];
    });
    return { items, hasMore: response.data.has_more === true };
  }

  async listCalendarEvents(
    projectId: string,
    subject: CurrentUserContext,
    calendarSelectionId: string,
    startAt?: string,
    endAt?: string,
  ): Promise<CalendarEventOptionsResponse> {
    await this.requireOwner(projectId, subject.userId);
    const calendar = this.getSelection(projectId, subject.userId, calendarSelectionId, "calendar");
    if (calendar.locator.kind !== "feishu-calendar") throw new ProjectSourceBindingInputError();
    const calendarId = calendar.locator.calendarId;
    const range = normalizeTimeWindow(startAt, endAt, this.now);
    const api = (await this.userClient(subject)).calendar?.v4?.calendarEvent.list;
    if (!api) throw new ProjectSourceBindingUnavailableError();
    const response = await api({
      path: { calendar_id: calendarId },
      params: { page_size: MAX_EVENTS, start_time: String(range.start), end_time: String(range.end), user_id_type: "open_id" },
    });
    if (response.code !== 0 || !response.data) throw new ProjectSourceBindingUnavailableError();
    const events = Array.isArray(response.data.items) ? response.data.items.slice(0, MAX_EVENTS) : [];
    const items = events.flatMap((event) => {
      if (!safeText(event.event_id)) return [];
      const startAt = toIso(event.start_time?.timestamp);
      const endAt = toIso(event.end_time?.timestamp);
      return [{
        id: this.store(projectId, subject.userId, "calendar", { kind: "feishu-calendar", calendarId, eventIds: [event.event_id] }),
        title: safeLabel(event.summary, "未命名日程"),
        ...(startAt ? { startAt } : {}),
        ...(endAt ? { endAt } : {}),
      }];
    });
    return { items, hasMore: response.data.has_more === true };
  }

  async listChats(projectId: string, subject: CurrentUserContext): Promise<ProjectSourceOptionsResponse> {
    await this.requireOwner(projectId, subject.userId);
    const api = (await this.userClient(subject)).im?.v1?.chat?.list;
    if (!api) throw new ProjectSourceBindingUnavailableError();
    const response = await api({ params: { page_size: MAX_CHATS, user_id_type: "open_id" } });
    if (response.code !== 0 || !response.data) throw new ProjectSourceBindingUnavailableError();
    const chats = Array.isArray(response.data.items) ? response.data.items.slice(0, MAX_CHATS) : [];
    const items = chats.flatMap((chat, index) => {
      if (!safeText(chat.chat_id)) return [];
      return [{
        id: this.store(projectId, subject.userId, "chat", { kind: "feishu-chat", containerType: "chat", containerId: chat.chat_id }),
        label: safeLabel(chat.name, `可访问群聊 ${index + 1}`),
      }];
    });
    return { items, hasMore: response.data.has_more === true };
  }

  async resolveSelection(projectId: string, subject: CurrentUserContext, selectionId: string): Promise<ConfiguredProjectDataSourceLocator> {
    await this.requireOwner(projectId, subject.userId);
    return this.getSelection(projectId, subject.userId, selectionId).locator;
  }

  async resolveUrl(
    projectId: string,
    subject: CurrentUserContext,
    type: Exclude<ProjectDataSourceKind, "feishu-base" | "feishu-chat" | "feishu-calendar">,
    sourceUrl: string,
  ): Promise<ConfiguredProjectDataSourceLocator> {
    await this.requireOwner(projectId, subject.userId);
    const url = parseFeishuUrl(sourceUrl);
    if (type === "feishu-minutes") {
      const token = pathToken(url, "minutes");
      if (!token) throw new ProjectSourceBindingInputError();
      return { kind: type, minuteToken: token };
    }
    if (type === "feishu-task") {
      const taskId = url.searchParams.get("guid")?.trim();
      if (!safeText(taskId)) throw new ProjectSourceBindingInputError();
      return { kind: type, taskIds: [taskId] };
    }
    const token = pathToken(url, "wiki") ?? pathToken(url, "docx");
    if (!token) throw new ProjectSourceBindingInputError();
    if (type === "feishu-wiki-drive") return { kind: type, resourceKind: "wiki-node", token };
    if (url.pathname.includes("/docx/")) return { kind: type, documentToken: token };
    const node = await (await this.userClient(subject)).wiki?.v2?.space.getNode({ params: { token } });
    const documentToken = node?.code === 0 ? node.data?.node?.obj_token?.trim() : undefined;
    if (!safeText(documentToken)) throw new ProjectSourceBindingUnavailableError();
    return { kind: type, documentToken };
  }

  private async userClient(subject: CurrentUserContext) {
    if (!this.credentials) throw new ProjectSourceBindingUnavailableError();
    return createFeishuUserAccessClient(this.getClient(), await this.credentials.getUserAccessToken(subject));
  }

  private async requireOwner(projectId: string, userId: string): Promise<void> {
    const [project, membership] = await Promise.all([
      this.projectService.getProject(projectId, userId),
      this.projectService.getMembership(projectId, userId),
    ]);
    if (!project || !membership) throw new ProjectDataSourceAccessDeniedError();
    if (membership.role !== "owner") throw new ProjectDataSourceForbiddenError();
  }

  private store(projectId: string, userId: string, kind: StoredSelection["kind"], locator: ConfiguredProjectDataSourceLocator): string {
    this.prune();
    const id = `selection-${this.generateId()}`;
    this.selections.set(id, { projectId, userId, kind, locator, expiresAt: this.now() + SELECTION_TTL_MS });
    return id;
  }

  private getSelection(projectId: string, userId: string, id: string, kind?: StoredSelection["kind"]): StoredSelection {
    this.prune();
    const selection = this.selections.get(id.trim());
    if (!selection || selection.projectId !== projectId || selection.userId !== userId || (kind && selection.kind !== kind)) throw new ProjectSourceBindingInputError();
    return selection;
  }

  private prune(): void {
    for (const [id, item] of this.selections) if (item.expiresAt <= this.now()) this.selections.delete(id);
  }
}

function normalizeTimeWindow(startAt: string | undefined, endAt: string | undefined, now: () => number): { start: number; end: number } {
  const start = startAt ? Date.parse(startAt) : now() - 24 * 60 * 60_000;
  const end = endAt ? Date.parse(endAt) : now() + DEFAULT_WINDOW_DAYS * 24 * 60 * 60_000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 180 * 24 * 60 * 60_000) throw new ProjectSourceBindingInputError();
  return { start: Math.floor(start / 1_000), end: Math.floor(end / 1_000) };
}

function parseFeishuUrl(value: string): URL {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || !/(^|\.)feishu\.cn$/u.test(url.hostname)) throw new Error();
    return url;
  } catch {
    throw new ProjectSourceBindingInputError();
  }
}

function pathToken(url: URL, segment: string): string | undefined {
  const match = new RegExp(`/${segment}/([^/?#]+)`, "u").exec(url.pathname);
  const token = match?.[1];
  return safeText(token) ? token : undefined;
}

function safeText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 512; }
function safeLabel(value: unknown, fallback: string): string { return safeText(value) ? value.trim().slice(0, 160) : fallback; }
function toIso(timestamp: string | undefined): string | undefined { const milliseconds = timestamp ? Number(timestamp) * 1_000 : Number.NaN; return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined; }

function readCalendarEntries(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const value = data as { calendar_list?: unknown; calendarList?: unknown };
  const entries = value.calendar_list ?? value.calendarList;
  return entries === undefined ? [] : Array.isArray(entries) ? entries : [entries];
}

function readPrimaryCalendarEntries(data: unknown): unknown[] {
  if (!data || typeof data !== "object") return [];
  const value = data as { calendars?: unknown; calendar?: unknown };
  if (Array.isArray(value.calendars)) return value.calendars;
  return value.calendar ? [value.calendar] : [];
}

function calendarIdOf(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const calendar = value as { calendar_id?: unknown; calendarId?: unknown; calendar?: { calendar_id?: unknown; calendarId?: unknown } };
  const id = calendar.calendar_id ?? calendar.calendarId ?? calendar.calendar?.calendar_id ?? calendar.calendar?.calendarId;
  return safeText(id) ? id : undefined;
}

function isPrimaryCalendar(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const calendar = value as { is_primary?: unknown; isPrimary?: unknown; calendar?: { is_primary?: unknown; isPrimary?: unknown } };
  return calendar.is_primary === true
    || calendar.isPrimary === true
    || calendar.calendar?.is_primary === true
    || calendar.calendar?.isPrimary === true;
}
