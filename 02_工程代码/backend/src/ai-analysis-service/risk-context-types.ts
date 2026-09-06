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

/** Backward-compatible aliases for the initial Risk Context implementation. */
export type RiskContextPrimaryTask = PrimaryTaskContext;
export type RiskContextRelatedTask = RelatedTaskContext;
