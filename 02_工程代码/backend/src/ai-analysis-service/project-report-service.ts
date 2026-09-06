import type {
  AiExplanationOutput,
  RiskExplanationAnalyzer,
} from "../../../ai-service/src/index.js";
import type { RiskEngineOutput } from "../risk-engine/index.js";
import type { ProjectAnalysisService } from "../analysis-service/index.js";
import { buildAiExplanationInput } from "./ai-input-builder.js";
import { buildRiskContexts } from "./risk-context-builder.js";
import type { RiskContext } from "./risk-context-types.js";

export interface ProjectReportResult {
  analysis: RiskEngineOutput;
  riskContexts: RiskContext[];
  aiStatus: "available" | "unavailable";
  aiReport: AiExplanationOutput;
}

type ExplanationResult = Pick<ProjectReportResult, "aiStatus" | "aiReport">;

interface CachedExplanation {
  expiresAt: number;
  value: Promise<ExplanationResult>;
}

const MAX_CACHED_EXPLANATIONS = 50;

/** Coordinates rule analysis with an explanation-only AI analyzer. */
export class ProjectReportService {
  private readonly explanations = new Map<string, CachedExplanation>();

  constructor(
    private readonly projectAnalysisService: Pick<ProjectAnalysisService, "analyzeProject">,
    private readonly explanationAnalyzer: RiskExplanationAnalyzer,
    private readonly explanationCacheTtlMs = 0,
  ) {}

  async createProjectReport(baseToken: string): Promise<ProjectReportResult> {
    const projectAnalysis = await this.projectAnalysisService.analyzeProject(baseToken);
    const riskContexts = buildRiskContexts(projectAnalysis);
    const explanation = await this.getExplanation(projectAnalysis, riskContexts);
    return {
      analysis: projectAnalysis.analysis,
      riskContexts,
      ...explanation,
    };
  }

  /** Drops cached AI explanations; deterministic facts are never cached here. */
  invalidateExplanationCache(): void {
    this.explanations.clear();
  }

  private async getExplanation(
    projectAnalysis: Awaited<ReturnType<ProjectAnalysisService["analyzeProject"]>>,
    riskContexts: RiskContext[],
  ): Promise<ExplanationResult> {
    if (this.explanationCacheTtlMs <= 0) {
      return this.createExplanation(projectAnalysis, riskContexts);
    }
    const fingerprint = explanationFingerprint(projectAnalysis.analysis);
    const cached = this.explanations.get(fingerprint);
    if (cached && cached.expiresAt > Date.now()) {
      try {
        return await cached.value;
      } catch {
        this.explanations.delete(fingerprint);
      }
    }
    const value = this.createExplanation(projectAnalysis, riskContexts);
    this.explanations.set(fingerprint, { expiresAt: Date.now() + this.explanationCacheTtlMs, value });
    if (this.explanations.size > MAX_CACHED_EXPLANATIONS) {
      const oldest = this.explanations.keys().next().value;
      if (oldest !== undefined) this.explanations.delete(oldest);
    }
    try {
      const result = await value;
      if (result.aiStatus !== "available" && this.explanations.get(fingerprint)?.value === value) {
        // Failed explanations are not reused; the next request retries the provider.
        this.explanations.delete(fingerprint);
      }
      return result;
    } catch (error) {
      if (this.explanations.get(fingerprint)?.value === value) this.explanations.delete(fingerprint);
      throw error;
    }
  }

  private async createExplanation(
    projectAnalysis: Awaited<ReturnType<ProjectAnalysisService["analyzeProject"]>>,
    riskContexts: RiskContext[],
  ): Promise<ExplanationResult> {
    const aiInput = buildAiExplanationInput(projectAnalysis, riskContexts);
    try {
      return {
        aiStatus: "available",
        aiReport: await this.explanationAnalyzer.analyze(aiInput),
      };
    } catch {
      // AI explanation is optional. Deterministic facts, health and risks remain
      // usable even when the provider or its output contract is unavailable.
      return {
        aiStatus: "unavailable",
        aiReport: {
          risks: [],
          limitations: [
            "AI 解释本次未更新；已确认事实、健康度与规则风险已正常更新。",
          ],
        },
      };
    }
  }
}

/**
 * Stable fingerprint of the deterministic analysis that the AI explanation is
 * derived from. Volatile timestamps are excluded so a re-read of unchanged
 * facts reuses the prior explanation instead of paying for another provider call.
 */
function explanationFingerprint(analysis: RiskEngineOutput): string {
  return JSON.stringify({
    healthScore: analysis.healthScore,
    healthStatus: analysis.healthStatus,
    riskLevel: analysis.riskLevel,
    signals: analysis.riskSignals
      .map((signal) => [
        signal.code,
        signal.level,
        signal.taskId ?? "",
        signal.relatedTaskIds.join("+"),
      ].join("|"))
      .sort(),
  });
}