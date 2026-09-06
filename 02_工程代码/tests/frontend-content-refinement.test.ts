import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAiRiskView,
  createRiskView,
  formatDate,
  formatTaskStatus,
  getHealthReasonLines,
} from "../frontend/src/features/project-report/presentation.js";
import type { ProjectReport, RiskSignal } from "../frontend/src/services/api/types.js";

const blockedSignal = (signalId: string, taskId: string): RiskSignal => ({
  signalId,
  code: "TASK_BLOCKED",
  level: "L4",
  taskId,
  relatedTaskIds: [],
  evidence: `任务 ${taskId} 状态为 TASK_BLOCKED`,
  deduction: 25,
  countedDeduction: 25,
});

function reportWithTaskContexts(): ProjectReport {
  const firstSignal = blockedSignal("signal-one", "task-internal-one");
  const secondSignal = blockedSignal("signal-two", "task-internal-two");

  return {
    analysis: {
      healthScore: 50,
      healthStatus: "at-risk",
      riskLevel: "L4",
      riskSignals: [firstSignal, secondSignal],
      scoringDetails: { calculatedAt: "2026-08-25T00:00:00.000Z", totalDeduction: 50 },
    },
    riskContexts: [
      {
        signalId: firstSignal.signalId,
        type: firstSignal.code,
        primaryTask: {
          name: "接口联调",
          status: "阻塞",
          deadline: "2026-08-28",
          owner: "陈晨",
          description: "等待测试环境恢复",
        },
        relatedTasks: [],
        factualEvidence: ["任务当前状态为阻塞。"],
        dataLimitations: [],
      },
      {
        signalId: secondSignal.signalId,
        type: secondSignal.code,
        primaryTask: {
          name: "上线验收",
          status: "BLOCKED",
          deadline: "2026-08-30",
          owner: "李敏",
        },
        relatedTasks: [],
        factualEvidence: ["任务当前状态为 BLOCKED。"],
        dataLimitations: ["关联任务缺少任务说明。"],
      },
    ],
    aiReport: {
      risks: [
        {
          id: firstSignal.signalId,
          title: "TASK_BLOCKED",
          evidenceRefs: [firstSignal.signalId],
          reason: "测试环境尚未恢复，接口联调暂时无法继续。",
          impact: "接口联调未完成会影响后续验收安排。",
          suggestedActions: ["与陈晨确认测试环境恢复时间。"],
        },
        {
          id: secondSignal.signalId,
          title: "TASK_BLOCKED",
          evidenceRefs: [secondSignal.signalId],
          reason: "上线验收需要等待前置确认完成。",
          impact: "上线安排需要根据确认时间重新评估。",
          suggestedActions: ["与李敏确认上线验收的最新计划。"],
        },
      ],
      limitations: [],
    },
  };
}

test("task-level context produces business language without internal identifiers", () => {
  const report = reportWithTaskContexts();
  const signal = report.analysis.riskSignals[0];
  assert.ok(signal);

  const view = createRiskView(signal, report.aiReport.risks, report.riskContexts);
  const visibleContent = JSON.stringify({ ...view, id: undefined });

  assert.equal(view.name, "「接口联调」等待处理");
  assert.match(view.fact, /接口联调/);
  assert.match(view.fact, /2026年8月28日/);
  assert.equal(formatTaskStatus("BLOCKED"), "等待处理");
  assert.doesNotMatch(visibleContent, /signal-one|task-internal-one|Risk Engine|TASK_BLOCKED|BLOCKED|阻塞/);
});

test("date presentation keeps a defensive fallback for timestamp inputs", () => {
  assert.equal(formatDate("1787875200000"), "2026年8月28日");
  assert.equal(formatDate("1787875200"), "2026年8月28日");
});

test("same-type risks retain different task titles, facts, and AI explanations", () => {
  const report = reportWithTaskContexts();
  const [firstSignal, secondSignal] = report.analysis.riskSignals;
  assert.ok(firstSignal);
  assert.ok(secondSignal);

  const firstRisk = createRiskView(firstSignal, report.aiReport.risks, report.riskContexts);
  const secondRisk = createRiskView(secondSignal, report.aiReport.risks, report.riskContexts);
  const firstAiRisk = report.aiReport.risks[0];
  const secondAiRisk = report.aiReport.risks[1];
  assert.ok(firstAiRisk);
  assert.ok(secondAiRisk);
  const firstAiView = createAiRiskView(report, firstAiRisk);
  const secondAiView = createAiRiskView(report, secondAiRisk);

  assert.notEqual(firstRisk.name, secondRisk.name);
  assert.notEqual(firstRisk.fact, secondRisk.fact);
  assert.match(firstAiView.fact, /接口联调/);
  assert.match(secondAiView.fact, /上线验收/);
  assert.notEqual(firstAiView.aiReason, secondAiView.aiReason);
});

test("dashboard health explanation lists the concrete reasons for the score", () => {
  const reasons = getHealthReasonLines(reportWithTaskContexts());

  assert.deepEqual(reasons, [
    "「接口联调」等待处理：任务当前状态为等待处理。",
    "「上线验收」等待处理：任务当前状态为等待处理。",
  ]);
});

test("user-facing pages do not render internal risk vocabulary", async () => {
  for (const pagePath of [
    "../frontend/src/pages/Dashboard/DashboardPage.tsx",
    "../frontend/src/pages/RiskCenter/RiskCenterPage.tsx",
    "../frontend/src/pages/AIReport/AIReportPage.tsx",
  ]) {
    const pageSource = await readFile(new URL(pagePath, import.meta.url), "utf8");
    assert.doesNotMatch(pageSource, /signalId|taskId|Risk Engine|BLOCKED/);
  }
});
