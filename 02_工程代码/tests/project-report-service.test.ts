import assert from "node:assert/strict";
import test from "node:test";

import type {
  AiExplanationInput,
  AiExplanationOutput,
  RiskExplanationAnalyzer,
} from "../ai-service/src/index.js";
import { ProjectAnalysisService } from "../backend/src/analysis-service/index.js";
import { ProjectReportService } from "../backend/src/ai-analysis-service/index.js";
import type {
  ProjectDataReader,
  StandardProjectData,
  StandardTask,
} from "../feishu-connector/src/index.js";

const NOW = new Date("2026-08-22T00:00:00.000Z");

class RecordingAnalyzer implements RiskExplanationAnalyzer {
  inputs: AiExplanationInput[] = [];

  async analyze(input: AiExplanationInput): Promise<AiExplanationOutput> {
    this.inputs.push(input);
    return {
      risks: input.riskContexts.map((context) => ({
        id: context.signalId,
        title: context.type,
        evidenceRefs: [context.signalId],
        reason: context.factualEvidence.join(" ") || "当前缺少可引用的任务事实。",
        impact: "项目计划可能受影响。",
        suggestedActions: ["由项目负责人确认后续安排。"],
      })),
      limitations: ["仅基于已授权的结构化项目数据。", ...input.limitations],
    };
  }
}

function task(overrides: Partial<StandardTask> = {}): StandardTask {
  return {
    id: "task-1",
    tableId: "table-1",
    tableName: "Tasks",
    name: "测试任务",
    owner: null,
    status: "进行中",
    deadline: "2026-08-30",
    riskLevel: "L1",
    description: "仅用于验收。",
    attributes: {},
    ...overrides,
  };
}

function projectData(tasks: StandardTask[]): StandardProjectData {
  return {
    project: { id: "base-1", name: "Echo Project", source: "feishu-base" },
    tasks,
    metadata: {
      baseToken: "base-1",
      tableCount: 1,
      recordCount: tasks.length,
      retrievedAt: NOW.toISOString(),
      accessMode: "read-only",
      tables: [{ id: "table-1", name: "Tasks", recordCount: tasks.length }],
    },
  };
}

async function reportFor(tasks: StandardTask[]) {
  const reader: ProjectDataReader = { readProjectData: async () => projectData(tasks) };
  const analyzer = new RecordingAnalyzer();
  const analysis = new ProjectAnalysisService(reader, () => NOW);
  const service = new ProjectReportService(analysis, analyzer);
  return { result: await service.createProjectReport("base-1"), analyzer };
}

test("normal project keeps rule fields separate from V2 AI output", async () => {
  const { result, analyzer } = await reportFor([task({ status: "已完成", deadline: "2026-08-20" })]);

  assert.equal(result.analysis.healthStatus, "healthy");
  assert.equal(result.aiStatus, "available");
  assert.deepEqual(Object.keys(result.aiReport).sort(), ["limitations", "risks"]);
  assert.ok(Array.isArray(result.aiReport.limitations));
  assert.equal(analyzer.inputs.length, 1);
  assert.equal(JSON.stringify(analyzer.inputs[0]).includes("healthScore"), false);
  assert.equal(JSON.stringify(analyzer.inputs[0]).includes("riskLevel"), false);
});

test("AI failure preserves deterministic health and risk results", async () => {
  const reader: ProjectDataReader = {
    readProjectData: async () => projectData([task({ status: "阻塞", riskLevel: "L4" })]),
  };
  const service = new ProjectReportService(
    new ProjectAnalysisService(reader, () => NOW),
    { analyze: async () => { throw new Error("provider output unavailable"); } },
  );

  const result = await service.createProjectReport("base-1");

  assert.equal(result.aiStatus, "unavailable");
  assert.ok(result.analysis.riskSignals.some((signal) => signal.code === "TASK_BLOCKED"));
  assert.equal(result.riskContexts[0]?.type, "TASK_BLOCKED");
  assert.deepEqual(result.aiReport.risks, []);
  assert.match(result.aiReport.limitations[0] ?? "", /规则风险已正常更新/);
});

