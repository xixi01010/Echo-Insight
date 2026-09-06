import { createHash } from "node:crypto";

import type {
  GlobalInsightSynthesizer,
  GlobalSynthesisInput,
  GlobalSynthesisOutput,
} from "../../../ai-service/src/index.js";
import type { GlobalInsightsResult } from "./types.js";
import type { GlobalInsightService } from "./global-insight-service.js";

export const GLOBAL_SYNTHESIS_TOP_INSIGHT_COUNT = 3;

export type GlobalSynthesisStatus = "available" | "limited" | "unavailable";

export interface GlobalInsightSynthesisResult extends GlobalSynthesisOutput {
  status: GlobalSynthesisStatus;
}

type GlobalInsightFactsProvider = Pick<GlobalInsightService, "getInsights">;

export interface GlobalSynthesisRequestOptions {
  forceRefresh?: boolean;
}

const DEFAULT_MAX_CACHE_ENTRIES = 100;

/**
 * Adds an optional explanation layer to deterministic global insights. Rules
 * remain the source of facts, ordering, and identifiers.
 */
export class GlobalInsightSynthesisService {
  private readonly cache = new Map<string, GlobalInsightSynthesisResult>();
  private readonly inFlight = new Map<string, Promise<GlobalInsightSynthesisResult>>();

  constructor(
    private readonly insightService: GlobalInsightFactsProvider,
    private readonly synthesizer: GlobalInsightSynthesizer,
    private readonly maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES,
  ) {}

  async getSynthesis(
    userId: string,
    options: GlobalSynthesisRequestOptions = {},
  ): Promise<GlobalInsightSynthesisResult> {
    const facts = await this.insightService.getInsights(userId);
    const input = buildGlobalSynthesisInput(facts);
    if (input.insights.length === 0) {
      return {
        status: "limited",
        summary: "当前没有可供综合解释的已确认项目风险。",
        priorities: [],
        limitations: appendCoverageLimitation([], facts.partialFailure),
      };
    }

    const cacheKey = createCacheKey(userId, input);
    if (!options.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.cache.delete(cacheKey);
        this.cache.set(cacheKey, cached);
        return cached;
      }
    }

    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending;

    const value = this.createSynthesis(input, facts.partialFailure);
    this.inFlight.set(cacheKey, value);
    try {
      const result = await value;
      if (result.status !== "unavailable") this.cacheResult(cacheKey, result);
      return result;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  private cacheResult(cacheKey: string, result: GlobalInsightSynthesisResult): void {
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, result);
    while (this.cache.size > Math.max(0, this.maxCacheEntries)) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.cache.delete(oldestKey);
    }
  }

  private async createSynthesis(
    input: GlobalSynthesisInput,
    partialFailure: boolean,
  ): Promise<GlobalInsightSynthesisResult> {
    try {
      const output = alignPrioritiesToDeterministicInput(
        await this.synthesizer.synthesize(input),
        input,
      );
      return {
        status: partialFailure || output.priorities.length === 0 ? "limited" : "available",
        ...output,
        limitations: appendCoverageLimitation(output.limitations, partialFailure),
      };
    } catch {
      return {
        status: "unavailable",
        summary: "AI 综合洞察暂不可用。",
        priorities: [],
        limitations: appendCoverageLimitation(
          ["已确认的规则风险仍可正常查看，AI 未参与风险事实或排序。"],
          partialFailure,
        ),
      };
    }
  }
}

function alignPrioritiesToDeterministicInput(
  output: GlobalSynthesisOutput,
  input: GlobalSynthesisInput,
): GlobalSynthesisOutput {
  const allowedIds = new Set(input.insights.map((insight) => insight.insightId));
  const prioritiesById = new Map<string, GlobalSynthesisOutput["priorities"][number]>();
  for (const priority of output.priorities) {
    if (!allowedIds.has(priority.insightId) || prioritiesById.has(priority.insightId)) {
      throw new Error("Global synthesis references an unsupported insight.");
    }
    prioritiesById.set(priority.insightId, priority);
  }
  return {
    ...output,
    priorities: input.insights.flatMap((insight) => {
      const priority = prioritiesById.get(insight.insightId);
      return priority ? [priority] : [];
    }),
  };
}

export function buildGlobalSynthesisInput(
  result: GlobalInsightsResult,
): GlobalSynthesisInput {
  return {
    insights: result.insights.slice(0, GLOBAL_SYNTHESIS_TOP_INSIGHT_COUNT).map((insight) => ({
      insightId: insight.id,
      projectName: insight.projectName,
      currentUserRole: insight.currentUserRole,
      riskLevel: insight.riskLevel,
      title: insight.title,
      facts: [...new Set(insight.facts)].sort((left, right) => left.localeCompare(right, "zh-CN")),
      ruleBasis: insight.ruleBasis,
    })),
    partialFailure: result.partialFailure,
  };
}

function createCacheKey(userId: string, input: GlobalSynthesisInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ userId, input }))
    .digest("hex");
}

function appendCoverageLimitation(
  limitations: string[],
  partialFailure: boolean,
): string[] {
  if (!partialFailure) return limitations;
  return [
    ...limitations,
    "部分项目暂时无法完成规则分析，AI 综合解释仅基于当前成功得到的风险事实。",
  ];
}
