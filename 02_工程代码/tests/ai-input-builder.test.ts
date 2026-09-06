import assert from "node:assert/strict";
import test from "node:test";

import { buildAiExplanationInput } from "../backend/src/ai-analysis-service/index.js";
import type { RiskContext } from "../backend/src/ai-analysis-service/index.js";
import type { ProjectAnalysisResult } from "../backend/src/analysis-service/index.js";

function projectAnalysisResult(): ProjectAnalysisResult {
  return {
    projectData: {
      project: {
        id: "base-project",
        name: "Echo Project",
        source: "feishu-base",
      },
      tasks: [],
      metadata: {
        baseToken: "sensitive-base-token",
        tableCount: 1,
        recordCount: 0,
        retrievedAt: "2026-08-25T00:00:00.000Z",
        accessMode: "read-only",
        tables: [{ id: "table-internal", name: "Tasks", recordCount: 0 }],
      },
    },
    analysis: {
      healthScore: 75,
      healthStatus: "needs-attention",
      riskLevel: "L4",
      riskSignals: [
        {
          signalId: "signal-001",
          code: "DEPENDENCY_BLOCKED",
          level: "L4",
          taskId: "task-internal-primary",
          relatedTaskIds: ["task-internal-related"],
          evidence: "内部规则证据不应作为旧结构直接进入 AI 输入。",
          deduction: 20,
          countedDeduction: 20,
        },
      ],
      scoringDetails: {
        baseScore: 100,
        totalDeduction: 20,
        ruleVersion: "mvp-v1",
        calculatedAt: "2026-08-25T00:00:00.000Z",
        deductions: [],
        escalationReasons: [],
      },
    },
  };
}

function riskContext(): RiskContext {
  return {
    signalId: "signal-001",
    type: "DEPENDENCY_BLOCKED",
    primaryTask: {
      name: "上线验收",
      status: "进行中",
      deadline: "2026-08-28",
      owner: "陈晨",
      description: "等待接口联调完成。",
    },
    relatedTasks: [
      {
        name: "接口联调",
        status: "阻塞",
        deadline: "2026-08-26",
      },
    ],
    factualEvidence: [
      "风险关联任务为“上线验收”。",
      "前置依赖任务“接口联调”当前状态为“阻塞”。",
    ],
    dataLimitations: ["关联任务缺少负责人信息。"],
  };
}

test("AI input consumes the authorized Risk Context contract", () => {
  const input = buildAiExplanationInput(projectAnalysisResult(), [riskContext()]);

  assert.deepEqual(input.riskSignals, [
    { signalId: "signal-001", type: "DEPENDENCY_BLOCKED" },
  ]);
  assert.deepEqual(input.riskContexts, [riskContext()]);
  assert.deepEqual(input.limitations, []);
  assert.equal(input.riskContexts[0]?.primaryTask?.name, "上线验收");
  assert.equal(input.riskContexts[0]?.relatedTasks[0]?.name, "接口联调");
  assert.match(input.riskContexts[0]?.factualEvidence.join(" ") ?? "", /接口联调/);
});

test("AI input does not expose legacy task identifiers or unapproved fields", () => {
  const contextWithInternalFields = {
    ...riskContext(),
    taskId: "task-internal-primary",
    relatedTaskIds: ["task-internal-related"],
    recordId: "record-internal",
    attributes: { secret: "raw-attribute-secret" },
  } as RiskContext;

  const input = buildAiExplanationInput(projectAnalysisResult(), [
    contextWithInternalFields,
  ]);
  const serialized = JSON.stringify(input);

  assert.doesNotMatch(serialized, /taskId|relatedTaskIds|affectedTasks/);
  assert.doesNotMatch(
    serialized,
    /task-internal|record-internal|sensitive-base-token|table-internal/,
  );
  assert.doesNotMatch(serialized, /attributes|raw-attribute-secret/);
});

test("empty Risk Context input reports a limitation without legacy fallback", () => {
  const input = buildAiExplanationInput(projectAnalysisResult(), []);

  assert.deepEqual(input.riskSignals, []);
  assert.deepEqual(input.riskContexts, []);
  assert.deepEqual(input.limitations, [
    "当前规则分析未提供可供 AI 解释的风险上下文。",
  ]);
  assert.doesNotMatch(JSON.stringify(input), /task-internal-primary/);
});
