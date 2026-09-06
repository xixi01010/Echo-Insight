import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateProjectHealth,
  type RiskEngineInput,
  type RiskEngineTask,
} from "../backend/src/risk-engine/index.js";

const NOW = new Date("2026-08-22T00:00:00.000Z");

function projectInput(tasks: RiskEngineTask[]): RiskEngineInput {
  return {
    project: {
      id: "project-1",
      name: "Echo Insight MVP",
      sensitivityMode: "robust",
    },
    tasks,
    metadata: {
      source: "feishu-base",
      accessMode: "read-only",
      generatedAt: NOW.toISOString(),
    },
  };
}

function task(overrides: Partial<RiskEngineTask> = {}): RiskEngineTask {
  return {
    id: "task-1",
    name: "测试任务",
    status: "进行中",
    deadline: "2026-08-30",
    riskLevel: "L1",
    isOverdue: false,
    dependencyIds: [],
    description: "规则引擎测试任务",
    ...overrides,
  };
}

function evaluate(input: RiskEngineInput) {
  return evaluateProjectHealth(input, { now: () => NOW });
}

test("normal project remains healthy at 100 points", () => {
  const result = evaluate(
    projectInput([
      task({ status: "已完成", deadline: "2026-08-20", riskLevel: "L1" }),
    ]),
  );

  assert.equal(result.healthScore, 100);
  assert.equal(result.healthStatus, "healthy");
  assert.equal(result.riskLevel, "L1");
  assert.deepEqual(result.riskSignals, []);
  assert.equal(result.scoringDetails.totalDeduction, 0);
});

test("single overdue task emits TASK_OVERDUE and deducts 15 points", () => {
  const result = evaluate(
    projectInput([
      task({ deadline: "2026-08-15", riskLevel: "L3", isOverdue: true }),
    ]),
  );

  assert.equal(result.healthScore, 85);
  assert.equal(result.healthStatus, "healthy");
  assert.equal(result.riskLevel, "L3");
  assert.equal(result.riskSignals.length, 1);
  assert.equal(result.riskSignals[0]?.code, "TASK_OVERDUE");
  assert.equal(result.scoringDetails.totalDeduction, 15);
});

test("single blocked task emits TASK_BLOCKED and deducts 25 points", () => {
  const result = evaluate(
    projectInput([task({ status: "阻塞", riskLevel: "L4" })]),
  );

  assert.equal(result.healthScore, 75);
  assert.equal(result.healthStatus, "needs-attention");
  assert.equal(result.riskLevel, "L4");
  assert.equal(result.riskSignals[0]?.code, "TASK_BLOCKED");
  assert.equal(result.scoringDetails.totalDeduction, 25);
});

test("blocked prerequisite emits DEPENDENCY_BLOCKED for its dependent task", () => {
  const result = evaluate(
    projectInput([
      task({ id: "task-prerequisite", status: "阻塞", riskLevel: "L4" }),
      task({
        id: "task-dependent",
        name: "后续任务",
        dependencyIds: ["task-prerequisite"],
        riskLevel: "L3",
      }),
    ]),
  );

  assert.equal(result.healthScore, 55);
  assert.equal(result.healthStatus, "at-risk");
  assert.equal(result.riskLevel, "L4");
  assert.equal(
    result.riskSignals.filter((signal) => signal.code === "DEPENDENCY_BLOCKED")
      .length,
    1,
  );
  assert.equal(result.scoringDetails.totalDeduction, 45);
});

test("multiple risks retain all signals but do not double-deduct blocked overdue task", () => {
  const result = evaluate(
    projectInput([
      task({
        id: "task-critical",
        status: "阻塞",
        deadline: "2026-08-15",
        isOverdue: true,
        riskLevel: "L4",
      }),
      task({
        id: "task-dependent",
        dependencyIds: ["task-critical", "task-critical"],
        riskLevel: "L3",
      }),
    ]),
  );

  assert.deepEqual(
    new Set(result.riskSignals.map((signal) => signal.code)),
    new Set(["TASK_BLOCKED", "TASK_OVERDUE", "DEPENDENCY_BLOCKED"]),
  );
  assert.equal(result.riskSignals.length, 3);
  assert.equal(result.scoringDetails.totalDeduction, 45);
  assert.equal(result.healthScore, 55);
});

test("missing task data emits MISSING_PROJECT_DATA with per-task cap", () => {
  const result = evaluate(
    projectInput([
      task({ deadline: null, riskLevel: null, dependencyIds: [] }),
    ]),
  );

  assert.equal(result.healthScore, 90);
  assert.equal(result.healthStatus, "healthy");
  assert.equal(result.riskLevel, "L2");
  assert.equal(result.riskSignals.length, 1);
  assert.equal(result.riskSignals[0]?.code, "MISSING_PROJECT_DATA");
  assert.equal(result.riskSignals[0]?.countedDeduction, 10);
});

test("blocked and overdue signals on the same task upgrade project to L5", () => {
  const result = evaluate(
    projectInput([
      task({
        status: "阻塞",
        deadline: "2026-08-15",
        isOverdue: true,
        riskLevel: "L4",
      }),
    ]),
  );

  assert.equal(result.riskLevel, "L5");
  assert.equal(result.healthScore, 75);
  assert.equal(result.healthStatus, "at-risk");
  assert.equal(result.scoringDetails.totalDeduction, 25);
  assert.equal(result.scoringDetails.escalationReasons.length, 1);
});
