import type { AiExplanationInput } from "../../../ai-service/src/index.js";
import type { ProjectIntelligenceSnapshot, SourceFreshnessRecord } from "../intelligence/index.js";
import type { PotentialSignal } from "../intelligence/index.js";
import type { RiskContext } from "./risk-context-types.js";

/** Builds a bounded V3 addition to the existing V2 explanation input; no raw source record is copied. */
export function buildIntelligenceAiExplanationInput(input: { projectName: string; riskContexts: RiskContext[]; intelligence: ProjectIntelligenceSnapshot; potentialSignals: PotentialSignal[]; freshness: SourceFreshnessRecord[] }): AiExplanationInput {
  return {
    projectName: input.projectName,
    riskSignals: input.riskContexts.map((context) => ({ signalId: context.signalId, type: context.type })),
    riskContexts: input.riskContexts,
    limitations: input.riskContexts.length === 0 ? ["当前规则分析未提供可供 AI 解释的风险上下文。"] : [],
    intelligenceContext: {
      currentFacts: input.intelligence.currentFacts.map((item) => ({ subjectKey: item.subjectKey, value: safeClaimValue(item.fact.claim), sourceKinds: item.fact.evidence.map((evidence) => evidence.observation.provenance.context.sourceKind) })),
      candidates: input.intelligence.candidates.map((candidate) => ({ kind: claimKind(candidate.claim), summary: claimSummary(candidate.claim), sourceKinds: candidate.evidence.map((evidence) => evidence.observation.provenance.context.sourceKind) })),
      potentialSignals: input.potentialSignals.map((signal) => ({ kind: signal.kind, summary: signal.summary })),
      conflicts: input.intelligence.conflicts.map((conflict) => ({ sourceKinds: conflict.evidence.map((evidence) => evidence.observation.provenance.context.sourceKind) })),
      freshness: input.freshness.map((item) => ({ state: item.state })),
    },
  };
}
function claimKind(claim: unknown): string { return typeof claim === "object" && claim !== null && typeof (claim as { kind?: unknown }).kind === "string" ? (claim as { kind: string }).kind : "unresolved"; }
function claimSummary(claim: unknown): string { return typeof claim === "object" && claim !== null && typeof (claim as { summary?: unknown }).summary === "string" ? (claim as { summary: string }).summary.slice(0, 300) : "存在待确认信息。"; }
function safeClaimValue(claim: unknown): string { return typeof claim === "object" && claim !== null && typeof (claim as { value?: unknown }).value === "string" ? (claim as { value: string }).value.slice(0, 300) : "已准入结构化事实。"; }
