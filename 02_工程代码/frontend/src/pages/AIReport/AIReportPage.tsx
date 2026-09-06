import { useState } from "react";
import { AnimatedDisclosure, DetailDrawer, useIsMobileDetail } from "../../components/AdaptiveDetail";
import type { ProjectReportController } from "../../features/project-report/useProjectReport";
import { getDataCompletenessNotice, getFactBackedAiRiskViews, getExplainabilityStateLabel, getRiskToneClass, sanitizeUserFacingText, type RiskViewModel } from "../../features/project-report/presentation";
import { INTERACTIVE_SURFACE_CLASS } from "../../animations/interactive-surface";
import { PageHeader } from "../../components/PageHeader";
import { StatePanel } from "../../components/StatePanel";
import type { ProjectIntelligence } from "../../services/api";

interface AIReportPageProps { projectReport: ProjectReportController; embedded?: boolean; intelligence?: ProjectIntelligence | null; }

export function AIReportPage({ projectReport, embedded = false, intelligence }: AIReportPageProps) {
  const [selectedRiskId, setSelectedRiskId] = useState<string | null>(null);
  const [boundaryOpen, setBoundaryOpen] = useState(false);
  const isMobileDetail = useIsMobileDetail();
  const { report } = projectReport;
  if (!report) return <div className="page-stack">{!embedded ? <PageHeader description="在项目事实与规则判断之后，查看 AI 对影响和下一步的解释。" eyebrow="AI 分析" title="AI 报告" /> : null}<StatePanel description="生成首次分析后，AI 解释会与风险依据分层展示。" title="AI 报告尚未生成" /></div>;

  const risks = getFactBackedAiRiskViews(report);
  const limitations = report.aiReport.limitations.map(sanitizeUserFacingText).filter(Boolean);
  const dataCompletenessNotice = getDataCompletenessNotice(report);
  if (dataCompletenessNotice) limitations.push(dataCompletenessNotice.message);
  const selectedRisk = risks.find((risk) => risk.id === selectedRiskId) ?? null;

  return <div className="page-stack ai-report-page">
    {!embedded ? <PageHeader description="这里回答风险意味着什么、为什么重要，以及今天可以先做什么。" eyebrow="AI 分析" title="AI 报告" /> : null}
    {report.aiStatus === "unavailable" && risks.length > 0 ? <p className="inline-alert" role="status">AI 解释本次未更新；已确认事实、健康度与规则风险仍为最新结果。</p> : null}
    {report.aiStatus === "unavailable" && risks.length === 0 ? <StatePanel description="本次 AI 解释未能更新；已确认事实、健康度与规则风险仍可在项目概览和风险中心查看。" title="AI 解释暂未更新" /> : risks.length === 0 ? <StatePanel description="当前规则结果没有需要 AI 追加解释的风险。" title="暂无风险解释" /> : <>
      <section className={`ai-report-summary ${INTERACTIVE_SURFACE_CLASS.card}`}><p className="section-kicker">项目级综合判断</p><h2>今天优先处理 {risks.slice(0, 2).map((risk) => risk.name).join("、")}</h2><p>这些问题可能共同影响项目推进；建议先完成最优先问题的确认与安排，再更新后续计划。</p><ol>{risks.slice(0, 2).map((risk) => <li key={risk.id}><strong>{risk.name}</strong><span>{risk.actions[0] ?? "先确认当前项目事实。"}</span></li>)}</ol></section>
      <section className="ai-report-card-grid" aria-label="项目 AI 解释列表">{risks.map((risk) => <AiExplanationCard detailsOpen={selectedRiskId === risk.id} inlineDetails={isMobileDetail} key={risk.id} onToggle={() => setSelectedRiskId((current) => current === risk.id ? null : risk.id)} risk={risk} />)}</section>
    </>}
    <section className={`report-boundary-card report-boundary-card--compact ${INTERACTIVE_SURFACE_CLASS.card}`}><div><p className="section-kicker">可信度说明</p><h2>AI 分析说明</h2></div><p className="report-boundary-card__body">AI 基于已确认事实及明确标记的待确认信息提供解释，不会修改项目事实、健康度或风险判断。</p>{limitations.length ? <><button aria-controls="ai-boundary-details" aria-expanded={boundaryOpen} className="text-action" onClick={() => setBoundaryOpen((value) => !value)} type="button">{boundaryOpen ? "收起分析边界" : "查看分析边界"}</button><AnimatedDisclosure id="ai-boundary-details" open={boundaryOpen}><p className="report-boundary-card__details">{limitations.join("；")}</p></AnimatedDisclosure></> : null}{intelligence?.potentialSignals.length ? <small>本次参考了 {intelligence.potentialSignals.length} 项待确认信息，它们仍不参与正式风险计算。</small> : null}</section>
    {!isMobileDetail && selectedRisk ? <DetailDrawer onClose={() => setSelectedRiskId(null)} open title={selectedRisk.name}><AiEvidenceDetails risk={selectedRisk} /></DetailDrawer> : null}
  </div>;
}

function AiExplanationCard({ detailsOpen, inlineDetails, onToggle, risk }: { detailsOpen: boolean; inlineDetails: boolean; onToggle: () => void; risk: RiskViewModel }) {
  const detailId = `ai-detail-${risk.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <article className={`explanation-chain ${getRiskToneClass(risk.level.tone)} ${INTERACTIVE_SURFACE_CLASS.card}`}>
    <header className="explanation-chain__header"><span className="risk-pill">{risk.level.label}</span><h3>{risk.name}</h3><span className={`explainability-badge explainability-badge--${risk.explainabilityState}`}>{getExplainabilityStateLabel(risk.explainabilityState)}</span></header>
    <section><span>AI 解释</span><p>{risk.aiReason ?? "当前仅能依据已确认项目事实提供有限说明。"}</p></section>
    <section><span>为什么重要</span><p>{risk.impact}</p></section>
    <section><span>{risk.explainabilityState === "limited" ? "建议先补充" : "下一步建议"}</span><p>{risk.actions[0] ?? "请先确认当前项目事实。"}</p></section>
    <button aria-controls={detailId} aria-expanded={detailsOpen} className="text-action explanation-chain__details-toggle" onClick={onToggle} type="button">{detailsOpen ? "收起详情" : "查看详情"}</button>
    <AnimatedDisclosure id={detailId} open={inlineDetails && detailsOpen}><div className="explanation-chain__details"><AiEvidenceDetails risk={risk} /></div></AnimatedDisclosure>
  </article>;
}

function AiEvidenceDetails({ risk }: { risk: RiskViewModel }) {
  return <div className="detail-content"><section><span>系统依据</span><p>{risk.fact}</p><ul>{risk.factualEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul></section><section><span>规则判断</span><p>{risk.ruleReason}</p></section>{risk.limitations.length ? <section><span>信息限制</span><p>{risk.limitations.join("；")}</p></section> : null}</div>;
}
