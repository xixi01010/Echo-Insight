import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

import {
  clearOAuthStateCookie,
  clearJoinOAuthStateCookie,
  clearSessionCookie,
  createOAuthStateCookie,
  createSessionCookie,
  CurrentUserContextUnavailableError,
  FeishuIdentityExchangeError,
  type CurrentUserContextProvider,
  type FeishuIdentityVerifier,
  type FeishuIdentityWithAccessTokenVerifier,
  type FeishuSessionStore,
  readCookie,
  toFeishuOpenIdIdentityRef,
  toFeishuUserId,
  FEISHU_OAUTH_STATE_COOKIE,
  FEISHU_JOIN_OAUTH_STATE_COOKIE,
  FEISHU_SESSION_COOKIE,
} from "../current-user/index.js";
import { type FeishuProjectJoinService } from "../project-context/index.js";

export interface AuthRouteDependencies {
  getCurrentUserContextProvider: () => CurrentUserContextProvider | undefined;
  getIdentityVerifier: () => FeishuIdentityVerifier | undefined;
  getSessionStore: () => FeishuSessionStore | undefined;
  getProjectJoinService?: () => FeishuProjectJoinService | undefined;
  feishuAppId?: string;
  feishuRedirectUri?: string;
  frontendOrigin?: string;
  secureCookies: boolean;
}

export const FEISHU_USER_IDENTITY_SCOPES = [
  "offline_access",
  "im:chat:readonly",
  "im:message:readonly",
  "task:task:readonly",
  "minutes:minutes.basic:read",
  "minutes:minutes.transcript:export",
  "minutes:minutes.artifacts:read",
  "docx:document:readonly",
  "wiki:wiki:readonly",
  "drive:drive.metadata:readonly",
  "calendar:calendar:readonly",
  "calendar:calendar.event:read",
] as const;

export function isAuthApiPath(pathname: string): boolean {
  return pathname === "/api/auth/status"
    || pathname === "/api/auth/feishu/start"
    || pathname === "/api/auth/feishu/callback"
    || pathname === "/api/auth/logout";
}

export function createAuthRoute(dependencies: AuthRouteDependencies) {
  const pendingStates = new Map<string, number>();
  return async (request: IncomingMessage, response: ServerResponse, requestUrl: URL): Promise<void> => {
    if (requestUrl.pathname === "/api/auth/status" && request.method === "GET") {
      await sendStatus(request, response, dependencies);
      return;
    }
    if (requestUrl.pathname === "/api/auth/feishu/start" && request.method === "GET") {
      startFeishuAuthorization(response, dependencies, pendingStates);
      return;
    }
    if (requestUrl.pathname === "/api/auth/feishu/callback" && request.method === "GET") {
      await completeFeishuAuthorization(request, response, requestUrl, dependencies, pendingStates);
      return;
    }
    if (requestUrl.pathname === "/api/auth/logout" && request.method === "POST") {
      logout(request, response, dependencies);
      return;
    }
    sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method is not supported for this route." } });
  };
}

async function sendStatus(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AuthRouteDependencies,
): Promise<void> {
  const provider = dependencies.getCurrentUserContextProvider();
  if (!provider) {
    sendJson(response, 200, unauthenticatedStatus(dependencies));
    return;
  }
  try {
    const currentUser = await provider.getCurrentUser(request);
    const session = dependencies.getSessionStore()?.get(
      readCookie(request, FEISHU_SESSION_COOKIE) ?? "",
    );
    sendJson(response, 200, {
      authenticated: true,
      ...(currentUser.source === "development-fixed"
        ? { mode: "development" }
        : { mode: "feishu", user: safeDisplay(session) }),
    });
  } catch (error) {
    if (error instanceof CurrentUserContextUnavailableError) {
      sendJson(response, 200, unauthenticatedStatus(dependencies));
      return;
    }
    sendJson(response, 503, { error: { code: "AUTH_STATUS_UNAVAILABLE", message: "Authentication status is unavailable." } });
  }
}

function startFeishuAuthorization(
  response: ServerResponse,
  dependencies: AuthRouteDependencies,
  pendingStates: Map<string, number>,
): void {
  if (!isCredentialVerifier(dependencies.getIdentityVerifier()) || !dependencies.feishuAppId || !dependencies.feishuRedirectUri) {
    sendJson(response, 503, { error: { code: "FEISHU_IDENTITY_UNAVAILABLE", message: "Feishu identity is unavailable." } });
    return;
  }
  const state = randomUUID();
  pendingStates.set(state, Date.now() + 10 * 60 * 1_000);
  response.setHeader("set-cookie", createOAuthStateCookie(state, dependencies.secureCookies));
  const authorizationUrl = new URL("https://accounts.feishu.cn/open-apis/authen/v1/authorize");
  authorizationUrl.searchParams.set("client_id", dependencies.feishuAppId);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", dependencies.feishuRedirectUri);
  authorizationUrl.searchParams.set("scope", FEISHU_USER_IDENTITY_SCOPES.join(" "));
  authorizationUrl.searchParams.set("state", state);
  response.writeHead(302, { location: authorizationUrl.toString() });
  response.end();
}

