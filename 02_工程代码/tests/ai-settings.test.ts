import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AiProviderBundle } from "../ai-service/src/index.js";
import {
  FeishuCurrentUserContextProvider,
  InMemoryFeishuSessionStore,
  InMemoryVisitorAiAccountStore,
  JsonVisitorAiAccountStore,
  toFeishuOpenIdIdentityRef,
} from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import {
  isServerAiProviderConfigured,
  readAiAccessMode,
} from "../backend/src/routes/ai-settings.js";

const FRONTEND_ORIGIN = "https://echo-insight.example.com";
const USER_ID = "feishu:ou_ai_settings_user";

test("production defaults to visitor AI access while local setup can explicitly use server mode", () => {
  assert.equal(readAiAccessMode({}), "visitor");
  assert.equal(readAiAccessMode({ NODE_ENV: "production" }), "visitor");
  assert.equal(readAiAccessMode({ NODE_ENV: "test" }), "visitor");
  assert.equal(readAiAccessMode({ NODE_ENV: "production", ECHO_INSIGHT_AI_ACCESS_MODE: "server" }), "server");
  assert.throws(() => readAiAccessMode({ ECHO_INSIGHT_AI_ACCESS_MODE: "shared" }));
  assert.equal(isServerAiProviderConfigured({ AI_PROVIDER: "deepseek" }), false);
  assert.equal(isServerAiProviderConfigured({ AI_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "test-key" }), true);
});

