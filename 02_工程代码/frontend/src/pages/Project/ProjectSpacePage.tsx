import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { CustomSelect } from "../../components/CustomSelect";
import { SectionSkeleton, WorkspaceLoadingOverlay } from "../../components/LoadingStates";
import { StatePanel } from "../../components/StatePanel";
import { getHealthPresentation } from "../../features/project-report/presentation";
import { useProjectReport } from "../../features/project-report/useProjectReport";
import { useProjects } from "../../features/projects/ProjectContext";
import { getProjectSummaryAvailabilityLabel } from "../../features/projects/project-summary-presentation";
import { useProjectDetail } from "../../features/projects/useProjectDetail";
import { useProjectDataSource } from "../../features/projects/useProjectDataSource";
import { useProjectIntelligence } from "../../features/projects/useProjectIntelligence";
import { useDelayedLoadingVisibility } from "../../hooks/useDelayedLoadingVisibility";
import { AIReportPage } from "../AIReport/AIReportPage";
import { DashboardPage } from "../Dashboard/DashboardPage";
import { RiskCenterPage } from "../RiskCenter/RiskCenterPage";
import { ProjectDataSourcePanel } from "./ProjectDataSourcePanel";
import { ProjectIntelligencePanel } from "./ProjectIntelligencePanel";

type ProjectSpaceView = "overview" | "risks" | "report" | "data-source";

export const PROJECT_HEADER_COLLAPSE_SCROLL_Y = 140;
export const PROJECT_HEADER_EXPAND_SCROLL_Y = 72;

