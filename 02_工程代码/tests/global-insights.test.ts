import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectAnalysisService } from "../backend/src/analysis-service/index.js";
import { FixedCurrentUserContextProvider } from "../backend/src/current-user/index.js";
import { GlobalInsightService } from "../backend/src/global-insight/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import {
  ProjectContextService,
  ProjectDataSourceResolver,
} from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import {
  GlobalInsightsApiClient,
  GlobalInsightsApiError,
} from "../frontend/src/services/api/index.js";
import type { ProjectDataReader, StandardProjectData } from "../feishu-connector/src/index.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const TOKEN_BLOCKED = "insight-source-blocked";
const TOKEN_OVERDUE = "insight-source-overdue";

test("global insights use authorized rule analysis, sort deterministically, and never call AI", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const first = await fixture.service.getInsights("user-a");
  const second = await fixture.service.getInsights("user-a");

  assert.equal(first.partialFailure, true);
  assert.deepEqual(first, second);
  assert.equal(first.insights.length, 2);
  assert.deepEqual(first.insights.map((insight) => [
    insight.projectName,
    insight.currentUserRole,
    insight.riskLevel,
  ]), [
    ["Blocked Project", "owner", "L4"],
    ["Overdue Project", "member", "L3"],
  ]);
  assert.equal(fixture.requestedTokens.filter((token) => token === TOKEN_BLOCKED).length, 1);
  assert.equal(fixture.requestedTokens.filter((token) => token === TOKEN_OVERDUE).length, 1);
  assert.equal(first.insights.some((insight) => insight.projectName === "Other User Project"), false);
  const serialized = JSON.stringify(first);
  assert.equal(serialized.includes(TOKEN_BLOCKED), false);
  assert.equal(serialized.includes("source-blocked"), false);
  assert.equal(serialized.includes("table-internal"), false);

  const source = await readFile(
    new URL("../backend/src/global-insight/global-insight-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /ProjectAnalysisService/);
  assert.match(source, /mapWithConcurrency/);
  assert.doesNotMatch(source, /ProjectReportService|createProjectReport|SiliconFlow|RiskExplanationAnalyzer/);
});

test("GET /api/insights fails closed and returns a safe partial result", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const server = createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider("user-a"),
    globalInsightService: fixture.service,
    projectService: fixture.projectService,
  });
  context.after(() => closeServer(server));
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${String(address.port)}`;

  const response = await fetch(`${origin}/api/insights`);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(body.partialFailure, true);
  assert.equal(JSON.stringify(body).includes(TOKEN_BLOCKED), false);
  assert.equal(JSON.stringify(body).includes("source-blocked"), false);
  assert.equal(JSON.stringify(body).includes("owner-a-internal"), false);

  const failClosed = createEchoInsightServer({
    environment: { NODE_ENV: "development" },
    globalInsightService: fixture.service,
    projectService: fixture.projectService,
  });
  context.after(() => closeServer(failClosed));
  await listen(failClosed);
  const unavailableAddress = failClosed.address();
  assert.ok(unavailableAddress && typeof unavailableAddress === "object");
  const unavailable = await fetch(`http://127.0.0.1:${String(unavailableAddress.port)}/api/insights`);
  assert.equal(unavailable.status, 503);
});

test("global insights limit concurrent project analysis", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-global-insight-concurrency-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
  const registrations = new Map<string, { kind: "feishu-base"; baseToken: string }>();
  for (const index of [1, 2, 3, 4]) {
    await projectService.createProject({
      name: `Project ${String(index)}`,
      creatorId: "user-a",
      ownerId: "user-a",
      dataSourceRefs: [`source-${String(index)}`],
    });
    registrations.set(`source-${String(index)}`, {
      kind: "feishu-base",
      baseToken: `token-${String(index)}`,
    });
  }
  let activeReads = 0;
  let maximumActiveReads = 0;
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeReads -= 1;
      return projectData(baseToken, "进行中", "2026-08-30");
    },
  };
  const service = new GlobalInsightService(
    projectService,
    new ProjectContextService(projectService, new ProjectDataSourceResolver(registrations)),
    new ProjectAnalysisService(reader, () => NOW),
  );

  await service.getInsights("user-a");
  assert.equal(maximumActiveReads <= 3, true);
});

