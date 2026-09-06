import { useCallback, useEffect, useRef, useState } from "react";
import {
  readProjectReportCache,
  writeProjectReportCache,
  type ProjectReport,
} from "../../services/api";
import { getInsightErrorMessage } from "./insight-copy";
import {
  isClientCacheEpochCurrent,
  readClientCacheEpoch,
} from "../ai-access/client-cache-epoch";
import { useWorkspaceRuntime } from "../workspace/WorkspaceRuntimeContext";

export type ProjectReportStatus = "empty" | "loading" | "success" | "error" | "refreshing";
export type ProjectReportRefreshOutcome = "success" | "partial" | "failed";

export interface ProjectReportController {
  report: ProjectReport | null;
  status: ProjectReportStatus;
  error: string | null;
  hasHistoricalReport: boolean;
  refresh: () => Promise<ProjectReportRefreshOutcome>;
}

interface ScopedProjectReportState {
  scopeKey: string;
  report: ProjectReport | null;
  status: ProjectReportStatus;
  error: string | null;
}

export function useProjectReport(
  projectId?: string | null,
): ProjectReportController {
  const runtime = useWorkspaceRuntime();
  const v1Client = runtime.projectReportClient;
  const projectClient = runtime.projectClient;
  const currentScopeKey = getReportScopeKey(projectId);
  const scopeKeyRef = useRef(currentScopeKey);
  scopeKeyRef.current = currentScopeKey;
  const visibleReportRef = useRef<ProjectReport | null>(null);
  const inFlightRef = useRef<{ scopeKey: string; request: Promise<ProjectReportRefreshOutcome> } | null>(null);
  const [state, setState] = useState<ScopedProjectReportState>(() => (
    createScopedState(projectId, runtime.cacheStorage)
  ));
  const visibleState = state.scopeKey === currentScopeKey
    ? state
    : createScopedState(projectId, runtime.cacheStorage);
  visibleReportRef.current = visibleState.report;

  useEffect(() => {
    setState(createScopedState(projectId, runtime.cacheStorage));
  }, [currentScopeKey, projectId, runtime.cacheStorage]);

  const refresh = useCallback((): Promise<ProjectReportRefreshOutcome> => {
    if (projectId === null) return Promise.resolve("failed");

    const requestScopeKey = getReportScopeKey(projectId);
    const currentRequest = inFlightRef.current;
    if (currentRequest?.scopeKey === requestScopeKey) return currentRequest.request;
    const existingReport = visibleReportRef.current;
    const requestEpoch = readClientCacheEpoch();

    const request = (async (): Promise<ProjectReportRefreshOutcome> => {
      setState({
        scopeKey: requestScopeKey,
        report: existingReport,
        status: existingReport ? "refreshing" : "loading",
        error: null,
      });
      try {
        const nextReport = typeof projectId === "string"
          ? await projectClient.getProjectReport(projectId)
          : await v1Client.getProjectReport();
        if (
          scopeKeyRef.current !== requestScopeKey
          || !isClientCacheEpochCurrent(requestEpoch)
        ) return "failed";
        const didCache = writeProjectReportCache(
          runtime.cacheStorage,
          nextReport,
          typeof projectId === "string" ? projectId : undefined,
          requestEpoch,
        );
        if (!didCache) return "failed";
        setState({
          scopeKey: requestScopeKey,
          report: nextReport,
          status: "success",
          error: null,
        });
        return nextReport.aiStatus === "unavailable" ? "partial" : "success";
      } catch (caughtError) {
        if (
          scopeKeyRef.current !== requestScopeKey
          || !isClientCacheEpochCurrent(requestEpoch)
        ) return "failed";
        console.error("Echo Insight project analysis request failed.", caughtError);
        setState({
          scopeKey: requestScopeKey,
          report: existingReport,
          status: "error",
          error: getInsightErrorMessage(caughtError),
        });
        return "failed";
      }
    })();
    inFlightRef.current = { scopeKey: requestScopeKey, request };
    void request.finally(() => {
      if (inFlightRef.current?.request === request) inFlightRef.current = null;
    });
    return request;
  }, [projectClient, projectId, runtime.cacheStorage, v1Client]);

  return {
    report: visibleState.report,
    status: visibleState.status,
    error: visibleState.error,
    hasHistoricalReport: Boolean(visibleState.report),
    refresh,
  };
}

function createScopedState(projectId: string | null | undefined, storage: Storage): ScopedProjectReportState {
  const report = projectId === null
    ? null
    : readProjectReportCache(
        storage,
        typeof projectId === "string" ? projectId : undefined,
      );
  return {
    scopeKey: getReportScopeKey(projectId),
    report,
    status: report ? "success" : "empty",
    error: null,
  };
}

function getReportScopeKey(projectId?: string | null): string {
  if (projectId === null) return "none";
  return typeof projectId === "string" ? `project:${projectId}` : "v1";
}