export function ProjectSpacePage({ view }: { view: ProjectSpaceView }) {
  const routeParams = useParams<{ projectId: string }>();
  const projectId = routeParams.projectId?.trim() || null;
  const navigate = useNavigate();
  const {
    currentProject,
    projects,
    projectsError,
    projectsLoading,
    projectsRefreshing,
    refreshProjects,
    setCurrentProject,
    updateProjectSummary,
  } = useProjects();
  const projectDetail = useProjectDetail(projectId);
  const projectDataSource = useProjectDataSource(projectId);
  const projectIntelligence = useProjectIntelligence(projectId, projectDataSource.status === "configured");
  const projectReport = useProjectReport(projectId);
  const requestedReportProject = useRef<string | null>(null);
  const activeProjectIdRef = useRef(projectId);
  const overviewRefreshPromiseRef = useRef<{ projectId: string | null; request: Promise<void> } | null>(null);
  const [headerCompact, setHeaderCompact] = useState(false);
  const [overviewRefreshState, setOverviewRefreshState] = useState<"idle" | "updating" | "success" | "partial" | "error">("idle");
  const headerCompactRef = useRef(false);
  activeProjectIdRef.current = projectId;
  const detailLoading = projectDetail.status !== "success" || !projectDetail.project;
  const dataSourceLoading = projectDataSource.status === "idle" || projectDataSource.status === "loading";
  const isConfigured = projectDataSource.status === "configured";
  const reportLoading = isConfigured
    && !projectReport.report
    && (projectReport.status === "loading" || projectReport.status === "refreshing");
  const showDetailLoading = useDelayedLoadingVisibility(detailLoading);
  const showDataSourceLoading = useDelayedLoadingVisibility(dataSourceLoading);
  const showReportLoading = useDelayedLoadingVisibility(reportLoading);

  useEffect(() => {
    setOverviewRefreshState("idle");
  }, [projectId]);

  useEffect(() => {
    const desktopHeader = window.matchMedia("(min-width: 769px)");
    let animationFrame: number | null = null;
    const updateHeader = () => {
      animationFrame = null;
      const current = headerCompactRef.current;
      const next = desktopHeader.matches
        ? current
          ? window.scrollY > PROJECT_HEADER_EXPAND_SCROLL_Y
          : window.scrollY >= PROJECT_HEADER_COLLAPSE_SCROLL_Y
        : false;
      if (next === current) return;
      headerCompactRef.current = next;
      setHeaderCompact(next);
    };
    const requestHeaderUpdate = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(updateHeader);
    };

    updateHeader();
    window.addEventListener("scroll", requestHeaderUpdate, { passive: true });
    desktopHeader.addEventListener("change", requestHeaderUpdate);
    return () => {
      window.removeEventListener("scroll", requestHeaderUpdate);
      desktopHeader.removeEventListener("change", requestHeaderUpdate);
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    setCurrentProject(projectId);
    return () => setCurrentProject(null);
  }, [projectId, setCurrentProject]);

  useEffect(() => {
    if (
      projectId
      && projectDetail.status === "success"
      && projectDataSource.status === "configured"
      && requestedReportProject.current !== projectId
    ) {
      requestedReportProject.current = projectId;
      void projectReport.refresh();
    }
  }, [projectDataSource.status, projectDetail.status, projectId, projectReport]);

  useEffect(() => {
    const analysis = projectReport.report?.analysis;
    if (!projectId || !analysis) return;
    updateProjectSummary(projectId, {
      healthScore: analysis.healthScore,
      healthStatus: analysis.healthStatus,
      riskCount: analysis.riskSignals.length,
    });
  }, [projectId, projectReport.report, updateProjectSummary]);

  if (!projectId || projectDetail.status === "error") {
    return (
      <StatePanel
        description={projectDetail.error ?? "该项目地址无效。"}
        title="无法访问该项目"
      />
    );
  }

  if (projectDetail.status !== "success" || !projectDetail.project) {
    return showDetailLoading ? (
      <>
        <ProjectWorkspaceLoadingFrame />
        <WorkspaceLoadingOverlay description="正在确认项目访问权限与项目内容。" title="正在打开项目" />
      </>
    ) : <div className="project-space-loading-delay" />;
  }

  const dataSourceError = projectDataSource.status === "error";
  const isUnconfigured = projectDataSource.status === "unconfigured";
  const reportError = isConfigured
    && !projectReport.report
    && Boolean(projectReport.error);

  const listedProject = currentProject?.id === projectId
    ? currentProject
    : projects.find((project) => project.id === projectId) ?? null;
  const reportSummary = projectReport.report?.analysis;
  const healthScore = reportSummary?.healthScore ?? listedProject?.healthScore;
  const healthStatus = reportSummary?.healthStatus ?? listedProject?.healthStatus;
  const riskCount = reportSummary?.riskSignals.length ?? listedProject?.riskCount;
  const health = healthScore !== undefined && healthStatus !== undefined
    ? getHealthPresentation(healthScore, healthStatus)
    : null;
  const projectBasePath = `/projects/${encodeURIComponent(projectId)}`;
  const currentViewLabel = view === "overview"
    ? "项目概览"
    : view === "risks"
      ? "风险中心"
      : view === "report"
        ? "AI 报告"
        : "数据配置";
  const onConfigured = async () => {
    requestedReportProject.current = projectId;
    await Promise.all([refreshProjects(), projectReport.refresh()]);
  };
  const refreshOverview = (): Promise<void> => {
    const currentRequest = overviewRefreshPromiseRef.current;
    if (currentRequest?.projectId === projectId) return currentRequest.request;
    const refreshProjectId = projectId;
    const request = (async () => {
      setOverviewRefreshState("updating");
      const [reportOutcome, intelligenceOutcome] = await Promise.all([
        projectReport.refresh(),
        projectIntelligence.refresh(),
      ]);
      if (activeProjectIdRef.current !== refreshProjectId) return;
      setOverviewRefreshState(
        reportOutcome === "failed" && intelligenceOutcome === "failed"
          ? "error"
          : reportOutcome !== "success" || intelligenceOutcome !== "success"
            ? "partial"
            : "success",
      );
    })();
    overviewRefreshPromiseRef.current = { projectId: refreshProjectId, request };
    void request.finally(() => {
      if (overviewRefreshPromiseRef.current?.request === request) overviewRefreshPromiseRef.current = null;
    });
    return request;
  };

  return (
    <>
      <div className="project-space">
      <aside className="project-space__list" aria-label="我的项目">
        <div className="project-space__list-header">
          <p className="section-kicker">我的项目</p>
          <h2>项目列表</h2>
        </div>
        {projectsLoading && projects.length === 0 ? <p className="project-space__hint">正在读取项目列表。</p> : null}
        {projectsError ? <p className="project-space__error" role="alert">{projectsError}</p> : null}
        {!projectsLoading && !projectsError && projects.length === 0 ? <p className="project-space__hint">当前没有可访问项目。</p> : null}
        <nav className="project-space__project-links" aria-label="切换项目">
          {projects.map((project) => (
            <Link
              aria-current={project.id === projectId ? "page" : undefined}
              className={`project-space__project-link ${project.id === projectId ? "is-active" : ""}`}
              key={project.id}
              onClick={() => setCurrentProject(project.id)}
              to={`/projects/${encodeURIComponent(project.id)}`}
            >
              <div><strong>{project.name}</strong><span>我的角色：{project.currentUserRole === "owner" ? "负责人" : "成员"}</span></div>
              <div className="project-space__project-summary">
                {project.healthScore !== undefined && project.healthStatus !== undefined ? <><em className={`project-health-score project-health-score--${project.healthStatus}`}>{project.healthScore}</em>{getProjectSummaryAvailabilityLabel(project) ? <small>{getProjectSummaryAvailabilityLabel(project)}</small> : null}</> : <small>{getProjectSummaryAvailabilityLabel(project, projectsLoading || projectsRefreshing)}</small>}
                {project.riskCount !== undefined ? <small>{project.riskCount} 项风险</small> : null}
              </div>
            </Link>
          ))}
        </nav>
      </aside>

      <section className="project-space__current">
        <div className="project-space__mobile-selector">
          <span>切换项目</span>
          <CustomSelect
            aria-label="切换项目"
            onChange={(nextProjectId) => {
              setCurrentProject(nextProjectId);
              navigate(`/projects/${encodeURIComponent(nextProjectId)}`);
            }}
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            value={projectId}
          />
        </div>

        <header className={`project-space__header ${headerCompact ? "is-compact" : ""}`}>
          <div>
            <p className="section-kicker">当前项目 · {currentViewLabel}</p>
            <h1>{projectDetail.project.name}</h1>
            <span className="project-role">
              我的角色：{projectDetail.project.currentUserRole === "owner" ? "负责人" : "成员"}
            </span>
          </div>
          {(health || riskCount !== undefined) ? (
            <div className="project-space__metrics" aria-label="当前项目健康状态">
              {health ? (
                <div>
                  <span>健康度</span>
                  <strong className={`project-health-score project-health-score--${healthStatus}`}>{healthScore}</strong>
                  <small>{health.label}</small>
                </div>
              ) : null}
              {riskCount !== undefined ? <div><span>风险信号</span><strong>{riskCount}</strong><small>项</small></div> : null}
            </div>
          ) : null}
        </header>

        <nav className="project-space__tabs" aria-label="当前项目内容">
          <Link aria-current={view === "overview" ? "page" : undefined} className={view === "overview" ? "is-active" : ""} to={projectBasePath}>项目概览</Link>
          <Link aria-current={view === "risks" ? "page" : undefined} className={view === "risks" ? "is-active" : ""} to={`${projectBasePath}/risks`}>风险中心</Link>
          <Link aria-current={view === "report" ? "page" : undefined} className={view === "report" ? "is-active" : ""} to={`${projectBasePath}/report`}>AI 报告</Link>
          <Link aria-current={view === "data-source" ? "page" : undefined} className={view === "data-source" ? "is-active" : ""} to={`${projectBasePath}/data-source`}>数据配置</Link>
        </nav>

        <div className="project-space__content">
          {view === "data-source" ? (
            <ProjectDataSourcePanel
              currentUserRole={projectDetail.project.currentUserRole}
              dataSourceController={projectDataSource}
              onConfigured={onConfigured}
            />
          ) : null}
          {view !== "data-source" && showDataSourceLoading ? <SectionSkeleton description="正在确认当前项目是否已经连接数据源。" title="正在读取项目配置" /> : null}
          {view !== "data-source" && dataSourceError ? (
            <StatePanel
              action={{ label: "重新加载", onClick: () => void projectDataSource.refresh() }}
              description={projectDataSource.error ?? "暂时无法读取项目数据配置。"}
              title="项目数据配置暂不可用"
            />
          ) : null}
          {view !== "data-source" && isUnconfigured ? <UnconfiguredProjectPanel view={view} dataSourcePath={`${projectBasePath}/data-source`} /> : null}
          {view === "risks" && showReportLoading ? <SectionSkeleton description="正在读取项目事实并确认当前需要关注的风险。" title="正在整理项目风险" /> : null}
          {view === "report" && showReportLoading ? <SectionSkeleton description="风险事实已经确认，正在整理当前项目的解释与建议。" title="正在整理项目分析" /> : null}
          {(view === "risks" || view === "report") && reportError ? <StatePanel action={{ label: "重新加载", onClick: () => void projectReport.refresh() }} description={projectReport.error ?? "暂时无法读取项目分析。"} title="项目分析暂不可用" /> : null}
          {view === "risks" && isConfigured && !reportLoading && !reportError ? <RiskCenterPage embedded intelligence={projectIntelligence.intelligence} projectReport={projectReport} /> : null}
          {view === "report" && isConfigured && !reportLoading && !reportError ? <AIReportPage embedded intelligence={projectIntelligence.intelligence} projectReport={projectReport} /> : null}
          {view === "overview" && isConfigured ? <><DashboardPage embedded onRefresh={refreshOverview} project={projectDetail.project} projectReport={projectReport} refreshState={overviewRefreshState} /><ProjectIntelligencePanel backgroundUpdating={projectIntelligence.status === "refreshing"} intelligence={projectIntelligence.intelligence} loading={projectIntelligence.status === "loading"} refreshState={overviewRefreshState} /></> : null}
        </div>
      </section>
      </div>
      {view !== "data-source" && showDataSourceLoading ? <WorkspaceLoadingOverlay description="正在确认项目的数据连接状态，当前工作区会保持在原位。" title="正在准备项目内容" /> : null}
    </>
  );
}

function ProjectWorkspaceLoadingFrame() {
  return (
    <div className="project-space project-space--loading" aria-hidden="true">
      <aside className="project-space__list"><div className="skeleton skeleton--panel" /></aside>
      <section className="project-space__current"><div className="skeleton skeleton--heading" /><div className="skeleton skeleton--panel" /></section>
    </div>
  );
}

function UnconfiguredProjectPanel({
  view,
  dataSourcePath,
}: {
  view: Exclude<ProjectSpaceView, "data-source">;
  dataSourcePath: string;
}) {
  const title = view === "overview" ? "项目尚未绑定数据源" : view === "risks" ? "暂时无法分析项目风险" : "暂时无法生成 AI 报告";
  return (
    <div className="unconfigured-project-panel">
      <StatePanel
        description="请先在项目数据配置中绑定一个飞书多维表格。绑定前不会伪造健康度、风险或 AI 结论。"
        title={title}
      />
      <Link className="primary-action" to={dataSourcePath}>前往数据配置</Link>
    </div>
  );
}
