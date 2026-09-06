import type {
  GlobalInsight,
  GlobalInsightSynthesisResponse,
  GlobalInsightsResponse,
} from "./types.js";

type FetchLike = typeof fetch;

type ViteEnvironment = {
  readonly VITE_API_BASE_URL?: string;
};

export class GlobalInsightsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GlobalInsightsApiError";
  }
}

export class GlobalInsightsApiClient {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly apiBaseUrl = readApiBaseUrl(),
  ) {}

  async getInsights(signal?: AbortSignal): Promise<GlobalInsightsResponse> {
    const request: RequestInit = { credentials: "include", headers: { Accept: "application/json" } };
    if (signal) request.signal = signal;
    const response = await this.fetcher(resolveInsightsApiEndpoint(this.apiBaseUrl), request);
    const payload: unknown = await response.json();
    if (!response.ok) throw toInsightsApiError(payload, response.status);
    if (!isGlobalInsightsResponse(payload)) {
      throw new GlobalInsightsApiError(
        "Global insights response has an unsupported structure.",
        200,
        "INVALID_INSIGHTS_RESPONSE",
      );
    }
    return payload;
  }

  async getSynthesis(
    signal?: AbortSignal,
    forceRefresh = false,
  ): Promise<GlobalInsightSynthesisResponse> {
    const request: RequestInit = {
      credentials: "include",
      headers: { Accept: "application/json" },
      method: "POST",
    };
    if (signal) request.signal = signal;
    const response = await this.fetcher(
      resolveInsightsSynthesisApiEndpoint(this.apiBaseUrl, forceRefresh),
      request,
    );
    const payload: unknown = await response.json();
    if (!response.ok) throw toInsightsApiError(payload, response.status);
    if (!isGlobalInsightSynthesisResponse(payload)) {
      throw new GlobalInsightsApiError(
        "Global insight synthesis response has an unsupported structure.",
        200,
        "INVALID_INSIGHT_SYNTHESIS_RESPONSE",
      );
    }
    return payload;
  }
}

export function resolveInsightsApiEndpoint(apiBaseUrl = readApiBaseUrl()): string {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/insights`;
}

export function resolveInsightsSynthesisApiEndpoint(
  apiBaseUrl = readApiBaseUrl(),
  forceRefresh = false,
): string {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  return `${normalizedBaseUrl}/api/insights/synthesis${forceRefresh ? "?forceRefresh=true" : ""}`;
}

export function isGlobalInsightsResponse(value: unknown): value is GlobalInsightsResponse {
  return isRecord(value)
    && Object.keys(value).every((key) => key === "insights" || key === "partialFailure")
    && Array.isArray(value.insights)
    && value.insights.every(isGlobalInsight)
    && typeof value.partialFailure === "boolean";
}

export function isGlobalInsightSynthesisResponse(
  value: unknown,
): value is GlobalInsightSynthesisResponse {
  return isRecord(value)
    && Object.keys(value).length === 4
    && ["status", "summary", "priorities", "limitations"].every((key) => key in value)
    && (value.status === "available" || value.status === "limited" || value.status === "unavailable")
    && typeof value.summary === "string"
    && Array.isArray(value.priorities)
    && value.priorities.every((priority) => (
      isRecord(priority)
      && Object.keys(priority).length === 3
      && typeof priority.insightId === "string"
      && typeof priority.explanation === "string"
      && typeof priority.suggestedAction === "string"
    ))
    && Array.isArray(value.limitations)
    && value.limitations.every((limitation) => typeof limitation === "string");
}

function isGlobalInsight(value: unknown): value is GlobalInsight {
  if (!isRecord(value)) return false;
  const requiredKeys = [
    "id",
    "projectId",
    "projectName",
    "currentUserRole",
    "riskLevel",
    "title",
    "facts",
    "ruleBasis",
  ];
  return Object.keys(value).every((key) => requiredKeys.includes(key) || key === "deadline")
    && requiredKeys.every((key) => key in value)
    && typeof value.id === "string"
    && typeof value.projectId === "string"
    && typeof value.projectName === "string"
    && (value.currentUserRole === "owner" || value.currentUserRole === "member")
    && isRiskLevel(value.riskLevel)
    && typeof value.title === "string"
    && Array.isArray(value.facts)
    && value.facts.every((fact) => typeof fact === "string")
    && typeof value.ruleBasis === "string"
    && (value.deadline === undefined || value.deadline === null || typeof value.deadline === "string");
}

function readApiBaseUrl(): string {
  const environment = (import.meta as ImportMeta & { env?: ViteEnvironment }).env;
  return environment?.VITE_API_BASE_URL ?? "";
}

function toInsightsApiError(payload: unknown, status: number): GlobalInsightsApiError {
  const code = isRecord(payload)
      && isRecord(payload.error)
      && typeof payload.error.code === "string"
    ? payload.error.code
    : "INSIGHTS_UNAVAILABLE";
  return new GlobalInsightsApiError("Insights are unavailable.", status, code);
}

function isRiskLevel(value: unknown): value is "L1" | "L2" | "L3" | "L4" | "L5" {
  return value === "L1" || value === "L2" || value === "L3" || value === "L4" || value === "L5";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
