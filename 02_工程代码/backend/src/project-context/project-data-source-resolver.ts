import type { Project } from "../project-service/index.js";
import type { ResolvedProjectDataSource } from "./project-context.js";
import {
  DefaultProjectDataSourceVisibilityChecker,
  toProjectDataSourceVisibility,
  type ProjectDataSourceSubject,
  type ProjectDataSourceVisibilityChecker,
} from "./project-data-source-visibility.js";

export interface FeishuBaseDataSourceRegistration {
  kind: "feishu-base";
  baseToken: string;
  enabled?: boolean;
}

export type PendingProjectDataSourceKind =
  | "feishu-chat"
  | "feishu-minutes"
  | "feishu-docs"
  | "feishu-wiki-drive"
  | "feishu-task"
  | "feishu-calendar";

export interface PendingProjectDataSourceRegistration {
  kind: PendingProjectDataSourceKind;
  enabled: false;
}

export type ConfiguredProjectDataSourceLocator =
  | { kind: "feishu-chat"; containerType: "chat" | "thread"; containerId: string }
  | { kind: "feishu-minutes"; minuteToken: string }
  | { kind: "feishu-docs"; documentToken: string }
  | { kind: "feishu-wiki-drive"; resourceKind: "wiki-node" | "drive-file"; token: string; fileType?: string }
  | { kind: "feishu-task"; taskIds: string[] }
  | { kind: "feishu-calendar"; calendarId: string; eventIds: string[] };

export interface ConfiguredProjectDataSourceRegistration {
  kind: PendingProjectDataSourceKind;
  enabled: boolean;
  publicId: string;
  displayName?: string;
  locator: ConfiguredProjectDataSourceLocator;
}

export type ProjectDataSourceKind =
  | FeishuBaseDataSourceRegistration["kind"]
  | PendingProjectDataSourceKind;

export type ProjectDataSourceRegistration =
  | FeishuBaseDataSourceRegistration
  | ConfiguredProjectDataSourceRegistration
  | PendingProjectDataSourceRegistration;

export interface ProjectDataSourceRegistrationLookup {
  get(ref: string): ProjectDataSourceRegistration | undefined;
  getForProject?(
    projectId: string,
    ref: string,
  ): ProjectDataSourceRegistration | undefined;
}

export class ProjectDataSourceResolutionError extends Error {
  readonly code = "PROJECT_DATA_SOURCE_RESOLUTION_FAILED";

  constructor(message: string) {
    super(message);
    this.name = "ProjectDataSourceResolutionError";
  }
}

/** Resolves opaque project references to server-only data-source credentials. */
export class ProjectDataSourceResolver {
  private readonly registrations: ProjectDataSourceRegistrationLookup;

  constructor(
    registrations: ProjectDataSourceRegistrationLookup,
    private readonly visibilityChecker: ProjectDataSourceVisibilityChecker = new DefaultProjectDataSourceVisibilityChecker(),
  ) {
    this.registrations = registrations;
  }

  resolve(
    project: Project,
    subject: ProjectDataSourceSubject = { userId: "" },
  ): ResolvedProjectDataSource[] {
    if (project.dataSourceRefs.length === 0) {
      throw new ProjectDataSourceResolutionError(
        `Project ${project.id} does not have a configured data source.`,
      );
    }

    const resolvedSources = project.dataSourceRefs.flatMap((ref) => {
      const registration = this.registrations.getForProject
        ? this.registrations.getForProject(project.id, ref)
        : this.registrations.get(ref);
      if (!registration) {
        throw new ProjectDataSourceResolutionError(
          `Project data source reference ${ref} is not registered.`,
        );
      }
      const visibility = toProjectDataSourceVisibility(this.visibilityChecker.check({
        projectId: project.id,
        sourceRef: ref,
        source: registration,
        subject,
      }));
      if (visibility !== "allowed") return [];
      if (registration.kind !== "feishu-base") return [];
      const baseToken = requireText(registration.baseToken, "Feishu Base token");
      if (ref === baseToken) {
        throw new ProjectDataSourceResolutionError(
          "Data source references must not contain the real Feishu Base token.",
        );
      }

      return [{
        ref,
        kind: registration.kind,
        baseToken,
      }];
    });

    return resolvedSources;
  }
}

function requireText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ProjectDataSourceResolutionError(`${fieldName} is required.`);
  }
  return normalized;
}
