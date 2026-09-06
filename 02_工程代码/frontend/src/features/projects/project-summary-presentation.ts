import type { HealthStatus, ProjectSummary } from "../../services/api/index.js";

export interface ProjectConsoleHealthOverview {
  projectCount: number;
  analyzedProjectCount: number;
  healthyProjectCount: number;
  attentionProjectCount: number;
}

export function getProjectConsoleHealthOverview(
  projects: ProjectSummary[],
): ProjectConsoleHealthOverview {
  const analyzedProjects = projects.filter(hasProjectHealthSummary);
  return {
    projectCount: projects.length,
    analyzedProjectCount: analyzedProjects.length,
    healthyProjectCount: analyzedProjects.filter(
      (project) => project.healthStatus === "healthy",
    ).length,
    attentionProjectCount: analyzedProjects.filter(
      (project) => project.healthStatus !== "healthy",
    ).length,
  };
}

export function hasProjectHealthSummary(
  project: ProjectSummary,
): project is ProjectSummary & {
  healthScore: number;
  healthStatus: HealthStatus;
} {
  return typeof project.healthScore === "number" && project.healthStatus !== undefined;
}

export function getProjectSummaryAvailabilityLabel(
  project: ProjectSummary,
  loading = false,
): string {
  if (hasProjectHealthSummary(project)) {
    return project.summaryState === "unavailable" ? "上次分析" : "";
  }
  if (loading) return "正在读取";
  return project.summaryState === "unavailable" ? "暂时不可用" : "待分析";
}
