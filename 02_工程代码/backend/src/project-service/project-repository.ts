import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createProjectMemberships,
  isProject,
  type Project,
  type UserProjectMembership,
} from "./project-model.js";

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  findById(projectId: string): Promise<Project | null>;
  findByUserId(userId: string): Promise<Project[]>;
  findMembership(
    projectId: string,
    userId: string,
  ): Promise<UserProjectMembership | null>;
  listMemberships(projectId: string): Promise<UserProjectMembership[]>;
}

interface ProjectStore {
  version: 1;
  projects: Project[];
}

export class JsonProjectRepository implements ProjectRepository {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async save(project: Project): Promise<void> {
    const storedProject = cloneProject(project);
    const operation = this.writeQueue.then(async () => {
      const projects = await this.readProjectsFromDisk();
      const existingIndex = projects.findIndex((item) => item.id === project.id);

      if (existingIndex === -1) {
        projects.push(storedProject);
      } else {
        projects[existingIndex] = storedProject;
      }

      await this.writeProjects(projects);
    });

    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  async findById(projectId: string): Promise<Project | null> {
    await this.writeQueue;
    const project = (await this.readProjectsFromDisk()).find(
      (item) => item.id === projectId,
    );
    return project ? cloneProject(project) : null;
  }

  async findByUserId(userId: string): Promise<Project[]> {
    await this.writeQueue;
    const projects = await this.readProjectsFromDisk();
    return projects
      .filter(
        (project) => project.ownerId === userId || project.members.includes(userId),
      )
      .map(cloneProject);
  }

  async findMembership(
    projectId: string,
    userId: string,
  ): Promise<UserProjectMembership | null> {
    const memberships = await this.listMemberships(projectId);
    return memberships.find((membership) => membership.userId === userId) ?? null;
  }

  async listMemberships(projectId: string): Promise<UserProjectMembership[]> {
    const project = await this.findById(projectId);
    return project ? createProjectMemberships(project) : [];
  }

  private async readProjectsFromDisk(): Promise<Project[]> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return [];
      throw error;
    }

    const parsed: unknown = JSON.parse(serialized);
    if (!isProjectStore(parsed)) {
      throw new Error("Project store contains unsupported data.");
    }
    return parsed.projects.map(cloneProject);
  }

  private async writeProjects(projects: Project[]): Promise<void> {
    const store: ProjectStore = { version: 1, projects };
    const temporaryPath = `${this.filePath}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }
}

function cloneProject(project: Project): Project {
  return {
    ...project,
    members: [...project.members],
    dataSourceRefs: [...project.dataSourceRefs],
  };
}

function isProjectStore(value: unknown): value is ProjectStore {
  if (!isRecord(value)) return false;
  return value.version === 1
    && Array.isArray(value.projects)
    && value.projects.every(isProject);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
