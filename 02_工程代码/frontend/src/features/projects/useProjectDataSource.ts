import { useCallback, useEffect, useReducer } from "react";
import {
  ProjectApiError,
  type CalendarEventOption,
  type ProjectDataSourceStatus,
  type ProjectSourceOption,
  type ProjectSourceStatus,
} from "../../services/api";
import { useWorkspaceRuntime } from "../workspace/WorkspaceRuntimeContext";
import {
  createProjectDataSourceState,
  getVisibleProjectDataSourceState,
  reduceProjectDataSourceState,
  type ProjectDataSourceConfigurationState,
} from "./project-data-source-state";

export interface ProjectDataSourceController {
  status: ProjectDataSourceConfigurationState;
  error: string | null;
  dataSource: ProjectDataSourceStatus | null;
  configure: (url: string) => Promise<void>;
  addSource: (input: { displayName?: string; sourceType?: string; sourceUrl?: string; selectionId?: string }) => Promise<void>;
  getSourceOptions: (sourceType: "chat" | "calendar") => Promise<{ items: ProjectSourceOption[]; hasMore: boolean }>;
  getCalendarEventOptions: (calendarSelectionId: string, start: string, end: string) => Promise<{ items: CalendarEventOption[]; hasMore: boolean }>;
  setSourceEnabled: (sourceId: string, enabled: boolean) => Promise<void>;
  removeSource: (sourceId: string) => Promise<void>;
  refresh: (signal?: AbortSignal) => Promise<void>;
}

export function useProjectDataSource(projectId: string | null): ProjectDataSourceController {
  const client = useWorkspaceRuntime().projectClient;
  const [state, dispatch] = useReducer(
    reduceProjectDataSourceState,
    projectId,
    createProjectDataSourceState,
  );
  const visibleState = getVisibleProjectDataSourceState(state, projectId);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    dispatch({ type: "load-start", projectId });
    try {
      const next = await client.getProjectDataSource(projectId, signal);
      let sources: ProjectSourceStatus[] | undefined;
      try {
        sources = await client.getProjectSources(projectId, signal);
      } catch {
        // Keep the V2 Base-only page usable while the additive V3 endpoint is unavailable.
      }
      if (signal?.aborted) return;
      dispatch({ type: "load-success", projectId, configured: next.configured, dataSource: { ...next, ...(sources ? { sources } : {}) } });
    } catch (caughtError) {
      if (signal?.aborted) return;
      dispatch({
        type: "load-error",
        projectId,
        error: getDataSourceErrorMessage(caughtError),
      });
    }
  }, [client, projectId]);

  const configure = useCallback(async (url: string) => {
    if (!projectId) return;
    const next = await client.configureProjectDataSource(projectId, url);
    dispatch({ type: "load-success", projectId, configured: next.configured, dataSource: next });
    await refresh();
  }, [client, projectId, refresh]);

  const addSource = useCallback(async (input: { displayName?: string; sourceType?: string; sourceUrl?: string; selectionId?: string }) => {
    if (!projectId) return;
    await client.addProjectSource(projectId, input);
    await refresh();
  }, [client, projectId, refresh]);

  const getSourceOptions = useCallback(async (sourceType: "chat" | "calendar") => {
    if (!projectId) throw new ProjectApiError("Project id is required.", 400, "PROJECT_ID_REQUIRED");
    return client.getProjectSourceOptions(projectId, sourceType);
  }, [client, projectId]);

  const getCalendarEventOptions = useCallback(async (calendarSelectionId: string, start: string, end: string) => {
    if (!projectId) throw new ProjectApiError("Project id is required.", 400, "PROJECT_ID_REQUIRED");
    return client.getCalendarEventOptions(projectId, calendarSelectionId, start, end);
  }, [client, projectId]);

  const setSourceEnabled = useCallback(async (sourceId: string, enabled: boolean) => {
    if (!projectId) return;
    await client.setProjectSourceEnabled(projectId, sourceId, enabled);
    await refresh();
  }, [client, projectId, refresh]);

  const removeSource = useCallback(async (sourceId: string) => {
    if (!projectId) return;
    await client.removeProjectSource(projectId, sourceId);
    await refresh();
  }, [client, projectId, refresh]);

  useEffect(() => {
    dispatch({ type: "scope-changed", projectId });
    if (!projectId) return;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [projectId, refresh]);

  return {
    configure,
    addSource,
    getSourceOptions,
    getCalendarEventOptions,
    dataSource: visibleState.dataSource,
    error: visibleState.error,
    refresh,
    removeSource,
    setSourceEnabled,
    status: visibleState.status,
  };
}

export function getDataSourceErrorMessage(error: unknown): string {
  if (error instanceof ProjectApiError && error.status === 404) {
    return "该项目不存在，或当前用户没有访问权限。";
  }
  if (error instanceof TypeError) return "当前无法连接项目服务，请检查网络后重试。";
  return "暂时无法读取项目数据配置，请稍后重试。";
}
