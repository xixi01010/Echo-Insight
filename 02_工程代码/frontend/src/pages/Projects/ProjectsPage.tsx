import { FormEvent, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AppIcon } from "../../components/AppIcon";
import { AnimatedDisclosure } from "../../components/AdaptiveDetail";
import { Modal } from "../../components/Modal";
import { StatePanel } from "../../components/StatePanel";
import { useDelayedLoadingVisibility } from "../../hooks/useDelayedLoadingVisibility";
import { usePreferences } from "../../features/preferences/PreferenceContext";
import { getRiskLevelPresentation, getRiskToneClass } from "../../features/project-report/presentation";
import { useProjects } from "../../features/projects/ProjectContext";
import { useWorkspaceRuntime } from "../../features/workspace/WorkspaceRuntimeContext";
import {
  getCreateProjectErrorMessage,
  normalizeProjectNameInput,
  PROJECT_NAME_MAX_LENGTH,
} from "../../features/projects/project-creation";
import {
  getProjectConsoleHealthOverview,
  getProjectSummaryAvailabilityLabel,
  hasProjectHealthSummary,
} from "../../features/projects/project-summary-presentation";
import {
  ProjectApiError,
  type GlobalInsightsResponse,
  type ProjectSummary,
} from "../../services/api";

type DashboardModal = "create" | "join" | null;

