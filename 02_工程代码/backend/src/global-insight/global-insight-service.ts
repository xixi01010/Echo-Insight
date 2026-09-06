import { buildRiskContexts } from "../ai-analysis-service/risk-context-builder.js";
import type { ProjectAnalysisService } from "../analysis-service/index.js";
import type { ProjectContext } from "../project-context/index.js";
import {
  ProjectDataSourceResolutionError,
  ProjectContextService,
  type ProjectDataSourceSubject,
} from "../project-context/index.js";
import type { ProjectService } from "../project-service/index.js";
import type { RiskLevel, RiskSignal } from "../risk-engine/index.js";
import type { RiskContext } from "../ai-analysis-service/risk-context-types.js";
import type { GlobalInsight, GlobalInsightsResult } from "./types.js";

type ProjectAnalyzer = Pick<ProjectAnalysisService, "analyzeProject">;

interface CachedProjectInsights {
  expiresAt: number;
  value: Promise<ProjectInsightFact[]>;
}

interface ProjectInsightFact {
  signal: RiskSignal;
  title: string;
  facts: string[];
  ruleBasis: string;
  deadline: string;
}

interface InsightEntry {
  insight: GlobalInsight;
  fact: ProjectInsightFact;
}

const RISK_LEVEL_WEIGHT: Record<RiskLevel, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

/**
 * Aggregates existing rule-derived risks for projects the current user can access.
 * It deliberately does not create reports or invoke an AI analyzer.
 */
export class GlobalInsightService {
  private readonly cache = new Map<string, CachedProjectInsights>();

  constructor(
    private readonly projectService: ProjectService,
    private readonly contextService: ProjectContextService,
    private readonly projectAnalysisService: ProjectAnalyzer,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = 120_000,
    private readonly concurrency = 3,
  ) {}

  async getInsights(subject: ProjectDataSourceSubject | string): Promise<GlobalInsightsResult> {
    const currentSubject = typeof subject === "string" ? { userId: subject } : subject;
    const projects = await this.projectService.listProjects(currentSubject.userId);
    let partialFailure = false;
    const batches = await mapWithConcurrency(projects, this.concurrency, async (project) => {
      try {
        const context = await this.contextService.resolve(project.id, currentSubject);
        const facts = await this.getProjectInsightFacts(context);
        return facts.map((fact, index) => ({
          insight: toGlobalInsight(context, fact, index),
          fact,
        }));
      } catch {
        partialFailure = true;
        return [];
      }
    });

    return {
      insights: batches.flat().sort(compareInsights).map((entry) => entry.insight),
      partialFailure,
    };
  }

  invalidate(projectId: string): void {
    const prefix = `${projectId}\u0000`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  private async getProjectInsightFacts(
    context: ProjectContext,
  ): Promise<ProjectInsightFact[]> {
    const sources = context.resolvedDataSources.filter(
      (source) => source.kind === "feishu-base",
    );
    if (sources.length !== 1) {
      throw new ProjectDataSourceResolutionError(
        "A global insight requires exactly one Feishu Base data source.",
      );
    }

    const cacheKey = toCacheKey(context.projectId, context.userId);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const value = this.projectAnalysisService
      .analyzeProject(sources[0]!.baseToken)
      .then((result) => {
        const contexts = new Map(
          buildRiskContexts(result).map((riskContext) => [riskContext.signalId, riskContext]),
        );
        return result.analysis.riskSignals.map((signal) => toProjectInsightFact(
          signal,
          contexts.get(signal.signalId),
        ));
      });
    this.cache.set(cacheKey, {
      expiresAt: this.now() + this.cacheTtlMs,
      value,
    });
    try {
      return await value;
    } catch (error) {
      this.cache.delete(cacheKey);
      throw error;
    }
  }
}

function toCacheKey(projectId: string, userId: string): string {
  return `${projectId}\u0000${userId}`;
}

function toProjectInsightFact(
  signal: RiskSignal,
  riskContext: RiskContext | undefined,
): ProjectInsightFact {
  const taskName = riskContext?.primaryTask?.name;
  const taskReference = taskName ? `「${taskName}」` : "当前项目事项";
  const facts = [
    ...(riskContext?.factualEvidence ?? []),
    ...(riskContext?.dataLimitations ?? []),
  ];

  switch (signal.code) {
    case "TASK_BLOCKED":
      return {
        signal,
        title: `${taskReference}等待处理`,
        facts,
        ruleBasis: "系统规则识别到任务当前无法继续推进。",
        deadline: riskContext?.primaryTask?.deadline ?? "9999-12-31",
      };
    case "TASK_OVERDUE":
      return {
        signal,
        title: `${taskReference}存在延期风险`,
        facts,
        ruleBasis: "系统规则根据未完成任务的计划完成时间判断，其已超过原计划。",
        deadline: riskContext?.primaryTask?.deadline ?? "9999-12-31",
      };
    case "DEPENDENCY_BLOCKED":
      return {
        signal,
        title: `${taskReference}受前置事项影响`,
        facts,
        ruleBasis: "系统规则识别到前置事项无法稳定推进，当前任务需要等待处理。",
        deadline: riskContext?.primaryTask?.deadline ?? "9999-12-31",
      };
    case "MISSING_PROJECT_DATA":
      return {
        signal,
        title: "项目信息待补充",
        facts,
        ruleBasis: "系统规则发现完成判断所需的项目事实不完整。",
        deadline: "9999-12-31",
      };
  }
}

function toGlobalInsight(
  context: ProjectContext,
  fact: ProjectInsightFact,
  index: number,
): GlobalInsight {
  return {
    id: `${context.projectId}:insight:${String(index + 1)}`,
    projectId: context.projectId,
    projectName: context.projectMetadata.name,
    currentUserRole: context.membership.role,
    riskLevel: fact.signal.level,
    title: fact.title,
    facts: fact.facts,
    ruleBasis: fact.ruleBasis,
    deadline: fact.deadline === "9999-12-31" ? null : fact.deadline,
  };
}

function compareInsights(left: InsightEntry, right: InsightEntry): number {
  const levelDifference = RISK_LEVEL_WEIGHT[right.insight.riskLevel] - RISK_LEVEL_WEIGHT[left.insight.riskLevel];
  if (levelDifference !== 0) return levelDifference;
  const deductionDifference = right.fact.signal.deduction - left.fact.signal.deduction;
  if (deductionDifference !== 0) return deductionDifference;
  const deadlineDifference = left.fact.deadline.localeCompare(right.fact.deadline);
  if (deadlineDifference !== 0) return deadlineDifference;
  return left.insight.projectName.localeCompare(right.insight.projectName, "zh-CN")
    || left.insight.title.localeCompare(right.insight.title, "zh-CN")
    || left.insight.id.localeCompare(right.insight.id);
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, values.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value === undefined) continue;
      results[index] = await mapper(value);
    }
  }));
  return results;
}
