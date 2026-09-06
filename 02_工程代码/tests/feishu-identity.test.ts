import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  compareFeishuIdentityRefs,
  createFeishuIdentityRef,
  InMemoryFeishuSessionStore,
  readFeishuIdentityConfiguration,
  toFeishuOpenIdIdentityRef,
  type FeishuIdentityWithAccessTokenVerifier,
} from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import { FEISHU_USER_IDENTITY_SCOPES } from "../backend/src/routes/auth.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";

const environment = {
  NODE_ENV: "production",
  FEISHU_APP_ID: "cli_test_identity",
  FEISHU_APP_SECRET: "test-app-secret-not-a-real-secret",
  FEISHU_IDENTITY_REDIRECT_URI: "https://echo-insight.example.test/api/auth/feishu/callback",
  FRONTEND_ORIGIN: "https://echo-insight.example.test",
} as NodeJS.ProcessEnv;

test("local real-tenant OAuth is opt-in and production never uses its redirect setting", () => {
  const base = {
    FEISHU_APP_ID: "cli_test_identity",
    FEISHU_APP_SECRET: "test-app-secret-not-a-real-secret",
    ECHO_INSIGHT_REAL_TENANT_REDIRECT_URI: "http://localhost:3000/api/auth/feishu/callback",
  } as NodeJS.ProcessEnv;
  assert.equal(readFeishuIdentityConfiguration({ ...base, NODE_ENV: "development" }), undefined);
  assert.deepEqual(
    readFeishuIdentityConfiguration({ ...base, NODE_ENV: "development", ECHO_INSIGHT_REAL_TENANT_DEV: "1" }),
    { appId: "cli_test_identity", appSecret: "test-app-secret-not-a-real-secret", redirectUri: "http://localhost:3000/api/auth/feishu/callback" },
  );
  assert.equal(readFeishuIdentityConfiguration({ ...base, NODE_ENV: "production" }), undefined);
});

test("production V2 APIs fail closed until a Feishu session is established", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const server = createIdentityServer(fixture);
  context.after(() => closeServer(server));
  const origin = await listen(server);

  const response = await fetch(`${origin}/api/projects`);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("test-app-secret"), false);
});

test("Feishu open_id maps to a scoped user and a session never exposes tokens", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  await fixture.projectService.createProject({
    name: "User A Project", creatorId: "creator-a", ownerId: "feishu:ou_user_a",
  });
  const sessions = new InMemoryFeishuSessionStore();
  const server = createIdentityServer(fixture, sessions);
  context.after(() => closeServer(server));
  const origin = await listen(server);

  const login = await exchange(origin, "code-for-user-a");
  assert.equal(login.response.status, 302);
  assert.equal(login.response.headers.get("location"), environment.FRONTEND_ORIGIN);
  const cookie = requireCookie(login.response);
  const sessionHeader = login.response.headers.get("set-cookie") ?? "";
  assert.match(sessionHeader, /HttpOnly/);
  assert.match(sessionHeader, /SameSite=Lax/);
  assert.match(sessionHeader, /Secure/);
  const session = sessions.get(decodeURIComponent(cookie.split("=")[1] ?? ""));
  assert.deepEqual(session?.identity, {
    type: "open_id",
    value: "ou_user_a",
    context: { applicationId: environment.FEISHU_APP_ID },
  });
  assert.equal(session?.credential?.accessToken, "test-user-access-token-a");
  assert.equal(session?.credential?.refreshToken, "test-refresh-token-a");

  const projects = await fetch(`${origin}/api/projects`, { headers: { cookie } });
  assert.equal(projects.status, 200);
  assertSingleProject(await projects.json(), "User A Project", "owner");

  const projectJson = await readFile(fixture.projectStorePath, "utf8");
  assert.equal(projectJson.includes("access_token"), false);
  assert.equal(projectJson.includes("refresh_token"), false);
  assert.equal(projectJson.includes("test-user-access-token-a"), false);
  assert.equal(projectJson.includes("test-refresh-token-a"), false);
  assert.equal(projectJson.includes("test-app-secret"), false);

  const status = await fetch(`${origin}/api/auth/status`, { headers: { cookie } });
  const statusBody = await status.text();
  assert.equal(statusBody.includes("ou_user_a"), false);
  assert.equal(statusBody.includes("open_id"), false);
  assert.equal(statusBody.includes(environment.FEISHU_APP_ID ?? ""), false);
  assert.equal(statusBody.includes("test-user-access-token-a"), false);
  assert.equal(statusBody.includes("test-refresh-token-a"), false);
});