export function ProjectsPage() {
  const runtime = useWorkspaceRuntime();
  const demo = runtime.mode === "demo";
  const { projects, projectsError, projectsLoading, projectsRefreshing, refreshProjects } = useProjects();
  const navigate = useNavigate();
  const showInitialLoading = useDelayedLoadingVisibility(projectsLoading && projects.length === 0);
  const summaryPending = projectsLoading || projectsRefreshing;
  const { favoriteProjectIds, projectSort, showRiskBadges, toggleFavoriteProject } = usePreferences();
  const [searchParams, setSearchParams] = useSearchParams();
  const [modal, setModal] = useState<DashboardModal>(null);
  const [insights, setInsights] = useState<GlobalInsightsResponse | null>(null);
  const [showAllFavorites, setShowAllFavorites] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    void runtime.globalInsightsClient.getInsights(controller.signal).then(setInsights).catch(() => setInsights(null));
    return () => controller.abort();
  }, [runtime.globalInsightsClient]);

  const sortedProjects = useMemo(() => [...projects].sort((left, right) => (
    projectSort === "name"
      ? left.name.localeCompare(right.name, "zh-CN")
      : new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime()
  )), [projectSort, projects]);

  if (projectsLoading && projects.length === 0) {
    return showInitialLoading ? <DashboardSkeleton /> : <div className="page-stack dashboard-page loading-reveal-placeholder" />;
  }

  if (projectsError && projects.length === 0) {
    return (
      <div className="page-stack dashboard-page">
        <DashboardHeading demo={demo} onCreate={() => setModal("create")} onJoin={() => setModal("join")} />
        <StatePanel action={{ label: "重新加载", onClick: () => void refreshProjects(), disabled: projectsLoading }} description={projectsError} title="暂时无法读取项目" />
      </div>
    );
  }

  const overview = getProjectConsoleHealthOverview(projects);
  const reportedRiskCount = projects.reduce((sum, project) => sum + (project.riskCount ?? 0), 0);
  const riskProjectCount = projects.filter((project) => (project.riskCount ?? 0) > 0).length;
  const focusInsight = insights?.insights[0] ?? null;
  const focusRisk = focusInsight ? getRiskLevelPresentation(focusInsight.riskLevel) : null;
  const filter = searchParams.get("filter");
  const visibleProjects = sortedProjects.filter((project) => (
    filter === "healthy" ? project.healthStatus === "healthy"
      : filter === "risk" ? (project.riskCount ?? 0) > 0
        : true
  ));
  const favoriteProjects = sortedProjects.filter((project) => favoriteProjectIds.includes(project.id));

  return (
    <div aria-busy={projectsRefreshing || undefined} className={`page-stack dashboard-page${projectsRefreshing ? " is-refreshing" : ""}`}>
      <DashboardHeading demo={demo} onCreate={() => setModal("create")} onJoin={() => setModal("join")} />
      {projectsError ? <p className="inline-alert" role="alert">部分项目暂时未能更新，页面展示上一次可用信息。</p> : null}
      {searchParams.get("join") === "failed" ? <p className="inline-alert" role="alert">未能确认你的项目访问资格，请检查飞书中的访问权限后重试。</p> : null}
      {projectsRefreshing ? <p aria-live="polite" className="dashboard-refresh-notice dashboard-refresh-notice--updating">正在更新项目健康度，页面先展示上次结果。</p> : null}

      {projects.length === 0 ? (
        <section className="dashboard-empty">
          <div className="dashboard-empty__visual"><AppIcon name="projects" /></div>
          <h2>建立你的第一个项目视图</h2>
          <p>创建一个新项目，或通过已有飞书多维表格加入你参与的项目。</p>
          <div className="dashboard-empty__actions">
            {demo ? <button className="primary-action" onClick={runtime.enterAccount} type="button">登录并使用我的项目</button> : <>
              <button className="primary-action" onClick={() => setModal("create")} type="button"><AppIcon name="plus" />创建项目</button>
              <button className="secondary-action" onClick={() => setModal("join")} type="button"><AppIcon name="join" />加入项目</button>
              <Link className="secondary-action" to="/?mode=demo"><AppIcon name="insights" />查看虚拟项目演示</Link>
            </>}
          </div>
        </section>
      ) : (
        <>
          <section className="dashboard-metrics dashboard-refresh-surface" aria-label="项目健康总览">
            <MetricCard label="我的项目" onClick={() => setSearchParams({})} value={overview.projectCount} note="当前可访问" />
            <MetricCard label="状态稳定" onClick={() => setSearchParams({ filter: "healthy" })} value={overview.healthyProjectCount} note="查看状态稳定项目" tone="healthy" />
            <MetricCard label="风险项目" onClick={() => setSearchParams({ filter: "risk" })} value={riskProjectCount} note="查看需要关注项目" tone={riskProjectCount > 0 ? "attention" : undefined} />
            <MetricCard label="风险信号" onClick={() => navigate("/insights")} value={reportedRiskCount} note="查看跨项目洞察" tone={reportedRiskCount > 0 ? "attention" : undefined} />
          </section>

          <section className="dashboard-focus-grid">
            <article className="dashboard-focus-card">
              <header><div><p className="section-kicker">重点关注</p><h2>当前最优先的项目风险</h2></div><Link to="/insights">查看全部</Link></header>
              {focusInsight ? (
                <div className="dashboard-focus-card__content">
                  <span className={`risk-pill ${focusRisk ? getRiskToneClass(focusRisk.tone) : ""}`}>{focusRisk?.label}</span>
                  <div><strong>{focusInsight.title}</strong><p>{focusInsight.projectName} · {focusInsight.currentUserRole === "owner" ? "项目负责人" : "项目成员"}</p></div>
                  <Link className="icon-link" aria-label="查看项目风险" to={`/projects/${encodeURIComponent(focusInsight.projectId)}/risks`}><AppIcon name="chevron" /></Link>
                </div>
              ) : <p className="dashboard-card-empty">当前没有需要优先处理的项目风险。</p>}
            </article>
            <article className="dashboard-focus-card dashboard-focus-card--favorites">
              <header><div><p className="section-kicker">我的关注</p><h2>常看项目</h2></div>{favoriteProjects.length > 3 ? <button aria-controls="favorite-projects-extra" aria-expanded={showAllFavorites} className="text-action" onClick={() => setShowAllFavorites((value) => !value)} type="button">{showAllFavorites ? "收起" : `查看全部 ${favoriteProjects.length} 个`}</button> : null}</header>
              {favoriteProjects.length ? <><ul className="favorite-project-list">{favoriteProjects.slice(0, 3).map((project) => <FavoriteProjectItem key={project.id} loading={summaryPending} onRemove={() => toggleFavoriteProject(project.id)} project={project} />)}</ul>{favoriteProjects.length > 3 ? <AnimatedDisclosure id="favorite-projects-extra" open={showAllFavorites}><ul className="favorite-project-list favorite-project-list--extra">{favoriteProjects.slice(3).map((project) => <FavoriteProjectItem key={project.id} loading={summaryPending} onRemove={() => toggleFavoriteProject(project.id)} project={project} />)}</ul></AnimatedDisclosure> : null}</> : <p className="dashboard-card-empty">点击项目卡右上角的星标，常看的项目会显示在这里。</p>}
            </article>
          </section>

          <section className="dashboard-projects">
            <header className="section-heading"><div><p className="section-kicker">项目空间</p><h2>{filter === "healthy" ? "状态稳定项目" : filter === "risk" ? "需要关注的项目" : "我的项目"}</h2></div><span>{visibleProjects.length} 个项目</span></header>
            <div className="project-card-grid">
              {visibleProjects.map((project) => (
                <article className="project-list-card motion-surface--interactive-card" key={project.id}>
                  <header><span className="project-role">{project.currentUserRole === "owner" ? "负责人" : "成员"}</span>{showRiskBadges && project.riskCount !== undefined && project.riskCount > 0 ? <span className="project-risk-badge">{project.riskCount} 项风险</span> : null}<button aria-label={`${favoriteProjectIds.includes(project.id) ? "取消关注" : "关注"} ${project.name}`} aria-pressed={favoriteProjectIds.includes(project.id)} className="project-favorite-action project-favorite-action--icon" onClick={() => toggleFavoriteProject(project.id)} title={favoriteProjectIds.includes(project.id) ? "取消关注" : "关注"} type="button"><AppIcon name="star" /></button></header>
                  <Link className="project-list-card__open" to={`/projects/${encodeURIComponent(project.id)}`}><h3>{project.name}</h3>{hasProjectHealthSummary(project) ? <div className="project-card-health"><span>健康度</span><strong className={`project-health-score project-health-score--${project.healthStatus}`}>{project.healthScore}</strong>{getProjectSummaryAvailabilityLabel(project) ? <small>{getProjectSummaryAvailabilityLabel(project)}</small> : null}</div> : <p className="project-card-unavailable">{getProjectSummaryAvailabilityLabel(project, summaryPending)}</p>}<footer><span>更新于 {formatRelativeDate(project.updatedAt)}</span><span>进入项目 <AppIcon name="chevron" /></span></footer></Link>
                </article>
              ))}
              {!visibleProjects.length ? <p className="dashboard-card-empty">当前筛选下没有项目。<button className="text-action" onClick={() => setSearchParams({})} type="button">查看全部项目</button></p> : null}
            </div>
          </section>
        </>
      )}

      {!demo ? <CreateProjectModal onClose={() => setModal(null)} open={modal === "create"} /> : null}
      {!demo ? <JoinProjectModal onClose={() => setModal(null)} open={modal === "join"} /> : null}
    </div>
  );
}