test("visitor AI settings bind a verified provider to one encrypted account record without returning its key", async (context) => {
  const sessions = new InMemoryFeishuSessionStore();
  const accounts = new InMemoryVisitorAiAccountStore();
  const session = createSession(sessions);
  const receivedEnvironments: NodeJS.ProcessEnv[] = [];
  let verificationCount = 0;
  const server = createEchoInsightServer({
    environment: visitorEnvironment(),
    allowedFrontendOrigin: FRONTEND_ORIGIN,
    currentUserContextProvider: new FeishuCurrentUserContextProvider(sessions),
    feishuSessionStore: sessions,
    visitorAiAccountStore: accounts,
    aiProviderBundleFactory: (environment) => {
      receivedEnvironments.push(environment);
      return fakeBundle(environment.AI_PROVIDER === "qwen" ? "qwen" : "deepseek");
    },
    verifyVisitorAiProviderBundle: async () => { verificationCount += 1; },
  });
  const baseUrl = await listen(server);
  context.after(() => server.close());

  const unauthenticated = await fetch(`${baseUrl}/api/settings/ai`);
  assert.equal(unauthenticated.status, 401);
  const initialStatus = await fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${session.id}` },
  });
  assert.equal(initialStatus.status, 200);
  assert.equal(
    (await initialStatus.json() as Record<string, unknown>).storage,
    "server-session-memory",
  );
  assert.equal(receivedEnvironments.length, 0);

  const secret = "test-only-visitor-key-never-returned";
  const connected = await fetch(`${baseUrl}/api/settings/ai?storage-contract=account-v1`, {
    method: "PUT",
    headers: requestHeaders(session.id),
    body: JSON.stringify({ providerId: "qwen", apiKey: secret }),
  });
  const connectedText = await connected.text();
  const connectedBody = JSON.parse(connectedText) as Record<string, unknown>;

  assert.equal(connected.status, 200);
  assert.equal(connectedBody.configured, true);
  assert.equal(connectedBody.setupRequired, false);
  assert.equal(connectedBody.providerId, "qwen");
  assert.equal(connectedBody.storage, "server-account-encrypted");
  assert.equal(connectedText.includes(secret), false);
  assert.equal(verificationCount, 1);
  assert.equal(receivedEnvironments.length, 1);
  assert.equal(receivedEnvironments[0]?.DASHSCOPE_API_KEY, secret);
  assert.equal(sessions.get(session.id)?.aiProvider?.bundle.providerId, "qwen");

  const status = await fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${session.id}` },
  });
  const statusText = await status.text();
  assert.equal(status.status, 200);
  assert.equal(statusText.includes(secret), false);
  assert.equal(JSON.parse(statusText).storage, "server-session-memory");

  const disconnected = await fetch(`${baseUrl}/api/settings/ai?storage-contract=account-v1`, {
    method: "DELETE",
    headers: requestHeaders(session.id),
  });
  const disconnectedBody = await disconnected.json() as Record<string, unknown>;
  assert.equal(disconnected.status, 200);
  assert.equal(disconnectedBody.configured, false);
  assert.equal(disconnectedBody.setupRequired, false);
  assert.equal(sessions.get(session.id)?.aiProvider, undefined);

  const secondSession = sessions.create({
    userId: "feishu:ou_second_ai_user",
    identity: toFeishuOpenIdIdentityRef("ou_second_ai_user", "cli_test_app"),
  });
  const secondSecret = "test-only-second-session-key";
  const secondConnected = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(secondSession.id),
    body: JSON.stringify({ providerId: "deepseek", apiKey: secondSecret }),
  });
  assert.equal(secondConnected.status, 200);
  const firstBundle = fakeBundle("qwen");
  sessions.setAiProvider(session.id, firstBundle);
  const sessionOneBundle = sessions.get(session.id)?.aiProvider?.bundle;
  const sessionTwoBundle = sessions.get(secondSession.id)?.aiProvider?.bundle;
  assert.ok(sessionOneBundle && sessionTwoBundle);
  assert.notEqual(sessionOneBundle, sessionTwoBundle);
  assert.deepEqual((await sessionOneBundle.riskAnalyzer.analyze({} as never)).limitations, ["qwen"]);
  assert.deepEqual((await sessionTwoBundle.riskAnalyzer.analyze({} as never)).limitations, ["deepseek"]);

  for (let request = 1; request <= 11; request += 1) {
    await sessionTwoBundle.riskAnalyzer.analyze({} as never);
  }
  await assert.rejects(
    sessionTwoBundle.riskAnalyzer.analyze({} as never),
    /rate limited/u,
  );

  const reconnected = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(secondSession.id),
    body: JSON.stringify({ providerId: "qwen", apiKey: secondSecret }),
  });
  assert.equal(reconnected.status, 200);
  const reconnectedBundle = sessions.get(secondSession.id)?.aiProvider?.bundle;
  assert.ok(reconnectedBundle);
  await assert.rejects(
    reconnectedBundle.riskAnalyzer.analyze({} as never),
    /rate limited/u,
  );

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: requestHeaders(secondSession.id),
  });
  assert.equal(logout.status, 200);
  assert.equal(sessions.get(secondSession.id), undefined);
});

