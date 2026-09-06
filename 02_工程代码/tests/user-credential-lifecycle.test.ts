import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  FeishuSessionUserCredentialProvider,
  FeishuUserCredentialUnavailableError,
  HttpFeishuIdentityVerifier,
  InMemoryFeishuSessionStore,
  toFeishuOpenIdIdentityRef,
  type FeishuIdentityWithAccessTokenVerifier,
  type FeishuUserCredential,
} from "../backend/src/current-user/index.js";
import { createBaseBackedProjectIntelligenceProvider } from "../backend/src/intelligence/index.js";
import {
  JsonProjectDataSourceRegistry,
} from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import type { FeishuApiClient, StandardProjectData } from "../feishu-connector/src/index.js";

const NOW = new Date("2026-08-31T00:00:00.000Z").getTime();
const identity = toFeishuOpenIdIdentityRef("ou_user", "cli_echo");

test("OAuth exchange stores refreshable server-only material and refresh rotates it", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const verifier = new HttpFeishuIdentityVerifier({
    appId: "cli_echo", appSecret: "not-a-real-secret", redirectUri: "https://echo.example.test/callback",
  }, async (input, init) => {
    const url = String(input);
    if (url.includes("oauth/v3/token")) {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const refresh = requests.length === 2;
      return new Response(JSON.stringify({
        code: 0,
        access_token: refresh ? "access-rotated" : "access-initial",
        refresh_token: refresh ? "refresh-rotated" : "refresh-initial",
        expires_in: 3600,
        refresh_expires_in: 7200,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data: { open_id: "ou_user", name: "User" } }), { status: 200 });
  });

  const authorization = await verifier.exchangeAuthorizationCodeWithAccessToken("one-time-code");
  const refreshed = await verifier.refreshUserCredential(authorization.credential.refreshToken);

  assert.equal(authorization.identity.openId, "ou_user");
  assert.equal(authorization.userAccessToken, authorization.credential.accessToken);
  assert.equal(refreshed.accessToken, "access-rotated");
  assert.equal(refreshed.refreshToken, "refresh-rotated");
  assert.deepEqual(requests.map((request) => request.grant_type), ["authorization_code", "refresh_token"]);
  assert.equal(JSON.stringify(authorization.identity).includes("access-"), false);
});

test("credential provider refreshes once, rotates the session credential, and fails closed", async () => {
  let now = NOW;
  let refreshes = 0;
  let releaseRefresh: (() => void) | undefined;
  const waitForRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const store = new InMemoryFeishuSessionStore();
  const session = store.create({
    userId: "feishu:ou_user",
    identity,
    credential: credential("access-expired", "refresh-initial", now - 1),
  });
  const verifier: FeishuIdentityWithAccessTokenVerifier = {
    exchangeAuthorizationCode: async () => ({ openId: "ou_user" }),
    exchangeAuthorizationCodeWithAccessToken: async () => ({ identity: { openId: "ou_user" }, userAccessToken: "unused", credential: credential("unused", "unused", now + 1_000) }),
    refreshUserCredential: async () => {
      refreshes += 1;
      await waitForRefresh;
      return credential("access-rotated", "refresh-rotated", now + 3_600_000);
    },
  };
  const provider = new FeishuSessionUserCredentialProvider(store, verifier, () => now);
  const subject = { userId: "feishu:ou_user", identity, sessionId: session.id };

  const first = provider.getUserAccessToken(subject);
  const second = provider.getUserAccessToken(subject);
  await Promise.resolve();
  assert.equal(refreshes, 1);
  releaseRefresh?.();
  assert.deepEqual(await Promise.all([first, second]), ["access-rotated", "access-rotated"]);
  assert.equal(store.get(session.id)?.credential?.refreshToken, "refresh-rotated");
  assert.equal(await provider.getUserAccessToken(subject), "access-rotated");
  assert.equal(refreshes, 1);

  store.get(session.id)!.credential = credential("access-expired-again", "refresh-invalid", now - 1);
  const failingProvider = new FeishuSessionUserCredentialProvider(store, {
    ...verifier,
    refreshUserCredential: async () => { throw new Error("raw credential error"); },
  }, () => now);
  await assert.rejects(failingProvider.getUserAccessToken(subject), FeishuUserCredentialUnavailableError);
  assert.equal(store.get(session.id)?.credential, undefined);
  const logoutSession = store.create({
    userId: "feishu:ou_user",
    identity,
    credential: credential("access-before-logout", "refresh-before-logout", now + 3_600_000),
  });
  const logoutSubject = { userId: "feishu:ou_user", identity, sessionId: logoutSession.id };
  assert.equal(await provider.getUserAccessToken(logoutSubject), "access-before-logout");
  store.delete(logoutSession.id);
  await assert.rejects(provider.getUserAccessToken(logoutSubject), FeishuUserCredentialUnavailableError);
  session.expiresAt = now - 1;
  await assert.rejects(provider.getUserAccessToken(subject), FeishuUserCredentialUnavailableError);
});

