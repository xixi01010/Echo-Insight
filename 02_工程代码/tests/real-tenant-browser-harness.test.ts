import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { CurrentUserContextUnavailableError, toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import {
  createRealTenantValidationRoute,
  describeCalendarFailure,
  describeCalendarResponse,
  isRealTenantValidationEnabled,
  type RealTenantValidationReport,
} from "../backend/src/routes/real-tenant-validation.js";

const subject = {
  userId: "feishu:ou_real_user",
  source: "feishu" as const,
  sessionId: "server-only-session",
  identity: toFeishuOpenIdIdentityRef("ou_real_user", "cli_echo"),
};

test("browser harness is absent without the explicit local validation flag and in production", () => {
  assert.equal(isRealTenantValidationEnabled({ NODE_ENV: "development" }), false);
  assert.equal(isRealTenantValidationEnabled({ NODE_ENV: "production", ECHO_INSIGHT_REAL_TENANT_DEV: "1" }), false);
  assert.equal(isRealTenantValidationEnabled({ NODE_ENV: "development", ECHO_INSIGHT_REAL_TENANT_DEV: "1" }), true);
});

test("Calendar development diagnostics expose only response shape, never token values", () => {
  const shape = describeCalendarResponse({
    code: 0,
    data: { calendar_list: [{ calendar_id: "calendar-private-id" }], has_more: true, page_token: "cursor-secret", access_token: "must-not-appear" },
    access_token: "must-not-appear",
  }, "calendar_list");
  assert.deepEqual(shape, {
    kind: "response",
    topLevelKeys: ["code", "data"],
    dataKeys: ["calendar_list", "has_more"],
    itemCount: 1,
    hasMore: true,
    hasPageToken: true,
    apiCode: 0,
  });
  assert.equal(JSON.stringify(shape).includes("must-not-appear"), false);
  assert.equal(JSON.stringify(shape).includes("calendar-private-id"), false);
  assert.equal(JSON.stringify(shape).includes("cursor-secret"), false);
});

test("Calendar development diagnostics expose only numeric API failure metadata", () => {
  const shape = describeCalendarFailure({
    code: "ERR_BAD_REQUEST",
    message: "must-not-appear",
    response: {
      status: 400,
      data: { code: 99991663, msg: "must-not-appear", error: { field_violations: [{ field: "page_size", description: "must-not-appear" }] }, access_token: "must-not-appear" },
    },
  });
  assert.deepEqual(shape, {
    kind: "thrown",
    topLevelKeys: ["code", "message", "response"],
    apiCode: 99991663,
    httpStatus: 400,
    violationFields: ["page_size"],
  });
  assert.equal(JSON.stringify(shape).includes("must-not-appear"), false);
});

test("browser harness rejects an unauthenticated request before any validation run", async (context) => {
  let runs = 0;
  const server = createHarnessServer({
    getCurrentUserContextProvider: () => ({ getCurrentUser: async () => { throw new CurrentUserContextUnavailableError(); } }),
    run: async () => { runs += 1; return report(); },
  });
  context.after(() => close(server));
  const origin = await listen(server);
  const response = await fetch(`${origin}/api/review/real-tenant/run`, { method: "POST" });
  assert.equal(response.status, 401);
  assert.equal(runs, 0);
  assert.equal((await response.text()).includes("token"), false);
});

test("authenticated browser run keeps current OAuth identity server-side and isolates one failed Source", async (context) => {
  let receivedUserId = "";
  const server = createHarnessServer({
    getCurrentUserContextProvider: () => ({ getCurrentUser: async () => subject }),
    run: async (current) => {
      receivedUserId = current.userId;
      return report();
    },
  });
  context.after(() => close(server));
  const origin = await listen(server);
  const response = await fetch(`${origin}/api/review/real-tenant/run`, { method: "POST" });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal(receivedUserId, "feishu:ou_real_user");
  assert.equal(body.includes("server-only-session"), false);
  assert.equal(body.includes("user-access-token"), false);
  assert.equal(body.includes("refresh-token"), false);
  assert.equal(body.includes("full message"), false);
  const parsed = JSON.parse(body) as RealTenantValidationReport;
  assert.equal(parsed.project.currentUserRole, "owner");
  assert.equal(parsed.sources.some((source) => source.source === "chat" && source.readerStatus === "failure"), true);
  assert.equal(parsed.sources.some((source) => source.source === "base" && source.readerStatus === "success"), true);
});

test("credential failure remains fail-closed and does not invoke the run", async (context) => {
  let runs = 0;
  const server = createHarnessServer({
    getCurrentUserContextProvider: () => ({ getCurrentUser: async () => subject }),
    getUserCredentialProvider: () => ({ getUserAccessToken: async () => { throw new Error("raw credential failure"); } }),
    run: async () => { runs += 1; return report(); },
  });
  context.after(() => close(server));
  const origin = await listen(server);
  const response = await fetch(`${origin}/api/review/real-tenant/run`, { method: "POST" });
  assert.equal(response.status, 503);
  assert.equal(runs, 0);
  assert.equal((await response.text()).includes("raw credential failure"), false);
});

function createHarnessServer(overrides: Partial<Parameters<typeof createRealTenantValidationRoute>[0]>) {
  const route = createRealTenantValidationRoute({
    getCurrentUserContextProvider: () => ({ getCurrentUser: async () => subject }),
    getUserCredentialProvider: () => ({ getUserAccessToken: async () => "user-access-token" }),
    getFeishuClient: () => ({} as never),
    getProjectService: () => ({} as never),
    getRegistry: () => ({} as never),
    ensureReady: async () => undefined,
    getIntelligence: () => ({} as never),
    run: async () => report(),
    ...overrides,
  });
  return createServer((request, response) => { void route(request, response, new URL(request.url ?? "/", "http://localhost")); });
}

function report(): RealTenantValidationReport {
  return {
    project: { name: "V3 Real Tenant Connectivity Test", currentUserRole: "owner" },
    sources: [
      { source: "base", locatorStatus: "resolved", readerStatus: "success", visibilityStatus: "allowed", freshness: "fresh" },
      { source: "chat", locatorStatus: "resolved", readerStatus: "failure", visibilityStatus: "unknown", freshness: "stale", failureCategory: "permission-denied" },
    ],
    intelligence: { currentFacts: 2, candidates: 0, potentialSignals: 1, conflicts: 0, confirmedRisks: 1, aiStatus: "unavailable", candidateProvenance: [] },
  };
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${address.port}`;
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
