import { randomUUID } from "node:crypto";
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
import type { ProjectIntelligenceDto, ProjectIntelligenceQueryService } from "../intelligence/index.js";
import type { JsonProjectDataSourceRegistry } from "../project-context/index.js";
import type { Project, ProjectService } from "../project-service/index.js";

const RUN_PATH = "/api/review/real-tenant/run";
const PAGE_PATH = "/api/review/real-tenant";
const PROJECT_NAME = "V3 Real Tenant Connectivity Test";
const BASE_TOKEN = "WF4TbRxdkaIeHysv7eTcEBjVnzb";
const MINUTE_TOKEN = "obcnq1vwc834g213q84fi991";
const DOCUMENT_WIKI_TOKEN = "WcvEwgnSjiGh8ZkQYXgcYqzUnyb";
const WIKI_TOKEN = "VouRwqPzbix0ELkSOCCchfUOnof";
const TASK_ID = "bbe5f471-f913-42ba-b2e3-426d5fbd983e";
const CALENDAR_TITLE = "Echo Insight V3 项目评审";
const CALENDAR_START = "2026-09-04T14:00:00+08:00";
const CALENDAR_END = "2026-09-04T15:00:00+08:00";
const MAX_CALENDARS = 100;
// Feishu Calendar list accepts 50 through 1000 items per request.
const CALENDAR_PAGE_SIZE = 50;
const MAX_EVENT_PAGES_PER_CALENDAR = 5;

type SafeSourceStatus = {
  source: "base" | "chat" | "minutes" | "docs" | "wiki-drive" | "task" | "calendar";
  locatorStatus: "resolved" | "blocked";
  readerStatus: "success" | "failure" | "unavailable" | "unknown" | "not-run";
  visibilityStatus: "allowed" | "unknown";
  freshness: "fresh" | "stale" | "unknown" | "unavailable";
  failureCategory?: string;
  diagnostic?: {
    stage: "chat-membership" | "chat-history" | "calendar-primary" | "calendar-list" | "calendar-search" | "calendar-match";
    result: "api-failure" | "invalid-response" | "not-a-member" | "ambiguous-or-not-found";
    apiCode?: number;
    responseShape?: SafeCalendarResponseShape;
  };
};

type SafeCalendarResponseShape = {
  kind: "response" | "thrown";
  topLevelKeys: string[];
  dataKeys?: string[];
  itemCount?: number;
  hasMore?: boolean;
  hasPageToken?: boolean;
  apiCode?: number;
  httpStatus?: number;
  violationFields?: string[];
};

type CalendarDiagnostics = Partial<Record<"calendar-primary" | "calendar-list" | "calendar-search", SafeCalendarResponseShape>>;

export interface RealTenantValidationReport {
  project: { name: string; currentUserRole: "owner" };
  sources: SafeSourceStatus[];
  intelligence: {
    currentFacts: number;
    candidates: number;
    potentialSignals: number;
    conflicts: number;
    confirmedRisks: number;
    aiStatus: "available" | "unavailable";
    candidateProvenance: Array<{ sourceKinds: string[]; semanticType: "prediction" | "proposal" | "pending-confirmation" | "other" }>;
  };
}

export interface RealTenantValidationRouteDependencies {
  getCurrentUserContextProvider: () => CurrentUserContextProvider | undefined;
  getUserCredentialProvider: () => Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken"> | undefined;
  getFeishuClient: () => FeishuApiClient;
  getProjectService: () => ProjectService;
  getRegistry: () => JsonProjectDataSourceRegistry;
  ensureReady: () => Promise<void>;
  getIntelligence: () => ProjectIntelligenceQueryService;
  run?: (subject: Awaited<ReturnType<CurrentUserContextProvider["getCurrentUser"]>>) => Promise<RealTenantValidationReport>;
}

export function isRealTenantValidationPath(pathname: string): boolean {
  return pathname === RUN_PATH || pathname === PAGE_PATH;
}

export function isRealTenantValidationEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.NODE_ENV !== "production" && environment.ECHO_INSIGHT_REAL_TENANT_DEV === "1";
}

