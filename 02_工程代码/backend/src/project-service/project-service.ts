import { randomUUID } from "node:crypto";

import type {
  CreateProjectInput,
  Project,
  UserProjectMembership,
} from "./project-model.js";
import type { ProjectRepository } from "./project-repository.js";

export const PROJECT_NAME_MAX_LENGTH = 120;

export class InvalidProjectNameError extends Error {
  constructor() {
    super("Project name is invalid.");
    this.name = "InvalidProjectNameError";
  }
}

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly generateId: () => string = randomUUID,
  ) {}

  async createProject(input: CreateProjectInput): Promise<Project> {
    const name = normalizeProjectName(input.name);
    const creatorId = requireText(input.creatorId, "Creator id");
    const ownerId = requireText(input.ownerId, "Owner id");
    const members = normalizeValues(input.members ?? []).filter(
      (userId) => userId !== ownerId,
    );
    const timestamp = this.now().toISOString();
    const project: Project = {
      id: requireText(this.generateId(), "Project id"),
      name,
      creatorId,
      ownerId,
      members,
      dataSourceRefs: normalizeValues(input.dataSourceRefs ?? []),
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.repository.save(project);
    return project;
  }

  async getProject(projectId: string, userId: string): Promise<Project | null> {
    const membership = await this.repository.findMembership(projectId, userId);
    if (!membership) return null;
    return this.repository.findById(projectId);
  }

  async listProjects(userId: string): Promise<Project[]> {
    return this.repository.findByUserId(requireText(userId, "User id"));
  }

  async getMembership(
    projectId: string,
    userId: string,
  ): Promise<UserProjectMembership | null> {
    return this.repository.findMembership(
      requireText(projectId, "Project id"),
      requireText(userId, "User id"),
    );
  }

  async listMemberships(
    projectId: string,
    requestingUserId: string,
  ): Promise<UserProjectMembership[] | null> {
    const project = await this.getProject(projectId, requestingUserId);
    if (!project) return null;
    return this.repository.listMemberships(projectId);
  }

  async replaceDataSourceRefs(
    projectId: string,
    dataSourceRefs: string[],
  ): Promise<Project | null> {
    const project = await this.repository.findById(requireText(projectId, "Project id"));
    if (!project) return null;

    const updatedProject: Project = {
      ...project,
      dataSourceRefs: normalizeValues(dataSourceRefs),
      updatedAt: this.now().toISOString(),
    };
    await this.repository.save(updatedProject);
    return updatedProject;
  }

  async addDataSourceRef(projectId: string, dataSourceRef: string): Promise<Project | null> {
    const project = await this.repository.findById(requireText(projectId, "Project id"));
    if (!project) return null;
    return this.replaceDataSourceRefs(project.id, [...project.dataSourceRefs, dataSourceRef]);
  }

  async removeDataSourceRef(projectId: string, dataSourceRef: string): Promise<Project | null> {
    const project = await this.repository.findById(requireText(projectId, "Project id"));
    if (!project) return null;
    const normalizedRef = requireText(dataSourceRef, "Data source reference");
    return this.replaceDataSourceRefs(
      project.id,
      project.dataSourceRefs.filter((ref) => ref !== normalizedRef),
    );
  }

  /** Called only after a server-side Feishu access verification succeeds. */
  async addMemberAfterVerifiedAccess(projectId: string, userId: string): Promise<Project | null> {
    const project = await this.repository.findById(requireText(projectId, "Project id"));
    if (!project) return null;

    const normalizedUserId = requireText(userId, "User id");
    if (project.ownerId === normalizedUserId || project.members.includes(normalizedUserId)) {
      return project;
    }

    const updatedProject: Project = {
      ...project,
      members: [...project.members, normalizedUserId],
      updatedAt: this.now().toISOString(),
    };
    await this.repository.save(updatedProject);
    return updatedProject;
  }
}

export function normalizeProjectName(value: string): string {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > PROJECT_NAME_MAX_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    throw new InvalidProjectNameError();
  }
  return normalized;
}

function requireText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} is required.`);
  return normalized;
}

function normalizeValues(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
