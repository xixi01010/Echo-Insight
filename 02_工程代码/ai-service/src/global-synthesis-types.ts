export type GlobalSynthesisRole = "owner" | "member";

/**
 * The only cross-project facts permitted to cross into the global AI boundary.
 */
export interface GlobalSynthesisInsightInput {
  insightId: string;
  projectName: string;
  currentUserRole: GlobalSynthesisRole;
  riskLevel: "L1" | "L2" | "L3" | "L4" | "L5";
  title: string;
  facts: string[];
  ruleBasis: string;
}

export interface GlobalSynthesisInput {
  insights: GlobalSynthesisInsightInput[];
  partialFailure: boolean;
}

export interface GlobalSynthesisPriority {
  insightId: string;
  explanation: string;
  suggestedAction: string;
}

/** Explanation-only output. Ranking and facts remain system-owned. */
export interface GlobalSynthesisOutput {
  summary: string;
  priorities: GlobalSynthesisPriority[];
  limitations: string[];
}

export interface GlobalInsightSynthesizer {
  synthesize(input: GlobalSynthesisInput): Promise<GlobalSynthesisOutput>;
}
