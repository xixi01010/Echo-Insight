import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  HttpFeishuResourceMembershipVerifier,
  HttpFeishuIdentityVerifier,
  FeishuIdentityExchangeError,
  InMemoryFeishuSessionStore,
  type FeishuIdentityWithAccessTokenVerifier,
  type FeishuResourceMembershipVerifier,
} from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import {
  FeishuProjectJoinService,
  JsonProjectDataSourceRegistry,
  ProjectJoinDeniedError,
} from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";

const environment = {
  NODE_ENV: "production",
  FEISHU_APP_ID: "cli_test_join",
  FEISHU_APP_SECRET: "test-app-secret-not-a-real-secret",
  FEISHU_IDENTITY_REDIRECT_URI: "https://echo-insight.example.test/api/auth/feishu/callback",
  FRONTEND_ORIGIN: "https://echo-insight.example.test",
} as NodeJS.ProcessEnv;

test("verified user-token access creates a Member and keeps tokens and Base identifiers out of API and Project JSON", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Shared project", creatorId: "creator-a", ownerId: "feishu:ou_owner",
  });
  await fixture.registry.registerFeishuBase(project.id, "source-shared", "bascnSharedResource");
  const checks: Array<{ token: string; baseToken: string }> = [];
  const server = createJoinServer(fixture, { verifyBaseViewAccess: async (token, baseToken) => {
    checks.push({ token, baseToken });
    return token === "user-access-token-b" && baseToken === "bascnSharedResource";
  } });
  context.after(() => closeServer(server));
  const origin = await listen(server);
  const userCookie = await login(origin, "login-b");

  const start = await beginJoin(origin, userCookie, "https://feishu.cn/base/bascnSharedResource?table=tblInternal");
  assert.equal(start.authorizationUrl.includes("bascnSharedResource"), false);
  assert.equal(new URL(start.authorizationUrl).searchParams.get("scope"), "docs:permission.member:auth");
  assert.match(start.setCookie, /HttpOnly/);
  assert.match(start.setCookie, /SameSite=Lax/);
  const callback = await completeJoin(origin, userCookie, start, "join-b");
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), `${environment.FRONTEND_ORIGIN}/projects/${project.id}`);
  assert.deepEqual(checks, [{ token: "user-access-token-b", baseToken: "bascnSharedResource" }]);
  assert.equal((await fixture.projectService.getMembership(project.id, "feishu:ou_user_b"))?.role, "member");

  const projects = await fetch(`${origin}/api/projects`, { headers: { cookie: userCookie } });
  const payload = await projects.text();
  assert.equal(projects.status, 200);
  assert.match(payload, /Shared project/);
  assert.equal(payload.includes("bascnSharedResource"), false);
  assert.equal(payload.includes("user-access-token-b"), false);
  const stored = await readFile(fixture.projectStorePath, "utf8");
  assert.equal(stored.includes("bascnSharedResource"), false);
  assert.equal(stored.includes("user-access-token-b"), false);
});

test("Join fails closed for missing session, denied access, identity mismatch, and state reuse", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Private", creatorId: "creator-a", ownerId: "feishu:ou_owner",
  });
  await fixture.registry.registerFeishuBase(project.id, "source-private", "bascnPrivateResource");
  const server = createJoinServer(fixture, { verifyBaseViewAccess: async () => false });
  context.after(() => closeServer(server));
  const origin = await listen(server);
  const missingSession = await fetch(`${origin}/api/projects/join`, {
    method: "POST", headers: { origin: environment.FRONTEND_ORIGIN ?? "", "content-type": "application/json" },
    body: JSON.stringify({ url: "https://feishu.cn/base/bascnPrivateResource" }),
  });
  assert.equal(missingSession.status, 503);

  const userCookie = await login(origin, "login-b");
  const deniedStart = await beginJoin(origin, userCookie, "https://feishu.cn/base/bascnPrivateResource");
  const denied = await completeJoin(origin, userCookie, deniedStart, "join-b");
  assert.equal(denied.status, 302);
  assert.equal(denied.headers.get("location"), `${environment.FRONTEND_ORIGIN}/projects?join=failed`);
  assert.equal((await fixture.projectService.getMembership(project.id, "feishu:ou_user_b")), null);
  assert.equal((await completeJoin(origin, userCookie, deniedStart, "join-b")).status, 401);

  const mismatchStart = await beginJoin(origin, userCookie, "https://feishu.cn/base/bascnPrivateResource");
  const mismatch = await completeJoin(origin, userCookie, mismatchStart, "join-a");
  assert.equal(mismatch.status, 302);
  assert.equal(mismatch.headers.get("location"), `${environment.FRONTEND_ORIGIN}/projects?join=failed`);
});