test("Task and Minutes use only the current user credential after FND-03 allows the explicit resources", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  await fixture.registry.registerFeishuBase(fixture.project.id, "source-base", "base-private");
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-task", publicId: "task-public", locator: { kind: "feishu-task", taskIds: ["task-explicit"] } });
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-minutes", publicId: "minutes-public", locator: { kind: "feishu-minutes", minuteToken: "minute-explicit" } });
  await fixture.projectService.replaceDataSourceRefs(fixture.project.id, ["source-base", "source-task", "source-minutes"]);

  const store = new InMemoryFeishuSessionStore();
  const session = store.create({ userId: "feishu:ou_user", identity, credential: credential("user-reader-token", "refresh-reader", NOW + 3_600_000) });
  const credentials = new FeishuSessionUserCredentialProvider(store, stableVerifier(), () => NOW);
  const requests: Array<{ name: string; request: unknown; options: unknown }> = [];
  const client = {
    task: { v1: { task: { get: async (request: unknown, options: unknown) => {
      requests.push({ name: "task", request, options });
      return { code: 0, data: { task: { id: "task-explicit", summary: "Explicit task" } } };
    } } } },
    minutes: { v1: {
      minute: {
        get: async (request: unknown, options: unknown) => {
          requests.push({ name: "minutes-meta", request, options });
          return { code: 0, data: { minute: { token: "minute-explicit", title: "Explicit minute" } } };
        },
        artifacts: async (request: unknown, options: unknown) => {
          requests.push({ name: "minutes-artifacts", request, options });
          return { code: 0, data: {} };
        },
      },
      minuteTranscript: { get: async (request: unknown, options: unknown) => {
        requests.push({ name: "minutes-transcript", request, options });
        return { getReadableStream: async function* () { yield "safe transcript"; } };
      } },
    } },
  } as unknown as FeishuApiClient;
  const provider = createBaseBackedProjectIntelligenceProvider(
    fixture.projectService,
    fixture.registry,
    { readProjectData: async () => baseData() },
    client,
    { check: () => ({ sourceAuthorization: "authorized", subjectEligibility: "allowed" }) },
    credentials,
  );

  const output = await provider(fixture.project.id, { userId: "feishu:ou_user", identity, sessionId: session.id });
  assert.deepEqual(requests.map((item) => item.name), ["task", "minutes-meta", "minutes-transcript", "minutes-artifacts"]);
  assert.equal(JSON.stringify(requests.map((item) => item.request)).includes("task-explicit"), true);
  assert.equal(JSON.stringify(requests.map((item) => item.request)).includes("minute-explicit"), true);
  assert.equal(requests.every((item) => hasUserToken(item.options, "user-reader-token")), true);
  assert.equal(JSON.stringify(output).includes("user-reader-token"), false);
  assert.equal(JSON.stringify(output).includes("refresh-reader"), false);
  assert.equal(JSON.stringify(fixture.registry.listForProject(fixture.project.id)).includes("user-reader-token"), false);
  assert.equal(JSON.stringify(fixture.registry.listForProject(fixture.project.id)).includes("refresh-reader"), false);
});

test("an invalid user token refreshes and retries one explicit Task read once", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  await fixture.registry.registerFeishuBase(fixture.project.id, "source-base", "base-private");
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-task", publicId: "task-public", locator: { kind: "feishu-task", taskIds: ["task-explicit"] } });
  await fixture.projectService.replaceDataSourceRefs(fixture.project.id, ["source-base", "source-task"]);
  const store = new InMemoryFeishuSessionStore();
  const session = store.create({ userId: "feishu:ou_user", identity, credential: credential("token-before-retry", "refresh-before-retry", NOW + 3_600_000) });
  let refreshes = 0;
  const credentials = new FeishuSessionUserCredentialProvider(store, {
    ...stableVerifier(),
    refreshUserCredential: async () => { refreshes += 1; return credential("token-after-retry", "refresh-after-retry", NOW + 3_600_000); },
  }, () => NOW);
  const options: unknown[] = [];
  let calls = 0;
  const client = {
    task: { v1: { task: { get: async (_request: unknown, requestOptions: unknown) => {
      options.push(requestOptions); calls += 1;
      return calls === 1 ? { code: 99991668 } : { code: 0, data: { task: { id: "task-explicit" } } };
    } } } },
  } as unknown as FeishuApiClient;
  const provider = createBaseBackedProjectIntelligenceProvider(
    fixture.projectService, fixture.registry, { readProjectData: async () => baseData() }, client,
    { check: () => ({ sourceAuthorization: "authorized", subjectEligibility: "allowed" }) }, credentials,
  );
  await provider(fixture.project.id, { userId: "feishu:ou_user", identity, sessionId: session.id });
  assert.equal(calls, 2);
  assert.equal(refreshes, 1);
  assert.equal(hasUserToken(options[0], "token-before-retry"), true);
  assert.equal(hasUserToken(options[1], "token-after-retry"), true);
});

