import type { ProjectDataSourceSubject } from "../project-context/project-data-source-visibility.js";
import type { FeishuIdentityWithAccessTokenVerifier } from "./feishu-identity.js";
import type { FeishuSessionStore } from "./feishu-session.js";

const REFRESH_AHEAD_MS = 60_000;

export class FeishuUserCredentialUnavailableError extends Error {
  constructor() {
    super("A current Feishu user credential is unavailable.");
    this.name = "FeishuUserCredentialUnavailableError";
  }
}

/** Resolves a session-scoped credential and serializes refresh-token rotation per session. */
export class FeishuSessionUserCredentialProvider {
  private readonly pendingRefreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly sessions: FeishuSessionStore,
    private readonly verifier: FeishuIdentityWithAccessTokenVerifier,
    private readonly now: () => number = Date.now,
  ) {}

  async getUserAccessToken(subject: ProjectDataSourceSubject, forceRefresh = false): Promise<string> {
    const sessionId = subject.sessionId;
    if (!sessionId) throw new FeishuUserCredentialUnavailableError();
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== subject.userId || !session.credential) {
      throw new FeishuUserCredentialUnavailableError();
    }
    if (!forceRefresh && this.isUsable(session.credential.accessTokenExpiresAt)) {
      return session.credential.accessToken;
    }
    return this.refresh(sessionId, subject.userId, forceRefresh);
  }

  private async refresh(sessionId: string, userId: string, forceRefresh: boolean): Promise<string> {
    const existing = this.pendingRefreshes.get(sessionId);
    if (existing) return existing;
    const refresh = this.refreshSession(sessionId, userId, forceRefresh);
    this.pendingRefreshes.set(sessionId, refresh);
    try {
      return await refresh;
    } finally {
      this.pendingRefreshes.delete(sessionId);
    }
  }

  private async refreshSession(sessionId: string, userId: string, forceRefresh: boolean): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId || !session.credential) {
      throw new FeishuUserCredentialUnavailableError();
    }
    if (!forceRefresh && this.isUsable(session.credential.accessTokenExpiresAt)) return session.credential.accessToken;
    if (session.credential.refreshTokenExpiresAt && session.credential.refreshTokenExpiresAt <= this.now()) {
      this.sessions.clearCredential(sessionId);
      throw new FeishuUserCredentialUnavailableError();
    }
    try {
      const credential = await this.verifier.refreshUserCredential(session.credential.refreshToken);
      if (!credential.accessToken || !credential.refreshToken || credential.accessTokenExpiresAt <= this.now()) {
        throw new FeishuUserCredentialUnavailableError();
      }
      const updated = this.sessions.updateCredential(sessionId, credential);
      if (!updated || updated.userId !== userId) throw new FeishuUserCredentialUnavailableError();
      return credential.accessToken;
    } catch {
      this.sessions.clearCredential(sessionId);
      throw new FeishuUserCredentialUnavailableError();
    }
  }

  private isUsable(expiresAt: number): boolean {
    return expiresAt > this.now() + REFRESH_AHEAD_MS;
  }
}
