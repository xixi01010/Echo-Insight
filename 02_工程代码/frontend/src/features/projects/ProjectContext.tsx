import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type PropsWithChildren,
} from "react";
import {
  ProjectApiClient,
  ProjectApiError,
  readProjectListSnapshot,
  type ProjectSummary,
  writeProjectListSnapshot,
} from "../../services/api";
import { useWorkspaceRuntime } from "../workspace/WorkspaceRuntimeContext";
import {
  createHydratedProjectsState,
  reduceProjectsState,
} from "./project-state";

interface ProjectContextValue {
  projects: ProjectSummary[];
  projectsLoading: boolean;
  projectsRefreshing: boolean;
  projectsError: string | null;
  currentProjectId: string | null;
  currentProject: ProjectSummary | null;
  setCurrentProject: (projectId: string | null) => void;
  updateProjectSummary: (projectId: string, summary: { healthScore: number; healthStatus: NonNullable<ProjectSummary["healthStatus"]>; riskCount: number }) => void;
  refreshProjects: () => Promise<boolean>;
}

interface ProjectProviderProps extends PropsWithChildren {
  client?: Pick<ProjectApiClient, "getProjects">;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ children, client }: ProjectProviderProps) {
  const runtime = useWorkspaceRuntime();
  const apiClient = client ?? runtime.projectClient;
  const [state, dispatch] = useReducer(
    reduceProjectsState,
    null,
    () => createHydratedProjectsState(readProjectListSnapshot(runtime.cacheStorage) ?? []),
  );
  const requestSequenceRef = useRef(0);

  const refreshProjects = useCallback(async () => {
    const requestId = ++requestSequenceRef.current;
    dispatch({ type: "load-start" });
    try {
      const projects = await apiClient.getProjects();
      if (requestId !== requestSequenceRef.current) return false;
      dispatch({ type: "load-success", projects });
      return true;
    } catch (error) {
      if (requestId !== requestSequenceRef.current) return false;
      dispatch({ type: "load-error", error: getProjectsErrorMessage(error) });
      return false;
    }
  }, [apiClient]);

  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => {
    writeProjectListSnapshot(runtime.cacheStorage, state.projects);
  }, [runtime.cacheStorage, state.projects]);

  const setCurrentProject = useCallback((projectId: string | null) => {
    dispatch({ type: "select", projectId });
  }, []);
  const updateProjectSummary = useCallback((projectId: string, summary: { healthScore: number; healthStatus: NonNullable<ProjectSummary["healthStatus"]>; riskCount: number }) => {
    dispatch({ type: "summary-updated", projectId, ...summary });
  }, []);
  const currentProject = state.projects.find(
    (project) => project.id === state.currentProjectId,
  ) ?? null;
  const value = useMemo<ProjectContextValue>(() => ({
    ...state,
    currentProject,
    setCurrentProject,
    updateProjectSummary,
    refreshProjects,
  }), [currentProject, refreshProjects, setCurrentProject, state, updateProjectSummary]);

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProjects(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) throw new Error("useProjects must be used inside ProjectProvider.");
  return context;
}

export function getProjectsErrorMessage(error: unknown): string {
  if (error instanceof ProjectApiError && error.status === 503) {
    return "项目服务暂未就绪，请稍后重试。";
  }
  if (error instanceof TypeError) {
    return "当前无法连接项目服务，请检查网络后重试。";
  }
  return "暂时无法读取我的项目，请稍后重试。";
}
