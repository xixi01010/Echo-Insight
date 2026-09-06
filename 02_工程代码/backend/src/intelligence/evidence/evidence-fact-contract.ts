import type {
  FeishuBaseSourceSnapshot,
} from "../../../../feishu-connector/src/base-reader.js";
import type {
  ProjectSourceReadContext,
  SourceReadSuccess,
  SourceResourceLocator,
} from "../../../../feishu-connector/src/source-contract.js";

export type FactValidity = "current" | "historical" | "superseded";

/** A source record as observed for one visible project subject. It is not a fact. */
export interface Observation<T> {
  kind: "observation";
  observationId: string;
  record: T;
  provenance: {
    context: ProjectSourceReadContext;
    resources: readonly SourceResourceLocator[];
    observedAt: string;
    occurredAt?: string;
    fetchedAt: string;
    sourceUpdatedAt?: string;
  };
}

/** A visible observation that may support a later project judgement. */
export interface Evidence<T> {
  kind: "evidence";
  evidenceId: string;
  observation: Observation<T>;
}

/** A proposed project fact; it remains unconfirmed until explicit admission. */
export interface CandidateFact<T> {
  kind: "candidate-fact";
  candidateFactId: string;
  state: "unconfirmed";
  claim: T;
  evidence: readonly Evidence<unknown>[];
}

/** A separately-created fact that has passed an explicit admission action. */
export interface EffectiveFact<T> {
  kind: "effective-fact";
  factId: string;
  candidateFactId: string;
  claim: T;
  evidence: readonly Evidence<unknown>[];
  admission: {
    admittedAt: string;
    validity: FactValidity;
  };
}

/** Unresolved evidence is retained without selecting a winning source. */
export interface EvidenceConflict {
  kind: "evidence-conflict";
  conflictId: string;
  evidence: readonly Evidence<unknown>[];
  state: "unresolved";
}

/** Visible material that can inform AI or a human but is not a project fact. */
export interface BackgroundContext<T> {
  kind: "background-context";
  backgroundId: string;
  content: T;
  evidence: readonly Evidence<unknown>[];
}

export class EvidenceAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceAdmissionError";
  }
}

export function createObservation<T>(input: {
  observationId: string;
  result: SourceReadSuccess<T>;
  observedAt: string;
  occurredAt?: string;
}): Observation<T> {
  return {
    kind: "observation",
    observationId: input.observationId,
    record: input.result.data,
    provenance: {
      context: input.result.context,
      resources: input.result.resources,
      observedAt: input.observedAt,
      ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
      fetchedAt: input.result.freshness.fetchedAt,
      ...(input.result.freshness.sourceUpdatedAt
        ? { sourceUpdatedAt: input.result.freshness.sourceUpdatedAt }
        : {}),
    },
  };
}

export function createEvidence<T>(input: {
  evidenceId: string;
  observation: Observation<T>;
}): Evidence<T> {
  if (!isVisibleAuthorizedObservation(input.observation)) {
    throw new EvidenceAdmissionError(
      "Only visible and authorized source observations may become evidence.",
    );
  }
  return { kind: "evidence", ...input };
}

export function createCandidateFact<T>(input: {
  candidateFactId: string;
  claim: T;
  evidence: readonly Evidence<unknown>[];
}): CandidateFact<T> {
  requireEvidence(input.evidence, "Candidate fact");
  return { kind: "candidate-fact", ...input, state: "unconfirmed" };
}

/** This is the only contract API that creates an EffectiveFact. */
export function admitCandidateFact<T>(input: {
  factId: string;
  candidate: CandidateFact<T>;
  admittedAt: string;
  validity: FactValidity;
}): EffectiveFact<T> {
  return {
    kind: "effective-fact",
    factId: input.factId,
    candidateFactId: input.candidate.candidateFactId,
    claim: input.candidate.claim,
    evidence: input.candidate.evidence,
    admission: { admittedAt: input.admittedAt, validity: input.validity },
  };
}

export function createEvidenceConflict(input: {
  conflictId: string;
  evidence: readonly Evidence<unknown>[];
}): EvidenceConflict {
  if (input.evidence.length < 2) {
    throw new EvidenceAdmissionError("A conflict requires at least two evidence items.");
  }
  return { kind: "evidence-conflict", ...input, state: "unresolved" };
}

export function createBackgroundContext<T>(input: {
  backgroundId: string;
  content: T;
  evidence: readonly Evidence<unknown>[];
}): BackgroundContext<T> {
  requireEvidence(input.evidence, "Background context");
  return { kind: "background-context", ...input };
}

/**
 * V2 Base enters this contract only after the FND-04 reader has produced its
 * token-free snapshot. Existing StandardProjectData and Risk paths stay intact.
 */
export function createBaseObservation(input: {
  observationId: string;
  result: SourceReadSuccess<FeishuBaseSourceSnapshot>;
  observedAt: string;
  occurredAt?: string;
}): Observation<FeishuBaseSourceSnapshot> {
  if (input.result.context.sourceKind !== "feishu-base") {
    throw new EvidenceAdmissionError("Base observations require a feishu-base source result.");
  }
  return createObservation(input);
}

function isVisibleAuthorizedObservation(observation: Observation<unknown>): boolean {
  const { context } = observation.provenance;
  return context.visibility === "allowed"
    && context.authorization.sourceAuthorization === "authorized"
    && context.authorization.subjectEligibility === "allowed";
}

function requireEvidence(evidence: readonly Evidence<unknown>[], label: string): void {
  if (evidence.length === 0) {
    throw new EvidenceAdmissionError(`${label} requires at least one evidence item.`);
  }
}
