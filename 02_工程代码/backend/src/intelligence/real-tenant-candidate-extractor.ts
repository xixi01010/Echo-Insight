import type {
  CandidateExtraction,
  NaturalLanguageCandidateExtractor,
} from "./source-intelligence-projection.js";

/**
 * Bounded deterministic classifier for a small Reader-provided excerpt. It
 * never admits a fact or changes deterministic Risk input.
 */
export function createRealTenantCandidateExtractor(): NaturalLanguageCandidateExtractor {
  return {
    async extract({ excerpt }): Promise<CandidateExtraction[]> {
      if (excerpt.includes("尚未正式确认") || excerpt.includes("再确认")) {
        return [{ kind: "pending-confirmation", summary: "待确认类型：pending-confirmation。来源包含尚未正式确认的信息。" }];
      }
      if (excerpt.includes("如果")) {
        return [{ kind: "proposal", summary: "待确认类型：proposal。来源包含条件性提议。" }];
      }
      if (excerpt.includes("可能")) {
        return [{ kind: "prediction", summary: "待确认类型：prediction。来源包含预测性表达。" }];
      }
      return [];
    },
  };
}
