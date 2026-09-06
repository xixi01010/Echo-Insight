export type RiskLevel = "L1" | "L2" | "L3" | "L4" | "L5";

export type SensitivityMode = "robust" | "strict";

export type HealthStatus = "healthy" | "needs-attention" | "at-risk";

export interface AiProjectInput {
  project: {
    id: string;
    name: string;
    healthScore: number;
    healthStatus: HealthStatus;
    sensitivityMode: SensitivityMode;
    riskLevel?: RiskLevel;
  };
  tasks: AiTaskInput[];
  riskSignals: RiskSignalInput[];
  metadata: {
    source: "feishu-base";
    accessMode: "read-only";
    generatedAt: string;
  };
}

export interface AiTaskInput {
  id: string;
  name: string;
  owner: string | null;
  status: string | null;
  deadline: string | null;
  riskLevel: RiskLevel | null;
  isOverdue: boolean;
  dependencyIds: string[];
  description: string | null;
}

export interface RiskSignalInput {
  code: string;
  level: RiskLevel;
  taskId?: string;
  evidence: string;
}

export interface AiProjectHealthOutput {
  score: number;
  status: HealthStatus;
  riskLevel: RiskLevel;
}

export interface AiRiskOutput {
  id: string;
  level: RiskLevel;
  title: string;
  taskIds: string[];
  reason: string;
  impact: string;
  evidence: string[];
  suggestedActions: string[];
}

export interface AiAnalysisOutput {
  projectHealth: AiProjectHealthOutput;
  risks: AiRiskOutput[];
  analysis: {
    mode: SensitivityMode;
    explanation: string;
    limitations: string[];
  };
  generatedAt: string;
}

export interface RiskAnalyzer {
  analyze(input: AiProjectInput): Promise<AiAnalysisOutput>;
}
