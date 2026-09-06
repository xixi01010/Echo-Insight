import type { AiExplanationOutput } from "../../../ai-service/src/index.js";
import type { ProjectDataSourceSubject } from "../project-context/index.js";
import type { ProjectService } from "../project-service/index.js";
import type { MultiSourceIntelligenceResult } from "./multi-source-intelligence-service.js";

export interface ProjectIntelligenceDto {
  currentFacts: Array<{ subject: string; value: string; sourceTypes: string[] }>;
  confirmedRisks: Array<{ id: string; level: string; code: string; evidence: string; sourceTypes: string[] }>;
  potentialSignals: Array<{ id: string; kind: string; summary: string; sourceTypes: string[]; state: "unconfirmed" }>;
  conflicts: Array<{ id: string; state: "unresolved"; sourceTypes: string[] }>;
  freshness: Array<{ sourceType: string; state: "fresh" | "stale" | "unknown" | "unavailable"; lastSuccessfulReadAt?: string; failureCategory?: string }>;
  ai: {
    status: "available" | "unavailable";
    explanations: Array<{ riskId: string; reason: string; impact: string; suggestedActions: string[] }>;
    limitations: string[];
  };
}

export class ProjectIntelligenceAccessDeniedError extends Error {
  constructor() {
    super("The user cannot access the requested project intelligence.");
    this.name = "ProjectIntelligenceAccessDeniedError";
  }
}

export class ProjectIntelligenceUnavailableError extends Error {
  constructor() {
    super("Project intelligence is unavailable.");
    this.name = "ProjectIntelligenceUnavailableError";
  }
}

export type ProjectIntelligenceProvider = (
  projectId: string,
  subject: ProjectDataSourceSubject,
) => Promise<{ result: MultiSourceIntelligenceResult; aiOutput?: AiExplanationOutput }>;

/** Subject-scoped query boundary; callers must supply results already filtered by FND-03. */
export class ProjectIntelligenceQueryService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly provider: ProjectIntelligenceProvider,
  ) {}

  async get(projectId: string, subject: ProjectDataSourceSubject): Promise<ProjectIntelligenceDto> {
    const project = await this.projectService.getProject(projectId, subject.userId);
    if (!project) throw new ProjectIntelligenceAccessDeniedError();
    let value: Awaited<ReturnType<ProjectIntelligenceProvider>>;
    try {
      value = await this.provider(project.id, subject);
    } catch {
      throw new ProjectIntelligenceUnavailableError();
    }
    return toProjectIntelligenceDto(value.result, value.aiOutput);
  }
}

export function toProjectIntelligenceDto(
  result: MultiSourceIntelligenceResult,
  aiOutput?: AiExplanationOutput,
): ProjectIntelligenceDto {
  const intelligenceContext = result.aiInput.intelligenceContext;
  const facts = intelligenceContext?.currentFacts ?? [];
  const riskSourceTypes = [...new Set(facts.flatMap((fact) => fact.sourceKinds))];
  return {
    currentFacts: facts.map((fact) => ({
      subject: fact.subjectKey.slice(0, 300),
      value: fact.value.slice(0, 300),
      sourceTypes: uniqueSourceTypes(fact.sourceKinds),
    })),
    confirmedRisks: result.risk.analysis.riskSignals.map((risk) => ({
      id: risk.signalId,
      level: risk.level,
      code: risk.code,
      evidence: risk.evidence.slice(0, 500),
      sourceTypes: riskSourceTypes,
    })),
    potentialSignals: result.potentialSignals.map((signal, index) => ({
      id: `potential-${index + 1}`,
      kind: signal.kind,
      summary: signal.summary.slice(0, 300),
      sourceTypes: uniqueSourceTypes(signal.sourceKinds),
      state: "unconfirmed" as const,
    })),
    conflicts: result.intelligence.conflicts.map((conflict, index) => ({
      id: `conflict-${index + 1}`,
      state: "unresolved" as const,
      sourceTypes: uniqueSourceTypes(conflict.evidence.map((evidence) => evidence.observation.provenance.context.sourceKind)),
    })),
    freshness: result.sourceFreshness.map(({ sourceKind, record }) => ({
      sourceType: sourceKind,
      state: record.state,
      ...(record.lastSuccessfulReadAt ? { lastSuccessfulReadAt: record.lastSuccessfulReadAt } : {}),
      ...(record.latestFailureCategory ? { failureCategory: record.latestFailureCategory } : {}),
    })),
    ai: {
      status: aiOutput ? "available" : "unavailable",
      explanations: (aiOutput?.risks ?? []).map((risk) => ({
        riskId: risk.id,
        reason: risk.reason.slice(0, 1_000),
        impact: risk.impact.slice(0, 1_000),
        suggestedActions: risk.suggestedActions.map((action) => action.slice(0, 500)),
      })),
      limitations: (aiOutput?.limitations ?? ["AI 解释当前不可用；已确认事实与规则风险不受影响。"]).map((item) => item.slice(0, 500)),
    },
  };
}

function uniqueSourceTypes(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.slice(0, 80)))];
}
