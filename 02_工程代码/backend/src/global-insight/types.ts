import type { UserProjectRole } from "../project-service/index.js";
import type { RiskLevel } from "../risk-engine/index.js";

/** Browser-safe, rules-only cross-project blocker representation. */
export interface GlobalInsight {
  id: string;
  projectId: string;
  projectName: string;
  currentUserRole: UserProjectRole;
  riskLevel: RiskLevel;
  title: string;
  facts: string[];
  ruleBasis: string;
  deadline?: string | null;
}

export interface GlobalInsightsResult {
  insights: GlobalInsight[];
  partialFailure: boolean;
}
