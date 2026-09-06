import { isProjectSummary } from "./projects.js";
import type { ProjectSummary } from "./types.js";

export const PROJECT_LIST_CACHE_KEY = "echo-insight:project-list:v1";

export interface ProjectListStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// The client only knows displayName and avatarUrl for the signed-in user, so the snapshot
// stays on one browser-level key holding just the already-rendered project list DTO.
export function getProjectListCacheKey(): string {
  return PROJECT_LIST_CACHE_KEY;
}

export function readProjectListSnapshot(
  storage: ProjectListStorage | null | undefined,
): ProjectSummary[] | null {
  if (!storage) return null;
  let cached: string | null = null;
  try {
    cached = storage.getItem(getProjectListCacheKey());
  } catch {
    return null;
  }
  if (!cached) return null;

  try {
    const parsed: unknown = JSON.parse(cached);
    return isProjectListSnapshotPayload(parsed) ? parsed.projects : null;
  } catch {
    return null;
  }
}

export function writeProjectListSnapshot(
  storage: ProjectListStorage | null | undefined,
  projects: ProjectSummary[],
): void {
  if (!storage) return;
  try {
    storage.setItem(getProjectListCacheKey(), JSON.stringify({ projects }));
  } catch {
    // Storage quota or privacy mode: caching is best-effort only.
  }
}

export function isProjectListSnapshotPayload(value: unknown): value is { projects: ProjectSummary[] } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) => key === "projects")
    && Array.isArray(record.projects)
    && record.projects.every(isProjectSummary);
}
