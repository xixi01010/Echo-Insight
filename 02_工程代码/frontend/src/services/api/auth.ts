type FetchLike = typeof fetch;

export interface AuthStatus {
  authenticated: boolean;
  mode?: "development" | "feishu";
  user?: { displayName?: string; avatarUrl?: string };
}

export class AuthApiClient {
  constructor(
    private readonly fetcher: FetchLike = globalThis.fetch.bind(globalThis),
    private readonly apiBaseUrl = readApiBaseUrl(),
  ) {}

  async getStatus(): Promise<AuthStatus> {
    return this.request("/api/auth/status");
  }

  getFeishuStartEndpoint(): string {
    return resolveAuthApiEndpoint("/api/auth/feishu/start", this.apiBaseUrl);
  }

  async logout(): Promise<void> {
    await this.request("/api/auth/logout", { method: "POST" });
  }

  private async request(
    path: string,
    options: Pick<RequestInit, "method" | "body"> = {},
  ): Promise<AuthStatus> {
    const response = await this.fetcher(resolveAuthApiEndpoint(path, this.apiBaseUrl), {
      credentials: "include",
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
      ...options,
    });
    const payload: unknown = await response.json();
    if (!response.ok || !isAuthStatus(payload)) throw new Error("Authentication request failed.");
    return payload;
  }
}

export function resolveAuthApiEndpoint(path: string, apiBaseUrl = readApiBaseUrl()): string {
  const normalizedBaseUrl = apiBaseUrl.trim().replace(/\/+$/, "");
  return normalizedBaseUrl ? `${normalizedBaseUrl}${path}` : path;
}

export function isAuthStatus(value: unknown): value is AuthStatus {
  if (!isRecord(value) || typeof value.authenticated !== "boolean") return false;
  const keys = new Set(Object.keys(value));
  if ([...keys].some((key) => !["authenticated", "mode", "user"].includes(key))) {
    return false;
  }
  if (value.mode !== undefined && value.mode !== "development" && value.mode !== "feishu") return false;
  return value.user === undefined || (
    isRecord(value.user)
    && Object.keys(value.user).every((key) => key === "displayName" || key === "avatarUrl")
    && (value.user.displayName === undefined || typeof value.user.displayName === "string")
    && (value.user.avatarUrl === undefined || typeof value.user.avatarUrl === "string")
  );
}

function readApiBaseUrl(): string {
  const environment = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env;
  return environment?.VITE_API_BASE_URL ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
