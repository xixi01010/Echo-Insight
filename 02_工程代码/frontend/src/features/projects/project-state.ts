import type { ProjectSummary } from "../../services/api/index.js";

export interface ProjectsState {
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsRefreshing: boolean;
  projectsError: string | null;
  currentProjectId: string | null;
}

export type ProjectsAction =
  | { type: "load-start" }
  | { type: "load-success"; projects: ProjectSummary[] }
  | { type: "load-error"; error: string }
  | { type: "select"; projectId: string | null }
  | { type: "summary-updated"; projectId: string; healthScore: number; healthStatus: NonNullable<ProjectSummary["healthStatus"]>; riskCount: number };

export const INITIAL_PROJECTS_STATE: ProjectsState = {
  projects: [],
  projectsLoading: true,
  projectsRefreshing: false,
  projectsError: null,
  currentProjectId: null,
};

/**
 * A snapshot keeps the first render usable, so only an empty snapshot still counts as an
 * initial load; a refresh with data on screen must not swap the cards for a skeleton.
 */
export function createHydratedProjectsState(projects: ProjectSummary[]): ProjectsState {
  return projects.length === 0
    ? INITIAL_PROJECTS_STATE
    : { ...INITIAL_PROJECTS_STATE, projects, projectsLoading: false };
}

export function reduceProjectsState(
  state: ProjectsState,
  action: ProjectsAction,
): ProjectsState {
  switch (action.type) {
    case "load-start":
      return {
        ...state,
        projectsLoading: state.projects.length === 0,
        projectsRefreshing: state.projects.length > 0,
        projectsError: null,
      };
    case "load-success":
      return {
        ...state,
        projects: mergeLastKnownSummaries(state.projects, action.projects),
        projectsLoading: false,
        projectsRefreshing: false,
        projectsError: null,
        currentProjectId: action.projects.some(
          (project) => project.id === state.currentProjectId,
        )
          ? state.currentProjectId
          : null,
      };
    case "load-error":
      return {
        ...state,
        projectsLoading: false,
        projectsRefreshing: false,
        projectsError: action.error,
      };
    case "select":
      return { ...state, currentProjectId: action.projectId };
    case "summary-updated":
      return {
        ...state,
        projects: state.projects.map((project) => project.id === action.projectId
          ? {
              ...project,
              healthScore: action.healthScore,
              healthStatus: action.healthStatus,
              riskCount: action.riskCount,
              summaryState: "available",
            }
          : project),
      };
  }
}

export function mergeLastKnownSummaries(
  previousProjects: ProjectSummary[],
  incomingProjects: ProjectSummary[],
): ProjectSummary[] {
  const previousById = new Map(previousProjects.map((project) => [project.id, project]));
  return incomingProjects.map((project) => {
    const previous = previousById.get(project.id);
    const incomingHasSummary = project.healthScore !== undefined
      && project.healthStatus !== undefined
      && project.riskCount !== undefined;
    const previousHasSummary = previous?.healthScore !== undefined
      && previous.healthStatus !== undefined
      && previous.riskCount !== undefined;
    const mayUseLastKnown = project.summaryState === "unavailable";

    return !incomingHasSummary && previousHasSummary && mayUseLastKnown
      ? {
          ...project,
          healthScore: previous!.healthScore!,
          healthStatus: previous!.healthStatus!,
          riskCount: previous!.riskCount!,
          summaryState: "unavailable",
        }
      : project;
  });
}
