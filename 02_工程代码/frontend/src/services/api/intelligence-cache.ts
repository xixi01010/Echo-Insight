import type { ProjectIntelligence } from "./types.js";
import {
  isClientCacheEpochCurrent,
  readClientCacheEpoch,
} from "../../features/ai-access/client-cache-epoch.js";

export const PROJECT_INTELLIGENCE_CACHE_PREFIX = "echo-insight:project-intelligence:v1:project";

export interface IntelligenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getProjectIntelligenceCacheKey(projectId: string): string {
  return `${PROJECT_INTELLIGENCE_CACHE_PREFIX}:${encodeURIComponent(projectId)}`;
}

export function isProjectIntelligencePayload(value: unknown): value is ProjectIntelligence {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.currentFacts)
    && Array.isArray(record.confirmedRisks)
    && Array.isArray(record.potentialSignals)
    && Array.isArray(record.conflicts)
    && Array.isArray(record.freshness)
    && typeof record.ai === "object"
    && record.ai !== null;
}

export function readProjectIntelligenceCache(
  storage: IntelligenceStorage,
  projectId: string,
): ProjectIntelligence | null {
  const cached = storage.getItem(getProjectIntelligenceCacheKey(projectId));
  if (!cached) return null;
  try {
    const parsed: unknown = JSON.parse(cached);
    return isProjectIntelligencePayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProjectIntelligenceCache(
  storage: IntelligenceStorage,
  projectId: string,
  intelligence: ProjectIntelligence,
  requestEpoch?: number,
): boolean {
  const writeEpoch = requestEpoch ?? readClientCacheEpoch();
  if (!isClientCacheEpochCurrent(writeEpoch)) {
    return false;
  }
  try {
    storage.setItem(getProjectIntelligenceCacheKey(projectId), JSON.stringify(intelligence));
    return true;
  } catch {
    // Storage quota or privacy mode: caching is best-effort only.
    return false;
  }
}
