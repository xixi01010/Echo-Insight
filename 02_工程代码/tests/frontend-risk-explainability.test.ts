import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createAiRiskView,
  createRiskView,
  getDataCompletenessNotice,
  getFactBackedAiRiskViews,
  getFactBackedRiskViews,
  getUnavailableExplainabilityMessage,
} from "../frontend/src/features/project-report/presentation.js";
import { readProjectReportCache, type ReportStorage } from "../frontend/src/services/api/report-cache.js";
import type { ProjectReport, RiskSignal } from "../frontend/src/services/api/types.js";

function createStorage(): ReportStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const signal: RiskSignal = {
  signalId: "signal-blocked",
  code: "TASK_BLOCKED",
  level: "L4",
  taskId: "task-internal",
  relatedTaskIds: [],
  evidence: "任务状态异常",
  deduction: 25,
  countedDeduction: 25,
};

const aiRisk = {
  id: signal.signalId,
  title: "任务推进风险",
  evidenceRefs: [signal.signalId],
  reason: "测试环境尚未恢复，接口联调暂时无法继续。",
  impact: "接口联调未完成会影响后续验收安排。",
  suggestedActions: ["与负责人确认测试环境恢复时间。"],
};

function reportWithContext(dataLimitations: string[] = []): ProjectReport {
  return {
    analysis: {
      healthScore: 60,
      healthStatus: "at-risk",
      riskLevel: "L4",
      riskSignals: [signal],
      scoringDetails: { calculatedAt: "2026-08-25T00:00:00.000Z", totalDeduction: 25 },
    },
    riskContexts: [{
      signalId: signal.signalId,
      type: signal.code,
      primaryTask: { name: "接口联调", status: "BLOCKED", deadline: "2026-08-25" },
      relatedTasks: [],
      factualEvidence: [
        "任务“接口联调”当前状态为“BLOCKED”。",
        "任务截止日期为“2026-08-25”。",
      ],
      dataLimitations,
    }],
    aiReport: { risks: [aiRisk], limitations: [] },
  };
}

test("unmatched AI risks are unavailable and do not receive default risk copy", () => {
  const report = reportWithContext();
  const unmatchedRisk = { ...aiRisk, id: "unmatched-ai-risk", evidenceRefs: ["unmatched-signal"] };

  const view = createAiRiskView(report, unmatchedRisk);

  assert.equal(view.explainabilityState, "unavailable");
  assert.equal(view.fact, "");
  assert.equal(view.ruleReason, "");
  assert.equal(view.impact, "");
  assert.deepEqual(view.actions, []);
  assert.equal(getUnavailableExplainabilityMessage(), "该 AI 解释无法对应当前项目事实，因此未作为项目风险展示。");
});

test("incomplete RiskContext produces a limited, fact-bound explanation", () => {
  const report = reportWithContext(["关联任务缺少负责人信息。"]);
  const view = createRiskView(signal, report.aiReport.risks, report.riskContexts);

  assert.equal(view.explainabilityState, "limited");
  assert.match(view.factualEvidence.join(""), /接口联调/);
  assert.match(view.limitations.join(""), /负责人/);
  assert.doesNotMatch(JSON.stringify({ ...view, id: undefined }), /task-internal|signal-blocked|BLOCKED/);
});

test("verified RiskContext exposes sanitized factual evidence", () => {
  const report = reportWithContext();
  const view = createAiRiskView(report, aiRisk);

  assert.equal(view.explainabilityState, "verified");
  assert.deepEqual(view.factualEvidence, [
    "任务“接口联调”当前状态为等待处理。",
    "任务截止日期为“2026-08-25”。",
  ]);
});

test("risk and AI report pages render factual evidence and gate unavailable details", async () => {
  const root = new URL("../frontend/src/pages/", import.meta.url);
  const [riskCenter, aiReport] = await Promise.all([
    readFile(new URL("RiskCenter/RiskCenterPage.tsx", root), "utf8"),
    readFile(new URL("AIReport/AIReportPage.tsx", root), "utf8"),
  ]);

  assert.match(riskCenter, />系统依据</);
  assert.match(riskCenter, /risk\.factualEvidence/);
  assert.match(riskCenter, /getFactBackedRiskViews/);
  assert.match(riskCenter, /数据完整性提醒/);
  assert.match(aiReport, />系统依据</);
  assert.match(aiReport, /risk\.factualEvidence/);
  assert.match(aiReport, /getFactBackedAiRiskViews/);
  assert.match(aiReport, /getDataCompletenessNotice/);
});

test("unavailable missing-data signals become one data completeness notice", () => {
  const missingSignals: RiskSignal[] = [
    { ...signal, signalId: "signal-missing-one", code: "MISSING_PROJECT_DATA" },
    { ...signal, signalId: "signal-missing-two", code: "MISSING_PROJECT_DATA" },
  ];
  const report: ProjectReport = {
    analysis: {
      healthScore: 80,
      healthStatus: "needs-attention",
      riskLevel: "L3",
      riskSignals: missingSignals,
      scoringDetails: { calculatedAt: "2026-08-25T00:00:00.000Z", totalDeduction: 10 },
    },
    riskContexts: missingSignals.map((item) => ({
      signalId: item.signalId,
      type: item.code,
      primaryTask: { name: null, status: null, deadline: null },
      relatedTasks: [],
      factualEvidence: [],
      dataLimitations: ["关联任务缺少任务名称。"],
    })),
    aiReport: {
      risks: missingSignals.map((item) => ({
        id: item.signalId,
        title: "项目信息待补充",
        evidenceRefs: [item.signalId],
        reason: "当前信息不足。",
        impact: "当前影响待确认。",
        suggestedActions: ["补充任务信息。"],
      })),
      limitations: [],
    },
  };

  assert.deepEqual(getFactBackedRiskViews(report), []);
  assert.deepEqual(getFactBackedAiRiskViews(report), []);
  assert.deepEqual(getDataCompletenessNotice(report), {
    count: 2,
    message: "当前有 2 条任务记录缺少必要信息，因此未生成详细风险解释。",
  });
});

test("legacy v1 cache is not read as a fact-backed report", () => {
  const storage = createStorage();
  storage.setItem("echo-insight:project-report:v1", JSON.stringify(reportWithContext()));

  assert.equal(readProjectReportCache(storage), null);
});
