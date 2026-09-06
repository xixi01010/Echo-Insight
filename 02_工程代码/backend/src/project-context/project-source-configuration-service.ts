import { randomUUID } from "node:crypto";

import type { ProjectService } from "../project-service/index.js";
import { JsonProjectDataSourceRegistry } from "./project-data-source-registry.js";
import type {
  ConfiguredProjectDataSourceLocator,
  ProjectDataSourceKind,
  ProjectDataSourceRegistration,
} from "./project-data-source-resolver.js";
import {
  DefaultProjectDataSourceVisibilityChecker,
  toProjectDataSourceVisibility,
  type ProjectDataSourceSubject,
  type ProjectDataSourceVisibilityChecker,
} from "./project-data-source-visibility.js";
import {
  ProjectDataSourceAccessDeniedError,
  ProjectDataSourceForbiddenError,
} from "./project-data-source-configuration-service.js";

export type PublicProjectSourceStatus =
  | "available"
  | "disabled"
  | "unverified"
  | "authorization-required"
  | "unavailable"
  | "read-failed"
  | "stale";

export interface PublicProjectSourceDto {
  id: string;
  type: ProjectDataSourceKind;
  displayName: string;
  enabled: boolean;
  accessMode: "read-only";
  status: PublicProjectSourceStatus;
  authorization: "authorized" | "unknown" | "unavailable";
  visibility: "allowed" | "denied" | "unknown" | "source-unavailable";
  freshness: "fresh" | "stale" | "unknown" | "unavailable";
  activationState: "verified" | "real-tenant-unverified";
  lastSuccessfulReadAt?: string;
  failureCategory?: "permission-denied" | "source-unavailable" | "not-found" | "rate-limited" | "invalid-credential" | "transient" | "unknown";
}

export interface ProjectSourcesResponseDto {
  sources: PublicProjectSourceDto[];
}

export interface ConfigureProjectSourceInput {
  displayName?: string;
  locator: ConfiguredProjectDataSourceLocator;
}

export interface ProjectSourceOperationalState {
  freshness: "fresh" | "stale" | "unknown" | "unavailable";
  visibility?: PublicProjectSourceDto["visibility"];
  lastSuccessfulReadAt?: string;
  failureCategory?: PublicProjectSourceDto["failureCategory"];
}

export type ProjectSourceOperationalStateProvider = (
  projectId: string,
  sourceRef: string,
  subject: ProjectDataSourceSubject,
) => ProjectSourceOperationalState | undefined;

export class ProjectSourceConfigurationInputError extends Error {
  readonly code = "INVALID_PROJECT_SOURCE_INPUT";
  constructor() {
    super("Project Source configuration is invalid.");
    this.name = "ProjectSourceConfigurationInputError";
  }
}

