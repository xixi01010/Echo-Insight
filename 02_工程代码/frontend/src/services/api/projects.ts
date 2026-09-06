import { isProjectReportPayload } from "./project-report.js";
import type {
  ProjectDataSourceStatus,
  CalendarEventOption,
  ProjectIntelligence,
  ProjectSourceOption,
  ProjectSourceStatus,
  ProjectReport,
  ProjectSummary,
} from "./types.js";

const REQUIRED_PROJECT_DTO_KEYS = new Set([
  "id",
  "name",
  "currentUserRole",
  "createdAt",
  "updatedAt",
]);
const OPTIONAL_PROJECT_SUMMARY_KEYS = new Set([
  "healthScore",
  "healthStatus",
  "riskCount",
  "summaryState",
]);

type FetchLike = typeof fetch;

type ViteEnvironment = {
  readonly VITE_API_BASE_URL?: string;
};

export class ProjectApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProjectApiError";
  }
}

export class ProjectApiClient {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly apiBaseUrl = readApiBaseUrl(),
  ) {}

  async getProjects(signal?: AbortSignal): Promise<ProjectSummary[]> {
    const payload = await this.getJson("/api/projects", signal);
    if (!isRecord(payload) || !Array.isArray(payload.projects)) {
      throw invalidProjectResponse();
    }
    if (!payload.projects.every(isProjectSummary)) {
      throw invalidProjectResponse();
    }
    return payload.projects;
  }

  async getProject(projectId: string, signal?: AbortSignal): Promise<ProjectSummary> {
    const payload = await this.getJson(
      `/api/projects/${encodeURIComponent(requireProjectId(projectId))}`,
      signal,
    );
    if (!isProjectSummary(payload)) throw invalidProjectResponse();
    return payload;
  }

  async getProjectReport(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectReport> {
    const payload = await this.getJson(
      `/api/projects/${encodeURIComponent(requireProjectId(projectId))}/report`,
      signal,
      { method: "POST" },
    );
    if (!isProjectReportPayload(payload)) {
      throw new ProjectApiError(
        "Project report response has an unsupported structure.",
        200,
        "INVALID_PROJECT_REPORT",
      );
    }
    return payload;
  }

  async createProject(name: string): Promise<ProjectSummary> {
    const payload = await this.getJson("/api/projects", undefined, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
    if (!isProjectSummary(payload)) throw invalidProjectResponse();
    return payload;
  }

  async startProjectJoin(url: string): Promise<{ authorizationUrl: string }> {
    const payload = await this.getJson("/api/projects/join", undefined, {
      method: "POST",
      body: JSON.stringify({ url }),
    });
    if (!isProjectJoinAuthorization(payload)) throw invalidProjectResponse();
    return payload;
  }

  async getProjectDataSource(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectDataSourceStatus> {
    const payload = await this.getJson(
      `/api/projects/${encodeURIComponent(requireProjectId(projectId))}/data-source`,
      signal,
    );
    if (!isProjectDataSourceStatus(payload)) throw invalidProjectResponse();
    return payload;
  }

  async configureProjectDataSource(
    projectId: string,
    url: string,
  ): Promise<ProjectDataSourceStatus> {
    const payload = await this.getJson(
      `/api/projects/${encodeURIComponent(requireProjectId(projectId))}/data-source`,
      undefined,
      { method: "PUT", body: JSON.stringify({ url }) },
    );
    if (!isProjectDataSourceStatus(payload)) throw invalidProjectResponse();
    return payload;
  }

  async getProjectSources(projectId: string, signal?: AbortSignal): Promise<ProjectSourceStatus[]> {
    const payload = await this.getJson(`/api/projects/${encodeURIComponent(requireProjectId(projectId))}/sources`, signal);
    if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "sources") || !Array.isArray(payload.sources) || !payload.sources.every(isProjectSourceStatus)) throw invalidProjectResponse();
    return payload.sources;
  }

  async addProjectSource(projectId: string, input: { displayName?: string; sourceType?: string; sourceUrl?: string; selectionId?: string }): Promise<ProjectSourceStatus> {
    const payload = await this.getJson(`/api/projects/${encodeURIComponent(requireProjectId(projectId))}/sources`, undefined, { method: "POST", body: JSON.stringify(input) });
    if (!isProjectSourceStatus(payload)) throw invalidProjectResponse();
    return payload;
  }

  async getProjectSourceOptions(projectId: string, sourceType: "chat" | "calendar"): Promise<{ items: ProjectSourceOption[]; hasMore: boolean }> {
    const payload = await this.getJson(`/api/projects/${encodeURIComponent(requireProjectId(projectId))}/sources/options/${sourceType}`);
    if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "items" && key !== "hasMore") || !Array.isArray(payload.items) || !payload.items.every(isProjectSourceOption) || typeof payload.hasMore !== "boolean") throw invalidProjectResponse();
    return { items: payload.items, hasMore: payload.hasMore };
  }

  async getCalendarEventOptions(projectId: string, calendarSelectionId: string, start: string, end: string): Promise<{ items: CalendarEventOption[]; hasMore: boolean }> {
    const path = `/api/projects/${encodeURIComponent(requireProjectId(projectId))}/sources/options/calendar/${encodeURIComponent(calendarSelectionId)}/events?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
    const payload = await this.getJson(path);
    if (!isRecord(payload) || Object.keys(payload).some((key) => key !== "items" && key !== "hasMore") || !Array.isArray(payload.items) || !payload.items.every(isCalendarEventOption) || typeof payload.hasMore !== "boolean") throw invalidProjectResponse();
    return { items: payload.items, hasMore: payload.hasMore };
  }

  async setProjectSourceEnabled(projectId: string, sourceId: string, enabled: boolean): Promise<ProjectSourceStatus> {
    const payload = await this.getJson(`/api/projects/${encodeURIComponent(requireProjectId(projectId))}/sources/${encodeURIComponent(sourceId)}`, undefined, { method: "PATCH", body: JSON.stringify({ enabled }) });
    if (!isProjectSourceStatus(payload)) throw invalidProjectResponse();
    return payload;
  }

  async removeProjectSource(projectId: string, sourceId: string): Promise<void> {
    await this.getJson(`/api/projects/${encodeURIComponent(requireProjectId(projectId))}/sources/${encodeURIComponent(sourceId)}`, undefined, { method: "DELETE" });
  }

  async getProjectIntelligence(projectId: string, signal?: AbortSignal): Promise<ProjectIntelligence> {
    const payload = await this.getJson(`/api/projects/${encodeURIComponent(requireProjectId(projectId))}/intelligence`, signal);
    if (!isProjectIntelligence(payload)) throw invalidProjectResponse();
    return payload;
  }

  private async getJson(
    path: string,
    signal?: AbortSignal,
    options: Pick<RequestInit, "method" | "body"> = {},
  ): Promise<unknown> {
    const request: RequestInit = {
      credentials: "include",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...options,
    };
    if (signal) request.signal = signal;
    const response = await this.fetcher(resolveProjectApiEndpoint(path, this.apiBaseUrl), request);
    const payload: unknown = response.status === 204 ? null : await response.json();
    if (!response.ok) throw toProjectApiError(payload, response.status);
    return payload;
  }
}

export function isProjectDataSourceStatus(value: unknown): value is ProjectDataSourceStatus {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => ["type", "configured", "accessMode", "displayName", "sources"].includes(key))
    && value.type === "feishu-base"
    && typeof value.configured === "boolean"
    && value.accessMode === "read-only"
    && (value.displayName === undefined || (
      typeof value.displayName === "string"
      && value.displayName.trim().length > 0
      && value.displayName.length <= 160
    ))
    && (value.sources === undefined || (Array.isArray(value.sources) && value.sources.every(isProjectSourceStatus)));
}

export function isProjectSourceStatus(value: unknown): value is ProjectSourceStatus {
  if (!isRecord(value)) return false;
  const allowed = ["id", "type", "displayName", "enabled", "accessMode", "status", "authorization", "visibility", "freshness", "activationState", "lastSuccessfulReadAt", "failureCategory"];
  return Object.keys(value).every((key) => allowed.includes(key))
    && typeof value.id === "string" && value.id.length > 0
    && isProjectSourceType(value.type)
    && typeof value.displayName === "string" && value.displayName.length > 0 && value.displayName.length <= 160
    && typeof value.enabled === "boolean" && value.accessMode === "read-only"
    && ["available", "disabled", "unverified", "authorization-required", "unavailable", "read-failed", "stale"].includes(String(value.status))
    && ["authorized", "unknown", "unavailable"].includes(String(value.authorization))
    && ["allowed", "denied", "unknown", "source-unavailable"].includes(String(value.visibility))
    && ["fresh", "stale", "unknown", "unavailable"].includes(String(value.freshness))
    && (value.activationState === "verified" || value.activationState === "real-tenant-unverified")
    && (value.lastSuccessfulReadAt === undefined || typeof value.lastSuccessfulReadAt === "string")
    && (value.failureCategory === undefined || typeof value.failureCategory === "string");
}

export function isProjectIntelligence(value: unknown): value is ProjectIntelligence {
  if (!isRecord(value) || Object.keys(value).some((key) => !["currentFacts", "confirmedRisks", "potentialSignals", "conflicts", "freshness", "ai"].includes(key))) return false;
  if (!Array.isArray(value.currentFacts) || !value.currentFacts.every((item) => hasExactStrings(item, ["subject", "value"], "sourceTypes", ["subject", "value", "sourceTypes"]))) return false;
  if (!Array.isArray(value.confirmedRisks) || !value.confirmedRisks.every((item) => hasExactStrings(item, ["id", "level", "code", "evidence"], "sourceTypes", ["id", "level", "code", "evidence", "sourceTypes"]))) return false;
  if (!Array.isArray(value.potentialSignals) || !value.potentialSignals.every((item) => isRecord(item) && Object.keys(item).every((key) => ["id", "kind", "summary", "sourceTypes", "state"].includes(key)) && item.state === "unconfirmed" && hasExactStrings(item, ["id", "kind", "summary"], "sourceTypes", ["id", "kind", "summary", "sourceTypes", "state"]))) return false;
  if (!Array.isArray(value.conflicts) || !value.conflicts.every((item) => isRecord(item) && Object.keys(item).every((key) => ["id", "sourceTypes", "state"].includes(key)) && item.state === "unresolved" && hasExactStrings(item, ["id"], "sourceTypes", ["id", "sourceTypes", "state"]))) return false;
  if (!Array.isArray(value.freshness) || !value.freshness.every((item) => isRecord(item) && Object.keys(item).every((key) => ["sourceType", "state", "lastSuccessfulReadAt", "failureCategory"].includes(key)) && typeof item.sourceType === "string" && ["fresh", "stale", "unknown", "unavailable"].includes(String(item.state)) && (item.lastSuccessfulReadAt === undefined || typeof item.lastSuccessfulReadAt === "string") && (item.failureCategory === undefined || typeof item.failureCategory === "string"))) return false;
  return isRecord(value.ai)
    && Object.keys(value.ai).every((key) => ["status", "explanations", "limitations"].includes(key))
    && (value.ai.status === "available" || value.ai.status === "unavailable")
    && Array.isArray(value.ai.explanations)
    && value.ai.explanations.every((item) => isRecord(item) && Object.keys(item).every((key) => ["riskId", "reason", "impact", "suggestedActions"].includes(key)) && typeof item.riskId === "string" && typeof item.reason === "string" && typeof item.impact === "string" && Array.isArray(item.suggestedActions) && item.suggestedActions.every((action) => typeof action === "string"))
    && Array.isArray(value.ai.limitations)
    && value.ai.limitations.every((item) => typeof item === "string");
}

function hasExactStrings(value: unknown, keys: string[], arrayKey: string, allowedKeys: string[]): boolean {
  return isRecord(value) && Object.keys(value).every((key) => allowedKeys.includes(key)) && keys.every((key) => typeof value[key] === "string") && Array.isArray(value[arrayKey]) && (value[arrayKey] as unknown[]).every((item) => typeof item === "string");
}

function isProjectSourceType(value: unknown): boolean {
  return ["feishu-base", "feishu-chat", "feishu-minutes", "feishu-docs", "feishu-wiki-drive", "feishu-task", "feishu-calendar"].includes(String(value));
}

function isProjectSourceOption(value: unknown): value is ProjectSourceOption {
  return isRecord(value) && Object.keys(value).every((key) => key === "id" || key === "label") && typeof value.id === "string" && value.id.length > 0 && typeof value.label === "string" && value.label.length > 0;
}

function isCalendarEventOption(value: unknown): value is CalendarEventOption {
  return isRecord(value) && Object.keys(value).every((key) => ["id", "title", "startAt", "endAt"].includes(key)) && typeof value.id === "string" && value.id.length > 0 && typeof value.title === "string" && value.title.length > 0 && (value.startAt === undefined || typeof value.startAt === "string") && (value.endAt === undefined || typeof value.endAt === "string");
}

export function isProjectJoinAuthorization(
  value: unknown,
): value is { authorizationUrl: string } {
  return isRecord(value)
    && Object.keys(value).length === 1
    && typeof value.authorizationUrl === "string"
    && isFeishuAuthorizationUrl(value.authorizationUrl);
}

export function resolveProjectApiEndpoint(path: string, apiBaseUrl = readApiBaseUrl()): string {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

export function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    ![...REQUIRED_PROJECT_DTO_KEYS].every((key) => key in value)
    || keys.some(
      (key) => !REQUIRED_PROJECT_DTO_KEYS.has(key) && !OPTIONAL_PROJECT_SUMMARY_KEYS.has(key),
    )
  ) {
    return false;
  }

  return typeof value.id === "string"
    && typeof value.name === "string"
    && (value.currentUserRole === "owner" || value.currentUserRole === "member")
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
    && (value.healthScore === undefined || (
      typeof value.healthScore === "number"
      && value.healthScore >= 0
      && value.healthScore <= 100
    ))
    && (value.healthStatus === undefined || isHealthStatus(value.healthStatus))
    && (value.riskCount === undefined || (
      typeof value.riskCount === "number"
      && Number.isInteger(value.riskCount)
      && value.riskCount >= 0
    ))
    && (value.summaryState === undefined || ["available", "unconfigured", "unavailable"].includes(String(value.summaryState)))
    && (value.summaryState !== "available" || (
      typeof value.healthScore === "number"
      && isHealthStatus(value.healthStatus)
      && typeof value.riskCount === "number"
    ));
}

function readApiBaseUrl(): string {
  const environment = (import.meta as ImportMeta & { env?: ViteEnvironment }).env;
  return environment?.VITE_API_BASE_URL ?? "";
}

function requireProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!normalized) {
    throw new ProjectApiError("Project id is required.", 400, "PROJECT_ID_REQUIRED");
  }
  return normalized;
}

function toProjectApiError(payload: unknown, status: number): ProjectApiError {
  const code = isRecord(payload)
      && isRecord(payload.error)
      && typeof payload.error.code === "string"
    ? payload.error.code
    : "PROJECT_API_FAILED";

  return new ProjectApiError(
    status === 404 ? "Project not found." : "Project API is unavailable.",
    status,
    code,
  );
}

function invalidProjectResponse(): ProjectApiError {
  return new ProjectApiError(
    "Project response has an unsupported structure.",
    200,
    "INVALID_PROJECT_RESPONSE",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHealthStatus(value: unknown): value is "healthy" | "needs-attention" | "at-risk" {
  return value === "healthy" || value === "needs-attention" || value === "at-risk";
}

function isFeishuAuthorizationUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "accounts.feishu.cn"
      && url.pathname === "/open-apis/authen/v1/authorize"
      && Boolean(url.searchParams.get("state"));
  } catch {
    return false;
  }
}
