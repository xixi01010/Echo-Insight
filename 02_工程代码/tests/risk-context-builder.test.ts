import assert from "node:assert/strict";
import test from "node:test";

import { buildRiskContexts } from "../backend/src/ai-analysis-service/index.js";
import type {
  PrimaryTaskContext,
  RelatedTaskContext,
  RiskContext,
} from "../backend/src/ai-analysis-service/index.js";
import type { ProjectAnalysisResult } from "../backend/src/analysis-service/index.js";
import type { RiskSignal } from "../backend/src/risk-engine/index.js";
import type { StandardProjectData, StandardTask } from "../feishu-connector/src/index.js";

function task(overrides: Partial<StandardTask> = {}): StandardTask {
  return {
    id: "rec-primary",
    tableId: "tbl-tasks",
    tableName: "Tasks",
    name: "接口联调",
    owner: "陈晨",
    status: "阻塞",
    deadline: "2026-08-28",
    riskLevel: "L4",
    description: "等待测试环境恢复。",
    attributes: {},
    ...overrides,
  };
}

function signal(overrides: Partial<RiskSignal> = {}): RiskSignal {
  return {
    signalId: "signal-001",
    code: "TASK_BLOCKED",
    level: "L4",
    taskId: "rec-primary",
    relatedTaskIds: [],
    evidence: "任务 rec-primary 状态为阻塞。",
    deduction: 25,
    countedDeduction: 25,
    ...overrides,
  };
}

function projectData(tasks: StandardTask[]): StandardProjectData {
  return {
    project: {
      id: "base-project",
      name: "Echo Insight",
      source: "feishu-base",
    },
    tasks,
    metadata: {
      baseToken: "sensitive-base-token",
      tableCount: 1,
      recordCount: tasks.length,
      retrievedAt: "2026-08-25T00:00:00.000Z",
      accessMode: "read-only",
      tables: [{ id: "tbl-tasks", name: "Tasks", recordCount: tasks.length }],
    },
  };
}

function analysisResult(
  tasks: StandardTask[],
  riskSignals: RiskSignal[],
): ProjectAnalysisResult {
  return {
    projectData: projectData(tasks),
    analysis: {
      healthScore: 75,
      healthStatus: "needs-attention",
      riskLevel: "L4",
      riskSignals,
      scoringDetails: {
        baseScore: 100,
        totalDeduction: 25,
        ruleVersion: "mvp-v1",
        calculatedAt: "2026-08-25T00:00:00.000Z",
        deductions: [],
        escalationReasons: [],
      },
    },
  };
}

test("TASK_BLOCKED resolves the correct primary task facts", () => {
  const [context] = buildRiskContexts(analysisResult([task()], [signal()]));
  const typedContext: RiskContext | undefined = context;
  const typedPrimaryTask: PrimaryTaskContext | null | undefined =
    typedContext?.primaryTask;

  assert.equal(typedContext?.type, "TASK_BLOCKED");
  assert.deepEqual(typedPrimaryTask, {
    name: "接口联调",
    status: "阻塞",
    deadline: "2026-08-28",
    owner: "陈晨",
    description: "等待测试环境恢复。",
  });
  assert.match(context?.factualEvidence.join(" ") ?? "", /接口联调/);
  assert.match(context?.factualEvidence.join(" ") ?? "", /阻塞/);
});

test("RiskContext standardizes numeric deadline timestamps before exposure", () => {
  const [context] = buildRiskContexts(
    analysisResult([task({ deadline: "1787875200000" })], [signal()]),
  );

  assert.equal(context?.primaryTask?.deadline, "2026-08-28");
  assert.match(context?.factualEvidence.join(" ") ?? "", /2026-08-28/);
  assert.doesNotMatch(context?.factualEvidence.join(" ") ?? "", /1787875200000/);
});

test("DEPENDENCY_BLOCKED resolves the dependent and prerequisite tasks", () => {
  const dependent = task({
    id: "rec-dependent",
    name: "上线验收",
    status: "进行中",
    description: "等待接口联调完成。",
  });
  const prerequisite = task({
    id: "rec-prerequisite",
    name: "接口联调",
  });
  const [context] = buildRiskContexts(
    analysisResult(
      [dependent, prerequisite],
      [
        signal({
          code: "DEPENDENCY_BLOCKED",
          taskId: "rec-dependent",
          relatedTaskIds: ["rec-prerequisite"],
          deduction: 20,
          countedDeduction: 20,
        }),
      ],
    ),
  );
  const typedRelatedTasks: RelatedTaskContext[] | undefined =
    context?.relatedTasks;

  assert.equal(context?.primaryTask?.name, "上线验收");
  assert.deepEqual(typedRelatedTasks, [
    { name: "接口联调", status: "阻塞", deadline: "2026-08-28" },
  ]);
  assert.match(context?.factualEvidence.join(" ") ?? "", /前置依赖任务/);
});

test("missing task fields produce explicit data limitations", () => {
  const [context] = buildRiskContexts(
    analysisResult(
      [
        task({
          name: "",
          owner: null,
          status: null,
          deadline: null,
          description: null,
        }),
      ],
      [signal()],
    ),
  );

  assert.equal(context?.primaryTask?.name, null);
  assert.ok(context?.dataLimitations.includes("关联任务缺少任务名称。"));
  assert.ok(context?.dataLimitations.includes("关联任务缺少任务状态。"));
  assert.ok(context?.dataLimitations.includes("关联任务缺少截止日期。"));
  assert.ok(context?.dataLimitations.includes("关联任务缺少负责人信息。"));
  assert.ok(context?.dataLimitations.includes("关联任务缺少任务说明。"));
});

test("risk contexts do not expose record, table, token, or raw attribute values", () => {
  const [context] = buildRiskContexts(
    analysisResult(
      [
        task({
          description: "阻塞记录 rec-primary 需要处理。",
          attributes: {
            internalSecret: "attribute-secret",
            dependencyIds: ["rec-related"],
          },
        }),
      ],
      [signal()],
    ),
  );
  const serialized = JSON.stringify(context);

  assert.doesNotMatch(serialized, /rec-primary/);
  assert.doesNotMatch(serialized, /tbl-tasks/);
  assert.doesNotMatch(serialized, /sensitive-base-token/);
  assert.doesNotMatch(serialized, /attribute-secret|internalSecret/);
  assert.equal(context?.primaryTask?.description, undefined);
  assert.ok(context?.dataLimitations.includes("关联任务缺少任务说明。"));
  assert.deepEqual(Object.keys(context ?? {}).sort(), [
    "dataLimitations",
    "factualEvidence",
    "primaryTask",
    "relatedTasks",
    "signalId",
    "type",
  ]);
});

test("an unmatched task association does not fabricate task facts", () => {
  const [context] = buildRiskContexts(
    analysisResult(
      [],
      [signal({ taskId: "rec-missing", evidence: "任务 rec-missing 状态为阻塞。" })],
    ),
  );

  assert.equal(context?.primaryTask, null);
  assert.deepEqual(context?.relatedTasks, []);
  assert.deepEqual(context?.factualEvidence, []);
  assert.ok(
    context?.dataLimitations.includes(
      "未能在当前授权项目数据中解析与该风险关联的任务。",
    ),
  );
  assert.doesNotMatch(JSON.stringify(context), /rec-missing/);
});