async function completeFeishuAuthorization(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  dependencies: AuthRouteDependencies,
  pendingStates: Map<string, number>,
): Promise<void> {
  const state = requestUrl.searchParams.get("state")?.trim();
  const joinService = dependencies.getProjectJoinService?.();
  if (joinService?.hasRecordedState(state)) {
    await completeFeishuProjectJoin(request, response, requestUrl, dependencies, joinService);
    return;
  }

  const verifier = dependencies.getIdentityVerifier();
  const sessions = dependencies.getSessionStore();
  if (!isCredentialVerifier(verifier) || !sessions || !dependencies.frontendOrigin || !dependencies.feishuAppId) {
    sendJson(response, 503, { error: { code: "FEISHU_IDENTITY_UNAVAILABLE", message: "Feishu identity is unavailable." } });
    return;
  }
  try {
    const code = requestUrl.searchParams.get("code")?.trim();
    const cookieState = readCookie(request, FEISHU_OAUTH_STATE_COOKIE);
    const stateExpiry = state ? pendingStates.get(state) : undefined;
    if (!code || !state || !cookieState || state !== cookieState || !stateExpiry || stateExpiry <= Date.now()) {
      throw new Error("invalid authorization callback");
    }
    pendingStates.delete(state);
    const authorization = await verifier.exchangeAuthorizationCodeWithAccessToken(code);
    const session = sessions.create({
      userId: toFeishuUserId(authorization.identity.openId),
      identity: toFeishuOpenIdIdentityRef(authorization.identity.openId, dependencies.feishuAppId),
      credential: authorization.credential,
      ...(authorization.identity.displayName ? { displayName: authorization.identity.displayName } : {}),
      ...(authorization.identity.avatarUrl ? { avatarUrl: authorization.identity.avatarUrl } : {}),
    });
    response.setHeader("set-cookie", [
      createSessionCookie(session, dependencies.secureCookies),
      clearOAuthStateCookie(dependencies.secureCookies),
    ]);
    response.writeHead(302, { location: dependencies.frontendOrigin });
    response.end();
  } catch (error) {
    response.setHeader("set-cookie", clearOAuthStateCookie(dependencies.secureCookies));
    sendJson(response, 401, {
      error: {
        code: error instanceof FeishuIdentityExchangeError
          ? error.stage === "credential-exchange"
            ? "FEISHU_CREDENTIAL_EXCHANGE_FAILED"
            : "FEISHU_USER_INFO_FAILED"
          : "FEISHU_IDENTITY_FAILED",
        message: "Unable to verify Feishu identity.",
      },
    });
  }
}

function isCredentialVerifier(
  verifier: FeishuIdentityVerifier | undefined,
): verifier is FeishuIdentityWithAccessTokenVerifier {
  return Boolean(
    verifier
    && "exchangeAuthorizationCodeWithAccessToken" in verifier
    && typeof verifier.exchangeAuthorizationCodeWithAccessToken === "function"
    && "refreshUserCredential" in verifier
    && typeof verifier.refreshUserCredential === "function",
  );
}

async function completeFeishuProjectJoin(
  request: IncomingMessage,
  response: ServerResponse,
  requestUrl: URL,
  dependencies: AuthRouteDependencies,
  joinService: FeishuProjectJoinService,
): Promise<void> {
  const frontendOrigin = dependencies.frontendOrigin;
  try {
    const state = requestUrl.searchParams.get("state")?.trim();
    const code = requestUrl.searchParams.get("code")?.trim();
    const provider = dependencies.getCurrentUserContextProvider();
    if (!state || !code || !provider || !frontendOrigin) throw new Error("join callback unavailable");
    const currentUser = await provider.getCurrentUser(request);
    const project = await joinService.completeJoin({
      state,
      cookieState: readCookie(request, FEISHU_JOIN_OAUTH_STATE_COOKIE),
      sessionId: readCookie(request, FEISHU_SESSION_COOKIE),
      currentUserId: currentUser.userId,
      authorizationCode: code,
    });
    response.setHeader("set-cookie", clearJoinOAuthStateCookie(dependencies.secureCookies));
    response.writeHead(302, {
      location: `${frontendOrigin}/projects/${encodeURIComponent(project.id)}`,
    });
    response.end();
  } catch {
    response.setHeader("set-cookie", clearJoinOAuthStateCookie(dependencies.secureCookies));
    if (frontendOrigin) {
      response.writeHead(302, { location: `${frontendOrigin}/projects?join=failed` });
      response.end();
      return;
    }
    sendJson(response, 401, { error: { code: "PROJECT_JOIN_FAILED", message: "Unable to join project." } });
  }
}

function logout(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: AuthRouteDependencies,
): void {
  const sessionId = readCookie(request, FEISHU_SESSION_COOKIE);
  if (sessionId) dependencies.getSessionStore()?.delete(sessionId);
  response.setHeader("set-cookie", clearSessionCookie(dependencies.secureCookies));
  sendJson(response, 200, { authenticated: false });
}

function unauthenticatedStatus(dependencies: AuthRouteDependencies) {
  return {
    authenticated: false,
    ...(dependencies.feishuAppId ? { mode: "feishu" } : {}),
  };
}

function safeDisplay(session: { displayName?: string; avatarUrl?: string } | undefined) {
  return {
    ...(session?.displayName ? { displayName: session.displayName } : {}),
    ...(session?.avatarUrl ? { avatarUrl: session.avatarUrl } : {}),
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
