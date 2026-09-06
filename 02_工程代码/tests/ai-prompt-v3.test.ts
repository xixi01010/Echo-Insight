import assert from "node:assert/strict";
import test from "node:test";

import type { AiExplanationInput } from "../ai-service/src/index.js";
import { normalizeRiskOutput } from "../ai-service/src/risk-output-normalizer.js";
import {
  createPrompt,
  SYSTEM_PROMPT_V3,
  validateV2Output,
} from "../scripts/ai-model-test.js";

const twoBlockedRisks: AiExplanationInput = {
  projectName: "Echo Project",
  riskSignals: [
    { signalId: "signal-blocked-api", type: "TASK_BLOCKED" },
    { signalId: "signal-blocked-release", type: "TASK_BLOCKED" },
  ],
  riskContexts: [
    {
      signalId: "signal-blocked-api",
      type: "TASK_BLOCKED",
      primaryTask: {
        name: "接口联调",
        status: "阻塞",
        deadline: "2026-08-26",
        description: "等待测试环境恢复。",
      },
      relatedTasks: [],
      factualEvidence: [
        "风险关联任务为“接口联调”。",
        "当前任务状态为“阻塞”。",
        "任务截止日期为“2026-08-26”。",
      ],
      dataLimitations: ["关联任务缺少负责人信息。"],
    },
    {
      signalId: "signal-blocked-release",
      type: "TASK_BLOCKED",
      primaryTask: {
        name: "发布验收",
        status: "阻塞",
        deadline: "2026-08-30",
        owner: "陈晨",
      },
      relatedTasks: [],
      factualEvidence: [
        "风险关联任务为“发布验收”。",
        "当前任务状态为“阻塞”。",
        "任务截止日期为“2026-08-30”。",
      ],
      dataLimitations: ["任务说明未提供。"],
    },
  ],
  limitations: [],
};

function promptFor(input: AiExplanationInput): string {
  return createPrompt({
    name: "prompt-v3",
    filePath: "",
    input: input as unknown as Record<string, unknown>,
  });
}

test("Prompt V3 requires same-type risks to use their own task facts and differ", () => {
  const prompt = promptFor(twoBlockedRisks);

  assert.match(prompt, /接口联调/);
  assert.match(prompt, /发布验收/);
  assert.match(prompt, /2026-08-26/);
  assert.match(prompt, /2026-08-30/);
  assert.match(SYSTEM_PROMPT_V3, /同类型但 signalId 不同的风险必须使用各自上下文/);
  assert.match(SYSTEM_PROMPT_V3, /不得复用相同句子/);
  assert.match(SYSTEM_PROMPT_V3, /factualEvidence、primaryTask、relatedTasks/);
});

test("Prompt V3 requires data limitations instead of unsupported inference", () => {
  const prompt = promptFor(twoBlockedRisks);

  assert.match(prompt, /关联任务缺少负责人信息/);
  assert.match(prompt, /任务说明未提供/);
  assert.match(SYSTEM_PROMPT_V3, /必须在 limitations 中说明缺少的事实/);
  assert.match(SYSTEM_PROMPT_V3, /不得推断负责人、阻塞根因或未提供的影响对象/);
  assert.match(SYSTEM_PROMPT_V3, /不得使用“项目可能延期”“需要协调资源”“排查阻塞原因”/);
});

test("Prompt V3 bounds output length without changing the V2 protocol", () => {
  assert.match(SYSTEM_PROMPT_V3, /每个 reason 和 impact 最多使用两个短句/);
  assert.match(SYSTEM_PROMPT_V3, /suggestedActions 只提供一到两条可执行动作/);
  assert.match(SYSTEM_PROMPT_V3, /同一事实在同一风险中只说明一次/);
  assert.match(SYSTEM_PROMPT_V3, /只列出影响判断的关键缺失事实/);
  assert.match(SYSTEM_PROMPT_V3, /你只能输出 JSON 顶层字段 risks 和 limitations/);
});

test("V3-shaped differentiated explanations remain normalizer and V2 compatible", () => {
  const providerOutput = {
    risks: [
      {
        id: "signal-blocked-api",
        title: "TASK_BLOCKED",
        evidenceRefs: ["signal-blocked-api"],
        reason: "接口联调当前处于阻塞状态，且截止日期为 2026-08-26。",
        impact: "测试环境尚未恢复会直接阻断接口联调按计划完成。",
        suggestedActions: ["确认测试环境恢复时间，并据此更新接口联调的可执行安排。"],
      },
      {
        id: "signal-blocked-release",
        title: "TASK_BLOCKED",
        evidenceRefs: ["signal-blocked-release"],
        reason: "发布验收当前处于阻塞状态，负责人为陈晨，截止日期为 2026-08-30。",
        impact: "发布验收不能完成会使该节点无法按当前计划关闭。",
        suggestedActions: ["请陈晨确认阻塞状态的下一次复核时间，并记录可恢复推进的条件。"],
      },
    ],
    limitations: ["接口联调缺少负责人信息，无法判断具体协调对象。"],
  };

  const validation = validateV2Output(providerOutput);
  const normalized = normalizeRiskOutput(providerOutput, twoBlockedRisks);

  assert.equal(validation.valid, true);
  assert.notEqual(normalized.risks[0]?.reason, normalized.risks[1]?.reason);
  assert.notEqual(normalized.risks[0]?.impact, normalized.risks[1]?.impact);
  assert.notEqual(
    normalized.risks[0]?.suggestedActions[0],
    normalized.risks[1]?.suggestedActions[0],
  );
  assert.equal(JSON.stringify(normalized).includes("task-internal"), false);
});

test("Prompt V3 preserves forbidden V2 rule-field validation", () => {
  const validation = validateV2Output({
    risks: [],
    limitations: [],
    healthScore: 80,
    riskLevel: "L4",
  });

  assert.equal(validation.valid, false);
  assert.ok(validation.violations.includes("forbidden top-level field: healthScore"));
  assert.ok(validation.violations.includes("forbidden top-level field: riskLevel"));
  assert.match(SYSTEM_PROMPT_V3, /signalId 仅可出现在 id 和 evidenceRefs/);
});