test("Docs uses the current user credential only after its explicit document probe allows it", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  await fixture.registry.registerFeishuBase(fixture.project.id, "source-base", "base-private");
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-doc", publicId: "doc-public", locator: { kind: "feishu-docs", documentToken: "document-explicit" } });
  await fixture.projectService.replaceDataSourceRefs(fixture.project.id, ["source-base", "source-doc"]);
  const store = new InMemoryFeishuSessionStore();
  const session = store.create({ userId: "feishu:ou_user", identity, credential: credential("docs-user-token", "docs-refresh", NOW + 3_600_000) });
  const credentials = new FeishuSessionUserCredentialProvider(store, stableVerifier(), () => NOW);
  const calls: Array<{ name: string; options: unknown }> = [];
  const client = { docx: { v1: {
    document: { get: async (_request: unknown, options: unknown) => {
      calls.push({ name: "document", options });
      return { code: 0, data: { document: { document_id: "document-explicit", title: "Explicit document" } } };
    } },
    documentBlock: { list: async (_request: unknown, options: unknown) => {
      calls.push({ name: "blocks", options });
      return { code: 0, data: { items: [] } };
    } },
  } } } as unknown as FeishuApiClient;
  const provider = createBaseBackedProjectIntelligenceProvider(
    fixture.projectService, fixture.registry, { readProjectData: async () => baseData() }, client, undefined, credentials,
  );

  const output = await provider(fixture.project.id, { userId: "feishu:ou_user", identity, sessionId: session.id });
  assert.deepEqual(calls.map((call) => call.name), ["document", "document", "blocks"]);
  assert.equal(calls.every((call) => hasUserToken(call.options, "docs-user-token")), true);
  assert.equal(JSON.stringify(output).includes("docs-user-token"), false);
});

test("FND-03 proves the current user can read one configured Calendar event before the Reader runs", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  await fixture.registry.registerFeishuBase(fixture.project.id, "source-base", "base-private");
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-calendar", publicId: "calendar-public", locator: { kind: "feishu-calendar", calendarId: "calendar-explicit", eventIds: ["event-explicit"] } });
  await fixture.projectService.replaceDataSourceRefs(fixture.project.id, ["source-base", "source-calendar"]);

  const store = new InMemoryFeishuSessionStore();
  const session = store.create({ userId: "feishu:ou_user", identity, credential: credential("calendar-user-token", "calendar-refresh", NOW + 3_600_000) });
  const credentials = new FeishuSessionUserCredentialProvider(store, stableVerifier(), () => NOW);
  const calls: Array<{ request: unknown; options: unknown }> = [];
  const client = { calendar: { v4: { calendarEvent: { get: async (request: unknown, options: unknown) => {
    calls.push({ request, options });
    return { code: 0, data: { event: { event_id: "event-explicit", summary: "Explicit event" } } };
  } } } } } as unknown as FeishuApiClient;
  const provider = createBaseBackedProjectIntelligenceProvider(
    fixture.projectService, fixture.registry, { readProjectData: async () => baseData() }, client, undefined, credentials,
  );

  const output = await provider(fixture.project.id, { userId: "feishu:ou_user", identity, sessionId: session.id });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.request), [
    { path: { calendar_id: "calendar-explicit", event_id: "event-explicit" }, params: { need_attendee: false, user_id_type: "open_id" } },
    { path: { calendar_id: "calendar-explicit", event_id: "event-explicit" }, params: { need_attendee: true, user_id_type: "open_id" } },
  ]);
  assert.equal(calls.every((call) => hasUserToken(call.options, "calendar-user-token")), true);
  assert.equal(JSON.stringify(output).includes("calendar-user-token"), false);
});

function credential(accessToken: string, refreshToken: string, accessTokenExpiresAt: number): FeishuUserCredential {
  return { accessToken, refreshToken, accessTokenExpiresAt, refreshTokenExpiresAt: NOW + 7_200_000 };
}

function stableVerifier(): FeishuIdentityWithAccessTokenVerifier {
  return {
    exchangeAuthorizationCode: async () => ({ openId: "ou_user" }),
    exchangeAuthorizationCodeWithAccessToken: async () => ({ identity: { openId: "ou_user" }, userAccessToken: "unused", credential: credential("unused", "unused", NOW + 3_600_000) }),
    refreshUserCredential: async () => credential("unused-refresh", "unused-refresh-token", NOW + 3_600_000),
  };
}

function hasUserToken(options: unknown, token: string): boolean {
  if (!isRecord(options) || !isRecord(options.lark)) return false;
  const larkOptions = options.lark as Record<PropertyKey, unknown>;
  return Object.getOwnPropertySymbols(larkOptions).some((symbol) => larkOptions[symbol] === token);
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "echo-user-credential-"));
  const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")), () => new Date(NOW), () => "project-user-credential");
  const project = await projectService.createProject({ name: "Credential Project", creatorId: "feishu:ou_user", ownerId: "feishu:ou_user" });
  return {
    project,
    projectService,
    registry: new JsonProjectDataSourceRegistry(join(directory, "sources.json")),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function baseData(): StandardProjectData {
  return {
    project: { id: "base-private", name: "Credential Project", source: "feishu-base" },
    tasks: [],
    metadata: { baseToken: "base-private", tableCount: 0, recordCount: 0, retrievedAt: new Date(NOW).toISOString(), accessMode: "read-only", tables: [] },
  };
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
