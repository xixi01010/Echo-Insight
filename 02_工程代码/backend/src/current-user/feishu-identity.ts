import type { FeishuUserCredential } from "./feishu-session.js";

export interface FeishuIdentity {
  openId: string;
  displayName?: string;
  avatarUrl?: string;
}

export interface FeishuIdentityVerifier {
  exchangeAuthorizationCode(code: string): Promise<FeishuIdentity>;
}

/**
 * Only the Join callback needs the short-lived user token. It is deliberately
 * separate from the normal identity interface so existing login callers keep
 * receiving credential-free identities.
 */
export interface FeishuIdentityWithAccessTokenVerifier extends FeishuIdentityVerifier {
  exchangeAuthorizationCodeWithAccessToken(code: string): Promise<FeishuIdentityWithAccessToken>;
  refreshUserCredential(refreshToken: string): Promise<FeishuUserCredential>;
}

export interface FeishuIdentityWithAccessToken {
  identity: FeishuIdentity;
  userAccessToken: string;
  credential: FeishuUserCredential;
}

export interface FeishuIdentityConfiguration {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export class FeishuIdentityExchangeError extends Error {
  constructor(readonly stage: "credential-exchange" | "user-info") {
    super("Feishu identity exchange failed.");
    this.name = "FeishuIdentityExchangeError";
  }
}

/**
 * The authorization code and user_access_token stay inside this server call.
 * The returned identity intentionally excludes every Feishu credential.
 */
export class HttpFeishuIdentityVerifier implements FeishuIdentityWithAccessTokenVerifier {
  constructor(
    private readonly configuration: FeishuIdentityConfiguration,
    private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {}

  async exchangeAuthorizationCode(code: string): Promise<FeishuIdentity> {
    return (await this.exchangeAuthorizationCodeWithAccessToken(code)).identity;
  }

  async exchangeAuthorizationCodeWithAccessToken(
    code: string,
  ): Promise<FeishuIdentityWithAccessToken> {
    const credential = await this.requestCredential({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.configuration.redirectUri,
    });

    const userResponse = await this.fetcher(
      "https://open.feishu.cn/open-apis/authen/v1/user_info",
      { headers: { authorization: `Bearer ${credential.accessToken}` } },
    );
    const userPayload: unknown = await readJson(userResponse);
    const identity = readIdentity(userPayload);
    if (!userResponse.ok || !identity) throw new FeishuIdentityExchangeError("user-info");
    return { identity, userAccessToken: credential.accessToken, credential };
  }

  async refreshUserCredential(refreshToken: string): Promise<FeishuUserCredential> {
    return this.requestCredential({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  private async requestCredential(grant: Record<string, string>): Promise<FeishuUserCredential> {
    const tokenResponse = await this.fetcher(
      "https://accounts.feishu.cn/oauth/v3/token",
      {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          ...grant,
          client_id: this.configuration.appId,
          client_secret: this.configuration.appSecret,
        }),
      },
    );
    const tokenPayload: unknown = await readJson(tokenResponse);
    const token = readTokenGrant(tokenPayload);
    if (!tokenResponse.ok || !token) throw new FeishuIdentityExchangeError("credential-exchange");
    const now = Date.now();
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      accessTokenExpiresAt: now + token.expiresInSeconds * 1_000,
      ...(token.refreshExpiresInSeconds ? { refreshTokenExpiresAt: now + token.refreshExpiresInSeconds * 1_000 } : {}),
    };
  }
}

export function readFeishuIdentityConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): FeishuIdentityConfiguration | undefined {
  const isLocalRealTenantValidation = environment.NODE_ENV !== "production"
    && environment.ECHO_INSIGHT_REAL_TENANT_DEV === "1";
  if (environment.NODE_ENV !== "production" && !isLocalRealTenantValidation) return undefined;
  const appId = environment.FEISHU_APP_ID?.trim();
  const appSecret = environment.FEISHU_APP_SECRET?.trim();
  if (!appId || !appSecret) return undefined;

  const redirectUri = (isLocalRealTenantValidation
    ? environment.ECHO_INSIGHT_REAL_TENANT_REDIRECT_URI
    : environment.FEISHU_IDENTITY_REDIRECT_URI)?.trim();
  if (!redirectUri) return undefined;
  try {
    new URL(redirectUri);
  } catch {
    return undefined;
  }
  return { appId, appSecret, redirectUri };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function readTokenGrant(value: unknown): {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshExpiresInSeconds?: number;
} | undefined {
  if (!isRecord(value) || value.code !== 0) return undefined;
  const token = isRecord(value.data) ? value.data : value;
  const accessToken = typeof token.access_token === "string" ? token.access_token.trim() : "";
  const refreshToken = typeof token.refresh_token === "string" ? token.refresh_token.trim() : "";
  const expiresInSeconds = typeof token.expires_in === "number" ? token.expires_in : 0;
  const refreshExpiresInSeconds = typeof token.refresh_expires_in === "number" ? token.refresh_expires_in : undefined;
  if (!accessToken || !refreshToken || !Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return undefined;
  return {
    accessToken,
    refreshToken,
    expiresInSeconds,
    ...(refreshExpiresInSeconds && Number.isFinite(refreshExpiresInSeconds) && refreshExpiresInSeconds > 0
      ? { refreshExpiresInSeconds }
      : {}),
  };
}

function readIdentity(value: unknown): FeishuIdentity | undefined {
  const data = isRecord(value) && value.code === 0 && isRecord(value.data)
    ? value.data
    : undefined;
  if (!data || typeof data.open_id !== "string" || !data.open_id.trim()) return undefined;
  return {
    openId: data.open_id.trim(),
    ...(typeof data.name === "string" && data.name.trim() ? { displayName: data.name.trim() } : {}),
    ...(typeof data.avatar_url === "string" && data.avatar_url.trim() ? { avatarUrl: data.avatar_url.trim() } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