/** Public management boundary. Locators remain server-only; DTOs expose only safe labels and state. */
export class ProjectSourceConfigurationService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly registry: JsonProjectDataSourceRegistry,
    private readonly visibilityChecker: ProjectDataSourceVisibilityChecker = new DefaultProjectDataSourceVisibilityChecker(),
    private readonly generateId: () => string = randomUUID,
    private readonly getOperationalState: ProjectSourceOperationalStateProvider = () => undefined,
  ) {}

  async list(
    projectId: string,
    subject: ProjectDataSourceSubject,
  ): Promise<ProjectSourcesResponseDto> {
    const project = await this.projectService.getProject(projectId, subject.userId);
    const membership = await this.projectService.getMembership(projectId, subject.userId);
    if (!project || !membership) throw new ProjectDataSourceAccessDeniedError();
    await this.registry.ensureReady();
    const byRef = new Map(this.registry.listForProject(project.id).map((item) => [item.ref, item.registration]));
    return {
      sources: project.dataSourceRefs.flatMap((ref) => {
        const registration = byRef.get(ref);
        if (!registration) return [];
        return [this.toDto(project.id, ref, registration, subject, membership.role)];
      }),
    };
  }

  async add(
    projectId: string,
    userId: string,
    input: ConfigureProjectSourceInput,
  ): Promise<PublicProjectSourceDto> {
    const project = await this.requireOwner(projectId, userId);
    const locator = validateLocator(input.locator);
    const ref = `source-${this.generateId()}`;
    const publicId = this.generateId();
    const displayName = normalizeDisplayName(input.displayName);
    await this.registry.registerConfiguredSource({
      projectId: project.id,
      ref,
      publicId,
      locator,
      ...(displayName ? { displayName } : {}),
    });
    await this.projectService.addDataSourceRef(project.id, ref);
    const registration = this.registry.getForProject(project.id, ref);
    if (!registration) throw new ProjectDataSourceAccessDeniedError();
    return this.toDto(project.id, ref, registration, { userId }, "owner");
  }

  async setEnabled(projectId: string, userId: string, publicId: string, enabled: boolean): Promise<PublicProjectSourceDto> {
    const project = await this.requireOwner(projectId, userId);
    const source = this.findByPublicId(project.id, project.dataSourceRefs, publicId);
    if (!source) throw new ProjectDataSourceAccessDeniedError();
    await this.registry.setEnabled(project.id, source.ref, enabled);
    const registration = this.registry.getForProject(project.id, source.ref);
    if (!registration) throw new ProjectDataSourceAccessDeniedError();
    return this.toDto(project.id, source.ref, registration, { userId }, "owner");
  }

  async remove(projectId: string, userId: string, publicId: string): Promise<void> {
    const project = await this.requireOwner(projectId, userId);
    const source = this.findByPublicId(project.id, project.dataSourceRefs, publicId);
    if (!source) throw new ProjectDataSourceAccessDeniedError();
    await this.projectService.removeDataSourceRef(project.id, source.ref);
    await this.registry.remove(project.id, source.ref);
  }

  private async requireOwner(projectId: string, userId: string) {
    const project = await this.projectService.getProject(projectId, userId);
    const membership = await this.projectService.getMembership(projectId, userId);
    if (!project || !membership) throw new ProjectDataSourceAccessDeniedError();
    if (membership.role !== "owner") throw new ProjectDataSourceForbiddenError();
    return project;
  }

  private findByPublicId(projectId: string, refs: string[], publicId: string) {
    const normalized = publicId.trim();
    for (const ref of refs) {
      const registration = this.registry.getForProject(projectId, ref);
      if (!registration) continue;
      const currentPublicId = registration.kind === "feishu-base" ? "base" : "publicId" in registration ? registration.publicId : "";
      if (currentPublicId === normalized) return { ref, registration };
    }
    return undefined;
  }

  private toDto(
    projectId: string,
    ref: string,
    registration: ProjectDataSourceRegistration,
    subject: ProjectDataSourceSubject,
    role: "owner" | "member",
  ): PublicProjectSourceDto {
    const configuredAuthorization = this.visibilityChecker.check({ projectId, sourceRef: ref, source: registration, subject });
    const operational = this.getOperationalState(projectId, ref, subject);
    const visibility = operational?.visibility ?? toProjectDataSourceVisibility(configuredAuthorization);
    const authorization = visibility === "allowed"
      ? { sourceAuthorization: "authorized" as const, subjectEligibility: "allowed" as const }
      : configuredAuthorization;
    const enabled = registration.enabled !== false;
    const configured = registration.kind === "feishu-base" || "locator" in registration;
    const displayName = role === "owner" || visibility === "allowed"
      ? configured && "displayName" in registration && registration.displayName
        ? registration.displayName
        : sourceTypeLabel(registration.kind)
      : sourceTypeLabel(registration.kind);
    const status: PublicProjectSourceStatus = !configured
      ? "unverified"
      : !enabled
        ? "disabled"
        : visibility === "allowed"
          ? operational?.freshness === "stale"
            ? "stale"
            : operational?.freshness === "unavailable"
              ? "unavailable"
              : operational?.failureCategory
                ? "read-failed"
                : "available"
          : visibility === "source-unavailable"
            ? "unavailable"
            : "authorization-required";
    return {
      id: registration.kind === "feishu-base" ? "base" : "publicId" in registration ? registration.publicId : `pending-${registration.kind}`,
      type: registration.kind,
      displayName,
      enabled,
      accessMode: "read-only",
      status,
      authorization: authorization.sourceAuthorization,
      visibility,
      freshness: operational?.freshness ?? (status === "available" && registration.kind === "feishu-base" ? "fresh" : status === "unavailable" ? "unavailable" : "unknown"),
      activationState: registration.kind === "feishu-base" || operational?.lastSuccessfulReadAt ? "verified" : "real-tenant-unverified",
      ...(operational?.lastSuccessfulReadAt ? { lastSuccessfulReadAt: operational.lastSuccessfulReadAt } : {}),
      ...(operational?.failureCategory ? { failureCategory: operational.failureCategory } : {}),
    };
  }
}

function validateLocator(locator: ConfiguredProjectDataSourceLocator): ConfiguredProjectDataSourceLocator {
  if (locator.kind === "feishu-chat") {
    if ((locator.containerType !== "chat" && locator.containerType !== "thread") || !safeText(locator.containerId)) throw new ProjectSourceConfigurationInputError();
    return { ...locator, containerId: locator.containerId.trim() };
  }
  if (locator.kind === "feishu-minutes") {
    if (!safeText(locator.minuteToken)) throw new ProjectSourceConfigurationInputError();
    return { ...locator, minuteToken: locator.minuteToken.trim() };
  }
  if (locator.kind === "feishu-docs") {
    if (!safeText(locator.documentToken)) throw new ProjectSourceConfigurationInputError();
    return { ...locator, documentToken: locator.documentToken.trim() };
  }
  if (locator.kind === "feishu-wiki-drive") {
    if (!safeText(locator.token) || (locator.resourceKind !== "wiki-node" && locator.resourceKind !== "drive-file")) throw new ProjectSourceConfigurationInputError();
    if (locator.resourceKind === "drive-file" && !safeText(locator.fileType)) throw new ProjectSourceConfigurationInputError();
    return { ...locator, token: locator.token.trim(), ...(locator.fileType ? { fileType: locator.fileType.trim() } : {}) };
  }
  if (locator.kind === "feishu-task") {
    const taskIds = uniqueIds(locator.taskIds);
    if (taskIds.length === 0) throw new ProjectSourceConfigurationInputError();
    return { kind: locator.kind, taskIds };
  }
  const eventIds = uniqueIds(locator.eventIds);
  if (!safeText(locator.calendarId) || eventIds.length === 0) throw new ProjectSourceConfigurationInputError();
  return { kind: locator.kind, calendarId: locator.calendarId.trim(), eventIds };
}

function uniqueIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 100) throw new ProjectSourceConfigurationInputError();
  return [...new Set(values.map((value) => value.trim()).filter((value) => safeText(value)))];
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512;
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function sourceTypeLabel(kind: ProjectDataSourceKind): string {
  const labels: Record<ProjectDataSourceKind, string> = {
    "feishu-base": "飞书多维表格",
    "feishu-chat": "飞书群聊",
    "feishu-minutes": "飞书妙记",
    "feishu-docs": "飞书文档",
    "feishu-wiki-drive": "飞书知识库/云盘",
    "feishu-task": "飞书任务",
    "feishu-calendar": "飞书日历",
  };
  return labels[kind];
}
