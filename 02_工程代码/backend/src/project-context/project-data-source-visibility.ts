import type { FeishuIdentityRef } from "../current-user/index.js";

export interface ProjectDataSourceSubject {
  userId: string;
  identity?: FeishuIdentityRef;
  /** Server-only session reference for user-identity Source credentials. */
  sessionId?: string;
}

export type ProjectDataSourceAuthorizationStatus = "authorized" | "unavailable" | "unknown";
export type ProjectDataSourceSubjectEligibility = "allowed" | "denied" | "unknown";
export type ProjectDataSourceVisibility = "allowed" | "denied" | "unknown" | "source-unavailable";

export interface ProjectDataSourceVisibilityCheck {
  projectId: string;
  sourceRef: string;
  source: { kind: string; enabled?: boolean };
  subject: ProjectDataSourceSubject;
}

export interface ProjectDataSourceAuthorization {
  sourceAuthorization: ProjectDataSourceAuthorizationStatus;
  subjectEligibility: ProjectDataSourceSubjectEligibility;
}

export interface ProjectDataSourceVisibilityChecker {
  check(input: ProjectDataSourceVisibilityCheck): ProjectDataSourceAuthorization;
}

/**
 * Preserves the established V2 Base behavior. Future Source tasks must replace
 * this result with resource-specific authorization evidence for each subject.
 */
export class DefaultProjectDataSourceVisibilityChecker implements ProjectDataSourceVisibilityChecker {
  check(input: ProjectDataSourceVisibilityCheck): ProjectDataSourceAuthorization {
    if (input.source.enabled === false) {
      return { sourceAuthorization: "unavailable", subjectEligibility: "unknown" };
    }
    if (input.source.kind === "feishu-base") {
      return { sourceAuthorization: "authorized", subjectEligibility: "allowed" };
    }
    return { sourceAuthorization: "unknown", subjectEligibility: "unknown" };
  }
}

export function toProjectDataSourceVisibility(
  authorization: ProjectDataSourceAuthorization,
): ProjectDataSourceVisibility {
  if (authorization.sourceAuthorization === "unavailable") return "source-unavailable";
  if (authorization.sourceAuthorization !== "authorized") return "unknown";
  return authorization.subjectEligibility;
}
