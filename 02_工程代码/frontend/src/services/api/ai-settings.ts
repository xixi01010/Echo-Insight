type FetchLike = typeof fetch;

const AI_SETTINGS_STATUS_KEYS = new Set([
  "mode",
  "configured",
  "setupRequired",
  "storage",
  "providerId",
  "providerName",
  "model",
]);
const SENSITIVE_RESPONSE_KEYS = new Set([
  "apikey",
  "appsecret",
  "authorization",
  "accesstoken",
  "refreshtoken",
  "secret",
  "token",
]);

export type VisitorAiProviderId = "deepseek" | "qwen";

export interface AiSettingsStatus {
  mode: "server" | "visitor";
  configured: boolean;
  setupRequired: boolean;
  storage: "deployment-environment" | "server-account-encrypted" | "server-session-memory";
  providerId?: "deepseek" | "qwen" | "openai-compatible";
  providerName?: string;
  model?: string;
}

export class AiSettingsApiError extends Error {
  constructor(readonly status: number) {
    super("AI settings request failed.");
  }
}

export class AiSettingsApiClient {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly apiBaseUrl = readApiBaseUrl(),
  ) {}

  getStatus(): Promise<AiSettingsStatus> {
    return this.request("/api/settings/ai?storage-contract=account-v1");
  }

  connect(providerId: VisitorAiProviderId, apiKey: string): Promise<AiSettingsStatus> {
    return this.request("/api/settings/ai?storage-contract=account-v1", {
      method: "PUT",
      body: JSON.stringify({ providerId, apiKey }),
    });
  }

  skip(): Promise<AiSettingsStatus> {
    return this.request("/api/settings/ai/skip?storage-contract=account-v1", { method: "POST" });
  }

  disconnect(): Promise<AiSettingsStatus> {
    return this.request("/api/settings/ai?storage-contract=account-v1", { method: "DELETE" });
  }

  private async request(
    path: string,
    options: Pick<RequestInit, "method" | "body"> = {},
  ): Promise<AiSettingsStatus> {
    const response = await this.fetcher(resolveAiSettingsEndpoint(path, this.apiBaseUrl), {
      cache: "no-store",
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...options,
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isAiSettingsStatus(payload)) {
      throw new AiSettingsApiError(response.status);
    }
    return projectAiSettingsStatus(payload);
  }
}

export function resolveAiSettingsEndpoint(
  path: string,
  apiBaseUrl = readApiBaseUrl(),
): string {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/u, "");
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

export function isAiSettingsStatus(value: unknown): value is AiSettingsStatus {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    containsSensitiveResponseKey(value)
    || keys.some((key) => !AI_SETTINGS_STATUS_KEYS.has(key))
    || !["mode", "configured", "setupRequired", "storage"].every((key) => key in value)
  ) return false;
  if (value.mode !== "server" && value.mode !== "visitor") return false;
  if (typeof value.configured !== "boolean" || typeof value.setupRequired !== "boolean") return false;
  if (
    value.storage !== "deployment-environment"
    && value.storage !== "server-account-encrypted"
    && value.storage !== "server-session-memory"
  ) return false;
  if (
    (value.mode === "server" && value.storage !== "deployment-environment")
    || (value.mode === "visitor" && value.storage === "deployment-environment")
    || (value.setupRequired && (value.mode !== "visitor" || value.configured))
  ) return false;
  if (
    value.providerId !== undefined
    && value.providerId !== "deepseek"
    && value.providerId !== "qwen"
    && value.providerId !== "openai-compatible"
  ) return false;
  const hasProviderMetadata = value.providerId !== undefined
    || value.providerName !== undefined
    || value.model !== undefined;
  if (hasProviderMetadata && (
    value.providerId === undefined
    || typeof value.providerName !== "string"
    || typeof value.model !== "string"
  )) return false;
  if (value.configured && !hasProviderMetadata) return false;
  if (value.mode === "visitor" && (
    value.providerId === "openai-compatible"
    || (!value.configured && hasProviderMetadata)
  )) return false;
  return true;
}

function projectAiSettingsStatus(value: AiSettingsStatus): AiSettingsStatus {
  return {
    mode: value.mode,
    configured: value.configured,
    setupRequired: value.setupRequired,
    storage: value.storage,
    ...(value.providerId === undefined ? {} : { providerId: value.providerId }),
    ...(value.providerName === undefined ? {} : { providerName: value.providerName }),
    ...(value.model === undefined ? {} : { model: value.model }),
  };
}

function readApiBaseUrl(): string {
  const environment = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env;
  return environment?.VITE_API_BASE_URL ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsSensitiveResponseKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsSensitiveResponseKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    SENSITIVE_RESPONSE_KEYS.has(key.replace(/[^a-z0-9]/giu, "").toLowerCase())
    || containsSensitiveResponseKey(nested)
  ));
}