function FavoriteProjectItem({ loading, onRemove, project }: { loading: boolean; onRemove: () => void; project: ProjectSummary }) {
  const availability = getProjectSummaryAvailabilityLabel(project, loading);
  return <li><Link to={`/projects/${encodeURIComponent(project.id)}`}><strong>{project.name}</strong>{hasProjectHealthSummary(project) ? <span>健康度 {project.healthScore}{availability ? ` · ${availability}` : ""}</span> : <span>{availability}</span>}</Link><button aria-label={`取消关注 ${project.name}`} aria-pressed="true" className="project-favorite-action project-favorite-action--icon" onClick={onRemove} title="取消关注" type="button"><AppIcon name="star" /></button></li>;
}

function DashboardHeading({ demo, onCreate, onJoin }: { demo: boolean; onCreate: () => void; onJoin: () => void }) {
  return (
    <header className="dashboard-heading">
      <div><p className="section-kicker">{demo ? "演示账号 · 项目控制台" : "个人项目控制台"}</p><h1>今天，先看清项目全局</h1><p>{demo ? "通过五个不同健康状态的合成项目，完整体验风险判断、多源信息与项目洞察。" : "集中了解你参与项目的健康状态、风险变化与下一步关注重点。"}</p></div>
      {demo ? null : <div className="dashboard-heading__actions">
          <button className="secondary-action" onClick={onJoin} type="button"><AppIcon name="join" />加入项目</button>
          <button className="primary-action" onClick={onCreate} type="button"><AppIcon name="plus" />创建项目</button>
        </div>}
    </header>
  );
}

