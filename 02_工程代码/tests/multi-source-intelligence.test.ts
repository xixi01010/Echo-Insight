import assert from "node:assert/strict";
import test from "node:test";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { admitCandidateFact, createCandidateFact, createEvidence, createObservation, MultiSourceIntelligenceService, type ProjectFactInput } from "../backend/src/intelligence/index.js";
import { createSourceReadSuccess, type ProjectSourceReadContext } from "../feishu-connector/src/index.js";
import type { StandardProjectData } from "../feishu-connector/src/index.js";

const NOW = new Date("2026-09-11T00:00:00.000Z");
test("full fixture wires authorized Sources through current facts, unchanged deterministic risk, and bounded AI context", async () => {
  const base = source("base", baseSnapshot());
  const chat = source("chat", { locator: { containerType: "chat", containerId: "chat-1" }, messages: [message("技术问题可能会在 9 月 4 日解决。"), message("那么我们可以将宣发节奏控制在 9 月 10 日进行宣发。"), message("那我们明天上午确认一下吧。")] });
  const minutes = source("minutes", { locator: { minuteToken: "minute-1" }, metadata: { minuteToken: "minute-1" }, transcript: { kind: "raw-transcript", state: "unavailable" }, artifacts: [{ kind: "platform-summary", content: "平台摘要" }], meetingRelation: { state: "unknown" } });
  const calendar = source("calendar", { locator: { calendarId: "cal-1", eventIds: ["event-1"] }, events: [{ eventId: "event-1", title: "Review Meeting", startTime: { date: "2026-09-09" }, attendees: [] }], syncToken: { state: "not-requested" } });
  const admitted = admittedDeadline(minutes, "2026-09-10");
  const service = new MultiSourceIntelligenceService(undefined, { extract: async ({ excerpt }) => [{ kind: excerpt.includes("宣发") ? "proposal" : excerpt.includes("明天") ? "pending-confirmation" : "prediction", summary: "已提取的待确认信息" }] }, () => NOW);
  const result = await service.build({ baseProjectData: baseData(), sourceResults: [base, chat, minutes, calendar], admittedFacts: [admitted], relations: [{ type: "supersedes", fromFactId: admitted.fact.factId, toFactId: "fact:task-deadline:task-1:1" }] });
  assert.equal(result.intelligence.currentFacts.find((item) => item.subjectKey === "task:task-1:task-deadline")?.fact.factId, admitted.fact.factId);
  assert.equal(result.intelligence.historicalFacts.some((item) => item.validity === "superseded"), true);
  assert.equal(result.projection.backgrounds.some((item) => JSON.stringify(item.content).includes("platformArtifacts")), true);
  assert.deepEqual(result.intelligence.candidates.map((item) => (item.claim as { kind: string }).kind), ["prediction", "proposal", "pending-confirmation"]);
  assert.equal(result.risk.analysis.riskSignals.some((signal) => signal.code === "TASK_BLOCKED"), true);
  assert.equal(result.potentialSignals.some((signal) => signal.kind === "candidate"), true);
  assert.equal(JSON.stringify(result.aiInput).includes("技术问题可能会在"), false);
  assert.equal(result.aiInput.intelligenceContext?.currentFacts.some((item) => item.value === "2026-09-10"), true);
});
test("a Chat prediction never changes Base deadline or its deterministic risk", async () => {
  const base = source("base", baseSnapshot()); const chat = source("chat", { locator: { containerType: "chat", containerId: "chat-1" }, messages: [message("可能延期到 Sep 10") ] });
  const result = await new MultiSourceIntelligenceService(undefined, { extract: async () => [{ kind: "potential-risk", summary: "存在延期可能" }] }, () => NOW).build({ baseProjectData: baseData(), sourceResults: [base, chat] });
  assert.equal(result.risk.projectData.tasks[0]?.deadline, "2026-09-04");
  assert.equal(result.intelligence.candidates.length, 1);
  assert.equal(result.risk.analysis.scoringDetails.ruleVersion, "mvp-v1");
});
test("unresolved Base/Task conflict does not let Task overwrite Risk input", async () => {
  const base = source("base", baseSnapshot()); const task = source("task", { locator: { taskIds: ["task-1"] }, tasks: [{ taskId: "task-1", due: { time: "2026-09-08" }, collaborators: [], followers: [] }] });
  const result = await new MultiSourceIntelligenceService(undefined, undefined, () => NOW).build({ baseProjectData: baseData(), sourceResults: [base, task] });
  assert.equal(result.intelligence.conflicts.length, 1); assert.equal(result.risk.projectData.tasks[0]?.deadline, "2026-09-04");
});
test("revoked Docs is removed before projection and AI input while other Sources remain", async () => {
  const base = source("base", baseSnapshot());
  const docs = { status: "unavailable" as const, context: { ...context("docs"), visibility: "denied" as const }, freshness: { fetchedAt: NOW.toISOString() } };
  const result = await new MultiSourceIntelligenceService(undefined, undefined, () => NOW).build({ baseProjectData: baseData(), sourceResults: [base, docs] });
  assert.equal(result.projection.evidence.some((item) => item.observation.provenance.context.sourceRef === "source-docs"), false);
  assert.equal(JSON.stringify(result.aiInput).includes("source-docs"), false);
  assert.equal(result.risk.analysis.riskSignals.some((signal) => signal.code === "TASK_BLOCKED"), true);
});
function baseData(): StandardProjectData { return { project: { id: "base-1", name: "Fixture Project", source: "feishu-base" }, tasks: [{ id: "task-1", tableId: "table-1", tableName: "Tasks", name: "技术问题", owner: null, status: "blocked", deadline: "2026-09-04", riskLevel: "L4", description: null, attributes: {} }], metadata: { baseToken: "never-exposed", tableCount: 1, recordCount: 1, retrievedAt: NOW.toISOString(), accessMode: "read-only", tables: [{ id: "table-1", name: "Tasks", recordCount: 1 }] } }; }
function baseSnapshot() { const data = baseData(); const { baseToken: _token, ...metadata } = data.metadata; return { project: { ...data.project, id: "source-base" }, tasks: data.tasks, metadata }; }
function source(kind: string, data: unknown) { const sourceContext = context(kind); return createSourceReadSuccess({ context: sourceContext, data, resources: [{ sourceRef: sourceContext.sourceRef, resourceType: kind }], freshness: { fetchedAt: NOW.toISOString() } }); }
function context(kind: string): ProjectSourceReadContext { const sourceKind = kind === "base" ? "feishu-base" : kind === "chat" ? "feishu-chat" : kind === "minutes" ? "feishu-minutes" : kind === "task" ? "feishu-task" : kind === "calendar" ? "feishu-calendar" : "feishu-docs"; return { projectId: "project-1", sourceRef: `source-${kind}`, sourceKind, subject: { userId: "member-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" }, visibility: "allowed" }; }
function message(content: string) { return { messageId: `message-${content.length}`, content }; }
function admittedDeadline(result: ReturnType<typeof source>, value: string): ProjectFactInput<{ kind: "task-deadline"; taskId: string; value: string }> { const evidence = createEvidence({ evidenceId: "evidence-minutes-confirmed", observation: createObservation({ observationId: "observation-minutes-confirmed", result, observedAt: NOW.toISOString() }) }); const candidate = createCandidateFact({ candidateFactId: "candidate-minutes-confirmed", claim: { kind: "task-deadline" as const, taskId: "task-1", value }, evidence: [evidence] }); return { fact: admitCandidateFact({ factId: "fact-minutes-confirmed", candidate, admittedAt: NOW.toISOString(), validity: "current" }), subjectKey: "task:task-1:task-deadline", claimFingerprint: value }; }
