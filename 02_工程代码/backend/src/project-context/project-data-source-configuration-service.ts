import { randomUUID } from "node:crypto";

import type { ProjectService } from "../project-service/index.js";
import { JsonProjectDataSourceRegistry } from "./project-data-source-registry.js";

export interface ProjectDataSourceStatus {
  type: "feishu-base";
  configured: boolean;
  accessMode: "read-only";
  displayName?: string;
}

export class ProjectDataSourceAccessDeniedError extends Error {
  constructor() {
    super("The user cannot access the requested project data source.");
    this.name = "ProjectDataSourceAccessDeniedError";
  }
}

export class ProjectDataSourceForbiddenError extends Error {
  constructor() {
    super("Only a project owner can update the project data source.");
    this.name = "ProjectDataSourceForbiddenError";
  }
}

export class ProjectDataSourceUrlError extends Error {
  constructor(readonly code: "INVALID_DATA_SOURCE_URL" | "UNSUPPORTED_DATA_SOURCE_URL") {
    super("The supplied Feishu Base URL is not supported.");
    this.name = "ProjectDataSourceUrlError";
  }
}

export class ProjectDataSourceValidationError extends Error {
  constructor() {
    super("The supplied Feishu Base cannot be read by the application.");
    this.name = "ProjectDataSourceValidationError";
  }
}

interface FeishuBaseMetadata {
  displayName?: string;
}

type DataSourceValidator = (baseToken: string) => Promise<void | FeishuBaseMetadata>;

/** Owns the user-facing configuration boundary; raw Base identifiers never leave it. */
export class ProjectDataSourceConfigurationService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly registry: JsonProjectDataSourceRegistry,
    private readonly validateFeishuBase: DataSourceValidator,
    private readonly onConfigured: (projectId: string) => void = () => undefined,
    private readonly generateRef: () => string = randomUUID,
  ) {}

  async getStatus(projectId: string, userId: string): Promise<ProjectDataSourceStatus> {
    const project = await this.projectService.getProject(projectId, userId);
    if (!project) throw new ProjectDataSourceAccessDeniedError();
    await this.registry.ensureReady();
    const registration = this.findFeishuBaseRegistration(project.id, project.dataSourceRefs);
    const displayName = registration?.kind === "feishu-base"
      ? await this.readDisplayName(registration.baseToken)
      : undefined;
    return {
      type: "feishu-base",
      configured: Boolean(registration),
      accessMode: "read-only",
      ...(displayName ? { displayName } : {}),
    };
  }

  async configureFeishuBase(
    projectId: string,
    userId: string,
    url: string,
  ): Promise<ProjectDataSourceStatus> {
    const project = await this.projectService.getProject(projectId, userId);
    const membership = await this.projectService.getMembership(projectId, userId);
    if (!project || !membership) throw new ProjectDataSourceAccessDeniedError();
    if (membership.role !== "owner") throw new ProjectDataSourceForbiddenError();

    const baseToken = parseStandaloneFeishuBaseUrl(url);
    let metadata: void | FeishuBaseMetadata;
    try {
      metadata = await this.validateFeishuBase(baseToken);
    } catch {
      throw new ProjectDataSourceValidationError();
    }
    const displayName = normalizeDisplayName(metadata?.displayName);
    const sourceRef = `source-${this.generateRef()}`;
    await this.registry.registerFeishuBase(project.id, sourceRef, baseToken);
    const updatedProject = await this.projectService.replaceDataSourceRefs(
      project.id,
      [
        ...project.dataSourceRefs.filter((ref) => (
          this.registry.getForProject(project.id, ref)?.kind !== "feishu-base"
        )),
        sourceRef,
      ],
    );
    if (!updatedProject) throw new ProjectDataSourceAccessDeniedError();
    this.onConfigured(updatedProject.id);
    return {
      type: "feishu-base",
      configured: true,
      accessMode: "read-only",
      ...(displayName ? { displayName } : {}),
    };
  }

  private async readDisplayName(baseToken: string): Promise<string | undefined> {
    try {
      const metadata = await this.validateFeishuBase(baseToken);
      return normalizeDisplayName(metadata?.displayName);
    } catch {
      return undefined;
    }
  }

  private findFeishuBaseRegistration(projectId: string, refs: string[]) {
    for (const ref of refs) {
      const registration = this.registry.getForProject(projectId, ref);
      if (registration?.kind === "feishu-base" && registration.enabled !== false) {
        return registration;
      }
    }
    return undefined;
  }
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

export function parseStandaloneFeishuBaseUrl(value: string): string {
  const sourceUrl = value.trim();
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new ProjectDataSourceUrlError("INVALID_DATA_SOURCE_URL");
  }
  if (url.protocol !== "https:" || !isFeishuHost(url.hostname)) {
    throw new ProjectDataSourceUrlError("INVALID_DATA_SOURCE_URL");
  }
  if (url.pathname.startsWith("/wiki/")) {
    throw new ProjectDataSourceUrlError("UNSUPPORTED_DATA_SOURCE_URL");
  }
  const match = /^\/base\/([A-Za-z0-9_-]{8,128})(?:\/|$)/u.exec(url.pathname);
  if (!match?.[1]) throw new ProjectDataSourceUrlError("UNSUPPORTED_DATA_SOURCE_URL");
  return match[1];
}

function isFeishuHost(hostname: string): boolean {
  return hostname === "feishu.cn"
    || hostname.endsWith(".feishu.cn")
    || hostname === "larksuite.com"
    || hostname.endsWith(".larksuite.com");
}