test("Base URLs only locate exactly one registered project and generic failures do not enumerate projects", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const projectA = await fixture.projectService.createProject({ name: "A", creatorId: "a", ownerId: "feishu:ou_owner" });
  const projectB = await fixture.projectService.createProject({ name: "B", creatorId: "b", ownerId: "feishu:ou_other" });
  await fixture.registry.registerFeishuBase(projectA.id, "source-a", "bascnAmbiguous");
  await fixture.registry.registerFeishuBase(projectB.id, "source-b", "bascnAmbiguous");
  const server = createJoinServer(fixture, { verifyBaseViewAccess: async () => true });
  context.after(() => closeServer(server));
  const origin = await listen(server);
  const userCookie = await login(origin, "login-b");

  for (const token of ["bascnUnknown", "bascnAmbiguous"]) {
    const response = await fetch(`${origin}/api/projects/join`, {
      method: "POST", headers: { origin: environment.FRONTEND_ORIGIN ?? "", cookie: userCookie, "content-type": "application/json" },
      body: JSON.stringify({ url: `https://feishu.cn/base/${token}` }),
    });
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.match(text, /PROJECT_JOIN_UNAVAILABLE/);
    assert.equal(text.includes(token), false);
    assert.equal(text.includes(projectA.id), false);
    assert.equal(text.includes(projectB.id), false);
  }
});

test("membership writes are idempotent, preserve Owner, and do not treat Creator as a fixed role", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Memberships", creatorId: "feishu:ou_creator", ownerId: "feishu:ou_owner", members: ["feishu:ou_member"],
  });
  await fixture.projectService.addMemberAfterVerifiedAccess(project.id, "feishu:ou_owner");
  await fixture.projectService.addMemberAfterVerifiedAccess(project.id, "feishu:ou_member");
  await fixture.projectService.addMemberAfterVerifiedAccess(project.id, "feishu:ou_creator");
  const persisted = await fixture.projectService.getProject(project.id, "feishu:ou_creator");
  assert.ok(persisted);
  assert.deepEqual(persisted.members.sort(), ["feishu:ou_creator", "feishu:ou_member"]);
  assert.equal((await fixture.projectService.getMembership(project.id, "feishu:ou_owner"))?.role, "owner");
  assert.equal((await fixture.projectService.getMembership(project.id, "feishu:ou_creator"))?.role, "member");
});

test("Join intents expire after ten minutes and cannot be consumed later", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({ name: "TTL", creatorId: "creator", ownerId: "feishu:ou_owner" });
  await fixture.registry.registerFeishuBase(project.id, "source-ttl", "bascnTtlResource");
  let clock = 0;
  const service = new FeishuProjectJoinService(
    fixture.projectService,
    fixture.registry,
    createIdentityVerifier(),
    { verifyBaseViewAccess: async () => true },
    { appId: "test", redirectUri: environment.FEISHU_IDENTITY_REDIRECT_URI ?? "" },
    () => clock,
    () => "join-ttl-state",
  );
  const authorization = await service.beginJoin({
    sessionId: "session-b", userId: "feishu:ou_user_b", baseUrl: "https://feishu.cn/base/bascnTtlResource",
  });
  clock = 10 * 60 * 1_000 + 1;
  await assert.rejects(service.completeJoin({
    state: authorization.state,
    cookieState: authorization.state,
    sessionId: "session-b",
    currentUserId: "feishu:ou_user_b",
    authorizationCode: "join-b",
  }), ProjectJoinDeniedError);
  assert.equal(service.hasRecordedState(authorization.state), false);
});

test("permission verifier uses only its supplied user token and fails closed for false or malformed responses", async () => {
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  const verified = new HttpFeishuResourceMembershipVerifier(async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ code: 0, data: { auth_result: true } }), { status: 200 });
  });
  assert.equal(await verified.verifyBaseViewAccess("user-access-token", "bascnResource"), true);
  assert.equal(requests[0]?.authorization, "Bearer user-access-token");
  assert.equal(requests[0]?.url.pathname, "/open-apis/drive/v1/permissions/bascnResource/members/auth");
  assert.equal(requests[0]?.url.searchParams.get("type"), "bitable");
  assert.equal(requests[0]?.url.searchParams.get("action"), "view");

  const denied = new HttpFeishuResourceMembershipVerifier(async () => (
    new Response(JSON.stringify({ code: 0, data: { auth_result: false } }), { status: 200 })
  ));
  const malformed = new HttpFeishuResourceMembershipVerifier(async () => new Response("not-json", { status: 200 }));
  assert.equal(await denied.verifyBaseViewAccess("user-token", "bascnResource"), false);
  assert.equal(await malformed.verifyBaseViewAccess("user-token", "bascnResource"), false);
});

test("authorization-code exchange rejects a tenant token and never treats it as a user token", async () => {
  let requests = 0;
  const verifier = new HttpFeishuIdentityVerifier({
    appId: "test-app", appSecret: "test-secret", redirectUri: environment.FEISHU_IDENTITY_REDIRECT_URI ?? "",
  }, async () => {
    requests += 1;
    return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-not-a-user-token" }), { status: 200 });
  });
  await assert.rejects(
    verifier.exchangeAuthorizationCodeWithAccessToken("join-code"),
    (error: unknown) => error instanceof FeishuIdentityExchangeError && error.stage === "credential-exchange",
  );
  assert.equal(requests, 1);
});

