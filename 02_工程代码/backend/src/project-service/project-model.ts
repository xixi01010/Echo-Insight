export type UserProjectRole = "owner" | "member";

export interface Project {
  id: string;
  name: string;
  creatorId: string;
  ownerId: string;
  members: string[];
  dataSourceRefs: string[];
  createdAt: string;
  updatedAt: string;
}

export interface UserProjectMembership {
  projectId: string;
  userId: string;
  role: UserProjectRole;
}

export interface CreateProjectInput {
  name: string;
  creatorId: string;
  ownerId: string;
  members?: string[];
  dataSourceRefs?: string[];
}

export function createProjectMemberships(
  project: Project,
): UserProjectMembership[] {
  return [
    { projectId: project.id, userId: project.ownerId, role: "owner" },
    ...project.members.map((userId) => ({
      projectId: project.id,
      userId,
      role: "member" as const,
    })),
  ];
}

export function isProject(value: unknown): value is Project {
  if (!isRecord(value)) return false;

  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.creatorId === "string"
    && typeof value.ownerId === "string"
    && isStringArray(value.members)
    && isStringArray(value.dataSourceRefs)
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
