import assert from "node:assert/strict";
import test from "node:test";

import {
  admitCandidateFact,
  createBackgroundContext,
  createBaseObservation,
  createCandidateFact,
  createEvidence,
  createEvidenceConflict,
  createObservation,
  EvidenceAdmissionError,
  type EffectiveFact,
} from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import {
  FeishuBaseSourceReaderAdapter,
  createSourceReadSuccess,
  type ProjectDataReader,
  type ProjectSourceReadContext,
  type SourceReadSuccess,
  type StandardProjectData,
} from "../feishu-connector/src/index.js";

const TIME = "2026-08-28T09:00:00.000Z";
const IDENTITY = toFeishuOpenIdIdentityRef("ou_subject", "cli_echo");

function context(overrides: Partial<ProjectSourceReadContext> = {}): ProjectSourceReadContext {
  return {
    projectId: "project-1",
    sourceRef: "source-1",
    sourceKind: "feishu-base",
    subject: { userId: "user-1", identity: IDENTITY },
    authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" },
    visibility: "allowed",
    ...overrides,
  };
}

function result<T>(
  data: T,
  sourceContext: ProjectSourceReadContext = context(),
): SourceReadSuccess<T> {
  return createSourceReadSuccess({
    context: sourceContext,
    data,
    resources: [{ sourceRef: sourceContext.sourceRef, resourceType: "record", resourceId: "record-1" }],
    freshness: { fetchedAt: TIME, sourceUpdatedAt: "2026-08-27T09:00:00.000Z" },
  });
}

function admittedEvidence() {
  return createEvidence({
    evidenceId: "evidence-1",
    observation: createObservation({
      observationId: "observation-1",
      result: result({ text: "可能下周完成" }),
      observedAt: TIME,
      occurredAt: "2026-08-28T08:00:00.000Z",
    }),
  });
}

test("observation preserves FND-02/FND-03/FND-04 provenance but is not an EffectiveFact", () => {
  const observation = createObservation({
    observationId: "observation-1",
    result: result({ text: "可能下周完成" }),
    observedAt: TIME,
    occurredAt: "2026-08-28T08:00:00.000Z",
  });

  assert.equal(observation.kind, "observation");
  assert.equal(observation.provenance.context.projectId, "project-1");
  assert.equal(observation.provenance.context.sourceRef, "source-1");
  assert.equal(observation.provenance.context.subject.identity, IDENTITY);
  assert.deepEqual(observation.provenance.resources[0], {
    sourceRef: "source-1", resourceType: "record", resourceId: "record-1",
  });
  assert.equal(observation.provenance.observedAt, TIME);
  assert.equal(observation.provenance.fetchedAt, TIME);
  // @ts-expect-error Observation is deliberately not a formally admitted fact.
  const _notAnEffectiveFact: EffectiveFact<unknown> = observation;
  void _notAnEffectiveFact;
});

test("denied, unknown, and unavailable source observations cannot produce evidence", () => {
  for (const sourceContext of [
    context({
      authorization: { sourceAuthorization: "authorized", subjectEligibility: "denied" },
      visibility: "denied",
    }),
    context({
      authorization: { sourceAuthorization: "unknown", subjectEligibility: "unknown" },
      visibility: "unknown",
    }),
    context({
      authorization: { sourceAuthorization: "unavailable", subjectEligibility: "unknown" },
      visibility: "source-unavailable",
    }),
  ]) {
    const observation = createObservation({
      observationId: "observation-blocked",
      result: result({ text: "not admissible" }, sourceContext),
      observedAt: TIME,
    });
    assert.throws(
      () => createEvidence({ evidenceId: "blocked", observation }),
      EvidenceAdmissionError,
    );
  }
});

test("candidate facts require evidence and become effective only through explicit admission", () => {
  const evidence = admittedEvidence();
  const candidate = createCandidateFact({
    candidateFactId: "candidate-1",
    claim: { deadline: "2026-09-04" },
    evidence: [evidence],
  });
  const effective = admitCandidateFact({
    factId: "fact-1",
    candidate,
    admittedAt: TIME,
    validity: "current",
  });

  assert.equal(candidate.kind, "candidate-fact");
  assert.equal(candidate.state, "unconfirmed");
  assert.equal(effective.kind, "effective-fact");
  assert.equal(effective.candidateFactId, candidate.candidateFactId);
  assert.equal(effective.admission.validity, "current");
  // @ts-expect-error A CandidateFact cannot be passed where an EffectiveFact is required.
  const _candidateIsNotEffective: EffectiveFact<{ deadline: string }> = candidate;
  void _candidateIsNotEffective;
  assert.throws(
    () => createCandidateFact({ candidateFactId: "empty", claim: "x", evidence: [] }),
    EvidenceAdmissionError,
  );
});

test("conflicts remain unresolved and background context is separate from admitted facts", () => {
  const first = admittedEvidence();
  const second = createEvidence({
    evidenceId: "evidence-2",
    observation: createObservation({
      observationId: "observation-2",
      result: result({ text: "发布日期调整到 9 月 10 日" }),
      observedAt: TIME,
    }),
  });
  const conflict = createEvidenceConflict({ conflictId: "conflict-1", evidence: [first, second] });
  const background = createBackgroundContext({
    backgroundId: "background-1",
    content: { text: "项目背景说明" },
    evidence: [first],
  });

  assert.equal(conflict.state, "unresolved");
  assert.equal(background.kind, "background-context");
  if (false) {
    // @ts-expect-error Background context cannot be passed to the admission API.
    admitCandidateFact({ factId: "bad", candidate: background, admittedAt: TIME, validity: "current" });
  }
  assert.throws(
    () => createEvidenceConflict({ conflictId: "invalid", evidence: [first] }),
    EvidenceAdmissionError,
  );
});

test("different allowed source kinds keep provenance without priority or numeric confidence", () => {
  const chatContext = context({ sourceRef: "chat-1", sourceKind: "feishu-chat" });
  const evidence = createEvidence({
    evidenceId: "chat-evidence",
    observation: createObservation({
      observationId: "chat-observation",
      result: result({ text: "讨论记录" }, chatContext),
      observedAt: TIME,
    }),
  });

  assert.equal(evidence.observation.provenance.context.sourceKind, "feishu-chat");
  assert.equal("confidence" in evidence, false);
  assert.equal("sourcePriority" in evidence, false);
});

test("V2 Base data projects through the token-free FND-04 result without changing the V2 path", async () => {
  const legacyData: StandardProjectData = {
    project: { id: "base-token", name: "V2 Base", source: "feishu-base" },
    tasks: [],
    metadata: {
      baseToken: "base-token",
      tableCount: 0,
      recordCount: 0,
      retrievedAt: TIME,
      accessMode: "read-only",
      tables: [],
    },
  };
  const reader: ProjectDataReader = { readProjectData: async () => legacyData };
  const readResult = await new FeishuBaseSourceReaderAdapter(reader).read({
    context: context(),
    baseToken: "base-token",
  });

  assert.equal(readResult.status, "success");
  if (readResult.status !== "success") throw new Error("expected Base source read success");
  const observation = createBaseObservation({
    observationId: "base-observation",
    result: readResult,
    observedAt: TIME,
  });
  assert.equal(observation.record.project.id, "source-1");
  assert.equal("baseToken" in observation.record.metadata, false);
  // @ts-expect-error The safe Base observation is still not an effective fact.
  const _baseObservationIsNotEffective: EffectiveFact<unknown> = observation;
  void _baseObservationIsNotEffective;
});