/** Browser-only route. Its HttpOnly session is verified again on the server. */
export function createRealTenantValidationRoute(dependencies: RealTenantValidationRouteDependencies) {
  return async (request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> => {
    if (requestUrl.pathname === PAGE_PATH && request.method === "GET") return sendTriggerPage(response);
    if (request.method !== "POST") return send(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
    const subject = await currentFeishuSubject(request, response, dependencies);
    if (!subject) return;
    const credentialProvider = dependencies.getUserCredentialProvider();
    if (!credentialProvider) return send(response, 503, { error: { code: "CREDENTIAL_UNAVAILABLE" } });
    try {
      // Deliberately validate the server-only credential without serializing it.
      await credentialProvider.getUserAccessToken(subject);
      const report = dependencies.run
        ? await dependencies.run(subject)
        : await runRealTenantValidation(subject, dependencies, credentialProvider);
      send(response, 200, report);
    } catch {
      send(response, 503, { error: { code: "REAL_TENANT_VALIDATION_UNAVAILABLE" } });
    }
  };
}

async function runRealTenantValidation(
  subject: Awaited<ReturnType<CurrentUserContextProvider["getCurrentUser"]>>,
  dependencies: RealTenantValidationRouteDependencies,
  credentials: Pick<FeishuSessionUserCredentialProvider, "getUserAccessToken">,
): Promise<RealTenantValidationReport> {
  await dependencies.ensureReady();
  const project = await ensureCurrentUserProject(subject.userId, dependencies.getProjectService());
  const registry = dependencies.getRegistry();
  const client = dependencies.getFeishuClient();
  const userClient = createFeishuUserAccessClient(client, await credentials.getUserAccessToken(subject));
  const bindings = await resolveBindings(userClient, client, registry, project.id);
  const refs = await registerBindings(project.id, registry, bindings);
  await dependencies.getProjectService().replaceDataSourceRefs(project.id, refs);
  const intelligence = await dependencies.getIntelligence().get(project.id, subject);
  return toSafeReport(project, bindings, intelligence);
}

async function ensureCurrentUserProject(userId: string, service: ProjectService): Promise<Project> {
  const existing = (await service.listProjects(userId)).find((project) => project.name === PROJECT_NAME);
  if (existing) return existing;
  return service.createProject({ name: PROJECT_NAME, creatorId: userId, ownerId: userId });
}

type Binding = {
  source: SafeSourceStatus["source"];
  locatorStatus: "resolved" | "blocked";
  locator?: Parameters<JsonProjectDataSourceRegistry["registerConfiguredSource"]>[0]["locator"];
  displayName: string;
  diagnostic?: SafeSourceStatus["diagnostic"];
};

async function resolveBindings(
  userClient: ReturnType<typeof createFeishuUserAccessClient>,
  client: FeishuApiClient,
  registry: JsonProjectDataSourceRegistry,
  projectId: string,
): Promise<Binding[]> {
  const results: Binding[] = [{ source: "base", locatorStatus: "resolved", displayName: "V3 test Base" }];
  results.push(await resolveChatBinding(userClient, client, registry, projectId));
  results.push({ source: "minutes", locatorStatus: "resolved", locator: { kind: "feishu-minutes", minuteToken: MINUTE_TOKEN }, displayName: "V3 test Minutes" });
  results.push(await resolveDocumentBinding(userClient));
  results.push({ source: "wiki-drive", locatorStatus: "resolved", locator: { kind: "feishu-wiki-drive", resourceKind: "wiki-node", token: WIKI_TOKEN }, displayName: "V3 test Wiki" });
  results.push({ source: "task", locatorStatus: "resolved", locator: { kind: "feishu-task", taskIds: [TASK_ID] }, displayName: "V3 test Task" });
  results.push(await resolveCalendarBinding(userClient));
  return results;
}

async function resolveChatBinding(
  userClient: ReturnType<typeof createFeishuUserAccessClient>,
  client: FeishuApiClient,
  registry: JsonProjectDataSourceRegistry,
  projectId: string,
): Promise<Binding> {
  const existing = registry.getForProject(projectId, `real-tenant-${projectId}-chat`);
  if (!existing || existing.kind !== "feishu-chat" || !("locator" in existing) || existing.locator.kind !== "feishu-chat") {
    return { source: "chat", locatorStatus: "blocked", displayName: "V3 test Chat", diagnostic: { stage: "chat-membership", result: "invalid-response" } };
  }
  const displayName = existing.displayName ?? "V3 test Chat";
  try {
    const response = await userClient.im?.v1?.chatMembers?.isInChat({ path: { chat_id: existing.locator.containerId } });
    if (!response) return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-membership", result: "invalid-response" } };
    if (response.code !== 0) return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-membership", result: "api-failure", ...(typeof response.code === "number" ? { apiCode: response.code } : {}) } };
    if (response.data?.is_in_chat !== true) {
      return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-membership", result: "not-a-member" } };
    }
    const history = await client.im?.v1?.message?.list({
      params: {
        container_id_type: existing.locator.containerType,
        container_id: existing.locator.containerId,
        sort_type: "ByCreateTimeAsc",
        page_size: 1,
        with_sender_name: false,
      },
    });
    if (!history) return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-history", result: "invalid-response" } };
    if (history.code !== 0) return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-history", result: "api-failure", ...(typeof history.code === "number" ? { apiCode: history.code } : {}) } };
    if (!history.data) return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-history", result: "invalid-response", ...(typeof history.code === "number" ? { apiCode: history.code } : {}) } };
    return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName };
  } catch {
    return { source: "chat", locatorStatus: "resolved", locator: existing.locator, displayName, diagnostic: { stage: "chat-membership", result: "invalid-response" } };
  }
}

async function resolveDocumentBinding(userClient: ReturnType<typeof createFeishuUserAccessClient>): Promise<Binding> {
  try {
    const response = await userClient.wiki?.v2?.space.getNode({ params: { token: DOCUMENT_WIKI_TOKEN } });
    const token = response?.code === 0 ? response.data?.node?.obj_token?.trim() : undefined;
    return token
      ? { source: "docs", locatorStatus: "resolved", locator: { kind: "feishu-docs", documentToken: token }, displayName: "V3 test document" }
      : { source: "docs", locatorStatus: "blocked", displayName: "V3 test document" };
  } catch {
    return { source: "docs", locatorStatus: "blocked", displayName: "V3 test document" };
  }
}

async function resolveCalendarBinding(userClient: ReturnType<typeof createFeishuUserAccessClient>): Promise<Binding> {
  let stage: NonNullable<SafeSourceStatus["diagnostic"]>["stage"] = "calendar-primary";
  const diagnostics: CalendarDiagnostics = {};
  try {
    const listEvents = userClient.calendar?.v4?.calendarEvent.list;
    if (!userClient.calendar?.v4?.calendar || !listEvents) throw new Error("calendar locator unavailable");
    const primaryCalendarId = await resolvePrimaryCalendarId(userClient, diagnostics);
    if (primaryCalendarId) {
      stage = "calendar-search";
      const primaryMatches = await findExactCalendarEvents(listEvents, primaryCalendarId, diagnostics);
      if (primaryMatches.length === 1) return { source: "calendar", locatorStatus: "resolved", locator: { kind: "feishu-calendar", calendarId: primaryMatches[0]!.calendarId, eventIds: [primaryMatches[0]!.eventId] }, displayName: "V3 test Calendar" };
      if (primaryMatches.length > 1) throw new LocatorResolutionError("calendar-match", "ambiguous-or-not-found");
    }
    stage = "calendar-list";
    const calendars = await collectCalendars(userClient, diagnostics);
    const matches: Array<{ calendarId: string; eventId: string }> = [];
    stage = "calendar-search";
    for (const calendar of calendars) {
      if (calendar.calendar_id === primaryCalendarId) continue;
      matches.push(...await findExactCalendarEvents(listEvents, calendar.calendar_id, diagnostics));
    }
    if (matches.length !== 1) throw new LocatorResolutionError("calendar-match", "ambiguous-or-not-found");
    return { source: "calendar", locatorStatus: "resolved", locator: { kind: "feishu-calendar", calendarId: matches[0]!.calendarId, eventIds: [matches[0]!.eventId] }, displayName: "V3 test Calendar" };
  } catch (error) {
    return { source: "calendar", locatorStatus: "blocked", displayName: "V3 test Calendar", diagnostic: toCalendarDiagnostic(error, stage, diagnostics) };
  }
}

async function resolvePrimaryCalendarId(userClient: ReturnType<typeof createFeishuUserAccessClient>, diagnostics: CalendarDiagnostics): Promise<string | undefined> {
  const api = userClient.calendar?.v4?.calendar?.primary;
  if (!api) return undefined;
  const response = await observeCalendarResponse("calendar-primary", diagnostics, () => api({ params: { user_id_type: "open_id" } }), "calendars");
  if (response.code !== 0) throw new LocatorResolutionError("calendar-primary", "api-failure", response.code);
  const ids = asArray(response.data?.calendars).flatMap((item) => item.calendar?.calendar_id ? [item.calendar.calendar_id] : []);
  if (ids.length > 1) throw new LocatorResolutionError("calendar-primary", "invalid-response");
  return ids[0];
}

async function collectCalendars(userClient: ReturnType<typeof createFeishuUserAccessClient>, diagnostics: CalendarDiagnostics): Promise<Array<{ calendar_id: string; is_primary?: boolean }>> {
  const api = userClient.calendar?.v4?.calendar;
  if (!api) throw new LocatorResolutionError("calendar-list", "invalid-response");
  const calendars: Array<{ calendar_id: string; is_primary?: boolean }> = [];
  let pageToken: string | undefined;
  do {
    const response = await observeCalendarResponse("calendar-list", diagnostics, () => api.list({ params: { page_size: CALENDAR_PAGE_SIZE, ...(pageToken ? { page_token: pageToken } : {}) } }), "calendar_list");
    if (response.code !== 0) throw new LocatorResolutionError("calendar-list", "api-failure", response.code);
    if (!response.data) throw new LocatorResolutionError("calendar-list", "invalid-response", response.code);
    calendars.push(...asArray(response.data.calendar_list));
    if (calendars.length > MAX_CALENDARS) throw new LocatorResolutionError("calendar-list", "invalid-response", response.code);
    pageToken = response.data.has_more ? response.data.page_token : undefined;
    if (response.data.has_more && !pageToken) throw new LocatorResolutionError("calendar-list", "invalid-response", response.code);
  } while (pageToken);
  return calendars.sort((left, right) => Number(Boolean(right.is_primary)) - Number(Boolean(left.is_primary)));
}

function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

async function findExactCalendarEvents(
  listEvents: NonNullable<NonNullable<NonNullable<FeishuApiClient["calendar"]>["v4"]>["calendarEvent"]["list"]>,
  calendarId: string,
  diagnostics: CalendarDiagnostics,
): Promise<Array<{ calendarId: string; eventId: string }>> {
  const matches: Array<{ calendarId: string; eventId: string }> = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES_PER_CALENDAR; page += 1) {
    const response = await observeCalendarResponse("calendar-search", diagnostics, () => listEvents({
      path: { calendar_id: calendarId },
      params: { page_size: CALENDAR_PAGE_SIZE, start_time: String(Date.parse(CALENDAR_START) / 1_000), end_time: String(Date.parse(CALENDAR_END) / 1_000), user_id_type: "open_id", ...(pageToken ? { page_token: pageToken } : {}) },
    }), "items");
    if (response.code !== 0) throw new LocatorResolutionError("calendar-search", "api-failure", response.code);
    if (!response.data) throw new LocatorResolutionError("calendar-search", "invalid-response");
    for (const event of response.data.items ?? []) {
      if (event.summary === CALENDAR_TITLE && event.start_time?.timestamp === String(Date.parse(CALENDAR_START) / 1_000) && event.end_time?.timestamp === String(Date.parse(CALENDAR_END) / 1_000) && event.event_id) {
        matches.push({ calendarId, eventId: event.event_id });
      }
    }
    if (!response.data.has_more) return matches;
    if (!response.data.page_token) throw new LocatorResolutionError("calendar-search", "invalid-response");
    pageToken = response.data.page_token;
  }
  throw new LocatorResolutionError("calendar-search", "invalid-response");
}

