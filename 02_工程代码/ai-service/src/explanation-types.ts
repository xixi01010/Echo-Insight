export interface AiPrimaryTaskContext {
  /** Authorized task facts only; absent fields must not be inferred. */
  name: string | null;
  status: string | null;
  deadline: string | null;
  owner?: string;
  description?: string;
}

export interface AiRelatedTaskContext {
  name: string | null;
  status: string | null;
  deadline?: string;
}

export interface AiRiskContext {
  /** The only signal reference allowed in V2 output id/evidenceRefs. */
  signalId: string;
  type: string;
  primaryTask: AiPrimaryTaskContext | null;
  relatedTasks: AiRelatedTaskContext[];
  /** Facts that may be cited in the explanation. */
  factualEvidence: string[];
  /** Coverage gaps that must be reflected in output limitations when relevant. */
  dataLimitations: string[];
}

/** Filtered rule evidence supplied to the AI explanation layer. */
export interface AiExplanationInput {
  projectName: string;
  /** Minimal authorization index retained for V2 output normalization. */
  riskSignals: Array<{
    signalId: string;
    type: string;
  }>;
  riskContexts: AiRiskContext[];
  /** Input-level coverage gaps, not model-generated limitations. */
  limitations: string[];
  /** V3-only, minimal, permission-filtered context; it cannot alter rule output. */
  intelligenceContext?: {
    currentFacts: Array<{ subjectKey: string; value: string; sourceKinds: string[] }>;
    candidates: Array<{ kind: string; summary: string; sourceKinds: string[] }>;
    potentialSignals: Array<{ kind: string; summary: string }>;
    conflicts: Array<{ sourceKinds: string[] }>;
    freshness: Array<{ state: string; sourceKind?: string }>;
  };
}

/** V2 protocol output: explanations only, never rule-calculated fields. */
export interface AiExplanationRisk {
  id: string;
  title: string;
  evidenceRefs: string[];
  reason: string;
  impact: string;
  suggestedActions: string[];
}

export interface AiExplanationOutput {
  risks: AiExplanationRisk[];
  limitations: string[];
}

export interface RiskExplanationAnalyzer {
  analyze(input: AiExplanationInput): Promise<AiExplanationOutput>;
}
