import assert from "node:assert/strict";
import test from "node:test";
import {
  ProjectApiClient,
  ProjectApiError,
  ProjectReportApiClient,
  ProjectReportApiError,
  resolveProjectReportEndpoint,
  UNSAFE_FRONTEND_ENDPOINTS,
} from "../frontend/src/services/api/index.js";
import { readFile } from "node:fs/promises";
import {
  getCreateProjectErrorMessage,
  normalizeProjectNameInput,
} from "../frontend/src/features/projects/project-creation.js";

const projectDto = {
  id: "project-a",
  name: "Project A",
  currentUserRole: "owner" as const,
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T01:00:00.000Z",
};

const safeProjectReport = {
  analysis: { healthScore: 75, healthStatus: "at-risk", riskLevel: "L5", riskSignals: [], scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 25 } },
  riskContexts: [],
  aiReport: { risks: [], limitations: [] },
};

test("ProjectApiClient loads the safe current-user project list", async () => {
  let requestedPath = "";
  const client = new ProjectApiClient(async (path: RequestInfo | URL) => {
    requestedPath = String(path);
    return new Response(JSON.stringify({ projects: [projectDto] }), { status: 200 });
  });

  assert.deepEqual(await client.getProjects(), [projectDto]);
  assert.equal(requestedPath, "/api/projects");
});

test("ProjectApiClient loads project detail and the project-scoped report", async () => {
  const requestedPaths: string[] = [];
  const requestedMethods: string[] = [];
  const client = new ProjectApiClient(async (path: RequestInfo | URL, init?: RequestInit) => {
    const requestedPath = String(path);
    requestedPaths.push(requestedPath);
    requestedMethods.push(init?.method ?? "GET");
    return new Response(JSON.stringify(
      requestedPath.endsWith("/report") ? safeProjectReport : projectDto,
    ), { status: 200 });
  });

  assert.deepEqual(await client.getProject("project-a"), projectDto);
  assert.deepEqual(await client.getProjectReport("project-a"), safeProjectReport);
  assert.deepEqual(requestedPaths, [
    "/api/projects/project-a",
    "/api/projects/project-a/report",
  ]);
  assert.deepEqual(requestedMethods, ["GET", "POST"]);
});

test("Project creation accepts common Chinese names and separates input from system failures", () => {
  for (const name of [
    "品牌焕新计划",
    "【演示】品牌焕新计划",
    "品牌焕新计划（第二阶段）",
    "Echo Insight 2.0",
    "AI-项目控制台_02",
  ]) {
    assert.equal(normalizeProjectNameInput(name), name);
  }
  assert.equal(normalizeProjectNameInput(""), null);
  assert.equal(normalizeProjectNameInput("   "), null);
  assert.equal(normalizeProjectNameInput("项".repeat(121)), null);
  assert.equal(normalizeProjectNameInput("项目\n名称"), null);

  assert.equal(
    getCreateProjectErrorMessage(
      new ProjectApiError("Project name is invalid.", 400, "INVALID_PROJECT_NAME"),
    ),
    "请输入有效的项目名称。",
  );
  assert.equal(
    getCreateProjectErrorMessage(
      new ProjectApiError("Project API is unavailable.", 503, "PROJECT_API_UNAVAILABLE"),
    ),
    "暂时无法创建项目，请稍后重试。",
  );
  assert.equal(
    getCreateProjectErrorMessage(new TypeError("network unavailable")),
    "暂时无法创建项目，请稍后重试。",
  );
});

test("ProjectApiClient rejects unsafe project fields and exposes safe 404 state", async () => {
  const unsafeClient = new ProjectApiClient(async () => new Response(JSON.stringify({
    projects: [{ ...projectDto, ownerId: "must-not-enter-frontend-contract" }],
  }), { status: 200 }));
  await assert.rejects(unsafeClient.getProjects(), (error: unknown) => (
    error instanceof ProjectApiError && error.code === "INVALID_PROJECT_RESPONSE"
  ));

  const missingClient = new ProjectApiClient(async () => new Response(JSON.stringify({
    error: { code: "PROJECT_NOT_FOUND", message: "Project not found." },
  }), { status: 404 }));
  await assert.rejects(missingClient.getProject("project-missing"), (error: unknown) => (
    error instanceof ProjectApiError
    && error.status === 404
    && error.code === "PROJECT_NOT_FOUND"
    && error.message === "Project not found."
  ));
});

test("ProjectApiClient accepts only a Feishu authorization URL for a project join", async () => {
  let requestedPath = "";
  const client = new ProjectApiClient(async (path: RequestInfo | URL) => {
    requestedPath = String(path);
    return new Response(JSON.stringify({
      authorizationUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=safe-state",
    }), { status: 200 });
  });
  assert.deepEqual(await client.startProjectJoin("https://feishu.cn/base/bascnSafeProject"), {
    authorizationUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=safe-state",
  });
  assert.equal(requestedPath, "/api/projects/join");

  const unsafe = new ProjectApiClient(async () => new Response(JSON.stringify({
    authorizationUrl: "https://attacker.example.test/authorize?state=unsafe",
  }), { status: 200 }));
  await assert.rejects(unsafe.startProjectJoin("https://feishu.cn/base/bascnSafeProject"), (error: unknown) => (
    error instanceof ProjectApiError && error.code === "INVALID_PROJECT_RESPONSE"
  ));

  const page = await readFile(new URL("../frontend/src/pages/Projects/ProjectsPage.tsx", import.meta.url), "utf8");
  assert.match(page, /startProjectJoin\(url\.trim\(\)\)/);
  assert.doesNotMatch(page, /ownerId|memberId|userId/);
});

