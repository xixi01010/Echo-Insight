import type { ProjectAnalysisService } from "../analysis-service/index.js";
import type { HealthStatus } from "../risk-engine/index.js";
import { ProjectDataSourceResolutionError } from "./project-data-source-resolver.js";
import type { ProjectContextService } from "./project-context-service.js";
import type { ProjectDataSourceSubject } from "./project-data-source-visibility.js";

type ProjectAnalyzer = Pick<ProjectAnalysisService, "analyzeProject">;

export interface ProjectAnalysisSummary {
  healthScore: number;
  healthStatus: HealthStatus;
  riskCount: number;
}

interface CachedSummary {
  expiresAt: number;
  value: Promise<ProjectAnalysisSummary>;
}

/**
 * Builds a safe, deterministic summary for the personal project console.
 * It deliberately excludes AI explanation generation.
 */
export class ProjectContextSummaryService {
  private readonly cache = new Map<string, CachedSummary>();
  private readonly inFlight = new Map<string, Promise<ProjectAnalysisSummary>>();

  constructor(
    private readonly contextService: ProjectContextService,
    private readonly projectAnalysisService: ProjectAnalyzer,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = 120_000,
  ) {}

  async createProjectSummary(
    projectId: string,
    subject: ProjectDataSourceSubject | string,
    forceRefresh = false,
  ): Promise<ProjectAnalysisSummary> {
    const context = await this.contextService.resolve(projectId, subject);
    const feishuSources = context.resolvedDataSources.filter(
      (source) => source.kind === "feishu-base",
    );
    if (feishuSources.length !== 1) {
      throw new ProjectDataSourceResolutionError(
        "A project summary requires exactly one Feishu Base data source.",
      );
    }

    const cacheKey = toCacheKey(context.projectId, context.userId);
    const cached = this.cache.get(cacheKey);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return cached.value;
    const currentRequest = this.inFlight.get(cacheKey);
    if (currentRequest) return currentRequest;

    const value = this.projectAnalysisService
      .analyzeProject(feishuSources[0]!.baseToken)
      .then(({ analysis }) => ({
        healthScore: analysis.healthScore,
        healthStatus: analysis.healthStatus,
        riskCount: analysis.riskSignals.length,
      }));
    this.inFlight.set(cacheKey, value);
    this.cache.set(cacheKey, {
      expiresAt: this.now() + this.cacheTtlMs,
      value,
    });
    try {
      return await value;
    } catch (error) {
      this.cache.delete(cacheKey);
      throw error;
    } finally {
      if (this.inFlight.get(cacheKey) === value) this.inFlight.delete(cacheKey);
    }
  }

  invalidate(projectId: string): void {
    const prefix = `${projectId}\u0000`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }
}

function toCacheKey(projectId: string, userId: string): string {
  return `${projectId}\u0000${userId}`;
}
