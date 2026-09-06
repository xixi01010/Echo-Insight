import type { ProjectDataSourceStatus } from "../../services/api/index.js";

export type ProjectDataSourceConfigurationState =
  | "idle"
  | "loading"
  | "configured"
  | "unconfigured"
  | "error";

export interface ScopedProjectDataSourceState {
  projectId: string | null;
  status: ProjectDataSourceConfigurationState;
  error: string | null;
  dataSource: ProjectDataSourceStatus | null;
}

export type ProjectDataSourceAction =
  | { type: "scope-changed"; projectId: string | null }
  | { type: "load-start"; projectId: string }
  | { type: "load-success"; projectId: string; configured: boolean; dataSource?: ProjectDataSourceStatus }
  | { type: "load-error"; projectId: string; error: string };

export function createProjectDataSourceState(
  projectId: string | null,
): ScopedProjectDataSourceState {
  return {
    projectId,
    status: projectId ? "loading" : "idle",
    error: null,
    dataSource: null,
  };
}

export function reduceProjectDataSourceState(
  state: ScopedProjectDataSourceState,
  action: ProjectDataSourceAction,
): ScopedProjectDataSourceState {
  if (action.type === "scope-changed") {
    return createProjectDataSourceState(action.projectId);
  }
  if (action.type === "load-start") {
    if (state.projectId !== action.projectId) return state;
    return { projectId: action.projectId, status: "loading", error: null, dataSource: state.dataSource };
  }
  if (state.projectId !== action.projectId) return state;
  if (action.type === "load-success") {
    const dataSource = action.dataSource ?? {
      type: "feishu-base",
      configured: action.configured,
      accessMode: "read-only",
    };
    return {
      projectId: action.projectId,
      status: action.configured ? "configured" : "unconfigured",
      error: null,
      dataSource,
    };
  }
  return { projectId: action.projectId, status: "error", error: action.error, dataSource: state.dataSource };
}

export function getVisibleProjectDataSourceState(
  state: ScopedProjectDataSourceState,
  projectId: string | null,
): ScopedProjectDataSourceState {
  return state.projectId === projectId
    ? state
    : createProjectDataSourceState(projectId);
}
