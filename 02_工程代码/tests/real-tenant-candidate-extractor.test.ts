import assert from "node:assert/strict";
import test from "node:test";

import { createRealTenantCandidateExtractor, MultiSourceIntelligenceService } from "../backend/src/intelligence/index.js";
import { createSourceReadSuccess, type ProjectSourceReadContext, type StandardProjectData } from "../feishu-connector/src/index.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

test("development real-tenant candidate verifier classifies tentative language without changing facts or risk input", async () => {
  const result = await new MultiSourceIntelligenceService(
    undefined,
    createRealTenantCandidateExtractor(),
    () => NOW,
  ).build({
    baseProjectData: baseData(),
    sourceResults: [baseSource(), chatSource("技术问题可能会在 9 月 4 日解决，明天再确认。")],
  });

  assert.deepEqual(result.intelligence.candidates.map((candidate) => (candidate.claim as { kind: string }).kind), ["pending-confirmation"]);
  assert.equal(result.intelligence.currentFacts.some((fact) => fact.subjectKey.includes("deadline")), true);
  assert.equal(result.risk.projectData.tasks[0]?.deadline, "2026-09-20");
  assert.equal(result.potentialSignals.some((signal) => signal.kind === "candidate"), true);
  assert.equal(JSON.stringify(result.aiInput).includes("技术问题可能会在"), false);
});

function baseData(): StandardProjectData {
  return {
    project: { id: "base-1", name: "Real tenant verifier", source: "feishu-base" },
    tasks: [{ id: "task-1", tableId: "table-1", tableName: "Tasks", name: "正式计划", owner: null, status: "进行中", deadline: "2026-09-20", riskLevel: null, description: null, attributes: {} }],
    metadata: { baseToken: "never-exposed", tableCount: 1, recordCount: 1, retrievedAt: NOW.toISOString(), accessMode: "read-only", tables: [{ id: "table-1", name: "Tasks", recordCount: 1 }] },
  };
}

function baseSource() {
  const data = baseData();
  const { baseToken: _token, ...metadata } = data.metadata;
  return createSourceReadSuccess({ context: context("source-base", "feishu-base"), data: { project: data.project, tasks: data.tasks, metadata }, resources: [], freshness: { fetchedAt: NOW.toISOString() } });
}

function chatSource(content: string) {
  return createSourceReadSuccess({
    context: context("source-chat", "feishu-chat"),
    data: { locator: { containerType: "chat" as const, containerId: "chat-1" }, messages: [{ messageId: "message-1", content }] },
    resources: [],
    freshness: { fetchedAt: NOW.toISOString() },
  });
}

function context(sourceRef: string, sourceKind: ProjectSourceReadContext["sourceKind"]): ProjectSourceReadContext {
  return {
    projectId: "project-1",
    sourceRef,
    sourceKind,
    subject: { userId: "user-1" },
    authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" },
    visibility: "allowed",
  };
}
