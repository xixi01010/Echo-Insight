import assert from "node:assert/strict";
import test from "node:test";
import { getInsightActionCopy, getInsightErrorMessage } from "../frontend/src/features/project-report/insight-copy.js";
import { createAiRiskView, createRiskView, getHealthPresentation, sanitizeUserFacingText } from "../frontend/src/features/project-report/presentation.js";
import { readProjectReportCache, writeProjectReportCache, type ReportStorage } from "../frontend/src/services/api/report-cache.js";
import type { ProjectReport } from "../frontend/src/services/api/types.js";

function createStorage(): ReportStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

const safeReport: ProjectReport = {
  analysis: {
    healthScore: 75,
    healthStatus: "at-risk",
    riskLevel: "L5",
    riskSignals: [],
    scoringDetails: { calculatedAt: "2026-08-23T00:00:00.000Z", totalDeduction: 25 },
  },
  riskContexts: [],
  aiReport: { risks: [], limitations: [] },
};

test("first insight uses product-specific copy", () => {
  const idleCopy = getInsightActionCopy(false, "empty");
  const loadingCopy = getInsightActionCopy(false, "loading");

  assert.equal(idleCopy.label, "生成首次分析");
  assert.match(idleCopy.description, /项目健康情况/);
  assert.match(idleCopy.description, /风险信号/);
  assert.match(idleCopy.description, /AI 解释/);
  assert.match(idleCopy.description, /行动建议/);
  assert.equal(loadingCopy.label, "正在生成首次分析");
  assert.equal(loadingCopy.title, "正在生成项目分析");
  assert.match(loadingCopy.description, /正在读取/);
});

test("technical errors are converted to Chinese product messages", () => {
  assert.equal(
    getInsightErrorMessage(new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")),
    "当前无法连接项目分析服务，请检查服务状态后重试。",
  );
  assert.equal(
    getInsightErrorMessage(new Error("low-level server detail")),
    "生成分析失败，请稍后重试。",
  );
});

test("historical insight uses update copy", () => {
  assert.equal(getInsightActionCopy(true, "success").label, "刷新项目分析");
  assert.equal(getInsightActionCopy(true, "refreshing").label, "正在刷新项目分析");
});

test("safe reports persist for the daily experience", () => {
  const storage = createStorage();
  writeProjectReportCache(storage, safeReport);
  assert.deepEqual(readProjectReportCache(storage), safeReport);
});

test("cached reports containing sensitive fields are rejected", () => {
  const storage = createStorage();
  storage.setItem("echo-insight:project-report:v2", JSON.stringify({ ...safeReport, baseToken: "forbidden" }));
  assert.equal(readProjectReportCache(storage), null);
});

test("v1 cached reports are ignored while v2 reports remain readable", () => {
  const storage = createStorage();
  storage.setItem("echo-insight:project-report:v1", JSON.stringify(safeReport));
  assert.equal(readProjectReportCache(storage), null);

  writeProjectReportCache(storage, safeReport);
  assert.deepEqual(readProjectReportCache(storage), safeReport);
});
test("health presentation uses the scorer status as its single UI source", () => {
  assert.equal(getHealthPresentation(95, "healthy").label, "健康稳定");
  assert.equal(getHealthPresentation(80, "needs-attention").label, "需要关注");
  assert.equal(getHealthPresentation(60, "at-risk").label, "存在风险");
  assert.equal(getHealthPresentation(60, "at-risk").tone, "risk");
});

test("risk presentation hides engine codes and record identifiers", () => {
  const signal = {
    signalId: "signal-014",
    code: "TASK_BLOCKED",
    level: "L4" as const,
    taskId: "recv12345678",
    relatedTaskIds: [],
    evidence: "任务 recv12345678 状态为 TASK_BLOCKED",
    deduction: 25,
    countedDeduction: 25,
  };
  const risk = createRiskView(signal, [{
    id: "signal-014",
    title: "TASK_BLOCKED",
    evidenceRefs: ["signal-014"],
    reason: "该任务无法继续推进。",
    impact: "可能影响后续联调安排。",
    suggestedActions: ["确认阻塞原因", "明确解除时间"],
  }], [{
    signalId: "signal-014",
    type: "TASK_BLOCKED",
    primaryTask: { name: "接口联调", status: "BLOCKED", deadline: "2026-08-25" },
    relatedTasks: [],
    factualEvidence: ["任务“接口联调”当前状态为“BLOCKED”。"],
    dataLimitations: [],
  }]);

  assert.equal(risk.name, "「接口联调」等待处理");
  assert.equal(risk.level.label, "严重风险");
  assert.doesNotMatch(JSON.stringify({ ...risk, id: undefined }), /TASK_BLOCKED|signal-014|recv12345678/);
  assert.deepEqual(risk.actions, ["确认暂时无法推进的原因", "明确解除时间"]);
});

test("AI report presentation keeps facts separate from explanation", () => {
  const report: ProjectReport = {
    ...safeReport,
    analysis: {
      ...safeReport.analysis,
      riskSignals: [{ signalId: "signal-013", code: "TASK_OVERDUE", level: "L3", taskId: "recv87654321", relatedTaskIds: [], evidence: "任务 recv87654321 已超过截止日期", deduction: 15, countedDeduction: 15 }],
    },
    riskContexts: [{
      signalId: "signal-013",
      type: "TASK_OVERDUE",
      primaryTask: { name: "接口联调", status: "进行中", deadline: "2026-08-20" },
      relatedTasks: [],
      factualEvidence: ["任务“接口联调”截止日期为“2026-08-20”。"],
      dataLimitations: [],
    }],
    aiReport: {
      limitations: ["仅基于已授权数据"],
      risks: [{ id: "signal-013", title: "TASK_OVERDUE", evidenceRefs: ["signal-013"], reason: "剩余时间被压缩。", impact: "可能影响后续测试。", suggestedActions: ["重新确认完成时间"] }],
    },
  };
  const aiRisk = report.aiReport.risks[0];
  assert.ok(aiRisk);
  const risk = createAiRiskView(report, aiRisk);

  assert.equal(risk.name, "「接口联调」存在延期风险");
  assert.match(risk.ruleReason, /计划完成时间/);
  assert.equal(risk.aiReason, "剩余时间被压缩。");
  assert.doesNotMatch(JSON.stringify({ ...risk, id: undefined }), /signal-013|recv87654321|TASK_OVERDUE/);
});

test("user-facing sanitizer removes known internal vocabulary", () => {
  const copy = sanitizeUserFacingText("Risk Engine 发现 signal-002，任务 recvABCDEFG 状态为 TASK_OVERDUE");
  assert.equal(copy, "系统规则 发现 相关风险，任务 相关任务 状态为 任务进度延期");
});
