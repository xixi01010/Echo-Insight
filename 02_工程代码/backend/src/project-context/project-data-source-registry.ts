import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  ConfiguredProjectDataSourceLocator,
  PendingProjectDataSourceKind,
  ProjectDataSourceRegistration,
} from "./project-data-source-resolver.js";

interface DataSourceStore {
  version: 1;
  sources: StoredProjectDataSourceRegistration[];
}

type RegisteredProjectDataSource = ProjectDataSourceRegistration & {
  projectId: string;
};

type StoredProjectDataSourceRegistration = RegisteredProjectDataSource & {
  ref: string;
};

/**
 * Server-only project data-source registry. It deliberately stores no app
 * credentials and is designed for a gitignored runtime location.
 */
export class JsonProjectDataSourceRegistry {
  private readonly registrations = new Map<string, RegisteredProjectDataSource>();
  private initialization: Promise<void> | undefined;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    initialRegistrations: ReadonlyMap<string, ProjectDataSourceRegistration> = new Map(),
  ) {
    for (const [ref, registration] of initialRegistrations) {
      this.registrations.set(requireText(ref, "Data source reference"), {
        ...cloneRegistration(registration),
        projectId: "development-default",
      });
    }
  }

  async ensureReady(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }

  get(ref: string): ProjectDataSourceRegistration | undefined {
    const registration = this.registrations.get(ref);
    return registration ? cloneRegistration(registration) : undefined;
  }

  getForProject(projectId: string, ref: string): ProjectDataSourceRegistration | undefined {
    const registration = this.registrations.get(requireText(ref, "Data source reference"));
    if (!registration || registration.projectId !== requireText(projectId, "Project id")) {
      return undefined;
    }
    return cloneRegistration(registration);
  }

  listForProject(projectId: string): Array<{ ref: string; registration: ProjectDataSourceRegistration }> {
    const normalizedProjectId = requireText(projectId, "Project id");
    return [...this.registrations]
      .filter(([, registration]) => registration.projectId === normalizedProjectId)
      .map(([ref, registration]) => ({ ref, registration: cloneRegistration(registration) }));
  }

  /** Server-only reverse lookup used to find one configured project from a Base URL. */
  async findProjectIdsByFeishuBaseToken(baseToken: string): Promise<string[]> {
    await this.ensureReady();
    const normalizedToken = requireText(baseToken, "Feishu Base token");
    return [...new Set(
      [...this.registrations.values()]
        .filter((registration) => (
          registration.kind === "feishu-base"
          && registration.enabled !== false
          && registration.baseToken === normalizedToken
        ))
        .map((registration) => registration.projectId),
    )];
  }

  async registerFeishuBase(projectId: string, ref: string, baseToken: string): Promise<void> {
    await this.ensureReady();
    const normalizedProjectId = requireText(projectId, "Project id");
    const normalizedRef = requireText(ref, "Data source reference");
    const normalizedToken = requireText(baseToken, "Feishu Base token");
    if (normalizedRef === normalizedToken) {
      throw new Error("Data source references must not contain the Feishu Base token.");
    }

    const operation = this.writeQueue.then(async () => {
      this.registrations.set(normalizedRef, {
        kind: "feishu-base",
        baseToken: normalizedToken,
        projectId: normalizedProjectId,
      });
      await this.writeToDisk();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  /** Reserves an opaque ref for a future Source without guessing its credentials. */
  async registerPendingSource(
    projectId: string,
    ref: string,
    kind: PendingProjectDataSourceKind,
  ): Promise<void> {
    await this.ensureReady();
    const normalizedProjectId = requireText(projectId, "Project id");
    const normalizedRef = requireText(ref, "Data source reference");
    if (!isPendingKind(kind)) throw new Error("Unsupported pending data source kind.");

    const operation = this.writeQueue.then(async () => {
      this.registrations.set(normalizedRef, {
        kind,
        enabled: false,
        projectId: normalizedProjectId,
      });
      await this.writeToDisk();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async registerConfiguredSource(input: {
    projectId: string;
    ref: string;
    publicId: string;
    locator: ConfiguredProjectDataSourceLocator;
    displayName?: string;
  }): Promise<void> {
    await this.ensureReady();
    const projectId = requireText(input.projectId, "Project id");
    const ref = requireText(input.ref, "Data source reference");
    const publicId = requireText(input.publicId, "Public data source id");
    const locator = cloneLocator(input.locator);
    const displayName = normalizeDisplayName(input.displayName);
    const operation = this.writeQueue.then(async () => {
      this.registrations.set(ref, {
        kind: locator.kind,
        enabled: true,
        publicId,
        locator,
        projectId,
        ...(displayName ? { displayName } : {}),
      });
      await this.writeToDisk();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async setEnabled(projectId: string, ref: string, enabled: boolean): Promise<boolean> {
    await this.ensureReady();
    const normalizedProjectId = requireText(projectId, "Project id");
    const normalizedRef = requireText(ref, "Data source reference");
    const registration = this.registrations.get(normalizedRef);
    if (!registration || registration.projectId !== normalizedProjectId) return false;
    if (registration.kind !== "feishu-base" && !("locator" in registration) && enabled) {
      throw new Error("A pending data source cannot be enabled before its Source task is implemented.");
    }

    const operation = this.writeQueue.then(async () => {
      const current = this.registrations.get(normalizedRef);
      if (!current || current.projectId !== normalizedProjectId) return;
      const next: RegisteredProjectDataSource = current.kind === "feishu-base"
        ? enabled
          ? {
            kind: current.kind,
            baseToken: current.baseToken,
            projectId: current.projectId,
          }
          : { ...current, enabled: false }
        : "locator" in current
          ? { ...current, enabled }
          : current;
      this.registrations.set(normalizedRef, next);
      await this.writeToDisk();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return true;
  }

  async remove(projectId: string, ref: string): Promise<boolean> {
    await this.ensureReady();
    const normalizedProjectId = requireText(projectId, "Project id");
    const normalizedRef = requireText(ref, "Data source reference");
    const registration = this.registrations.get(normalizedRef);
    if (!registration || registration.projectId !== normalizedProjectId) return false;

    const operation = this.writeQueue.then(async () => {
      const current = this.registrations.get(normalizedRef);
      if (!current || current.projectId !== normalizedProjectId) return;
      this.registrations.delete(normalizedRef);
      await this.writeToDisk();
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return true;
  }

  private async load(): Promise<void> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return;
      throw error;
    }
    const parsed: unknown = JSON.parse(serialized);
    if (!isDataSourceStore(parsed)) throw new Error("Data source registry contains unsupported data.");
    for (const source of parsed.sources) {
      this.registrations.set(source.ref, {
        ...cloneRegistration(source),
        projectId: source.projectId,
      });
    }
  }

  private async writeToDisk(): Promise<void> {
    const store: DataSourceStore = {
      version: 1,
      sources: [...this.registrations].map(([ref, registration]) => ({
        projectId: registration.projectId,
        ref,
        ...cloneRegistration(registration),
      })),
    };
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function cloneRegistration(
  registration: ProjectDataSourceRegistration,
): ProjectDataSourceRegistration {
  if (registration.kind === "feishu-base") {
    return {
      kind: registration.kind,
      baseToken: requireText(registration.baseToken, "Feishu Base token"),
      ...(registration.enabled === false ? { enabled: false } : {}),
    };
  }
  if ("locator" in registration) {
    return {
      kind: registration.kind,
      enabled: registration.enabled,
      publicId: requireText(registration.publicId, "Public data source id"),
      locator: cloneLocator(registration.locator),
      ...(registration.displayName ? { displayName: registration.displayName } : {}),
    };
  }
  return { kind: registration.kind, enabled: false };
}

function isDataSourceStore(value: unknown): value is DataSourceStore {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { sources?: unknown }).sources)
    && (value as { sources: unknown[] }).sources.every(isStoredRegistration);
}

function isStoredRegistration(value: unknown): value is StoredProjectDataSourceRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (typeof source.projectId !== "string" || typeof source.ref !== "string") return false;
  if (source.kind === "feishu-base") {
    return typeof source.baseToken === "string"
      && (source.enabled === undefined || typeof source.enabled === "boolean");
  }
  if (!isPendingKind(source.kind)) return false;
  if (source.locator === undefined) return source.enabled === false;
  return typeof source.enabled === "boolean"
    && typeof source.publicId === "string"
    && (source.displayName === undefined || typeof source.displayName === "string")
    && isConfiguredLocator(source.locator, source.kind);
}

function isConfiguredLocator(value: unknown, kind: PendingProjectDataSourceKind): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const locator = value as Record<string, unknown>;
  if (locator.kind !== kind) return false;
  if (kind === "feishu-chat") return (locator.containerType === "chat" || locator.containerType === "thread") && typeof locator.containerId === "string";
  if (kind === "feishu-minutes") return typeof locator.minuteToken === "string";
  if (kind === "feishu-docs") return typeof locator.documentToken === "string";
  if (kind === "feishu-wiki-drive") return (locator.resourceKind === "wiki-node" || locator.resourceKind === "drive-file") && typeof locator.token === "string" && (locator.fileType === undefined || typeof locator.fileType === "string");
  if (kind === "feishu-task") return Array.isArray(locator.taskIds) && locator.taskIds.every((item) => typeof item === "string");
  return typeof locator.calendarId === "string" && Array.isArray(locator.eventIds) && locator.eventIds.every((item) => typeof item === "string");
}

function cloneLocator(locator: ConfiguredProjectDataSourceLocator): ConfiguredProjectDataSourceLocator {
  if (locator.kind === "feishu-task") return { kind: locator.kind, taskIds: [...locator.taskIds] };
  if (locator.kind === "feishu-calendar") return { kind: locator.kind, calendarId: locator.calendarId, eventIds: [...locator.eventIds] };
  return { ...locator };
}

function normalizeDisplayName(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 160) : undefined;
}

function isPendingKind(value: unknown): value is PendingProjectDataSourceKind {
  return value === "feishu-chat"
    || value === "feishu-minutes"
    || value === "feishu-docs"
    || value === "feishu-wiki-drive"
    || value === "feishu-task"
    || value === "feishu-calendar";
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requireText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} is required.`);
  return normalized;
}
