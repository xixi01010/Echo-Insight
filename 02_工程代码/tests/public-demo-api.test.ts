import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import { createEchoInsightServer } from "../backend/src/index.js";
import { createPublicDemoApi } from "../backend/src/demo/public-demo-api.js";

const EXPECTED_PROJECTS = [
  { id: "demo-brand", healthScore: 85, riskCount: 1 },
  { id: "demo-growth", healthScore: 60, riskCount: 2 },
  { id: "demo-content", healthScore: 0, riskCount: 6 },
  { id: "demo-explore", healthScore: 40, riskCount: 4 },
  { id: "demo-recruit", healthScore: 10, riskCount: 5 },
] as const;

let server: Server;
let origin: string;
let temporaryRoot: string;
let realReaderCalls = 0;
let realAiProviderCalls = 0;

before(async () => {
  temporaryRoot = await mkdtemp(resolve(tmpdir(), "echo-public-demo-api-"));
  const publicDemoApi = await createPublicDemoApi({
    runtimeDirectory: resolve(temporaryRoot, "backend", ".runtime", "demo-v3"),
  });
  server = createEchoInsightServer({
    publicDemoApi,
    environment: {
      NODE_ENV: "production",
      ECHO_INSIGHT_AI_ACCESS_MODE: "server",
    },
    reader: {
      async readProjectData() {
        realReaderCalls += 1;
        throw new Error("The authenticated reader must not serve public demo requests.");
      },
    },
    aiProviderBundleFactory: () => {
      realAiProviderCalls += 1;
      throw new Error("The authenticated AI provider must not serve public demo requests.");
    },
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${String(address.port)}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error ? reject(error) : resolveClose());
    });
  }
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("anonymous demo allowlist exposes five synthetic projects through the complete safe API", async () => {
  const payloads: unknown[] = [];
  const list = await requestJson("GET", "/api/demo/projects");
  assert.equal(list.response.status, 200);
  payloads.push(list.body);
  const projects = requireRecordArray(list.body, "projects");
  assert.deepEqual(
    projects.map((project) => ({
      id: project.id,
      healthScore: project.healthScore,
      riskCount: project.riskCount,
    })),
    EXPECTED_PROJECTS,
  );

  for (const expected of EXPECTED_PROJECTS) {
    const detail = await requestJson("GET", `/api/demo/projects/${expected.id}`);
    const dataSource = await requestJson("GET", `/api/demo/projects/${expected.id}/data-source`);
    const sources = await requestJson("GET", `/api/demo/projects/${expected.id}/sources`);
    const intelligence = await requestJson("GET", `/api/demo/projects/${expected.id}/intelligence`);
    const report = await requestJson("POST", `/api/demo/projects/${expected.id}/report`);
    for (const result of [detail, dataSource, sources, intelligence, report]) {
      assert.equal(result.response.status, 200);
      payloads.push(result.body);
    }
    const reportBody = requireRecord(report.body);
    const analysis = requireRecord(reportBody.analysis);
    const riskSignals = requireRecordArray(analysis, "riskSignals");
    const riskContexts = requireRecordArray(reportBody, "riskContexts");
    const aiReport = requireRecord(reportBody.aiReport);
    const aiRisks = requireRecordArray(aiReport, "risks");
    assert.equal(analysis.healthScore, expected.healthScore);
    assert.equal(riskSignals.length, expected.riskCount);
    assert.equal(riskContexts.length, expected.riskCount);
    assert.equal(reportBody.aiStatus, "available");
    assert.equal(aiRisks.length, expected.riskCount);

    for (const signal of riskSignals) {
      const signalId = requireNonEmptyString(signal.signalId);
      const context = riskContexts.find((item) => item.signalId === signalId);
      assert.ok(context, `Missing demo risk context for ${signalId}.`);
      assert.ok(requireStringArray(context.factualEvidence).length > 0);

      const aiRisk = aiRisks.find((item) => (
        item.id === signalId
        || requireStringArray(item.evidenceRefs).includes(signalId)
      ));
      assert.ok(aiRisk, `Missing demo AI explanation for ${signalId}.`);
      requireNonEmptyString(aiRisk.title);
      requireNonEmptyString(aiRisk.reason);
      requireNonEmptyString(aiRisk.impact);
      assert.ok(requireStringArray(aiRisk.suggestedActions).every((item) => item.trim().length > 0));
      assert.ok(requireStringArray(aiRisk.suggestedActions).length > 0);
    }

    const repeatedReport = await requestJson("POST", `/api/demo/projects/${expected.id}/report`);
    assert.equal(repeatedReport.response.status, 200);
    assert.deepEqual(repeatedReport.body, report.body);
  }

  const insights = await requestJson("GET", "/api/demo/insights");
  const synthesis = await requestJson("POST", "/api/demo/insights/synthesis");
  assert.equal(insights.response.status, 200);
  assert.equal(synthesis.response.status, 200);
  payloads.push(insights.body, synthesis.body);

  for (const payload of payloads) assertSafePublicPayload(payload);
  assert.equal(realReaderCalls, 0);
  assert.equal(realAiProviderCalls, 0);
});

