import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createFeishuUserAccessClient,
  type FeishuApiClient,
} from "../../../feishu-connector/src/index.js";
import {
  CurrentUserContextUnavailableError,
  type CurrentUserContextProvider,
  type FeishuSessionUserCredentialProvider,
} from "../current-user/index.js";

const CHAT_LOCATOR_PATH = "/api/dev/real-tenant/locators/chat";
const CALENDAR_LOCATOR_PATH = "/api/dev/real-tenant/locators/calendar";
const CALENDAR_TITLE = "Echo Insight V3 项目评审";
const CALENDAR_START = "2026-09-04T14:00:00+08:00";
const CALENDAR_END = "2026-09-04T15:00:00+08:00";
// Feishu Calendar list accepts a page size of at least 50.
const MAX_CALENDARS = 50;

export interface RealTenantDevLocatorRouteDependencies {
  getCurrentUserContextProvider: () => CurrentUserContextProvider | undefined;
  getUserCredentialProvider: () => Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken"> | undefined;
  getFeishuClient: () => FeishuApiClient;
}

/**
 * This route exists only behind ECHO_INSIGHT_REAL_TENANT_DEV=1 in a
 * non-production process. It never returns credentials, message content, or
 * metadata belonging to a non-matching resource.
 */
export function isRealTenantDevLocatorPath(pathname: string): boolean {
  return pathname === CHAT_LOCATOR_PATH || pathname === CALENDAR_LOCATOR_PATH;
}

export function createRealTenantDevLocatorRoute(dependencies: RealTenantDevLocatorRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> => {
    if (request.method !== "GET") return send(response, 405, { status: "method_not_allowed" });
    const subject = await currentFeishuSubject(request, response, dependencies);
    if (!subject) return;
    const credentials = dependencies.getUserCredentialProvider();
    if (!credentials) return send(response, 503, { status: "credential_unavailable" });
    try {
      const userClient = createFeishuUserAccessClient(
        dependencies.getFeishuClient(),
        await credentials.getUserAccessToken(subject),
      );
      if (requestUrl.pathname === CHAT_LOCATOR_PATH) {
        return await resolveChat(response, requestUrl, dependencies.getFeishuClient());
      }
      return await resolveCalendar(response, userClient);
    } catch {
      return send(response, 503, { status: "credential_unavailable" });
    }
  };
}

async function currentFeishuSubject(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: RealTenantDevLocatorRouteDependencies,
) {
  try {
    const provider = dependencies.getCurrentUserContextProvider();
    const subject = provider ? await provider.getCurrentUser(request) : undefined;
    if (!subject || subject.source !== "feishu" || !subject.sessionId) {
      send(response, 401, { status: "feishu_session_required" });
      return undefined;
    }
    return subject;
  } catch (error) {
    send(response, error instanceof CurrentUserContextUnavailableError ? 401 : 503, {
      status: error instanceof CurrentUserContextUnavailableError ? "feishu_session_required" : "session_unavailable",
    });
    return undefined;
  }
}

async function resolveChat(
  response: ServerResponse,
  requestUrl: URL,
  client: FeishuApiClient,
): Promise<void> {
  const name = requestUrl.searchParams.get("name")?.trim();
  if (!name) return send(response, 400, { status: "exact_chat_name_required" });
  const result = await client.im?.v1?.chat?.list({ params: { page_size: 100 } });
  if (!result || result.code !== 0) return send(response, 503, { status: "locator_extraction_blocked" });
  const matches = (result.data?.items ?? []).filter((item) => item.name === name && item.chat_id);
  if (matches.length !== 1) {
    return send(response, 409, { status: matches.length ? "ambiguous" : "not_found" });
  }
  const match = matches[0];
  if (!match?.chat_id) return send(response, 503, { status: "locator_extraction_blocked" });
  send(response, 200, { status: "resolved", locator: { containerType: "chat", containerId: match.chat_id } });
}

async function resolveCalendar(
  response: ServerResponse,
  client: Pick<FeishuApiClient, "calendar">,
): Promise<void> {
  const calendars = await client.calendar?.v4?.calendar?.list({ params: { page_size: MAX_CALENDARS } });
  if (!calendars || calendars.code !== 0 || calendars.data?.has_more || (calendars.data?.calendar_list?.length ?? 0) > MAX_CALENDARS) {
    return send(response, 503, { status: "locator_extraction_blocked" });
  }
  const matches: Array<{ calendarId: string; eventId: string }> = [];
  const eventSearch = client.calendar?.v4?.calendarEvent.search;
  if (!eventSearch) return send(response, 503, { status: "locator_extraction_blocked" });
  for (const calendar of calendars.data?.calendar_list ?? []) {
    const events = await eventSearch({
      path: { calendar_id: calendar.calendar_id },
      data: {
        query: CALENDAR_TITLE,
        filter: {
          start_time: { timestamp: String(Date.parse(CALENDAR_START) / 1_000), timezone: "Asia/Shanghai" },
          end_time: { timestamp: String(Date.parse(CALENDAR_END) / 1_000), timezone: "Asia/Shanghai" },
        },
      },
      params: { page_size: 20, user_id_type: "open_id" },
    });
    if (!events || events.code !== 0) return send(response, 503, { status: "locator_extraction_blocked" });
    for (const event of events.data?.items ?? []) {
      if (event.summary === CALENDAR_TITLE && sameEventWindow(event)) {
        if (event.event_id) matches.push({ calendarId: calendar.calendar_id, eventId: event.event_id });
      }
    }
  }
  if (matches.length !== 1) return send(response, 409, { status: matches.length ? "ambiguous" : "not_found" });
  const match = matches[0];
  if (!match) return send(response, 503, { status: "locator_extraction_blocked" });
  send(response, 200, { status: "resolved", locator: { calendarId: match.calendarId, eventIds: [match.eventId] } });
}

function sameEventWindow(event: { start_time?: { timestamp?: string }; end_time?: { timestamp?: string } }): boolean {
  return event.start_time?.timestamp === String(Date.parse(CALENDAR_START) / 1_000)
    && event.end_time?.timestamp === String(Date.parse(CALENDAR_END) / 1_000);
}

function send(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}
