import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { INTERACTIVE_SURFACE_CLASS } from "../../animations/interactive-surface";
import { AiShimmer, SectionSkeleton } from "../../components/LoadingStates";
import { CustomSelect } from "../../components/CustomSelect";
import { PageHeader } from "../../components/PageHeader";
import { StatePanel } from "../../components/StatePanel";
import { useDelayedLoadingVisibility } from "../../hooks/useDelayedLoadingVisibility";
import {
  getRiskLevelPresentation,
  getRiskToneClass,
  sanitizeUserFacingText,
} from "../../features/project-report/presentation";
import { formatFactDisplay } from "../../features/product-language/presentation";
import {
  GlobalInsightsApiClient,
  GlobalInsightsApiError,
  type GlobalInsightSynthesisResponse,
  type GlobalInsightsResponse,
} from "../../services/api";
import { globalSynthesisSession } from "../../features/global-insights/synthesis-session";

type InsightsStatus = "loading" | "success" | "error";
type SynthesisStatus = "loading" | "success" | "error";

export function InsightsPage() {
  const client = useMemo(() => new GlobalInsightsApiClient(), []);
  const initialInsights = globalSynthesisSession.readInsights();
  const [status, setStatus] = useState<InsightsStatus>(initialInsights ? "success" : "loading");
  const [result, setResult] = useState<GlobalInsightsResponse | null>(initialInsights);
  const [error, setError] = useState<string | null>(null);
  const initialSynthesis = globalSynthesisSession.read();
  const [synthesisStatus, setSynthesisStatus] = useState<SynthesisStatus>(initialSynthesis ? "success" : "loading");
  const [synthesis, setSynthesis] = useState<GlobalInsightSynthesisResponse | null>(initialSynthesis);
  const [isRefreshingSynthesis, setIsRefreshingSynthesis] = useState(false);
  const [synthesisNotice, setSynthesisNotice] = useState<string | null>(null);
  const [riskLevelFilter, setRiskLevelFilter] = useState("all");
  const [projectFilter, setProjectFilter] = useState("all");
  const [sortMode, setSortMode] = useState("priority");
  const showInsightsLoading = useDelayedLoadingVisibility(status === "loading" && !result);
  const showSynthesisLoading = useDelayedLoadingVisibility(synthesisStatus === "loading");
  const browseInsights = useMemo(() => {
    const filtered = (result?.insights ?? []).filter((insight) => (
      (riskLevelFilter === "all" || insight.riskLevel === riskLevelFilter)
      && (projectFilter === "all" || insight.projectId === projectFilter)
    ));
    return sortMode === "deadline"
      ? [...filtered].sort((left, right) => (left.deadline ?? "9999-12-31").localeCompare(right.deadline ?? "9999-12-31"))
      : filtered;
  }, [projectFilter, result?.insights, riskLevelFilter, sortMode]);

  const loadInsights = useCallback(async () => {
    const previousInsights = globalSynthesisSession.readInsights();
    if (!previousInsights) {
      setStatus("loading");
      setError(null);
    }
    try {
      const nextResult = await globalSynthesisSession.revalidateInsights(client);
      setResult(nextResult);
      setStatus("success");
      setError(null);
    } catch (caughtError) {
      if (!previousInsights) {
        setResult(null);
        setError(getInsightsErrorMessage(caughtError));
        setStatus("error");
      }
    }
  }, [client]);

  const loadSynthesis = useCallback(async () => {
    const previousSynthesis = globalSynthesisSession.read();
    if (!previousSynthesis) setSynthesisStatus("loading");
    try {
      const nextSynthesis = await globalSynthesisSession.requestForVisit(client);
      setSynthesis(nextSynthesis.status === "unavailable" && previousSynthesis
        ? previousSynthesis
        : nextSynthesis);
      setSynthesisStatus("success");
    } catch {
      if (!globalSynthesisSession.read()) {
        setSynthesis(null);
        setSynthesisStatus("error");
      }
    }
  }, [client]);

  const refreshSynthesis = useCallback(async () => {
    if (isRefreshingSynthesis) return;
    setIsRefreshingSynthesis(true);
    setSynthesisNotice(null);
    const previousSynthesis = globalSynthesisSession.read();
    let factsConfirmed = false;
    try {
      const nextInsights = await globalSynthesisSession.revalidateInsights(client);
      factsConfirmed = true;
      setResult(nextInsights);
      setStatus("success");
      setError(null);
      const nextSynthesis = await globalSynthesisSession.forceRefresh(client);
      setSynthesis(nextSynthesis.status === "unavailable" && previousSynthesis
        ? previousSynthesis
        : nextSynthesis);
      setSynthesisStatus("success");
      setSynthesisNotice(nextSynthesis.status === "unavailable"
        ? "本次更新暂未完成，已确认的风险事实仍可正常查看。"
        : "已根据当前项目事实更新 AI 综合洞察。");
    } catch {
      setSynthesisNotice(factsConfirmed
        ? "本次更新暂未完成，已保留上次可用结果。"
        : "最新项目风险暂时无法确认，已保留上次可用结果。");
      if (!previousSynthesis) setSynthesisStatus("error");
    } finally {
      setIsRefreshingSynthesis(false);
    }
  }, [client, isRefreshingSynthesis]);

  useEffect(() => {
    void loadInsights();
    void loadSynthesis();
  }, [loadInsights, loadSynthesis]);

  return (
    <div className="page-stack global-insights-page">
      <PageHeader
        description="先看今天最值得处理的事，再按项目进入具体风险。"
        eyebrow="跨项目洞察"
        title="AI 洞察"
      />
      <p className="global-insights-page__boundary">排序只依据已确认的项目风险；待确认信息不会改变优先级。</p>
      <GlobalSynthesisPanel
        isRefreshing={isRefreshingSynthesis}
        notice={synthesisNotice}
        onRefresh={() => void refreshSynthesis()}
        showLoading={showSynthesisLoading}
        status={synthesisStatus}
        synthesis={synthesis}
      />
      {showInsightsLoading ? <SectionSkeleton description="正在读取你可访问项目中已经确认的风险事实。" title="正在整理重点风险" /> : null}
      {status === "error" ? (
        <StatePanel
          action={{ label: "重新加载", onClick: () => void loadInsights() }}
          description={error ?? "暂时无法读取跨项目洞察。"}
          title="洞察暂不可用"
        />
      ) : null}
      {status === "success" && result?.partialFailure ? (
        <p className="inline-alert" role="status">部分项目暂时无法完成分析，其余洞察仍可查看。</p>
      ) : null}
      {status === "success" && result?.insights.length === 0 ? (
        <StatePanel description="当前没有需要优先处理的项目风险。" title="暂无重点风险" />
      ) : null}
      {status === "success" && result?.insights.length ? (
        <>
        <section className="global-insight-list global-insight-list--priorities" aria-label="今日最值得关注的三件事">
          <header>
            <p className="section-kicker">今日重点</p>
            <h2>今日最值得关注的 3 件事</h2>
          </header>
          {result.insights.slice(0, 3).map((insight) => {
            const level = getRiskLevelPresentation(insight.riskLevel);
            return (
              <article className={`global-insight-card ${getRiskToneClass(level.tone)} ${INTERACTIVE_SURFACE_CLASS.card}`} key={insight.id}>
                <header>
                  <span className="risk-pill">{level.label}</span>
                  <span className="global-insight-card__project">来自：{insight.projectName}</span>
                </header>
                <h2>{sanitizeUserFacingText(insight.title)}</h2>
                <p>为什么现在重要：{sanitizeUserFacingText(insight.ruleBasis)}</p>
                <Link className={`secondary-action ${INTERACTIVE_SURFACE_CLASS.button}`} to={`/projects/${encodeURIComponent(insight.projectId)}/risks`}>进入项目处理</Link>
              </article>
            );
          })}
        </section>
        <section className="global-risk-browser" aria-label="全部跨项目风险">
          <header><div><p className="section-kicker">全部风险</p><h2>浏览所有已确认风险</h2></div><span>{browseInsights.length} 项</span></header>
          <div className="global-risk-filters" aria-label="风险筛选">
            <label><span>风险等级</span><CustomSelect aria-label="风险等级" onChange={setRiskLevelFilter} options={[{ value: "all", label: "全部等级" }, ...(["L5", "L4", "L3", "L2", "L1"] as const).map((level) => ({ value: level, label: getRiskLevelPresentation(level).label }))]} value={riskLevelFilter} /></label>
            <label><span>项目</span><CustomSelect aria-label="项目" onChange={setProjectFilter} options={[{ value: "all", label: "全部项目" }, ...groupInsights(result.insights).map((group) => ({ value: group.projectId, label: group.projectName }))]} value={projectFilter} /></label>
            <label><span>排序</span><CustomSelect aria-label="排序" onChange={setSortMode} options={[{ value: "priority", label: "按风险优先级" }, { value: "deadline", label: "按计划时间" }]} value={sortMode} /></label>
          </div>
<div className="global-risk-browser__list">{browseInsights.map((insight) => { const level = getRiskLevelPresentation(insight.riskLevel); return <article className={`global-risk-row ${getRiskToneClass(level.tone)}`} key={insight.id}><div className="global-risk-row__header"><span className="risk-pill">{level.label}</span><strong>{sanitizeUserFacingText(insight.title)}</strong><Link className="text-action" to={`/projects/${encodeURIComponent(insight.projectId)}/risks`}>进入项目风险中心</Link></div><p className="global-risk-row__meta">{insight.projectName}{insight.deadline ? ` · 计划时间 ${formatFactDisplay("计划时间", insight.deadline)}` : ""} · 依据：{sanitizeUserFacingText(insight.ruleBasis)}</p></article>; })}{browseInsights.length === 0 ? <p className="dashboard-card-empty">当前筛选下没有风险。</p> : null}</div>
        </section>
        </>
      ) : null}
    </div>
  );
}