function MetricCard({ label, note, onClick, tone, value }: { label: string; note: string; onClick: () => void; tone?: string; value: number }) {
  return <button className={`metric-card metric-card--interactive ${tone ? `metric-card--${tone}` : ""}`} onClick={onClick} type="button"><span>{label}</span><strong>{value}</strong><small>{note}</small></button>;
}

function CreateProjectModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const client = useWorkspaceRuntime().projectClient;
  const navigate = useNavigate();
  const { refreshProjects } = useProjects();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = normalizeProjectNameInput(name);
    if (!normalizedName) return setError("请输入有效的项目名称。");
    setSubmitting(true); setError(null);
    try {
      const project = await client.createProject(normalizedName);
      await refreshProjects();
      navigate(`/projects/${encodeURIComponent(project.id)}`);
    } catch (caughtError) {
      setError(getCreateProjectErrorMessage(caughtError));
      setSubmitting(false);
    }
  };
  return (
    <Modal description="先建立项目空间，随后可在项目内连接飞书多维表格。" onClose={onClose} open={open} title="创建项目">
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <label><span>项目名称</span><input autoFocus disabled={submitting} maxLength={PROJECT_NAME_MAX_LENGTH} onChange={(event) => setName(event.target.value)} placeholder="例如：产品发布准备" value={name} /></label>
        <p>你将成为该项目的负责人。</p>
        {error ? <p className="inline-alert" role="alert">{error}</p> : null}
        <div className="modal-form__actions"><button className="secondary-action" onClick={onClose} type="button">取消</button><button className="primary-action" disabled={submitting} type="submit">{submitting ? "正在创建…" : "创建项目"}</button></div>
      </form>
    </Modal>
  );
}

function JoinProjectModal({ onClose, open }: { onClose: () => void; open: boolean }) {
  const client = useWorkspaceRuntime().projectClient;
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!url.trim()) return setError("请粘贴飞书多维表格链接。");
    setSubmitting(true); setError(null);
    try {
      const authorization = await client.startProjectJoin(url.trim());
      window.location.assign(authorization.authorizationUrl);
    } catch (caughtError) {
      setError(caughtError instanceof ProjectApiError ? "暂时无法确认访问资格，请检查链接与飞书权限。" : "当前无法连接项目服务，请稍后重试。");
      setSubmitting(false);
    }
  };
  return (
    <Modal description="系统会通过飞书确认你对该资源的访问权；链接本身不会授予权限。" onClose={onClose} open={open} title="加入已有项目">
      <form className="modal-form" onSubmit={(event) => void submit(event)}>
        <label><span>飞书多维表格链接</span><input autoFocus disabled={submitting} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.feishu.cn/base/..." value={url} /></label>
        {error ? <p className="inline-alert" role="alert">{error}</p> : null}
        <div className="modal-form__actions"><button className="secondary-action" onClick={onClose} type="button">取消</button><button className="primary-action" disabled={submitting} type="submit">{submitting ? "正在前往飞书确认…" : "继续验证"}</button></div>
      </form>
    </Modal>
  );
}

function DashboardSkeleton() {
  return <div className="page-stack dashboard-page" aria-busy="true"><div className="skeleton skeleton--heading" /><div className="dashboard-metrics">{[0, 1, 2, 3].map((item) => <div className="skeleton skeleton--metric" key={item} />)}</div><div className="skeleton skeleton--panel" /></div>;
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "近期";
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  if (days < 7) return `${days} 天前`;
  return date.toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