test("all public demo writes and non-allowlisted paths fail with one stable read-only error", async () => {
  const beforeList = await requestJson("GET", "/api/demo/projects");
  const beforeSources = await requestJson("GET", "/api/demo/projects/demo-content/sources");
  const blockedRequests: Array<[string, string]> = [
    ["POST", "/api/demo/projects"],
    ["POST", "/api/demo/projects/join"],
    ["PUT", "/api/demo/projects/demo-content/data-source"],
    ["POST", "/api/demo/projects/demo-content/sources"],
    ["PATCH", "/api/demo/projects/demo-content/sources/source-1"],
    ["DELETE", "/api/demo/projects/demo-content/sources/source-1"],
    ["GET", "/api/demo/projects/demo-content/sources/options/chat"],
    ["GET", "/api/demo/projects/demo-content/report"],
    ["GET", "/api/demo/settings/ai"],
    ["GET", "/api/demo/not-a-route"],
    ["OPTIONS", "/api/demo/projects"],
  ];

  for (const [method, path] of blockedRequests) {
    const result = await requestJson(method, path);
    assert.equal(result.response.status, 405, `${method} ${path}`);
    assert.deepEqual(result.body, {
      error: {
        code: "DEMO_READ_ONLY",
        message: "The public demo is read-only.",
      },
    });
  }

  const afterList = await requestJson("GET", "/api/demo/projects");
  const afterSources = await requestJson("GET", "/api/demo/projects/demo-content/sources");
  assert.deepEqual(afterList.body, beforeList.body);
  assert.deepEqual(afterSources.body, beforeSources.body);
  assert.equal(realReaderCalls, 0);
  assert.equal(realAiProviderCalls, 0);
});

test("an allowlisted unknown project stays inside the demo graph and returns not found", async () => {
  const result = await requestJson("GET", "/api/demo/projects/not-a-demo-project");
  assert.equal(result.response.status, 404);
  assert.equal(requireRecord(requireRecord(result.body).error).code, "PROJECT_NOT_FOUND");
  assert.equal(realReaderCalls, 0);
  assert.equal(realAiProviderCalls, 0);
});

test("ordinary authenticated API paths are not replaced by demo data", async () => {
  const projects = await requestJson("GET", "/api/projects");
  assert.equal(projects.response.status, 503);
  assert.equal(
    requireRecord(requireRecord(projects.body).error).code,
    "CURRENT_USER_CONTEXT_UNAVAILABLE",
  );
  assert.doesNotMatch(JSON.stringify(projects.body), /demo-brand|品牌焕新计划/u);

  const auth = await requestJson("GET", "/api/auth/status");
  assert.equal(auth.response.status, 200);
  assert.deepEqual(auth.body, { authenticated: false });
});

async function requestJson(method: string, path: string): Promise<{ response: Response; body: unknown }> {
  const response = await fetch(`${origin}${path}`, { method });
  return { response, body: await response.json() as unknown };
}

function assertSafePublicPayload(value: unknown): void {
  const forbiddenKeys = new Set([
    "accesstoken",
    "apikey",
    "appsecret",
    "basetoken",
    "credential",
    "locator",
    "refreshtoken",
    "sessionid",
    "sourceref",
  ]);
  visit(value, (key) => assert.equal(
    forbiddenKeys.has(key.toLowerCase()),
    false,
    `Public demo payload exposed forbidden field ${key}.`,
  ));
  assert.doesNotMatch(JSON.stringify(value), /demo-[a-z-]+-base-token/u);
}

function visit(value: unknown, onKey: (key: string) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, onKey);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    onKey(key);
    visit(nested, onKey);
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function requireRecordArray(value: unknown, key: string): Record<string, unknown>[] {
  const items = requireArray(requireRecord(value)[key]);
  assert.ok(items.every((item) => item && typeof item === "object" && !Array.isArray(item)));
  return items as Record<string, unknown>[];
}

function requireNonEmptyString(value: unknown): string {
  assert.ok(typeof value === "string");
  assert.ok(value.trim().length > 0);
  return value;
}

function requireStringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value));
  assert.ok(value.every((item) => typeof item === "string"));
  return value as string[];
}
