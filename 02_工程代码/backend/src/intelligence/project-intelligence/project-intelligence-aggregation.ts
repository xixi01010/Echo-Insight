import {
  createEvidenceConflict,
  type CandidateFact,
  type EffectiveFact,
  type Evidence,
  type EvidenceConflict,
} from "../evidence/index.js";
import type { ProjectDataSourceVisibility } from "../../project-context/project-data-source-visibility.js";

export type EvidenceRelationType = "supports" | "contradicts" | "supersedes" | "confirms" | "supplements";

/** The caller supplies semantic keys and fingerprints; this layer never infers natural-language meaning. */
export interface ProjectFactInput<T = unknown> {
  fact: EffectiveFact<T>;
  subjectKey: string;
  claimFingerprint: string;
}

export interface FactRelation {
  type: EvidenceRelationType;
  fromFactId: string;
  toFactId: string;
}

export interface CurrentEffectiveFact<T = unknown> {
  kind: "current-effective-fact";
  subjectKey: string;
  fact: EffectiveFact<T>;
  supportingFactIds: readonly string[];
}

export interface HistoricalEffectiveFact<T = unknown> {
  fact: EffectiveFact<T>;
  validity: "historical" | "superseded";
}

export interface ProjectIntelligenceSnapshot {
  facts: readonly ProjectFactInput[];
  candidates: readonly CandidateFact<unknown>[];
  relations: readonly FactRelation[];
  conflicts: readonly EvidenceConflict[];
  currentFacts: readonly CurrentEffectiveFact[];
  historicalFacts: readonly HistoricalEffectiveFact[];
  historicalFactIds: readonly string[];
}

export interface AggregateProjectIntelligenceInput {
  facts: readonly ProjectFactInput[];
  candidates?: readonly CandidateFact<unknown>[];
  relations?: readonly FactRelation[];
}

/**
 * Deterministically groups already-admitted facts. It preserves unresolved
 * disagreements and never uses Source kind, recency, or AI as a tie-breaker.
 */
export function aggregateProjectIntelligence(input: AggregateProjectIntelligenceInput): ProjectIntelligenceSnapshot {
  const facts = [...input.facts];
  const relations = [...(input.relations ?? [])];
  const superseded = new Set(relations.filter((relation) => relation.type === "supersedes").map((relation) => relation.toFactId));
  const activeFacts = facts.filter(({ fact }) => fact.admission.validity === "current" && !superseded.has(fact.factId));
  const conflicts: EvidenceConflict[] = [];
  const currentFacts: CurrentEffectiveFact[] = [];

  for (const [subjectKey, group] of groupBy(activeFacts, (item) => item.subjectKey)) {
    const fingerprints = groupBy(group, (item) => item.claimFingerprint);
    if (fingerprints.size > 1) {
      const evidence = group.flatMap((item) => item.fact.evidence);
      conflicts.push(createEvidenceConflict({ conflictId: `conflict:${subjectKey}`, evidence }));
      continue;
    }
    const first = group[0]!;
    currentFacts.push({
      kind: "current-effective-fact",
      subjectKey,
      fact: first.fact,
      supportingFactIds: group.map((item) => item.fact.factId),
    });
  }

  const conflictRelations = conflicts.flatMap((conflict) => relationPairs(conflict, facts));
  return {
    facts,
    candidates: [...(input.candidates ?? [])],
    relations: [...relations, ...conflictRelations],
    conflicts,
    currentFacts,
    historicalFacts: facts
      .filter(({ fact }) => fact.admission.validity !== "current" || superseded.has(fact.factId))
      .map(({ fact }) => ({ fact, validity: superseded.has(fact.factId) ? "superseded" as const : "historical" as const })),
    historicalFactIds: facts.filter(({ fact }) => fact.admission.validity !== "current" || superseded.has(fact.factId)).map(({ fact }) => fact.factId),
  };
}

/** Removes cached material whose source is not currently visible to this subject. */
export function selectVisibleProjectIntelligence(
  snapshot: ProjectIntelligenceSnapshot,
  visibilityBySourceRef: ReadonlyMap<string, ProjectDataSourceVisibility>,
): ProjectIntelligenceSnapshot {
  const visibleFacts = snapshot.facts.filter(({ fact }) => fact.evidence.every((evidence) => isEvidenceVisible(evidence, visibilityBySourceRef)));
  const visibleIds = new Set(visibleFacts.map(({ fact }) => fact.factId));
  const visibleCandidates = snapshot.candidates.filter((candidate) => candidate.evidence.every((evidence) => isEvidenceVisible(evidence, visibilityBySourceRef)));
  return aggregateProjectIntelligence({
    facts: visibleFacts,
    candidates: visibleCandidates,
    relations: snapshot.relations.filter((relation) => visibleIds.has(relation.fromFactId) && visibleIds.has(relation.toFactId) && relation.type !== "contradicts"),
  });
}

function isEvidenceVisible(evidence: Evidence<unknown>, visibilityBySourceRef: ReadonlyMap<string, ProjectDataSourceVisibility>): boolean {
  const currentVisibility = visibilityBySourceRef.get(evidence.observation.provenance.context.sourceRef);
  return (currentVisibility ?? evidence.observation.provenance.context.visibility) === "allowed";
}

function groupBy<T, TKey>(items: readonly T[], key: (item: T) => TKey): Map<TKey, T[]> {
  const groups = new Map<TKey, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

function relationPairs(conflict: EvidenceConflict, facts: readonly ProjectFactInput[]): FactRelation[] {
  const factIds = facts.filter((item) => item.fact.evidence.some((evidence) => conflict.evidence.includes(evidence))).map((item) => item.fact.factId);
  return factIds.flatMap((fromFactId) => factIds.filter((toFactId) => toFactId !== fromFactId).map((toFactId) => ({ type: "contradicts" as const, fromFactId, toFactId })));
}
