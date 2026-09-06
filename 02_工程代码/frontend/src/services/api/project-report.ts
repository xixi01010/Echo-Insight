import type { ProjectReport, RiskContext } from "./types.js";

export const UNSAFE_FRONTEND_ENDPOINTS = ["/api/project-data", "/api/project-analysis"] as const;
const FORBIDDEN_RESPONSE_KEYS = new Set(["basetoken", "appsecret", "apikey", "api_key", "authorization", "access_token"]);
const PROJECT_REPORT_PATH = "/api/project-report";

type FetchLike = typeof fetch;

type ViteEnvironment = {
  readonly VITE_API_BASE_URL?: string;
};

export class ProjectReportApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProjectReportApiError";
  }
}

export class ProjectReportApiClient {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly apiBaseUrl = readApiBaseUrl(),
  ) {}

  async getProjectReport(signal?: AbortSignal): Promise<ProjectReport> {
    const request: RequestInit = { headers: { Accept: "application/json" } };
    if (signal) request.signal = signal;

    const response = await this.fetcher(resolveProjectReportEndpoint(this.apiBaseUrl), request);
    const payload: unknown = await response.json();

    if (!response.ok) throw toApiError(payload, response.status);
    if (containsForbiddenResponseKey(payload)) {
      throw new ProjectReportApiError("Project report response contains a forbidden sensitive field.", response.status, "UNSAFE_PROJECT_REPORT");
    }
    if (!isProjectReportPayload(payload)) {
      throw new ProjectReportApiError("Project report response has an unsupported structure.", response.status, "INVALID_PROJECT_REPORT");
    }

    return payload;
  }
}

export function resolveProjectReportEndpoint(apiBaseUrl = readApiBaseUrl()): string {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  return normalizedBaseUrl ? `${normalizedBaseUrl}${PROJECT_REPORT_PATH}` : PROJECT_REPORT_PATH;
}

function readApiBaseUrl(): string {
  const environment = (import.meta as ImportMeta & { env?: ViteEnvironment }).env;
  return environment?.VITE_API_BASE_URL ?? "";
}

export function isProjectReportPayload(value: unknown): value is ProjectReport {
  if (!isRecord(value) || !isRecord(value.analysis) || !isRecord(value.aiReport)) return false;
  if (containsForbiddenResponseKey(value)) return false;

  return typeof value.analysis.healthScore === "number"
    && typeof value.analysis.healthStatus === "string"
    && typeof value.analysis.riskLevel === "string"
    && Array.isArray(value.analysis.riskSignals)
    && isRecord(value.analysis.scoringDetails)
    && typeof value.analysis.scoringDetails.calculatedAt === "string"
    && Array.isArray(value.riskContexts)
    && value.riskContexts.every(isRiskContext)
    && hasContextsForRiskSignals(value.analysis.riskSignals, value.riskContexts)
    && (value.aiStatus === undefined || value.aiStatus === "available" || value.aiStatus === "unavailable")
    && Array.isArray(value.aiReport.risks)
    && Array.isArray(value.aiReport.limitations);
}

function isRiskContext(value: unknown): value is RiskContext {
  if (!isRecord(value) || containsUnsafeRiskContextKey(value)) return false;

  return typeof value.signalId === "string"
    && typeof value.type === "string"
    && (value.primaryTask === null || isPrimaryTaskContext(value.primaryTask))
    && Array.isArray(value.relatedTasks)
    && value.relatedTasks.every(isRelatedTaskContext)
    && isStringArray(value.factualEvidence)
    && isStringArray(value.dataLimitations);
}

function hasContextsForRiskSignals(
  riskSignals: unknown[],
  riskContexts: RiskContext[],
): boolean {
  if (riskSignals.length === 0) return true;

  const contextSignalIds = new Set(riskContexts.map((context) => context.signalId));
  return riskSignals.every((signal) =>
    isRecord(signal)
    && typeof signal.signalId === "string"
    && contextSignalIds.has(signal.signalId),
  );
}

function isPrimaryTaskContext(value: unknown): boolean {
  if (!isRecord(value)) return false;

  return isNullableString(value.name)
    && isNullableString(value.status)
    && isNullableString(value.deadline)
    && (value.owner === undefined || typeof value.owner === "string")
    && (value.description === undefined || typeof value.description === "string");
}

function isRelatedTaskContext(value: unknown): boolean {
  if (!isRecord(value)) return false;

  return isNullableString(value.name)
    && isNullableString(value.status)
    && (value.deadline === undefined || typeof value.deadline === "string");
}

function isNullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function toApiError(payload: unknown, status: number): ProjectReportApiError {
  if (isRecord(payload) && isRecord(payload.error)) {
    const message = typeof payload.error.message === "string" ? payload.error.message : "Unable to generate the project report.";
    const code = typeof payload.error.code === "string" ? payload.error.code : "PROJECT_REPORT_FAILED";
    return new ProjectReportApiError(message, status, code);
  }

  return new ProjectReportApiError("Unable to generate the project report.", status, "PROJECT_REPORT_FAILED");
}

function containsForbiddenResponseKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenResponseKey);
  if (!isRecord(value)) return false;

  return Object.entries(value).some(([key, item]) => FORBIDDEN_RESPONSE_KEYS.has(key.toLowerCase()) || containsForbiddenResponseKey(item));
}

function containsUnsafeRiskContextKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnsafeRiskContextKey);
  if (!isRecord(value)) return false;

  return Object.entries(value).some(([key, item]) =>
    ["recordid", "taskid", "relatedtaskids", "tableid", "basetoken"].includes(key.toLowerCase())
    || containsUnsafeRiskContextKey(item),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