test("typed Feishu identities compare only with matching identity type and context", () => {
  const openId = toFeishuOpenIdIdentityRef(" ou_same ", "echo-insight-app");
  const sameOpenId = createFeishuIdentityRef({
    type: "open_id", value: "ou_same", context: { applicationId: "echo-insight-app" },
  });
  const differentOpenId = createFeishuIdentityRef({
    type: "open_id", value: "ou_other", context: { applicationId: "echo-insight-app" },
  });
  const userIdWithSameValue = createFeishuIdentityRef({
    type: "user_id", value: "ou_same", context: { applicationId: "echo-insight-app" },
  });
  const unionIdWithSameValue = createFeishuIdentityRef({
    type: "union_id", value: "ou_same", context: { applicationId: "echo-insight-app" },
  });
  const otherApplication = createFeishuIdentityRef({
    type: "open_id", value: "ou_same", context: { applicationId: "other-app" },
  });

  assert.deepEqual(openId, sameOpenId);
  assert.equal(compareFeishuIdentityRefs(openId, sameOpenId), "same");
  assert.equal(compareFeishuIdentityRefs(openId, differentOpenId), "different");
  assert.equal(compareFeishuIdentityRefs(openId, userIdWithSameValue), "unknown");
  assert.equal(compareFeishuIdentityRefs(openId, unionIdWithSameValue), "unknown");
  assert.equal(compareFeishuIdentityRefs(openId, otherApplication), "unknown");
});

test("Feishu users, project authorization, and sessions stay isolated", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const userAProject = await fixture.projectService.createProject({
    name: "User A Project", creatorId: "creator-a", ownerId: "feishu:ou_user_a",
  });
  const userBProject = await fixture.projectService.createProject({
    name: "User B Project", creatorId: "creator-b", ownerId: "feishu:ou_user_b",
  });
  const server = createIdentityServer(fixture);
  context.after(() => closeServer(server));
  const origin = await listen(server);

  const userACookie = requireCookie((await exchange(origin, "code-for-user-a")).response);
  const userBCookie = requireCookie((await exchange(origin, "code-for-user-b")).response);
  const [projectsA, projectsB] = await Promise.all([
    fetch(`${origin}/api/projects`, { headers: { cookie: userACookie } }),
    fetch(`${origin}/api/projects`, { headers: { cookie: userBCookie } }),
  ]);
  assertSingleProject(await projectsA.json(), "User A Project", "owner");
  assertSingleProject(await projectsB.json(), "User B Project", "owner");

  const denied = await fetch(`${origin}/api/projects/${userBProject.id}`, {
    headers: { cookie: userACookie },
  });
  assert.equal(denied.status, 404);
  const allowed = await fetch(`${origin}/api/projects/${userAProject.id}`, {
    headers: { cookie: userACookie },
  });
  assert.equal(allowed.status, 200);
});

test("logout invalidates the Feishu session and production rejects development identity", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const server = createIdentityServer(fixture);
  context.after(() => closeServer(server));
  const origin = await listen(server);
  const cookie = requireCookie((await exchange(origin, "code-for-user-a")).response);

  const logout = await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: { cookie, origin: environment.FRONTEND_ORIGIN ?? "" },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie") ?? "", /Max-Age=0/);
  const afterLogout = await fetch(`${origin}/api/projects`, { headers: { cookie } });
  assert.equal(afterLogout.status, 503);

  const productionWithDevUser = createEchoInsightServer({
    environment: { NODE_ENV: "production", ECHO_INSIGHT_DEV_USER_ID: "forbidden" },
    projectService: fixture.projectService,
  });
  context.after(() => closeServer(productionWithDevUser));
  const devOrigin = await listen(productionWithDevUser);
  assert.equal((await fetch(`${devOrigin}/api/projects`)).status, 503);
});