test("visitor AI settings restore by Feishu account across logout and devices while isolating other accounts", async (context) => {
  const sessions = new InMemoryFeishuSessionStore();
  const accounts = new InMemoryVisitorAiAccountStore();
  const firstSession = createSession(sessions);
  let verificationCount = 0;
  let failNextVerification = false;
  const server = createEchoInsightServer({
    environment: visitorEnvironment(),
    allowedFrontendOrigin: FRONTEND_ORIGIN,
    currentUserContextProvider: new FeishuCurrentUserContextProvider(sessions),
    feishuSessionStore: sessions,
    visitorAiAccountStore: accounts,
    aiProviderBundleFactory: (environment) => fakeBundle(
      environment.AI_PROVIDER === "qwen" ? "qwen" : "deepseek",
    ),
    verifyVisitorAiProviderBundle: async () => {
      verificationCount += 1;
      if (failNextVerification) {
        failNextVerification = false;
        throw new Error("test-only replacement failure");
      }
    },
  });
  const baseUrl = await listen(server);
  context.after(() => server.close());

  const firstSecret = "test-only-account-a-key";
  const connected = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(firstSession.id),
    body: JSON.stringify({ providerId: "qwen", apiKey: firstSecret }),
  });
  assert.equal(connected.status, 200);

  const secondDevice = createSession(sessions);
  const restoredOnSecondDevice = await fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${secondDevice.id}` },
  });
  const secondDeviceText = await restoredOnSecondDevice.text();
  assert.equal(restoredOnSecondDevice.status, 200);
  assert.equal(JSON.parse(secondDeviceText).providerId, "qwen");
  assert.equal(secondDeviceText.includes(firstSecret), false);
  assert.equal(verificationCount, 1);
  assert.strictEqual(
    sessions.get(firstSession.id)?.aiProvider?.bundle,
    sessions.get(secondDevice.id)?.aiProvider?.bundle,
  );
  const sharedBundle = sessions.get(secondDevice.id)?.aiProvider?.bundle;
  assert.ok(sharedBundle);
  for (let request = 0; request < 12; request += 1) {
    const activeBundle = request % 2 === 0
      ? sessions.get(firstSession.id)?.aiProvider?.bundle
      : sessions.get(secondDevice.id)?.aiProvider?.bundle;
    assert.ok(activeBundle);
    await activeBundle.riskAnalyzer.analyze({} as never);
  }
  await assert.rejects(
    sharedBundle.riskAnalyzer.analyze({} as never),
    /rate limited for this account/u,
  );

  failNextVerification = true;
  const failedReplacement = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(secondDevice.id),
    body: JSON.stringify({ providerId: "deepseek", apiKey: "test-only-invalid-replacement" }),
  });
  assert.equal(failedReplacement.status, 422);
  assert.equal((await accounts.find(firstSession.identity))?.providerId, "qwen");
  assert.equal(sessions.get(firstSession.id)?.aiProvider?.bundle.providerId, "qwen");

  const otherUser = createSessionFor(sessions, "ou_ai_settings_other_user");
  const otherInitial = await fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${otherUser.id}` },
  });
  const otherInitialBody = await otherInitial.json() as Record<string, unknown>;
  assert.equal(otherInitialBody.configured, false);
  assert.equal(otherInitialBody.setupRequired, true);

  const otherConnected = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(otherUser.id),
    body: JSON.stringify({ providerId: "deepseek", apiKey: "test-only-account-b-key" }),
  });
  assert.equal(otherConnected.status, 200);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: requestHeaders(secondDevice.id),
  });
  assert.equal(logout.status, 200);
  assert.equal(sessions.get(secondDevice.id), undefined);

  const returnedSession = createSession(sessions);
  const restoredAfterLogout = await fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${returnedSession.id}` },
  });
  const returnedBody = await restoredAfterLogout.json() as Record<string, unknown>;
  assert.equal(returnedBody.configured, true);
  assert.equal(returnedBody.providerId, "qwen");

  const disconnected = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "DELETE",
    headers: requestHeaders(returnedSession.id),
  });
  assert.equal(disconnected.status, 200);
  assert.equal(sessions.get(firstSession.id)?.aiProvider, undefined);
  assert.equal(sessions.get(returnedSession.id)?.aiProvider, undefined);
  assert.equal((await accounts.find(firstSession.identity)), undefined);
  assert.equal(sessions.get(otherUser.id)?.aiProvider?.bundle.providerId, "deepseek");

  const afterDeletion = createSession(sessions);
  const afterDeletionStatus = await fetch(`${baseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${afterDeletion.id}` },
  });
  const afterDeletionBody = await afterDeletionStatus.json() as Record<string, unknown>;
  assert.equal(afterDeletionBody.configured, false);
  assert.equal(afterDeletionBody.setupRequired, true);
});

test("visitor AI settings restore after a backend restart from the encrypted runtime store", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-ai-restart-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "visitor-ai-accounts.json");
  const masterKey = Buffer.alloc(32, 19);
  const firstSessions = new InMemoryFeishuSessionStore();
  const firstSession = createSession(firstSessions);
  const firstServer = createEchoInsightServer({
    environment: visitorEnvironment(),
    allowedFrontendOrigin: FRONTEND_ORIGIN,
    currentUserContextProvider: new FeishuCurrentUserContextProvider(firstSessions),
    feishuSessionStore: firstSessions,
    visitorAiAccountStore: new JsonVisitorAiAccountStore(filePath, masterKey),
    aiProviderBundleFactory: (environment) => fakeBundle(
      environment.AI_PROVIDER === "qwen" ? "qwen" : "deepseek",
    ),
    verifyVisitorAiProviderBundle: async () => undefined,
  });
  const firstBaseUrl = await listen(firstServer);
  const secret = "test-only-restart-key";
  const connected = await fetch(`${firstBaseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(firstSession.id),
    body: JSON.stringify({ providerId: "qwen", apiKey: secret }),
  });
  assert.equal(connected.status, 200);
  await close(firstServer);

  const restartedSessions = new InMemoryFeishuSessionStore();
  const restartedSession = createSession(restartedSessions);
  const restartedServer = createEchoInsightServer({
    environment: visitorEnvironment(),
    allowedFrontendOrigin: FRONTEND_ORIGIN,
    currentUserContextProvider: new FeishuCurrentUserContextProvider(restartedSessions),
    feishuSessionStore: restartedSessions,
    visitorAiAccountStore: new JsonVisitorAiAccountStore(filePath, masterKey),
    aiProviderBundleFactory: (environment) => fakeBundle(
      environment.AI_PROVIDER === "qwen" ? "qwen" : "deepseek",
    ),
    verifyVisitorAiProviderBundle: async () => {
      throw new Error("restore must not make a billable verification request");
    },
  });
  const restartedBaseUrl = await listen(restartedServer);
  context.after(() => restartedServer.close());

  const restored = await fetch(`${restartedBaseUrl}/api/settings/ai`, {
    headers: { Cookie: `echo_insight_session=${restartedSession.id}` },
  });
  const restoredText = await restored.text();
  assert.equal(restored.status, 200);
  assert.equal(JSON.parse(restoredText).providerId, "qwen");
  assert.equal(restoredText.includes(secret), false);
});

