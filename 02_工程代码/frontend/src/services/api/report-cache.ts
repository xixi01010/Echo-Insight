import { isProjectReportPayload } from "./project-report.js";
import type { ProjectReport } from "./types.js";
import {
  isClientCacheEpochCurrent,
  readClientCacheEpoch,
} from "../../features/ai-access/client-cache-epoch.js";

export const PROJECT_REPORT_CACHE_KEY = "echo-insight:project-report:v2";
export const PROJECT_SCOPED_REPORT_CACHE_PREFIX = "echo-insight:project-report:v2:project";

export interface ReportStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function getProjectReportCacheKey(projectId?: string): string {
  return projectId
    ? `${PROJECT_SCOPED_REPORT_CACHE_PREFIX}:${encodeURIComponent(projectId)}`
    : PROJECT_REPORT_CACHE_KEY;
}

export function readProjectReportCache(
  storage: ReportStorage,
  projectId?: string,
): ProjectReport | null {
  const cached = storage.getItem(getProjectReportCacheKey(projectId));
  if (!cached) return null;

  try {
    const parsed: unknown = JSON.parse(cached);
    return isProjectReportPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeProjectReportCache(
  storage: ReportStorage,
  report: ProjectReport,
  projectId?: string,
  requestEpoch?: number,
): boolean {
  const writeEpoch = requestEpoch ?? readClientCacheEpoch();
  if (!isClientCacheEpochCurrent(writeEpoch)) {
    return false;
  }
  storage.setItem(getProjectReportCacheKey(projectId), JSON.stringify(report));
  return true;
}
