import { Link } from "react-router-dom";
import { PROJECT_PRESENTATION } from "../../app/presentation";
import type { ProjectReportController } from "../../features/project-report/useProjectReport";
import { getInsightActionCopy } from "../../features/project-report/insight-copy";
import {
  getDataCompletenessNotice,
  getFactBackedAiRiskViews,
  getFactBackedRiskViews,
  getHealthPresentation,
  getHealthReasonLines,
  getRiskLevelPresentation,
  getRiskToneClass,
  sanitizeUserFacingText,
} from "../../features/project-report/presentation";
import { INTERACTIVE_SURFACE_CLASS } from "../../animations/interactive-surface";
import { SectionSkeleton } from "../../components/LoadingStates";
import { StatePanel } from "../../components/StatePanel";
import { useDelayedLoadingVisibility } from "../../hooks/useDelayedLoadingVisibility";
import type { ProjectSummary } from "../../services/api";
import { formatProductDateTime } from "../../features/product-language/presentation";

interface DashboardPageProps {
  project?: ProjectSummary;
  projectReport: ProjectReportController;
  embedded?: boolean;
  onRefresh?: () => Promise<void>;
  refreshState?: "idle" | "updating" | "success" | "partial" | "error";
}

export function DashboardPage({ project, projectReport, embedded = false, onRefresh, refreshState = "idle" }: DashboardPageProps) {
  const { report, status, error, refresh, hasHistoricalReport } = projectReport;
  const actionCopy = getInsightActionCopy(hasHistoricalReport, status);
  const isLoading = refreshState === "updating" || status === "loading" || status === "refreshing";
  const showInitialLoading = useDelayedLoadingVisibility(isLoading && !report);
  const projectName = project?.name ?? PROJECT_PRESENTATION.name;
  const projectRole = project?.currentUserRole === "owner" ? "负责人" : "成员";
  const projectBasePath = project
    ? `/projects/${encodeURIComponent(project.id)}`
    : "";

  if (!report) {
    if (showInitialLoading) {
      return <SectionSkeleton description="正在读取项目事实并确认健康状态与风险。" title="正在整理项目概览" />;
    }
    if (isLoading) return <div className="loading-reveal-placeholder" />;
    return (
      <div className="first-insight-flow" aria-busy={isLoading}>
        {!embedded ? (
          <section className={`project-context-card ${INTERACTIVE_SURFACE_CLASS.card}`}>
            <p className="section-kicker">当前观察项目</p>
            <h2>{projectName}</h2>
            <div className="source-line">
              <span>{project ? `我的角色：${projectRole}` : PROJECT_PRESENTATION.source}</span>
              <span>{project ? "项目级报告" : PROJECT_PRESENTATION.accessMode}</span>
            </div>
          </section>
        ) : null}
        <StatePanel
          action={{ label: actionCopy.label, onClick: () => void refresh(), disabled: isLoading }}
          description={actionCopy.description}
          title={actionCopy.title}
        />
        {error && <p className="inline-alert" role="alert">{error}</p>}
        <ol
          className={`insight-steps ${INTERACTIVE_SURFACE_CLASS.card}`}
          aria-label="首次分析流程"
        >
          <li><span>01</span><div><strong>读取事实</strong><p>从已授权的飞书项目范围读取数据。</p></div></li>
          <li><span>02</span><div><strong>规则判断</strong><p>计算健康度并识别需要关注的问题。</p></div></li>
          <li><span>03</span><div><strong>AI 解释</strong><p>解释风险原因、影响与建议动作。</p></div></li>
        </ol>
      </div>
    );
  }

  const health = getHealthPresentation(report.analysis.healthScore, report.analysis.healthStatus);
  const riskLevel = getRiskLevelPresentation(report.analysis.riskLevel);
  const riskViews = getFactBackedRiskViews(report);
  const dataCompletenessNotice = getDataCompletenessNotice(report);
  const healthReasons = getHealthReasonLines(report);
  const primaryRisk = riskViews[0];
  const primaryInsight = getFactBackedAiRiskViews(report)[0];
  const aiUnavailable = report.aiStatus === "unavailable";
  const primaryRiskTone = primaryRisk
    ? getRiskToneClass(primaryRisk.level.tone)
    : "";

  return (
    <div aria-busy={isLoading} className={`page-stack dashboard-success ${isLoading ? "is-refreshing" : ""}`}>
      {!embedded ? (
        <section className="project-overview">
          <div>
            <p className="section-kicker">项目分析工作台</p>
            <h2>{projectName}</h2>
            <p>{project ? `我的角色：${projectRole}` : `${PROJECT_PRESENTATION.source} · ${PROJECT_PRESENTATION.accessMode}`}</p>
          </div>
          <span className="observation-status">持续观察中</span>
        </section>
      ) : null}

      <section
        className={`health-hero health-hero--${health.tone} dashboard-refresh-surface ${INTERACTIVE_SURFACE_CLASS.card}`}
      >
        <div className="health-score-block">
          <span>项目健康度</span>
          <strong>{report.analysis.healthScore}</strong>
          <small>/ 100 · 基于项目事实计算</small>
        </div>
        <div className="health-status-block">
          <span className="health-status-label">{health.label}</span>
          <h3>{riskLevel.label}</h3>
          <p>{health.summary}</p>
          <div className="health-reason-summary">
            <strong>主要影响因素</strong>
            <ul>{healthReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          </div>
          <small>AI 不参与健康评分，仅负责解释风险。</small>
        </div>
      </section>

      <section className="risk-summary-grid">
        <Link className={`risk-summary-card risk-summary-card--metric ${INTERACTIVE_SURFACE_CLASS.card}`} to={project ? `${projectBasePath}/risks` : "/risks"}>
          <span>当前风险</span>
          <strong>{riskViews.length}</strong>
          <p>项需要关注的问题</p>
          {dataCompletenessNotice ? <p className="data-completeness-summary">{dataCompletenessNotice.message}</p> : null}
        </Link>
        <article
          className={`priority-risk-card ${primaryRiskTone} ${INTERACTIVE_SURFACE_CLASS.card}`}
          >
            <span>最高优先级风险</span>
          <strong>{primaryRisk?.name ?? "当前无高优先风险"}</strong>
          <p>{primaryRisk?.fact ?? "当前报告未发现需要优先处理的风险。"}</p>
        </article>
      </section>

      <section className={`ai-entry-card ${INTERACTIVE_SURFACE_CLASS.card}`}>
        <div>
          <p className="section-kicker">AI 洞察</p>
          <h3>{aiUnavailable ? "AI 解释本次未更新" : primaryInsight?.name ?? "当前没有需要追加解释的风险"}</h3>
          <p>{aiUnavailable ? sanitizeUserFacingText(report.aiReport.limitations[0]) || "本次 AI 解释未能更新；项目事实与规则风险仍可正常查看。" : primaryInsight?.aiReason ?? "项目事实与规则结果显示，当前无需生成额外风险解释。"}</p>
        </div>
        <div className="insight-actions">
          <Link
            className={`secondary-action ${INTERACTIVE_SURFACE_CLASS.button}`}
            to={project ? `${projectBasePath}/risks` : "/risks"}
          >查看风险解释</Link>
          <Link
            className={`primary-action ${INTERACTIVE_SURFACE_CLASS.button}`}
            to={project ? `${projectBasePath}/report` : "/report"}
          >查看建议动作</Link>
        </div>
      </section>

      <footer className="dashboard-footer">
        <div>
          <span>最近更新时间</span>
          <strong>{formatProductDateTime(report.analysis.scoringDetails.calculatedAt)}</strong>
          {refreshState !== "idle" ? <span aria-live="polite" className={`dashboard-refresh-notice dashboard-refresh-notice--${refreshState}`}>{getRefreshNotice(refreshState)}</span> : null}
          {error && refreshState === "idle" ? <span className="dashboard-refresh-notice dashboard-refresh-notice--error" role="alert">更新失败，已保留上次结果：{error}</span> : null}
        </div>
        <button
          aria-busy={isLoading}
          className={`weui-btn weui-btn_primary refresh-insight ${INTERACTIVE_SURFACE_CLASS.button}`}
          disabled={isLoading}
          onClick={() => void (onRefresh?.() ?? refresh())}
          type="button"
        >
          {actionCopy.label}
        </button>
      </footer>
    </div>
  );
}

function getRefreshNotice(state: NonNullable<DashboardPageProps["refreshState"]>): string {
  return ({
    idle: "",
    updating: "正在刷新项目分析",
    success: "项目分析已更新",
    partial: "分析已更新，部分内容保留上次结果",
    error: "本次刷新失败，已保留上次结果",
  })[state];
}