test("ProjectReportApiClient reads the safe project report endpoint", async () => {
  let requestedPath = "";
  const client = new ProjectReportApiClient(async (path: RequestInfo | URL) => {
    requestedPath = String(path);
    return new Response(JSON.stringify({
      analysis: { healthScore: 75, healthStatus: "at-risk", riskLevel: "L5", riskSignals: [], scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 25 } },
      riskContexts: [],
      aiReport: { risks: [], limitations: [] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });

  const report = await client.getProjectReport();
  assert.equal(requestedPath, "/api/project-report");
  assert.equal(report.analysis.healthScore, 75);
  assert.deepEqual(report.aiReport.risks, []);
});

test("ProjectReportApiClient binds the browser fetch receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown;

  globalThis.fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve(new Response(JSON.stringify({
      analysis: { healthScore: 100, healthStatus: "healthy", riskLevel: "L1", riskSignals: [], scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 0 } },
      riskContexts: [],
      aiReport: { risks: [], limitations: [] },
    }), { status: 200, headers: { "content-type": "application/json" } }));
  } as typeof fetch;

  try {
    const client = new ProjectReportApiClient();
    await client.getProjectReport();
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ProjectReportApiClient uses a configured production API base URL", async () => {
  let requestedPath = "";
  const client = new ProjectReportApiClient(
    async (path: RequestInfo | URL) => {
      requestedPath = String(path);
      return new Response(JSON.stringify({
        analysis: { healthScore: 100, healthStatus: "healthy", riskLevel: "L1", riskSignals: [], scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 0 } },
        riskContexts: [],
        aiReport: { risks: [], limitations: [] },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    "https://echo-insight-api.example.com/",
  );

  await client.getProjectReport();
  assert.equal(requestedPath, "https://echo-insight-api.example.com/api/project-report");
  assert.equal(resolveProjectReportEndpoint(""), "/api/project-report");
});
test("ProjectReportApiClient exposes safe server errors", async () => {
  const client = new ProjectReportApiClient(async () => new Response(JSON.stringify({ error: { code: "PROJECT_REPORT_FAILED", message: "Report unavailable." } }), { status: 500 }));
  await assert.rejects(client.getProjectReport(), (error: unknown) => {
    if (!(error instanceof ProjectReportApiError)) return false;
    return error.code === "PROJECT_REPORT_FAILED" && error.status === 500;
  });
});

test("ProjectReportApiClient rejects sensitive response fields", async () => {
  const client = new ProjectReportApiClient(async () => new Response(JSON.stringify({
    analysis: { healthScore: 100, healthStatus: "healthy", riskLevel: "L1", riskSignals: [], scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 0 } },
    riskContexts: [],
    aiReport: { risks: [], limitations: [] },
    baseToken: "placeholder-sensitive-value",
  }), { status: 200, headers: { "content-type": "application/json" } }));

  await assert.rejects(client.getProjectReport(), (error: unknown) => {
    if (!(error instanceof ProjectReportApiError)) return false;
    return error.code === "UNSAFE_PROJECT_REPORT";
  });
});

test("ProjectReportApiClient rejects malformed risk contexts", async () => {
  const client = new ProjectReportApiClient(async () => new Response(JSON.stringify({
    analysis: { healthScore: 100, healthStatus: "healthy", riskLevel: "L1", riskSignals: [], scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 0 } },
    riskContexts: [{ signalId: "signal-1", type: "TASK_BLOCKED", primaryTask: "invalid" }],
    aiReport: { risks: [], limitations: [] },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  await assert.rejects(client.getProjectReport(), (error: unknown) => {
    if (!(error instanceof ProjectReportApiError)) return false;
    return error.code === "INVALID_PROJECT_REPORT";
  });
});

test("ProjectReportApiClient rejects reports with risk signals but no risk contexts", async () => {
  const client = new ProjectReportApiClient(async () => new Response(JSON.stringify({
    analysis: {
      healthScore: 70,
      healthStatus: "needs-attention",
      riskLevel: "L3",
      riskSignals: [{ signalId: "signal-1" }],
      scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 15 },
    },
    aiReport: { risks: [], limitations: [] },
  }), { status: 200, headers: { "content-type": "application/json" } }));

  await assert.rejects(client.getProjectReport(), (error: unknown) => {
    return error instanceof ProjectReportApiError && error.code === "INVALID_PROJECT_REPORT";
  });
});

test("unsafe raw data endpoints are not part of the browser data contract", () => {
  assert.deepEqual(UNSAFE_FRONTEND_ENDPOINTS, ["/api/project-data", "/api/project-analysis"]);
});
