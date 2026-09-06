export type HealthStatus = "healthy" | "needs-attention" | "at-risk";
export type RiskLevel = "L1" | "L2" | "L3" | "L4" | "L5";
export type ProjectRole = "owner" | "member";

export interface ProjectSummary {
  id: string;
  name: string;
  currentUserRole: ProjectRole;
  createdAt: string;
  updatedAt: string;
  healthScore?: number;
  healthStatus?: HealthStatus;
  riskCount?: number;
  summaryState?: "available" | "unconfigured" | "unavailable";
}

export interface ProjectDataSourceStatus {
  type: "feishu-base";
  configured: boolean;
  accessMode: "read-only";
  displayName?: string;
  sources?: ProjectSourceStatus[];
}

export type ProjectSourceType = "feishu-base" | "feishu-chat" | "feishu-minutes" | "feishu-docs" | "feishu-wiki-drive" | "feishu-task" | "feishu-calendar";
export interface ProjectSourceStatus {
  id: string;
  type: ProjectSourceType;
  displayName: string;
  enabled: boolean;
  accessMode: "read-only";
  status: "available" | "disabled" | "unverified" | "authorization-required" | "unavailable" | "read-failed" | "stale";
  authorization: "authorized" | "unknown" | "unavailable";
  visibility: "allowed" | "denied" | "unknown" | "source-unavailable";
  freshness: "fresh" | "stale" | "unknown" | "unavailable";
  activationState: "verified" | "real-tenant-unverified";
  lastSuccessfulReadAt?: string;
  failureCategory?: "permission-denied" | "source-unavailable" | "not-found" | "rate-limited" | "invalid-credential" | "transient" | "unknown";
}

export interface ProjectSourceOption { id: string; label: string; }
export interface CalendarEventOption { id: string; title: string; startAt?: string; endAt?: string; }

export interface ProjectIntelligence {
  currentFacts: Array<{ subject: string; value: string; sourceTypes: string[] }>;
  confirmedRisks: Array<{ id: string; level: string; code: string; evidence: string; sourceTypes: string[] }>;
  potentialSignals: Array<{ id: string; kind: string; summary: string; sourceTypes: string[]; state: "unconfirmed" }>;
  conflicts: Array<{ id: string; state: "unresolved"; sourceTypes: string[] }>;
  freshness: Array<{ sourceType: string; state: "fresh" | "stale" | "unknown" | "unavailable"; lastSuccessfulReadAt?: string; failureCategory?: string }>;
  ai: { status: "available" | "unavailable"; explanations: Array<{ riskId: string; reason: string; impact: string; suggestedActions: string[] }>; limitations: string[] };
}

export interface GlobalInsight {
  id: string;
  projectId: string;
  projectName: string;
  currentUserRole: ProjectRole;
  riskLevel: RiskLevel;
  title: string;
  facts: string[];
  ruleBasis: string;
  deadline?: string | null;
}

export interface GlobalInsightsResponse {
  insights: GlobalInsight[];
  partialFailure: boolean;
}

export type GlobalSynthesisStatus = "available" | "limited" | "unavailable";

export interface GlobalInsightSynthesisResponse {
  status: GlobalSynthesisStatus;
  summary: string;
  priorities: Array<{
    insightId: string;
    explanation: string;
    suggestedAction: string;
  }>;
  limitations: string[];
}

export interface RiskSignal {
  signalId: string;
  code: string;
  level: RiskLevel;
  taskId: string | null;
  relatedTaskIds: string[];
  evidence: string;
  deduction: number;
  countedDeduction: number;
}

export interface PrimaryTaskContext {
  name: string | null;
  status: string | null;
  deadline: string | null;
  owner?: string;
  description?: string;
}

export interface RelatedTaskContext {
  name: string | null;
  status: string | null;
  deadline?: string;
}

export interface RiskContext {
  signalId: string;
  type: string;
  primaryTask: PrimaryTaskContext | null;
  relatedTasks: RelatedTaskContext[];
  factualEvidence: string[];
  dataLimitations: string[];
}

export interface ProjectReport {
  analysis: {
    healthScore: number;
    healthStatus: HealthStatus;
    riskLevel: RiskLevel;
    riskSignals: RiskSignal[];
    scoringDetails: {
      calculatedAt: string;
      totalDeduction: number;
    };
  };
  riskContexts: RiskContext[];
  aiStatus?: "available" | "unavailable";
  aiReport: {
    risks: Array<{
      id: string;
      title: string;
      evidenceRefs: string[];
      reason: string;
      impact: string;
      suggestedActions: string[];
    }>;
    limitations: string[];
  };
}