class LocatorResolutionError extends Error {
  constructor(
    readonly stage: NonNullable<SafeSourceStatus["diagnostic"]>["stage"],
    readonly result: NonNullable<SafeSourceStatus["diagnostic"]>["result"],
    readonly apiCode?: number,
  ) {
    super("Calendar locator resolution failed.");
  }
}

function toCalendarDiagnostic(error: unknown, fallbackStage: NonNullable<SafeSourceStatus["diagnostic"]>["stage"], diagnostics: CalendarDiagnostics): NonNullable<SafeSourceStatus["diagnostic"]> {
  if (error instanceof LocatorResolutionError) {
    const responseShape = calendarResponseShapeForStage(diagnostics, error.stage);
    return { stage: error.stage, result: error.result, ...(typeof error.apiCode === "number" ? { apiCode: error.apiCode } : {}), ...(responseShape ? { responseShape } : {}) };
  }
  const responseShape = calendarResponseShapeForStage(diagnostics, fallbackStage);
  return { stage: fallbackStage, result: "invalid-response", ...(responseShape ? { responseShape } : {}) };
}

function calendarResponseShapeForStage(diagnostics: CalendarDiagnostics, stage: NonNullable<SafeSourceStatus["diagnostic"]>["stage"]): SafeCalendarResponseShape | undefined {
  return stage === "calendar-primary" || stage === "calendar-list" || stage === "calendar-search" ? diagnostics[stage] : undefined;
}