test("global insights frontend contract rejects unsafe fields and page stays blocker-focused", async () => {
  const safeResponse = {
    insights: [{
      id: "project-a:insight:1",
      projectId: "project-a",
      projectName: "Project A",
      currentUserRole: "owner",
      riskLevel: "L4",
      title: "「Implementation」等待处理",
      facts: ["当前任务状态为“阻塞”。"],
      ruleBasis: "系统规则识别到任务当前无法继续推进。",
    }],
    partialFailure: false,
  };
  const client = new GlobalInsightsApiClient(async () => new Response(
    JSON.stringify(safeResponse),
    { status: 200 },
  ));
  assert.deepEqual(await client.getInsights(), safeResponse);

  const unsafeClient = new GlobalInsightsApiClient(async () => new Response(JSON.stringify({
    ...safeResponse,
    insights: [{ ...safeResponse.insights[0], baseToken: "forbidden" }],
  }), { status: 200 }));
  await assert.rejects(unsafeClient.getInsights(), (error: unknown) => (
    error instanceof GlobalInsightsApiError && error.code === "INVALID_INSIGHTS_RESPONSE"
  ));

  const [page, app, appShell] = await Promise.all([
    readFile(new URL("../frontend/src/pages/Insights/InsightsPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../frontend/src/app/App.tsx", import.meta.url), "utf8"),
    readFile(new URL("../frontend/src/app/AppShell.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /\/projects\/\$\{encodeURIComponent\(insight\.projectId\)\}\/risks/);
  assert.match(page, /当前没有需要优先处理的项目风险/);
  assert.doesNotMatch(page, /<input|chat|问问 AI|Prompt/iu);
  assert.match(app, /path="\/insights"/);
  assert.match(appShell, /\{ to: "\/insights", label: "AI 洞察" \}/);
});

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-global-insights-"));
  const projectService = new ProjectService(
    new JsonProjectRepository(join(directory, "projects.json")),
    () => NOW,
  );
  await projectService.createProject({
    name: "Blocked Project",
    creatorId: "creator-a",
    ownerId: "user-a",
    dataSourceRefs: ["source-blocked"],
  });
  await projectService.createProject({
    name: "Overdue Project",
    creatorId: "creator-b",
    ownerId: "owner-b-internal",
    members: ["user-a"],
    dataSourceRefs: ["source-overdue"],
  });
  await projectService.createProject({
    name: "Unavailable Project",
    creatorId: "creator-c",
    ownerId: "user-a",
    dataSourceRefs: ["source-unavailable"],
  });
  await projectService.createProject({
    name: "Other User Project",
    creatorId: "creator-other",
    ownerId: "user-other",
    dataSourceRefs: ["source-other"],
  });
  const requestedTokens: string[] = [];
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      requestedTokens.push(baseToken);
      if (baseToken === TOKEN_BLOCKED) return projectData(baseToken, "阻塞", "2026-08-30");
      return projectData(baseToken, "进行中", "2026-08-20");
    },
  };
  const resolver = new ProjectDataSourceResolver(new Map([
    ["source-blocked", { kind: "feishu-base" as const, baseToken: TOKEN_BLOCKED }],
    ["source-overdue", { kind: "feishu-base" as const, baseToken: TOKEN_OVERDUE }],
    ["source-other", { kind: "feishu-base" as const, baseToken: "other-source" }],
  ]));
  const service = new GlobalInsightService(
    projectService,
    new ProjectContextService(projectService, resolver),
    new ProjectAnalysisService(reader, () => NOW),
  );
  return {
    projectService,
    requestedTokens,
    service,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function projectData(baseToken: string, status: string, deadline: string): StandardProjectData {
  return {
    project: { id: `project-for-${baseToken}`, name: "Analyzed Project", source: "feishu-base" },
    tasks: [{
      id: `task-for-${baseToken}`,
      tableId: "table-internal",
      tableName: "Tasks",
      name: "Implementation",
      owner: "Task Owner",
      status,
      deadline,
      riskLevel: "L3",
      description: null,
      attributes: {},
    }],
    metadata: {
      baseToken,
      tableCount: 1,
      recordCount: 1,
      retrievedAt: NOW.toISOString(),
      accessMode: "read-only",
      tables: [{ id: "table-internal", name: "Tasks", recordCount: 1 }],
    },
  };
}

async function listen(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
