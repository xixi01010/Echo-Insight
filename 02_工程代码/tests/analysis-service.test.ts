import assert from "node:assert/strict";
import test from "node:test";

import { ProjectAnalysisService } from "../backend/src/analysis-service/index.js";
import type {
  ProjectDataReader,
  StandardProjectData,
  StandardTask,
} from "../feishu-connector/src/index.js";

const NOW = new Date("2026-08-22T00:00:00.000Z");

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
    description: null,
    attributes: {},
    ...overrides,
  };
}

function service(reader?: ProjectDataReader): ProjectAnalysisService {
  return new ProjectAnalysisService(reader ?? { readProjectData: async () => projectData([]) }, () => NOW);
}

test("analysis service reads normal project data then returns healthy analysis", async () => {
  const data = projectData([task({ status: "已完成", deadline: "2026-08-20" })]);
  let requestedToken = "";
  const result = await service({
    readProjectData: async (baseToken) => {
      requestedToken = baseToken;
      return data;
    },
  }).analyzeProject("base-1");

  assert.equal(requestedToken, "base-1");
  assert.equal(result.projectData, data);
  assert.equal(result.analysis.healthStatus, "healthy");
  assert.equal(result.analysis.healthScore, 100);
  assert.deepEqual(result.analysis.riskSignals, []);
});

test("analysis service maps an overdue standardized task to TASK_OVERDUE", () => {
  const result = service().analyzeProjectData(
    projectData([task({ deadline: "2026-08-15", riskLevel: "L3" })]),
  );

  assert.equal(result.analysis.healthScore, 85);
  assert.equal(result.analysis.riskSignals[0]?.code, "TASK_OVERDUE");
});

test("analysis service maps a blocked standardized task to TASK_BLOCKED", () => {
  const result = service().analyzeProjectData(
    projectData([task({ status: "阻塞", riskLevel: "L4" })]),
  );

  assert.equal(result.analysis.healthScore, 75);
  assert.equal(result.analysis.riskSignals[0]?.code, "TASK_BLOCKED");
});

test("analysis service maps dependencyIds attributes to DEPENDENCY_BLOCKED", () => {
  const result = service().analyzeProjectData(
    projectData([
      task({ id: "task-prerequisite", status: "阻塞", riskLevel: "L4" }),
      task({
        id: "task-dependent",
        riskLevel: "L3",
        attributes: { dependencyIds: ["task-prerequisite"] },
      }),
    ]),
  );

  assert.equal(result.analysis.healthScore, 55);
  assert.ok(
    result.analysis.riskSignals.some(
      (signal) => signal.code === "DEPENDENCY_BLOCKED",
    ),
  );
});