test("disconnect wins over an older in-flight visitor AI connection verification", async (context) => {
  const sessions = new InMemoryFeishuSessionStore();
  const accounts = new InMemoryVisitorAiAccountStore();
  const session = createSession(sessions);
  let releaseVerification: (() => void) | undefined;
  let markVerificationStarted: (() => void) | undefined;
  const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
  const verificationReleased = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const server = createEchoInsightServer({
    environment: visitorEnvironment(),
    allowedFrontendOrigin: FRONTEND_ORIGIN,
    currentUserContextProvider: new FeishuCurrentUserContextProvider(sessions),
    feishuSessionStore: sessions,
    visitorAiAccountStore: accounts,
    aiProviderBundleFactory: () => fakeBundle("deepseek"),
    verifyVisitorAiProviderBundle: async () => {
      markVerificationStarted?.();
      await verificationReleased;
    },
  });
  const baseUrl = await listen(server);
  context.after(() => server.close());

  const connecting = fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(session.id),
    body: JSON.stringify({ providerId: "deepseek", apiKey: "test-race-key" }),
  });
  await verificationStarted;
  const disconnected = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "DELETE",
    headers: requestHeaders(session.id),
  });
  assert.equal(disconnected.status, 200);
  releaseVerification?.();

  const staleConnection = await connecting;
  assert.equal(staleConnection.status, 409);
  assert.equal(sessions.get(session.id)?.aiProvider, undefined);
  assert.equal(sessions.get(session.id)?.aiSetupSkipped, true);
  assert.equal(await accounts.find(session.identity), undefined);
});

