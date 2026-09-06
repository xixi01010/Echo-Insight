import assert from "node:assert/strict";
import test from "node:test";

import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import {
  admitCandidateFact, aggregateProjectIntelligence, createCandidateFact, createEvidence, createObservation,
  selectVisibleProjectIntelligence, SourceFreshnessService, type Evidence, type ProjectFactInput,
} from "../backend/src/intelligence/index.js";
import {
  createSourceReadSuccess, type ProjectSourceReadContext, type ProjectSourceReadResult, type ProjectSourceReader,
} from "../feishu-connector/src/index.js";

const TIME = "2026-08-29T12:00:00.000Z";

test("Scenario 1: matching Base, Task, and Minutes facts produce one current fact with multi-source support", () => {
  const result = aggregateProjectIntelligence({ facts: [fact("base", "Sep-10"), fact("task", "Sep-10"), fact("minutes", "Sep-10")] });
  assert.equal(result.currentFacts.length, 1);
  assert.deepEqual(result.currentFacts[0]?.supportingFactIds, ["fact-base", "fact-task", "fact-minutes"]);
  assert.equal(result.conflicts.length, 0);
});

test("Scenario 2: a Chat candidate never replaces the current structured Base fact", () => {
  const base = fact("base", "Sep-04");
  const chatCandidate = createCandidateFact({ candidateFactId: "candidate-chat", claim: { deadline: "Sep-10", qualifier: "可能" }, evidence: [evidence("chat")] });
  const result = aggregateProjectIntelligence({ facts: [base], candidates: [chatCandidate] });
  assert.equal(result.currentFacts[0]?.fact.factId, "fact-base");
  assert.equal(result.candidates[0]?.candidateFactId, "candidate-chat");
});

test("Scenario 3: explicit supersede keeps history and deterministically exposes the replacement", () => {
  const oldFact = fact("base-old", "Sep-04");
  const newFact = fact("minutes-new", "Sep-10");
  const result = aggregateProjectIntelligence({ facts: [oldFact, newFact], relations: [{ type: "supersedes", fromFactId: "fact-minutes-new", toFactId: "fact-base-old" }] });
  assert.equal(result.currentFacts[0]?.fact.factId, "fact-minutes-new");
  assert.deepEqual(result.historicalFactIds, ["fact-base-old"]);
  assert.equal(result.historicalFacts[0]?.validity, "superseded");
  assert.equal(result.relations.some((relation) => relation.type === "supersedes"), true);
});

test("Scenario 4: unresolved current disagreement stays a conflict and has no selected current fact", () => {
  const result = aggregateProjectIntelligence({ facts: [fact("base", "Sep-04"), fact("task", "Sep-08")] });
  assert.equal(result.currentFacts.length, 0);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.relations.filter((relation) => relation.type === "contradicts").length, 2);
});

test("Scenario 5: one source failure becomes stale without preventing other source freshness from remaining fresh", async () => {
  let timestamp = new Date(TIME);
  const freshness = new SourceFreshnessService(() => timestamp);
  const baseContext = context("base"); const minutesContext = context("minutes");
  freshness.record(success(baseContext)); freshness.record(success(minutesContext));
  timestamp = new Date("2026-08-29T13:00:00.000Z");
  const failedReader: ProjectSourceReader<{ context: ProjectSourceReadContext }, unknown> = { read: async (input) => ({ status: "failure", context: input.context, category: "transient", freshness: { fetchedAt: timestamp.toISOString() } }) };
  await freshness.revalidate(failedReader, { context: minutesContext });
  assert.equal(freshness.get(baseContext)?.state, "fresh");
  assert.equal(freshness.get(minutesContext)?.state, "stale");
  assert.equal(freshness.get(minutesContext)?.latestFailureCategory, "transient");
  assert.equal(freshness.getLastKnownUsable(minutesContext)?.status, "success");
});

test("Scenario 6: a revoked source is filtered from cached facts and stale fallback is erased", () => {
  const docsFact = fact("docs", "Sep-10");
  const snapshot = aggregateProjectIntelligence({ facts: [docsFact] });
  const visible = selectVisibleProjectIntelligence(snapshot, new Map([["source-docs", "denied" as const]]));
  assert.equal(visible.facts.length, 0);
  assert.equal(visible.currentFacts.length, 0);

  const service = new SourceFreshnessService(() => new Date(TIME));
  const docsContext = context("docs"); service.record(success(docsContext));
  service.record({ status: "unavailable", context: { ...docsContext, visibility: "denied" }, freshness: { fetchedAt: TIME } });
  assert.equal(service.getLastKnownUsable(docsContext), undefined);
});

function fact(source: string, fingerprint: string): ProjectFactInput<{ deadline: string }> {
  const candidate = createCandidateFact({ candidateFactId: `candidate-${source}`, claim: { deadline: fingerprint }, evidence: [evidence(source)] });
  return { fact: admitCandidateFact({ factId: `fact-${source}`, candidate, admittedAt: TIME, validity: "current" }), subjectKey: "project.deadline", claimFingerprint: fingerprint };
}
function evidence(source: string): Evidence<unknown> { return createEvidence({ evidenceId: `evidence-${source}`, observation: createObservation({ observationId: `observation-${source}`, result: success(context(source)), observedAt: TIME, occurredAt: "2026-08-20T00:00:00.000Z" }) }); }
function success(contextValue: ProjectSourceReadContext) { return createSourceReadSuccess({ context: contextValue, data: { source: contextValue.sourceRef }, resources: [{ sourceRef: contextValue.sourceRef, resourceType: "fixture", resourceId: contextValue.sourceRef }], freshness: { fetchedAt: TIME, revision: "revision-1" } }); }
function context(source: string): ProjectSourceReadContext { const kind = source === "base" || source === "base-old" ? "feishu-base" : source === "task" ? "feishu-task" : source.startsWith("minutes") || source === "minutes" ? "feishu-minutes" : source === "chat" ? "feishu-chat" : "feishu-docs"; return { projectId: "project-1", sourceRef: `source-${source}`, sourceKind: kind, subject: { userId: "member-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" }, visibility: "allowed" }; }
