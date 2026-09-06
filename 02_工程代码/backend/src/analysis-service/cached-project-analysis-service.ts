import type { ProjectAnalysisService } from "./project-analysis-service.js";
import type { ProjectAnalysisResult } from "./types.js";

type ProjectAnalyzer = Pick<ProjectAnalysisService, "analyzeProject">;

interface CachedAnalysis {
  expiresAt: number;
  value: Promise<ProjectAnalysisResult>;
}

/**
 * Shares one Feishu Base analysis per token across the project console,
 * global insights, and report paths. Results within the TTL window are
 * reused verbatim; concurrent identical requests are deduplicated.
 */
export class CachedProjectAnalysisService implements ProjectAnalyzer {
  private readonly cache = new Map<string, CachedAnalysis>();

  constructor(
    private readonly delegate: ProjectAnalyzer,
    private readonly now: () => number = Date.now,
    private readonly cacheTtlMs = 120_000,
  ) {}

  analyzeProject(baseToken: string): Promise<ProjectAnalysisResult> {
    const cached = this.cache.get(baseToken);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const value = this.delegate.analyzeProject(baseToken);
    this.cache.set(baseToken, { expiresAt: this.now() + this.cacheTtlMs, value });
    value.catch(() => {
      const current = this.cache.get(baseToken);
      if (current?.value === value) this.cache.delete(baseToken);
    });
    return value;
  }

  /** Drops cached analyses, optionally only for one Base token. */
  invalidate(baseToken?: string): void {
    if (baseToken === undefined) {
      this.cache.clear();
      return;
    }
    this.cache.delete(baseToken);
  }
}
