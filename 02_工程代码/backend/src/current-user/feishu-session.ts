import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import type { AiProviderBundle } from "../../../ai-service/src/index.js";
import { CurrentUserContextUnavailableError, type CurrentUserContext, type CurrentUserContextProvider } from "./current-user-context.js";
import { compareFeishuIdentityRefs, type FeishuIdentityRef } from "./feishu-identity-reference.js";

export const FEISHU_SESSION_COOKIE = "echo_insight_session";
export const FEISHU_OAUTH_STATE_COOKIE = "echo_insight_oauth_state";
export const FEISHU_JOIN_OAUTH_STATE_COOKIE = "echo_insight_join_oauth_state";
const SESSION_LIFETIME_MS = 8 * 60 * 60 * 1_000;

/** Server-only OAuth material. It is intentionally absent from every public DTO. */
export interface FeishuUserCredential {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: number;
  refreshTokenExpiresAt?: number;
}

/**
 * Server-memory visitor AI connection. The bundle closes over the API key, so
 * the bundle itself must never be serialized. Only the encrypted account store
 * may persist the minimal provider configuration used to rebuild it.
 */
export interface FeishuSessionAiProvider {
  bundle: AiProviderBundle;
  version: string;
}

export interface FeishuSession {
  id: string;
  userId: string;
  identity: FeishuIdentityRef;
  expiresAt: number;
  displayName?: string;
  avatarUrl?: string;
  credential?: FeishuUserCredential;
  aiProvider?: FeishuSessionAiProvider;
  aiSetupSkipped?: boolean;
  /** Monotonic guard for overlapping connect, disconnect, and skip operations. */
  aiConfigurationRevision?: number;
}

export interface FeishuSessionStore {
  create(input: Omit<FeishuSession, "id" | "expiresAt">): FeishuSession;
  get(id: string): FeishuSession | undefined;
  updateCredential(id: string, credential: FeishuUserCredential): FeishuSession | undefined;
  clearCredential(id: string): void;
  setAiProvider(id: string, bundle: AiProviderBundle): FeishuSession | undefined;
  setAiProviderIfRevision(
    id: string,
    bundle: AiProviderBundle,
    expectedRevision: number,
  ): FeishuSession | undefined;
  setAiProviderForIdentityIfRevision(
    id: string,
    identity: FeishuIdentityRef,
    bundle: AiProviderBundle,
    version: string,
    expectedRevision: number,
  ): FeishuSession | undefined;
  setAiProviderForIdentity(
    identity: FeishuIdentityRef,
    bundle: AiProviderBundle,
    version: string,
  ): void;
  clearAiProvider(id: string): FeishuSession | undefined;
  clearAiProviderForIdentity(identity: FeishuIdentityRef): void;
  skipAiSetup(id: string): FeishuSession | undefined;
  delete(id: string): void;
}

/** A deliberately small, single-server session store for the competition runtime. */
export class InMemoryFeishuSessionStore implements FeishuSessionStore {
  private readonly sessions = new Map<string, FeishuSession>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();

  create(input: Omit<FeishuSession, "id" | "expiresAt">): FeishuSession {
    const session: FeishuSession = {
      ...input,
      id: randomUUID(),
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
      aiConfigurationRevision: 0,
    };
    this.sessions.set(session.id, session);
    const expiryTimer = setTimeout(() => this.delete(session.id), SESSION_LIFETIME_MS);
    expiryTimer.unref();
    this.expiryTimers.set(session.id, expiryTimer);
    return session;
  }

