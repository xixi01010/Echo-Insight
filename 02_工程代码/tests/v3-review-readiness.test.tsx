import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, before, test } from "node:test";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createEchoInsightServer } from "../backend/src/index.js";
import { createReviewEnvironment } from "../backend/src/review/review-environment.js";
import { AIReportPage } from "../frontend/src/pages/AIReport/AIReportPage.js";
import { ProjectDataSourcePanel } from "../frontend/src/pages/Project/ProjectDataSourcePanel.js";
import { ProjectIntelligencePanel } from "../frontend/src/pages/Project/ProjectIntelligencePanel.js";
import { RiskCenterPage } from "../frontend/src/pages/RiskCenter/RiskCenterPage.js";
import { ProjectApiClient, type ProjectDataSourceStatus, type ProjectIntelligence, type ProjectReport } from "../frontend/src/services/api/index.js";

Object.assign(globalThis, { React });

let client: ProjectApiClient;
let closeServer: () => Promise<void>;
let temporaryRoot: string;

before(async () => {
  temporaryRoot = await mkdtemp(resolve(tmpdir(), "echo-v3-review-"));
  const runtimeDirectory = resolve(temporaryRoot, "backend", ".runtime", "review-v3");
  const review = await createReviewEnvironment(runtimeDirectory);
  const server = createEchoInsightServer({
    ...review,
    environment: { NODE_ENV: "development", ECHO_INSIGHT_DEV_USER_ID: "echo-review-user" },
    allowedFrontendOrigin: "http://localhost:5173",
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  client = new ProjectApiClient(fetch, `http://127.0.0.1:${address.port}`);
  closeServer = () => new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
});

after(async () => {
  if (closeServer) await closeServer();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

test("five deterministic projects are reachable through the real HTTP API", async () => {
  const projects = await client.getProjects();
  assert.deepEqual(projects.map((project) => project.id), ["review-a", "review-b", "review-c", "review-d", "review-e"]);
  assert.equal(projects[4]?.currentUserRole, "member");
  for (const project of projects) {
    assert.equal((await client.getProject(project.id)).id, project.id);
    assert.ok((await client.getProjectReport(project.id)).analysis.healthScore >= 0);
    assert.ok((await client.getProjectSources(project.id)).length >= 1);
    assert.ok((await client.getProjectIntelligence(project.id)).freshness.length >= 1);
  }
});

test("Project A remains a healthy Base-only V2 experience", async () => {
  const report = await client.getProjectReport("review-a");
  const intelligence = await client.getProjectIntelligence("review-a");
  const sources = await client.getProjectSources("review-a");
  assert.equal(report.analysis.healthScore, 100);
  assert.equal(report.analysis.riskSignals.length, 0);
  assert.deepEqual(sources.map((source) => source.type), ["feishu-base"]);
  assert.match(renderToStaticMarkup(<ProjectIntelligencePanel intelligence={intelligence} />), /已确认项目信息/);
});

test("Project B presents confirmed structure-backed risk before any potential signal", async () => {
  const report = await client.getProjectReport("review-b");
  const intelligence = await client.getProjectIntelligence("review-b");
  assert.ok(report.analysis.riskSignals.some((signal) => signal.code === "TASK_BLOCKED"));
  assert.ok(report.analysis.riskSignals.some((signal) => signal.code === "TASK_OVERDUE"));
  assert.equal(intelligence.potentialSignals.length, 0);
  const markup = renderToStaticMarkup(<RiskCenterPage embedded intelligence={intelligence} projectReport={controller(report)} />);
  assert.match(markup, /项目风险列表/);
  assert.doesNotMatch(markup, /待确认信号/);
});

test("Project C keeps natural language tentative and cannot change Health", async () => {
  const report = await client.getProjectReport("review-c");
  const intelligence = await client.getProjectIntelligence("review-c");
  assert.equal(report.analysis.healthScore, 100);
  assert.equal(report.analysis.riskSignals.length, 0);
  assert.equal(intelligence.confirmedRisks.length, 0);
  assert.equal(intelligence.potentialSignals.length, 3);
  assert.ok(intelligence.potentialSignals.every((signal) => signal.state === "unconfirmed"));
  const overview = renderToStaticMarkup(<ProjectIntelligencePanel intelligence={intelligence} />);
  const ai = renderToStaticMarkup(<AIReportPage embedded intelligence={intelligence} projectReport={controller(report)} />);
  assert.match(overview, /待确认信息 · 来自：群聊/);
  assert.match(overview, /待确认信息不会参与正式风险或健康度计算/);
  assert.match(ai, /待确认信息/);
});

test("Project D exposes an unresolved Base and Task conflict without selecting a winner", async () => {
  const intelligence = await client.getProjectIntelligence("review-d");
  assert.equal(intelligence.conflicts.length, 1);
  assert.deepEqual(intelligence.conflicts[0]?.sourceTypes.sort(), ["feishu-base", "feishu-task"]);
  assert.ok(!intelligence.currentFacts.some((fact) => fact.subject.includes("task:d-1:task-deadline")));
  const markup = renderToStaticMarkup(<ProjectIntelligencePanel intelligence={intelligence} />);
  assert.match(markup, /信息冲突 · 需要确认/);
  assert.match(markup, /系统不会自动选择答案/);
});

test("Project E remains usable while stale, failed and denied sources stay explicit and private", async () => {
  const report = await client.getProjectReport("review-e");
  const intelligence = await client.getProjectIntelligence("review-e");
  const sources = await client.getProjectSources("review-e");
  assert.equal(report.analysis.healthScore, 100);
  assert.ok(sources.some((source) => source.type === "feishu-docs" && source.freshness === "stale" && source.failureCategory === "rate-limited"));
  assert.ok(sources.some((source) => source.type === "feishu-chat" && source.failureCategory === "rate-limited"));
  const denied = sources.find((source) => source.type === "feishu-minutes");
  assert.equal(denied?.visibility, "denied");
  assert.notEqual(denied?.displayName, "成员无权查看的妙记");
  assert.ok(!JSON.stringify(intelligence).includes("成员无权查看的妙记"));
  const sourceMarkup = renderToStaticMarkup(<ProjectDataSourcePanel currentUserRole="member" dataSourceController={dataSourceController(sources)} />);
  assert.match(sourceMarkup, /数据状态：更新较早/);
  assert.match(sourceMarkup, /飞书暂时限制读取频率/);
  assert.doesNotMatch(sourceMarkup, /成员无权查看的妙记/);
});

function controller(report: ProjectReport) {
  return { report, status: "success" as const, error: null, hasHistoricalReport: true, refresh: async () => "success" as const };
}

function dataSourceController(sources: NonNullable<ProjectDataSourceStatus["sources"]>) {
  return {
    status: "configured" as const,
    error: null,
    dataSource: { type: "feishu-base" as const, configured: true, accessMode: "read-only" as const, displayName: "Project E Base", sources },
    configure: async () => undefined,
    addSource: async () => undefined,
    setSourceEnabled: async () => undefined,
    removeSource: async () => undefined,
    refresh: async () => undefined,
  };
}