test("authorization-code exchange classifies a failed user-info lookup without returning its response", async () => {
  let requests = 0;
  const verifier = new HttpFeishuIdentityVerifier({
    appId: "test-app", appSecret: "test-secret", redirectUri: environment.FEISHU_IDENTITY_REDIRECT_URI ?? "",
  }, async () => {
    requests += 1;
    if (requests === 1) {
      return new Response(JSON.stringify({ code: 0, data: {
        access_token: "test-user-access-token", refresh_token: "test-refresh-token", expires_in: 7200,
      } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 99991663, msg: "not exposed" }), { status: 403 });
  });

  await assert.rejects(
    verifier.exchangeAuthorizationCodeWithAccessToken("join-code"),
    (error: unknown) => error instanceof FeishuIdentityExchangeError && error.stage === "user-info",
  );
  assert.equal(requests, 2);
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-feishu-join-"));
  const projectStorePath = join(directory, "projects.json");
  const dataSourceRegistryPath = join(directory, "data-sources.json");
  return {
    cleanup: () => rm(directory, { recursive: true, force: true }),
    projectStorePath,
    projectService: new ProjectService(new JsonProjectRepository(projectStorePath)),
    dataSourceRegistryPath,
    registry: new JsonProjectDataSourceRegistry(dataSourceRegistryPath),
  };
}

function createJoinServer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  membershipVerifier: FeishuResourceMembershipVerifier,
) {
  const identityVerifier = createIdentityVerifier();
  const projectJoinService = new FeishuProjectJoinService(
    fixture.projectService,
    fixture.registry,
    identityVerifier,
    membershipVerifier,
    { appId: environment.FEISHU_APP_ID ?? "", redirectUri: environment.FEISHU_IDENTITY_REDIRECT_URI ?? "" },
  );
  return createEchoInsightServer({
    environment,
    reader: {
      readProjectData: async () => {
        throw new Error("The sealed join test must not contact a project data source.");
      },
    },
    projectService: fixture.projectService,
    projectStorePath: fixture.projectStorePath,
    dataSourceRegistryPath: fixture.dataSourceRegistryPath,
    feishuSessionStore: new InMemoryFeishuSessionStore(),
    feishuIdentityVerifier: identityVerifier,
    projectJoinService,
  });
}

function createIdentityVerifier(): FeishuIdentityWithAccessTokenVerifier {
  const identityFor = (code: string) => {
    if (code.endsWith("-a")) return { openId: "ou_user_a", displayName: "User A" };
    if (code.endsWith("-b")) return { openId: "ou_user_b", displayName: "User B" };
    throw new Error("invalid test code");
  };
  return {
    exchangeAuthorizationCode: async (code) => identityFor(code),
    exchangeAuthorizationCodeWithAccessToken: async (code) => ({
      identity: identityFor(code),
      userAccessToken: code.endsWith("-b") ? "user-access-token-b" : "user-access-token-a",
      credential: {
        accessToken: code.endsWith("-b") ? "user-access-token-b" : "user-access-token-a",
        refreshToken: "join-refresh-token",
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1_000,
      },
    }),
    refreshUserCredential: async () => ({
      accessToken: "refreshed-user-access-token",
      refreshToken: "rotated-join-refresh-token",
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1_000,
    }),
  };
}

async function login(origin: string, code: string): Promise<string> {
  const start = await fetch(`${origin}/api/auth/feishu/start`, { redirect: "manual" });
  const cookie = requireCookie(start, "echo_insight_oauth_state");
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  assert.ok(state);
  const callback = await fetch(`${origin}/api/auth/feishu/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: { cookie }, redirect: "manual",
  });
  assert.equal(callback.status, 302);
  return requireCookie(callback, "echo_insight_session");
}

async function beginJoin(origin: string, sessionCookie: string, url: string) {
  const response = await fetch(`${origin}/api/projects/join`, {
    method: "POST", headers: { origin: environment.FRONTEND_ORIGIN ?? "", cookie: sessionCookie, "content-type": "application/json" }, body: JSON.stringify({ url }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { authorizationUrl: string };
  return {
    state: new URL(body.authorizationUrl).searchParams.get("state") ?? "",
    cookie: requireCookie(response, "echo_insight_join_oauth_state"),
    authorizationUrl: body.authorizationUrl,
    setCookie: response.headers.get("set-cookie") ?? "",
  };
}

function completeJoin(
  origin: string,
  sessionCookie: string,
  start: { state: string; cookie: string },
  code: string,
) {
  return fetch(`${origin}/api/auth/feishu/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(start.state)}`, {
    headers: { cookie: `${sessionCookie}; ${start.cookie}` }, redirect: "manual",
  });
}

function requireCookie(response: Response, name: string): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;]+)`, "u").exec(header);
  assert.ok(match);
  return `${name}=${match[1]}`;
}

async function listen(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${String(address.port)}`;
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
