import { buildIntelligenceAiExplanationInput } from "../ai-analysis-service/index.js";
import { buildRiskContexts } from "../ai-analysis-service/index.js";
import type { StandardProjectData } from "../../../feishu-connector/src/index.js";
import type { ProjectSourceReadResult } from "../../../feishu-connector/src/source-contract.js";
import { aggregateProjectIntelligence, selectVisibleProjectIntelligence, SourceFreshnessService, type FactRelation, type ProjectFactInput } from "./project-intelligence/index.js";
import { evaluateCurrentFactsRisk } from "./intelligence-risk-bridge.js";
import { buildPotentialSignals, type PotentialSignal } from "./potential-signals.js";
import { projectSourceResults, type NaturalLanguageCandidateExtractor, type SourceProjection } from "./source-intelligence-projection.js";

export interface MultiSourceIntelligenceResult {
  projection: SourceProjection;
  intelligence: ReturnType<typeof aggregateProjectIntelligence>;
  potentialSignals: PotentialSignal[];
  risk: ReturnType<typeof evaluateCurrentFactsRisk>;
  aiInput: ReturnType<typeof buildIntelligenceAiExplanationInput>;
  freshness: ReturnType<SourceFreshnessService["get"]>[];
  sourceFreshness: Array<{ sourceKind: string; record: NonNullable<ReturnType<SourceFreshnessService["get"]>> }>;
}

/** The V3 fixture/runtime boundary: Source results → intelligence → unchanged rules → bounded AI input. */
export class MultiSourceIntelligenceService {
  constructor(private readonly freshness = new SourceFreshnessService(), private readonly extractor?: NaturalLanguageCandidateExtractor, private readonly now: () => Date = () => new Date()) {}
  async build(input: { baseProjectData: StandardProjectData; sourceResults: ProjectSourceReadResult<unknown>[]; admittedFacts?: ProjectFactInput[]; relations?: FactRelation[] }): Promise<MultiSourceIntelligenceResult> {
    for (const result of input.sourceResults) this.freshness.record(result);
    const projection = await projectSourceResults(input.sourceResults, this.extractor);
    const preliminary = aggregateProjectIntelligence({ facts: [...projection.facts, ...(input.admittedFacts ?? [])], candidates: projection.candidates, ...(input.relations ? { relations: input.relations } : {}) });
    const visibility = new Map(input.sourceResults.map((result) => [result.context.sourceRef, result.context.visibility] as const));
    const intelligence = selectVisibleProjectIntelligence(preliminary, visibility);
    const freshness = input.sourceResults.map((result) => this.freshness.get(result.context)).filter((item): item is NonNullable<typeof item> => Boolean(item));
    const sourceFreshness = input.sourceResults.flatMap((result) => {
      const record = this.freshness.get(result.context);
      return record ? [{ sourceKind: result.context.sourceKind, record }] : [];
    });
    const potentialSignals = buildPotentialSignals(intelligence, freshness);
    const risk = evaluateCurrentFactsRisk({ baseProjectData: input.baseProjectData, intelligence, now: this.now() });
    const riskContexts = buildRiskContexts({ projectData: risk.projectData, analysis: risk.analysis });
    return { projection, intelligence, potentialSignals, risk, aiInput: buildIntelligenceAiExplanationInput({ projectName: risk.projectData.project.name, riskContexts, intelligence, potentialSignals, freshness }), freshness, sourceFreshness };
  }
}