function groupInsights(insights: GlobalInsightsResponse["insights"]): Array<{ projectId: string; projectName: string; insights: GlobalInsightsResponse["insights"] }> {
  const groups = new Map<string, { projectId: string; projectName: string; insights: GlobalInsightsResponse["insights"] }>();
  for (const insight of insights) {
    const group = groups.get(insight.projectId) ?? { projectId: insight.projectId, projectName: insight.projectName, insights: [] };
    group.insights.push(insight);
    groups.set(insight.projectId, group);
  }
  return [...groups.values()];
}

function GlobalSynthesisPanel({
  isRefreshing,
  notice,
  onRefresh,
  status,
  showLoading,
  synthesis,
}: {
  isRefreshing: boolean;
  notice: string | null;
  onRefresh: () => void;
  status: SynthesisStatus;
  showLoading: boolean;
  synthesis: GlobalInsightSynthesisResponse | null;
}) {
  if (status === "loading") {
    return showLoading ? <AiShimmer /> : null;
  }

  if (status === "error" || !synthesis || synthesis.status === "unavailable") {
    return (
      <section className="global-synthesis-card global-synthesis-card--unavailable">
        <header><p className="eyebrow">AI 综合洞察</p><RefreshSynthesisButton isRefreshing={isRefreshing} onRefresh={onRefresh} /></header>
        <strong>AI 综合解释暂不可用</strong>
        <p>已确认的规则风险和优先级仍可在下方正常查看。</p>
        {notice ? <p className="global-synthesis-card__notice" role="status">{notice}</p> : null}
      </section>
    );
  }

  return (
    <section className="global-synthesis-card" aria-label="AI 综合洞察">
      <header>
        <div>
          <p className="eyebrow">AI 综合洞察</p>
          <h2>对已确认事实的解释与建议</h2>
        </div>
        <span className={`explainability-badge explainability-badge--${synthesis.status}`}>
          {synthesis.status === "available" ? "已生成" : "信息来源不足"}
        </span>
        <RefreshSynthesisButton isRefreshing={isRefreshing} onRefresh={onRefresh} />
      </header>
      <p className="global-synthesis-card__summary">{sanitizeUserFacingText(synthesis.summary)}</p>
      {synthesis.priorities.length > 0 ? (
        <ol className="global-synthesis-card__priorities">
          {synthesis.priorities.map((priority) => (
            <li key={priority.insightId}>
              <p className="global-synthesis-card__body">{sanitizeUserFacingText(priority.explanation)}</p>
              <strong className="global-synthesis-card__suggestion">建议：{sanitizeUserFacingText(priority.suggestedAction)}</strong>
            </li>
          ))}
        </ol>
      ) : null}
      {synthesis.limitations.length > 0 ? (
        <p className="context-limitation global-synthesis-card__source-note">信息来源说明：{synthesis.limitations.map(sanitizeUserFacingText).filter(Boolean).join("；")}</p>
      ) : null}
      {notice ? <p className="global-synthesis-card__notice" role="status">{notice}</p> : null}
    </section>
  );
}

function RefreshSynthesisButton({
  isRefreshing,
  onRefresh,
}: {
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <button
      aria-busy={isRefreshing}
      aria-label="更新 AI 综合洞察"
      className={`secondary-action global-synthesis-card__refresh ${INTERACTIVE_SURFACE_CLASS.button}`}
      disabled={isRefreshing}
      onClick={onRefresh}
      type="button"
    >
      {isRefreshing ? "更新中…" : "更新 AI 洞察"}
    </button>
  );
}

function getInsightsErrorMessage(error: unknown): string {
  if (error instanceof GlobalInsightsApiError && error.status === 503) {
    return "洞察服务暂未就绪，请稍后重试。";
  }
  if (error instanceof TypeError) return "当前无法连接洞察服务，请检查网络后重试。";
  return "暂时无法读取跨项目洞察，请稍后重试。";
}
