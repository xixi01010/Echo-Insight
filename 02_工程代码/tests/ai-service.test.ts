import assert from "node:assert/strict";
import test from "node:test";

import {
  MockRiskAnalyzer,
  type AiProjectInput,
  type RiskAnalyzer,
} from "../ai-service/src/index.js";

const input: AiProjectInput = {
  project: {
    id: "project-1",
    name: "Echo Insight MVP",
    healthScore: 76,
    healthStatus: "needs-attention",
    sensitivityMode: "robust",
  },
  tasks: [
    {
      id: "task-1",
      name: "完成数据读取",
      owner: "Alice",
      status: "进行中",
      deadline: "2026-08-30",
      riskLevel: "L3",
      isOverdue: false,
      dependencyIds: [],
      description: "完成 Base、Table、Record 读取链路",
    },
  ],
  riskSignals: [
    {
      code: "DEADLINE_NEAR",
      level: "L3",
      taskId: "task-1",
      evidence: "距离截止日期较近且任务仍在进行中",
    },
  ],
  metadata: {
    source: "feishu-base",
    accessMode: "read-only",
    generatedAt: "2026-08-22T00:00:00.000Z",
  },
};

test("MockRiskAnalyzer implements the unified RiskAnalyzer interface", async () => {
  const analyzer: RiskAnalyzer = new MockRiskAnalyzer(
    () => new Date("2026-08-22T01:00:00.000Z"),
  );
  const output = await analyzer.analyze(input);

  assert.equal(output.projectHealth.score, 76);
  assert.equal(output.projectHealth.status, "needs-attention");
  assert.equal(output.projectHealth.riskLevel, "L3");
  assert.equal(output.risks.length, 1);
  assert.equal(output.risks[0]?.taskIds[0], "task-1");
  assert.equal(output.risks[0]?.reason, "距离截止日期较近且任务仍在进行中");
  assert.equal(output.analysis.mode, "robust");
  assert.equal(
    output.generatedAt,
    "2026-08-22T01:00:00.000Z",
  );
});

test("MockRiskAnalyzer preserves rule health score and reports no-signal input", async () => {
  const analyzer = new MockRiskAnalyzer(
    () => new Date("2026-08-22T02:00:00.000Z"),
  );
  const output = await analyzer.analyze({
    ...input,
    project: { ...input.project, healthScore: 100, healthStatus: "healthy" },
    riskSignals: [],
  });

  assert.equal(output.projectHealth.score, 100);
  assert.equal(output.projectHealth.status, "healthy");
  assert.equal(output.projectHealth.riskLevel, "L1");
  assert.deepEqual(output.risks, []);
  assert.match(output.analysis.explanation, /未包含风险信号/);
});

test("MockRiskAnalyzer rejects non-read-only input", async () => {
  const analyzer = new MockRiskAnalyzer();
  await assert.rejects(
    () =>
      analyzer.analyze({
        ...input,
        metadata: { ...input.metadata, accessMode: "write" as "read-only" },
      }),
    /only accepts read-only project data/,
  );
});