async function observeCalendarResponse<T>(
  stage: keyof CalendarDiagnostics,
  diagnostics: CalendarDiagnostics,
  operation: () => Promise<T>,
  itemsKey: string,
): Promise<T> {
  try {
    const response = await operation();
    diagnostics[stage] = describeCalendarResponse(response, itemsKey);
    return response;
  } catch (error) {
    diagnostics[stage] = describeCalendarFailure(error);
    throw error;
  }
}

export function describeCalendarResponse(value: unknown, itemsKey: string): SafeCalendarResponseShape {
  const response = asRecord(value);
  const data = asRecord(response?.data);
  const collection = data?.[itemsKey];
  return {
    kind: "response",
    topLevelKeys: response ? safeResponseKeys(response) : [],
    ...(data ? { dataKeys: safeResponseKeys(data) } : {}),
    ...(Array.isArray(collection) ? { itemCount: collection.length } : {}),
    ...(typeof data?.has_more === "boolean" ? { hasMore: data.has_more } : {}),
    ...(typeof data?.page_token === "string" && data.page_token.length > 0 ? { hasPageToken: true } : {}),
    ...(typeof response?.code === "number" ? { apiCode: response.code } : {}),
  };
}

export function describeCalendarFailure(value: unknown): SafeCalendarResponseShape {
  const error = asRecord(value);
  const response = asRecord(error?.response);
  const responseData = asRecord(response?.data);
  const errorData = asRecord(responseData?.error);
  const violationFields = Array.isArray(errorData?.field_violations)
    ? errorData.field_violations.flatMap((entry) => {
      const field = asRecord(entry)?.field;
      return typeof field === "string" && /^[a-zA-Z0-9_.-]+$/.test(field) ? [field] : [];
    })
    : [];
  return {
    kind: "thrown",
    topLevelKeys: error ? safeResponseKeys(error) : [],
    ...(typeof responseData?.code === "number" ? { apiCode: responseData.code } : {}),
    ...(typeof response?.status === "number" ? { httpStatus: response.status } : {}),
    ...(violationFields.length ? { violationFields } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function safeResponseKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => !/(token|cookie|authorization|credential|secret)/i.test(key)).sort();
}

async function registerBindings(projectId: string, registry: JsonProjectDataSourceRegistry, bindings: Binding[]): Promise<string[]> {
  const refs: string[] = [];
  for (const binding of bindings) {
    const ref = `real-tenant-${projectId}-${binding.source}`;
    if (binding.source === "base") {
      await registry.registerFeishuBase(projectId, ref, BASE_TOKEN);
      refs.push(ref);
    } else if (binding.locator) {
      await registry.registerConfiguredSource({ projectId, ref, publicId: randomUUID(), locator: binding.locator, displayName: binding.displayName });
      refs.push(ref);
    }
  }
  return refs;
}

function toSafeReport(project: Project, bindings: Binding[], intelligence: ProjectIntelligenceDto): RealTenantValidationReport {
  return {
    project: { name: project.name, currentUserRole: "owner" },
    sources: bindings.map((binding) => {
      const freshness = intelligence.freshness.find((item) => item.sourceType === toSourceKind(binding.source));
      return {
        source: binding.source,
        locatorStatus: binding.locatorStatus,
        readerStatus: freshness ? freshness.state === "fresh" ? "success" : freshness.state === "stale" ? "failure" : freshness.state : "not-run",
        visibilityStatus: freshness?.state === "fresh" ? "allowed" : "unknown",
        freshness: freshness?.state ?? "unknown",
        ...(freshness?.failureCategory ? { failureCategory: freshness.failureCategory } : {}),
        ...(binding.diagnostic ? { diagnostic: binding.diagnostic } : {}),
      };
    }),
    intelligence: {
      currentFacts: intelligence.currentFacts.length,
      candidates: intelligence.potentialSignals.filter((item) => item.kind === "candidate" || item.kind === "possible-resolved").length,
      potentialSignals: intelligence.potentialSignals.length,
      conflicts: intelligence.conflicts.length,
      confirmedRisks: intelligence.confirmedRisks.length,
      aiStatus: intelligence.ai.status,
      candidateProvenance: intelligence.potentialSignals
        .filter((item) => item.kind === "candidate" || item.kind === "possible-resolved")
        .map((item) => ({ sourceKinds: item.sourceTypes, semanticType: candidateSemanticType(item.summary) })),
    },
  };
}

function candidateSemanticType(summary: string): "prediction" | "proposal" | "pending-confirmation" | "other" {
  if (summary.includes("pending-confirmation")) return "pending-confirmation";
  if (summary.includes("proposal")) return "proposal";
  if (summary.includes("prediction")) return "prediction";
  return "other";
}

function toSourceKind(source: SafeSourceStatus["source"]): string {
  return source === "wiki-drive" ? "feishu-wiki-drive" : `feishu-${source}`;
}

async function currentFeishuSubject(request: IncomingMessage, response: ServerResponse, dependencies: RealTenantValidationRouteDependencies) {
  try {
    const provider = dependencies.getCurrentUserContextProvider();
    const subject = provider ? await provider.getCurrentUser(request) : undefined;
    if (!subject || subject.source !== "feishu" || !subject.sessionId || !subject.identity) {
      send(response, 401, { error: { code: "FEISHU_SESSION_REQUIRED" } });
      return undefined;
    }
    return subject;
  } catch (error) {
    send(response, error instanceof CurrentUserContextUnavailableError ? 401 : 503, { error: { code: "FEISHU_SESSION_REQUIRED" } });
    return undefined;
  }
}

function send(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function sendTriggerPage(response: ServerResponse): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Echo Insight Real Tenant Validation</title><style>body{font:16px system-ui;margin:2rem;max-width:48rem}button{padding:.6rem 1rem}pre{white-space:pre-wrap;word-break:break-word}</style><h1>V3 Real Tenant Validation</h1><p>此开发专用页面只使用当前浏览器的 HttpOnly 会话。</p><button id="run">运行七来源验证</button><pre id="result"></pre><script>const result=document.querySelector('#result');document.querySelector('#run').onclick=async()=>{result.textContent='验证中…';const response=await fetch('${RUN_PATH}',{method:'POST'});result.textContent=JSON.stringify(await response.json(),null,2)}</script>`);
}
