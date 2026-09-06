import { useCallback, useEffect, useRef, useState } from "react";
import {
  readProjectIntelligenceCache,
  writeProjectIntelligenceCache,
  type ProjectIntelligence,
} from "../../services/api";
import {
  isClientCacheEpochCurrent,
  readClientCacheEpoch,
} from "../ai-access/client-cache-epoch";
import { useWorkspaceRuntime } from "../workspace/WorkspaceRuntimeContext";

export type ProjectIntelligenceStatus = "idle" | "loading" | "refreshing" | "success" | "unavailable";

export interface ProjectIntelligenceController {
  status: ProjectIntelligenceStatus;
  intelligence: ProjectIntelligence | null;
  refresh: () => Promise<"success" | "partial" | "failed">;
}

interface ScopedIntelligenceState {
  scopeKey: string;
  intelligence: ProjectIntelligence | null;
  status: ProjectIntelligenceStatus;
}

export function useProjectIntelligence(projectId: string | null, enabled: boolean): ProjectIntelligenceController {
  const runtime = useWorkspaceRuntime();
  const client = runtime.projectClient;
  const currentScopeKey = getIntelligenceScopeKey(projectId);
  const scopeKeyRef = useRef(currentScopeKey);
  scopeKeyRef.current = currentScopeKey;
  const visibleIntelligenceRef = useRef<ProjectIntelligence | null>(null);
  const inFlightRef = useRef<{ scopeKey: string; request: Promise<"success" | "partial" | "failed"> } | null>(null);
  const [state, setState] = useState<ScopedIntelligenceState>(() => (
    createScopedState(projectId, runtime.cacheStorage)
  ));
  const visibleState = state.scopeKey === currentScopeKey
    ? state
    : createScopedState(projectId, runtime.cacheStorage);
  visibleIntelligenceRef.current = visibleState.intelligence;

  useEffect(() => {
    setState(createScopedState(projectId, runtime.cacheStorage));
  }, [currentScopeKey, projectId, runtime.cacheStorage]);

  const refresh = useCallback((): Promise<"success" | "partial" | "failed"> => {
    if (!projectId || !enabled) return Promise.resolve("failed");
    const requestScopeKey = getIntelligenceScopeKey(projectId);
    const currentRequest = inFlightRef.current;
    if (currentRequest?.scopeKey === requestScopeKey) return currentRequest.request;
    const existing = visibleIntelligenceRef.current;
    const requestEpoch = readClientCacheEpoch();
    const request = (async (): Promise<"success" | "partial" | "failed"> => {
      setState({
        scopeKey: requestScopeKey,
        intelligence: existing,
        status: existing ? "refreshing" : "loading",
      });
      try {
        const next = await client.getProjectIntelligence(projectId);
        if (
          scopeKeyRef.current !== requestScopeKey
          || !isClientCacheEpochCurrent(requestEpoch)
        ) return "failed";
        const didCache = writeProjectIntelligenceCache(
          runtime.cacheStorage,
          projectId,
          next,
          requestEpoch,
        );
        if (!didCache) return "failed";
        setState({ scopeKey: requestScopeKey, intelligence: next, status: "success" });
        return next.freshness.some((item) => item.state !== "fresh") ? "partial" : "success";
      } catch {
        if (
          scopeKeyRef.current !== requestScopeKey
          || !isClientCacheEpochCurrent(requestEpoch)
        ) return "failed";
        setState({ scopeKey: requestScopeKey, intelligence: existing, status: "unavailable" });
        return "failed";
      }
    })();
    inFlightRef.current = { scopeKey: requestScopeKey, request };
    void request.finally(() => {
      if (inFlightRef.current?.request === request) inFlightRef.current = null;
    });
    return request;
  }, [client, enabled, projectId, runtime.cacheStorage]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    void refresh();
  }, [enabled, projectId, refresh]);

  return {
    status: enabled ? visibleState.status : "idle",
    intelligence: visibleState.intelligence,
    refresh,
  };
}

function createScopedState(projectId: string | null, storage: Storage): ScopedIntelligenceState {
  const intelligence = projectId ? readProjectIntelligenceCache(storage, projectId) : null;
  return {
    scopeKey: getIntelligenceScopeKey(projectId),
    intelligence,
    status: intelligence ? "success" : "idle",
  };
}

function getIntelligenceScopeKey(projectId: string | null): string {
  return projectId ? `project:${projectId}` : "none";
}