test("visitor AI settings reject cross-origin writes, unsupported custom endpoints, and failed verification", async (context) => {
  const sessions = new InMemoryFeishuSessionStore();
  const accounts = new InMemoryVisitorAiAccountStore();
  const session = createSession(sessions);
  let factoryCount = 0;
  const server = createEchoInsightServer({
    environment: visitorEnvironment(),
    allowedFrontendOrigin: FRONTEND_ORIGIN,
    currentUserContextProvider: new FeishuCurrentUserContextProvider(sessions),
    feishuSessionStore: sessions,
    visitorAiAccountStore: accounts,
    aiProviderBundleFactory: (environment) => {
      factoryCount += 1;
      return fakeBundle(environment.AI_PROVIDER === "qwen" ? "qwen" : "deepseek");
    },
    verifyVisitorAiProviderBundle: async () => { throw new Error("test-only failure"); },
  });
  const baseUrl = await listen(server);
  context.after(() => server.close());

  const crossOrigin = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: {
      ...requestHeaders(session.id),
      Origin: "https://attacker.example.com",
    },
    body: JSON.stringify({ providerId: "deepseek", apiKey: "test-key" }),
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal(factoryCount, 0);

  const custom = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(session.id),
    body: JSON.stringify({
      providerId: "openai-compatible",
      apiKey: "test-key",
      endpoint: "http://127.0.0.1/internal",
    }),
  });
  assert.equal(custom.status, 400);
  assert.equal(factoryCount, 0);

  const failed = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(session.id),
    body: JSON.stringify({ providerId: "deepseek", apiKey: "test-key" }),
  });
  assert.equal(failed.status, 422);
  assert.equal(factoryCount, 1);
  assert.equal(sessions.get(session.id)?.aiProvider, undefined);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const retry = await fetch(`${baseUrl}/api/settings/ai`, {
      method: "PUT",
      headers: requestHeaders(session.id),
      body: JSON.stringify({ providerId: "deepseek", apiKey: "test-key" }),
    });
    assert.equal(retry.status, 422);
  }
  const rateLimited = await fetch(`${baseUrl}/api/settings/ai`, {
    method: "PUT",
    headers: requestHeaders(session.id),
    body: JSON.stringify({ providerId: "deepseek", apiKey: "test-key" }),
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(factoryCount, 3);
});

test("production legacy report endpoints are unavailable before any shared AI provider can run", async (context) => {
  let reportCallCount = 0;
  const server = createEchoInsightServer({
    environment: { NODE_ENV: "production", ECHO_INSIGHT_AI_ACCESS_MODE: "visitor" },
    reportService: {
      createProjectReport: async () => {
        reportCallCount += 1;
        throw new Error("must not run");
      },
    } as never,
  });
  const baseUrl = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`${baseUrl}/api/project-report`);
  assert.equal(response.status, 404);
  assert.equal(reportCallCount, 0);
});

function createSession(sessions: InMemoryFeishuSessionStore) {
  return sessions.create({
    userId: USER_ID,
    identity: toFeishuOpenIdIdentityRef("ou_ai_settings_user", "cli_test_app"),
    displayName: "AI Settings Test User",
  });
}

function createSessionFor(
  sessions: InMemoryFeishuSessionStore,
  openId: string,
  applicationId = "cli_test_app",
) {
  return sessions.create({
    userId: `feishu:${openId}`,
    identity: toFeishuOpenIdIdentityRef(openId, applicationId),
  });
}

function visitorEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    ECHO_INSIGHT_AI_ACCESS_MODE: "visitor",
    FRONTEND_ORIGIN,
  };
}

function requestHeaders(sessionId: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Cookie: `echo_insight_session=${sessionId}`,
    Origin: FRONTEND_ORIGIN,
  };
}

function fakeBundle(providerId: "deepseek" | "qwen"): AiProviderBundle {
  return {
    providerId,
    displayName: providerId === "qwen" ? "Qwen (DashScope)" : "DeepSeek",
    model: providerId === "qwen" ? "qwen3.8-flash" : "deepseek-v4-flash",
    modelAdapter: {
      invoke: async () => ({
        model: "test-model",
        response: "{\"connected\":true}",
        latency: 1,
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        timestamp: "2026-09-05T00:00:00.000Z",
      }),
    },
    riskAnalyzer: { analyze: async () => ({ risks: [], limitations: [providerId] }) },
    globalSynthesizer: { synthesize: async () => ({ summary: "", priorities: [], limitations: [] }) },
  };
}

async function listen(server: ReturnType<typeof createEchoInsightServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function close(server: ReturnType<typeof createEchoInsightServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
