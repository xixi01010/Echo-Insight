import { useEffect, useState } from "react";
import {
  ProjectApiError,
  type ProjectSummary,
} from "../../services/api";
import { useWorkspaceRuntime } from "../workspace/WorkspaceRuntimeContext";

export type ProjectDetailStatus = "idle" | "loading" | "success" | "error";

interface ProjectDetailState {
  projectId: string | null;
  project: ProjectSummary | null;
  status: ProjectDetailStatus;
  error: string | null;
}

export function useProjectDetail(projectId: string | null) {
  const client = useWorkspaceRuntime().projectClient;
  const [state, setState] = useState<ProjectDetailState>({
    projectId,
    project: null,
    status: projectId ? "loading" : "idle",
    error: null,
  });

  useEffect(() => {
    if (!projectId) {
      setState({ projectId: null, project: null, status: "idle", error: null });
      return;
    }

    const controller = new AbortController();
    setState({ projectId, project: null, status: "loading", error: null });
    void client.getProject(projectId, controller.signal).then(
      (project) => setState({ projectId, project, status: "success", error: null }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          projectId,
          project: null,
          status: "error",
          error: getProjectDetailErrorMessage(error),
        });
      },
    );

    return () => controller.abort();
  }, [client, projectId]);

  if (state.projectId !== projectId) {
    return {
      project: null,
      status: projectId ? "loading" as const : "idle" as const,
      error: null,
    };
  }
  return { project: state.project, status: state.status, error: state.error };
}

function getProjectDetailErrorMessage(error: unknown): string {
  if (error instanceof ProjectApiError && error.status === 404) {
    return "该项目不存在，或当前用户没有访问权限。";
  }
  if (error instanceof TypeError) {
    return "当前无法连接项目服务，请检查网络后重试。";
  }
  return "暂时无法读取该项目，请稍后重试。";
}
