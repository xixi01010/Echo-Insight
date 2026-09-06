import type { UserProjectMembership } from "../project-service/index.js";

export interface ProjectContextMetadata {
  name: string;
  creatorId: string;
  ownerId: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResolvedFeishuBaseDataSource {
  ref: string;
  kind: "feishu-base";
  baseToken: string;
}

export type ResolvedProjectDataSource = ResolvedFeishuBaseDataSource;

/** Internal-only context. Resolved data-source credentials must never be serialized. */
export interface ProjectContext {
  projectId: string;
  userId: string;
  membership: UserProjectMembership;
  projectMetadata: ProjectContextMetadata;
  resolvedDataSources: ResolvedProjectDataSource[];
}
