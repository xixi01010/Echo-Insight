import type { ProjectIntelligenceSnapshot, SourceFreshnessRecord } from "./project-intelligence/index.js";

export type PotentialSignalKind = "candidate" | "possible-resolved" | "conflict" | "stale-source" | "source-unavailable";
export interface PotentialSignal { signalId: string; kind: PotentialSignalKind; summary: string; sourceKinds: string[]; }
export function buildPotentialSignals(snapshot: ProjectIntelligenceSnapshot, freshness: readonly SourceFreshnessRecord[]): PotentialSignal[] {
  return [
    ...snapshot.candidates.map((candidate, index) => ({ signalId: `potential:candidate:${index + 1}`, kind: candidate.claim && typeof candidate.claim === "object" && (candidate.claim as { kind?: string }).kind === "possible-resolution" ? "possible-resolved" as const : "candidate" as const, summary: candidateSummary(candidate.claim), sourceKinds: candidate.evidence.map((evidence) => evidence.observation.provenance.context.sourceKind) })),
    ...snapshot.conflicts.map((conflict) => ({ signalId: `potential:conflict:${conflict.conflictId}`, kind: "conflict" as const, summary: "当前存在未经解决的事实冲突，需要人工确认。", sourceKinds: conflict.evidence.map((evidence) => evidence.observation.provenance.context.sourceKind) })),
    ...freshness.filter((item) => item.state === "stale" || item.state === "unavailable" || item.state === "unknown").map((item) => ({ signalId: `potential:source:${item.sourceRef}`, kind: item.state === "stale" ? "stale-source" as const : "source-unavailable" as const, summary: item.state === "stale" ? "该来源上次成功读取结果可能已过期。" : "该来源当前不可用或状态未知。", sourceKinds: [] })),
  ];
}
function candidateSummary(claim: unknown): string { if (typeof claim === "object" && claim !== null && typeof (claim as { summary?: unknown }).summary === "string") return (claim as { summary: string }).summary.slice(0, 300); return "存在待确认的来源信息。"; }