test("overdue task produces a TASK_OVERDUE explanation", async () => {
  const { result } = await reportFor([task({ deadline: "2026-08-15", riskLevel: "L3" })]);

  assert.ok(result.analysis.riskSignals.some((signal) => signal.code === "TASK_OVERDUE"));
  assert.ok(result.aiReport.risks.some((risk) => risk.title === "TASK_OVERDUE"));
});

test("blocked task produces a TASK_BLOCKED explanation", async () => {
  const { result, analyzer } = await reportFor([
    task({ status: "阻塞", riskLevel: "L4" }),
  ]);

  assert.ok(result.analysis.riskSignals.some((signal) => signal.code === "TASK_BLOCKED"));
  assert.equal(result.riskContexts[0]?.type, "TASK_BLOCKED");
  assert.equal(result.riskContexts[0]?.primaryTask?.name, "测试任务");
  assert.equal(analyzer.inputs[0]?.riskContexts[0]?.primaryTask?.name, "测试任务");
  assert.equal(JSON.stringify(analyzer.inputs[0]).includes("taskId"), false);
  assert.equal(JSON.stringify(analyzer.inputs[0]).includes("relatedTaskIds"), false);
  assert.ok(result.aiReport.risks.some((risk) => risk.title === "TASK_BLOCKED"));
});

test("blocked dependency produces a DEPENDENCY_BLOCKED explanation", async () => {
  const { result } = await reportFor([
    task({ id: "task-prerequisite", status: "阻塞", riskLevel: "L4" }),
    task({
      id: "task-dependent",
      riskLevel: "L3",
      attributes: { dependencyIds: ["task-prerequisite"] },
    }),
  ]);

  assert.ok(result.analysis.riskSignals.some((signal) => signal.code === "DEPENDENCY_BLOCKED"));
  assert.ok(result.aiReport.risks.some((risk) => risk.title === "DEPENDENCY_BLOCKED"));
});

test("explanation cache reuses AI output while facts are unchanged", async () => {
  const reader: ProjectDataReader = { readProjectData: async () => projectData([task()]) };
  const analysis = new ProjectAnalysisService(reader, () => NOW);
  const analyzer = new RecordingAnalyzer();
  const service = new ProjectReportService(analysis, analyzer, 60_000);

  const first = await service.createProjectReport("base-1");
  const second = await service.createProjectReport("base-1");

  assert.equal(analyzer.inputs.length, 1);
  assert.equal(second.aiStatus, "available");
  assert.deepEqual(second.aiReport, first.aiReport);
  assert.deepEqual(second.analysis, first.analysis);
});

test("explanation cache refetches when the fingerprint changes", async () => {
  let tasks = [task()];
  const reader: ProjectDataReader = { readProjectData: async () => projectData(tasks) };
  const analysis = new ProjectAnalysisService(reader, () => NOW);
  const analyzer = new RecordingAnalyzer();
  const service = new ProjectReportService(analysis, analyzer, 60_000);

  await service.createProjectReport("base-1");
  tasks = [task(), task({ id: "task-2", name: "阻塞任务", status: "阻塞", riskLevel: "L4" })];
  const second = await service.createProjectReport("base-1");

  assert.equal(analyzer.inputs.length, 2);
  assert.ok(second.analysis.riskSignals.some((signal) => signal.code === "TASK_BLOCKED"));
});

test("unavailable AI explanations are not cached", async () => {
  let attempts = 0;
  const reader: ProjectDataReader = { readProjectData: async () => projectData([task()]) };
  const analysis = new ProjectAnalysisService(reader, () => NOW);
  const service = new ProjectReportService(analysis, {
    analyze: async () => {
      attempts += 1;
      throw new Error("provider unavailable");
    },
  }, 60_000);

  const first = await service.createProjectReport("base-1");
  const second = await service.createProjectReport("base-1");

  assert.equal(first.aiStatus, "unavailable");
  assert.equal(second.aiStatus, "unavailable");
  assert.equal(attempts, 2);
});