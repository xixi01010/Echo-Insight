import {
  admitCandidateFact, createBackgroundContext, createCandidateFact, createEvidence, createObservation,
  type BackgroundContext, type CandidateFact, type EffectiveFact, type Evidence, type ProjectFactInput,
} from "./index.js";
import type { ProjectSourceReadResult, SourceReadSuccess } from "../../../feishu-connector/src/source-contract.js";
import type { FeishuBaseSourceSnapshot } from "../../../feishu-connector/src/base-reader.js";
import type { FeishuChatSourceSnapshot } from "../../../feishu-connector/src/chat-reader.js";
import type { FeishuMinutesSourceSnapshot } from "../../../feishu-connector/src/minutes-reader.js";
import type { FeishuDocsSourceSnapshot } from "../../../feishu-connector/src/docs-reader.js";
import type { FeishuCalendarSourceSnapshot } from "../../../feishu-connector/src/calendar-reader.js";
import type { FeishuTaskSourceSnapshot } from "../../../feishu-connector/src/task-reader.js";

export type CandidateKind = "potential-risk" | "prediction" | "proposal" | "pending-confirmation" | "possible-decision" | "possible-resolution" | "background";
export interface CandidateExtraction { kind: CandidateKind; summary: string; }
export interface NaturalLanguageCandidateExtractor { extract(input: { sourceKind: string; sourceRef: string; excerpt: string; occurredAt?: string }): Promise<CandidateExtraction[]>; }
export interface StructuredTaskFact { kind: "task-deadline" | "task-status" | "task-completion"; taskId: string; value: string; }
export interface SourceProjection { evidence: Evidence<unknown>[]; facts: ProjectFactInput<StructuredTaskFact>[]; candidates: CandidateFact<unknown>[]; backgrounds: BackgroundContext<unknown>[]; }

/** Projects visible Reader results without granting natural language the right to admit facts. */
export async function projectSourceResults(results: readonly ProjectSourceReadResult<unknown>[], extractor?: NaturalLanguageCandidateExtractor): Promise<SourceProjection> {
  const projection: SourceProjection = { evidence: [], facts: [], candidates: [], backgrounds: [] };
  for (const result of results) {
    if (result.status !== "success" || result.context.visibility !== "allowed") continue;
    const evidence = toEvidence(result); projection.evidence.push(evidence);
    if (result.context.sourceKind === "feishu-base") projectBase(result as SourceReadSuccess<FeishuBaseSourceSnapshot>, evidence, projection);
    else if (result.context.sourceKind === "feishu-task") projectTask(result as SourceReadSuccess<FeishuTaskSourceSnapshot>, evidence, projection);
    else if (result.context.sourceKind === "feishu-calendar") projection.backgrounds.push(createBackgroundContext({ backgroundId: `background:${result.context.sourceRef}`, content: calendarSummary((result as SourceReadSuccess<FeishuCalendarSourceSnapshot>).data), evidence: [evidence] }));
    else if (result.context.sourceKind === "feishu-minutes") projectMinutes(result as SourceReadSuccess<FeishuMinutesSourceSnapshot>, evidence, projection);
    else projection.backgrounds.push(createBackgroundContext({ backgroundId: `background:${result.context.sourceRef}`, content: { sourceKind: result.context.sourceKind, state: "visible-source-observation" }, evidence: [evidence] }));
    if (extractor && isNaturalLanguageSource(result.context.sourceKind)) {
      for (const excerpt of excerpts(result).slice(0, 3)) {
        const extracted = await extractor.extract({ sourceKind: result.context.sourceKind, sourceRef: result.context.sourceRef, excerpt: truncate(excerpt), ...(result.freshness.sourceUpdatedAt ? { occurredAt: result.freshness.sourceUpdatedAt } : {}) });
        for (const item of extracted) projection.candidates.push(createCandidateFact({ candidateFactId: `candidate:${result.context.sourceRef}:${projection.candidates.length + 1}`, claim: { kind: item.kind, summary: truncate(item.summary) }, evidence: [evidence] }));
      }
    }
  }
  return projection;
}

function toEvidence(result: SourceReadSuccess<unknown>): Evidence<unknown> {
  return createEvidence({ evidenceId: `evidence:${result.context.sourceRef}`, observation: createObservation({ observationId: `observation:${result.context.sourceRef}`, result, observedAt: result.freshness.fetchedAt, ...(result.freshness.sourceUpdatedAt ? { occurredAt: result.freshness.sourceUpdatedAt } : {}) }) });
}
function projectBase(result: SourceReadSuccess<FeishuBaseSourceSnapshot>, evidence: Evidence<unknown>, projection: SourceProjection): void {
  for (const task of result.data.tasks) {
    if (task.deadline) addFact("task-deadline", task.id, task.deadline, evidence, projection);
    if (task.status) addFact("task-status", task.id, task.status, evidence, projection);
  }
}
function projectTask(result: SourceReadSuccess<FeishuTaskSourceSnapshot>, evidence: Evidence<unknown>, projection: SourceProjection): void {
  for (const task of result.data.tasks) {
    if (task.due?.time) addFact("task-deadline", task.taskId, task.due.time, evidence, projection);
    if (task.completeTime) addFact("task-completion", task.taskId, task.completeTime, evidence, projection);
  }
}
function addFact(kind: StructuredTaskFact["kind"], taskId: string, value: string, evidence: Evidence<unknown>, projection: SourceProjection): void {
  const claim = { kind, taskId, value } as const;
  const candidate = createCandidateFact({ candidateFactId: `candidate:${kind}:${taskId}:${projection.facts.length + 1}`, claim, evidence: [evidence] });
  const fact = admitCandidateFact({ factId: `fact:${kind}:${taskId}:${projection.facts.length + 1}`, candidate, admittedAt: evidence.observation.provenance.fetchedAt, validity: "current" });
  projection.facts.push({ fact, subjectKey: `task:${taskId}:${kind}`, claimFingerprint: value });
}
function projectMinutes(result: SourceReadSuccess<FeishuMinutesSourceSnapshot>, evidence: Evidence<unknown>, projection: SourceProjection): void {
  projection.backgrounds.push(createBackgroundContext({ backgroundId: `background:${result.context.sourceRef}:minutes`, content: { transcriptState: result.data.transcript.state, platformArtifacts: result.data.artifacts.map((item) => item.kind), derived: true }, evidence: [evidence] }));
}
function calendarSummary(snapshot: FeishuCalendarSourceSnapshot) { return { kind: "calendar-context", events: snapshot.events.map((event) => ({ title: event.title, startTime: event.startTime, endTime: event.endTime, recurringEventId: event.recurringEventId })) }; }
function isNaturalLanguageSource(kind: string): boolean { return kind === "feishu-chat" || kind === "feishu-minutes" || kind === "feishu-docs" || kind === "feishu-wiki-drive"; }
function excerpts(result: SourceReadSuccess<unknown>): string[] {
  if (result.context.sourceKind === "feishu-chat") return (result as SourceReadSuccess<FeishuChatSourceSnapshot>).data.messages.flatMap((message) => message.content ? [message.content] : []);
  if (result.context.sourceKind === "feishu-minutes") { const value = (result as SourceReadSuccess<FeishuMinutesSourceSnapshot>).data; return value.transcript.state === "available" ? [value.transcript.content] : []; }
  if (result.context.sourceKind === "feishu-docs") return (result as SourceReadSuccess<FeishuDocsSourceSnapshot>).data.blocks.flatMap((block) => block.text ? [block.text] : []);
  return [];
}
function truncate(value: string): string { return value.trim().slice(0, 400); }
