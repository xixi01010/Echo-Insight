export type RiskSignalCode =
  | "TASK_OVERDUE"
  | "TASK_BLOCKED"
  | "DEPENDENCY_BLOCKED"
  | "MISSING_PROJECT_DATA";

export type RiskLevel = "L1" | "L2" | "L3" | "L4" | "L5";
export type HealthStatus = "healthy" | "needs-attention" | "at-risk";

export interface RiskEngineProject {
  id?: string | null;
  name?: string | null;
  sensitivityMode?: "robust" | "strict" | null;
}

export interface RiskEngineTask {
  id?: string | null;
  name?: string | null;
  owner?: string | null;
  status?: string | null;
  deadline?: string | null;
  riskLevel?: RiskLevel | null;
  isOverdue?: boolean | null;
  dependencyIds?: string[] | null;
  description?: string | null;
}

export interface RiskEngineInput {
  project: RiskEngineProject;
  tasks: RiskEngineTask[];
  metadata?: {
    source?: string;
    accessMode?: "read-only";
    authorizedProjectIds?: string[];
    generatedAt?: string;
  };
}

export interface RiskSignal {
  signalId: string;
  code: RiskSignalCode;
  level: RiskLevel;
  taskId: string | null;
  relatedTaskIds: string[];
  evidence: string;
  deduction: number;
  countedDeduction: number;
}

export interface ScoringDeduction {
  signalId: string;
  code: RiskSignalCode;
  taskId: string | null;
  deduction: number;
  reason: string;
}

export interface ScoringDetails {
  baseScore: 100;
  totalDeduction: number;
  ruleVersion: "mvp-v1";
  calculatedAt: string;
  deductions: ScoringDeduction[];
  escalationReasons: string[];
}

export interface RiskEngineOutput {
  healthScore: number;
  healthStatus: HealthStatus;
  riskLevel: RiskLevel;
  riskSignals: RiskSignal[];
  scoringDetails: ScoringDetails;
}

export interface RiskEngineOptions {
  now?: () => Date;
}