test("production write endpoints require the configured same origin", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const server = createIdentityServer(fixture);
  context.after(() => closeServer(server));
  const origin = await listen(server);

  const blocked = await fetch(`${origin}/api/auth/logout`, {
    method: "POST",
    headers: { origin: "https://attacker.example.test" },
  });
  assert.equal(blocked.status, 403);
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-feishu-identity-"));
  const projectStorePath = join(directory, "projects.json");
  const dataSourceRegistryPath = join(directory, "data-sources.json");
  const projectService = new ProjectService(new JsonProjectRepository(projectStorePath));
  return {
    cleanup: () => rm(directory, { recursive: true, force: true }),
    projectService,
    projectStorePath,
    dataSourceRegistryPath,
  };
}

function createIdentityServer(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  feishuSessionStore = new InMemoryFeishuSessionStore(),
) {
  return createEchoInsightServer({
    environment,
    reader: {
      readProjectData: async () => {
        throw new Error("The sealed identity test must not read project data.");
      },
    },
    projectService: fixture.projectService,
    projectStorePath: fixture.projectStorePath,
    dataSourceRegistryPath: fixture.dataSourceRegistryPath,
    feishuSessionStore,
    feishuIdentityVerifier: mockIdentityVerifier,
  });
}

const mockIdentityVerifier: FeishuIdentityWithAccessTokenVerifier = {
  exchangeAuthorizationCode: async (code) => {
    if (code === "code-for-user-a") return { openId: "ou_user_a", displayName: "User A" };
    if (code === "code-for-user-b") return { openId: "ou_user_b", displayName: "User B" };
    throw new Error("invalid test code");
  },
  exchangeAuthorizationCodeWithAccessToken: async (code) => {
    const identity = await mockIdentityVerifier.exchangeAuthorizationCode(code);
    const suffix = identity.openId.endsWith("user_a") ? "a" : "b";
    return {
      identity,
      userAccessToken: `test-user-access-token-${suffix}`,
      credential: {
        accessToken: `test-user-access-token-${suffix}`,
        refreshToken: `test-refresh-token-${suffix}`,
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1_000,
        refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1_000,
      },
    };
  },
  refreshUserCredential: async () => ({
    accessToken: "test-refreshed-user-access-token",
    refreshToken: "test-rotated-refresh-token",
    accessTokenExpiresAt: Date.now() + 60 * 60 * 1_000,
  }),
};

async function exchange(origin: string, code: string) {
  const start = await fetch(`${origin}/api/auth/feishu/start`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const stateCookie = requireCookie(start);
  const authorizationUrl = new URL(start.headers.get("location") ?? "");
  const state = authorizationUrl.searchParams.get("state");
  assert.ok(state);
  assert.equal(authorizationUrl.searchParams.get("scope"), FEISHU_USER_IDENTITY_SCOPES.join(" "));
  const response = await fetch(`${origin}/api/auth/feishu/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`, {
    headers: { cookie: stateCookie },
    redirect: "manual",
  });
  return { response };
}

function requireCookie(response: Response): string {
  const header = response.headers.get("set-cookie") ?? "";
  const match = /(?:^|,\s*)(echo_insight_session|echo_insight_oauth_state)=([^;]+)/u.exec(header);
  assert.ok(match);
  return `${match[1]}=${match[2]}`;
}

function assertSingleProject(value: unknown, name: string, currentUserRole: "owner"): void {
  assert.ok(isRecord(value));
  assert.ok(Array.isArray(value.projects));
  assert.equal(value.projects.length, 1);
  const project = value.projects[0];
  assert.ok(isRecord(project));
  assert.equal(project.name, name);
  assert.equal(project.currentUserRole, currentUserRole);
  assert.equal(typeof project.id, "string");
  assert.equal(typeof project.createdAt, "string");
  assert.equal(typeof project.updatedAt, "string");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