  get(id: string): FeishuSession | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.delete(id);
      return undefined;
    }
    return session;
  }

  updateCredential(id: string, credential: FeishuUserCredential): FeishuSession | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    session.credential = credential;
    return session;
  }

  clearCredential(id: string): void {
    const session = this.get(id);
    if (session) delete session.credential;
  }

  setAiProvider(id: string, bundle: AiProviderBundle): FeishuSession | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    return this.applyAiProvider(session, bundle);
  }

  setAiProviderIfRevision(
    id: string,
    bundle: AiProviderBundle,
    expectedRevision: number,
  ): FeishuSession | undefined {
    const session = this.get(id);
    if (!session || (session.aiConfigurationRevision ?? 0) !== expectedRevision) return undefined;
    return this.applyAiProvider(session, bundle);
  }

  setAiProviderForIdentityIfRevision(
    id: string,
    identity: FeishuIdentityRef,
    bundle: AiProviderBundle,
    version: string,
    expectedRevision: number,
  ): FeishuSession | undefined {
    const session = this.get(id);
    if (
      !session
      || compareFeishuIdentityRefs(session.identity, identity) !== "same"
      || (session.aiConfigurationRevision ?? 0) !== expectedRevision
    ) return undefined;
    this.setAiProviderForIdentity(identity, bundle, version);
    return this.get(id);
  }

  setAiProviderForIdentity(
    identity: FeishuIdentityRef,
    bundle: AiProviderBundle,
    version: string,
  ): void {
    for (const candidate of [...this.sessions.values()]) {
      const session = this.get(candidate.id);
      if (session && compareFeishuIdentityRefs(session.identity, identity) === "same") {
        this.applyAiProvider(session, bundle, version);
      }
    }
  }

  private applyAiProvider(
    session: FeishuSession,
    bundle: AiProviderBundle,
    version: string = randomUUID(),
  ): FeishuSession {
    session.aiProvider = { bundle, version };
    session.aiSetupSkipped = false;
    session.aiConfigurationRevision = (session.aiConfigurationRevision ?? 0) + 1;
    return session;
  }

  clearAiProvider(id: string): FeishuSession | undefined {
    const session = this.get(id);
    if (!session) return undefined;
    delete session.aiProvider;
    session.aiSetupSkipped = true;
    session.aiConfigurationRevision = (session.aiConfigurationRevision ?? 0) + 1;
    return session;
  }

  clearAiProviderForIdentity(identity: FeishuIdentityRef): void {
    for (const candidate of [...this.sessions.values()]) {
      const session = this.get(candidate.id);
      if (session && compareFeishuIdentityRefs(session.identity, identity) === "same") {
        this.clearAiProvider(session.id);
      }
    }
  }

  skipAiSetup(id: string): FeishuSession | undefined {
    return this.clearAiProvider(id);
  }

  delete(id: string): void {
    this.sessions.delete(id);
    const expiryTimer = this.expiryTimers.get(id);
    if (expiryTimer) clearTimeout(expiryTimer);
    this.expiryTimers.delete(id);
  }
}

export class FeishuCurrentUserContextProvider implements CurrentUserContextProvider {
  constructor(private readonly sessions: FeishuSessionStore) {}

  async getCurrentUser(request: IncomingMessage): Promise<CurrentUserContext> {
    const session = this.sessions.get(readCookie(request, FEISHU_SESSION_COOKIE) ?? "");
    if (!session) throw new CurrentUserContextUnavailableError();
    return { userId: session.userId, source: "feishu", identity: session.identity, sessionId: session.id };
  }
}

export function toFeishuUserId(openId: string): string {
  const normalized = openId.trim();
  if (!normalized) throw new CurrentUserContextUnavailableError();
  return `feishu:${normalized}`;
}

export function readCookie(request: IncomingMessage, name: string): string | undefined {
  const cookie = request.headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=") || undefined;
  }
  return undefined;
}

export function createSessionCookie(session: FeishuSession, secure: boolean): string {
  return [
    `${FEISHU_SESSION_COOKIE}=${encodeURIComponent(session.id)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1_000))}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  return [
    `${FEISHU_SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function createOAuthStateCookie(state: string, secure: boolean): string {
  return [
    `${FEISHU_OAUTH_STATE_COOKIE}=${encodeURIComponent(state)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=600",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function clearOAuthStateCookie(secure: boolean): string {
  return [
    `${FEISHU_OAUTH_STATE_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}

export function createJoinOAuthStateCookie(state: string, secure: boolean): string {
  return createStateCookie(FEISHU_JOIN_OAUTH_STATE_COOKIE, state, secure, 600);
}

export function clearJoinOAuthStateCookie(secure: boolean): string {
  return createStateCookie(FEISHU_JOIN_OAUTH_STATE_COOKIE, "", secure, 0);
}

function createStateCookie(name: string, value: string, secure: boolean, maxAge: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
