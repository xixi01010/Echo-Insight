import { useState } from "react";
import { AnimatedDisclosure, DetailDrawer, useIsMobileDetail } from "../../components/AdaptiveDetail";
import type { ProjectReportController } from "../../features/project-report/useProjectReport";
import { getDataCompletenessNotice, getFactBackedRiskViews, getExplainabilityStateLabel, getRiskToneClass, type RiskViewModel } from "../../features/project-report/presentation";
import { toProductLanguage, translateCandidateKind } from "../../features/product-language/presentation";
import { INTERACTIVE_SURFACE_CLASS } from "../../animations/interactive-surface";
import { PageHeader } from "../../components/PageHeader";
import { StatePanel } from "../../components/StatePanel";
import type { ProjectIntelligence } from "../../services/api";
import { sourceLabels } from "../Project/ProjectIntelligencePanel";

interface RiskCenterPageProps { projectReport: ProjectReportController; embedded?: boolean; intelligence?: ProjectIntelligence | null; }

export function RiskCenterPage({ projectReport, embedded = false, intelligence }: RiskCenterPageProps) {
  const [selectedRiskId, setSelectedRiskId] = useState<string | null>(null);
  const isMobileDetail = useIsMobileDetail();
  const { report } = projectReport;
  if (!report) return <div className="page-stack">{!embedded ? <PageHeader description="集中查看项目当前需要关注的问题，以及每项判断的事实依据。" eyebrow="项目风险" title="风险中心" /> : null}<StatePanel description="生成首次分析后，这里将按优先级展示风险事实、影响和建议动作。" title="风险中心尚未生成分析" /></div>;

  const risks = getFactBackedRiskViews(report);
  const selectedRisk = risks.find((risk) => risk.id === selectedRiskId) ?? null;
  const dataCompletenessNotice = getDataCompletenessNotice(report);
  return <div className="page-stack">
    {!embedded ? <PageHeader description="这里回答发生了什么，以及系统依据什么判断需要关注。" eyebrow="项目风险" title="风险中心" /> : null}
    {risks.length === 0 && !dataCompletenessNotice ? <StatePanel description="当前项目事实未触发需要优先处理的风险。" title="项目暂未发现明显风险" /> : <section className="risk-card-grid" aria-label="项目风险列表">{risks.map((risk) => <RiskSummaryCard detailsOpen={selectedRiskId === risk.id} inlineDetails={isMobileDetail} key={risk.id} onToggle={() => setSelectedRiskId((current) => current === risk.id ? null : risk.id)} risk={risk} />)}</section>}
    {dataCompletenessNotice ? <section className={`data-completeness-notice ${INTERACTIVE_SURFACE_CLASS.card}`}><strong>数据完整性提醒</strong><p>{dataCompletenessNotice.message}</p></section> : null}
    {intelligence?.potentialSignals.length ? <section className="potential-risk-list"><h2>待确认信号</h2><p>这些信息尚未成为正式风险，不参与健康度或风险等级计算。</p><ul>{intelligence.potentialSignals.map((signal) => <li key={signal.id}><strong>{toProductLanguage(signal.summary)}</strong><span>{translateCandidateKind(signal.kind)} · 来自：{sourceLabels(signal.sourceTypes)}</span></li>)}</ul></section> : null}
    {intelligence?.conflicts.length ? <section className="conflict-list"><h2>信息冲突 · 需要确认</h2><ul>{intelligence.conflicts.map((conflict) => <li key={conflict.id}>尚未自动选择任何来源为最终答案。来源：{sourceLabels(conflict.sourceTypes)}</li>)}</ul></section> : null}
    {!isMobileDetail && selectedRisk ? <DetailDrawer onClose={() => setSelectedRiskId(null)} open title={selectedRisk.name}><RiskDetails risk={selectedRisk} /></DetailDrawer> : null}
  </div>;
}

function RiskSummaryCard({ detailsOpen, inlineDetails, onToggle, risk }: { detailsOpen: boolean; inlineDetails: boolean; onToggle: () => void; risk: RiskViewModel }) {
  const detailId = `risk-detail-${risk.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <article className={`risk-card ${getRiskToneClass(risk.level.tone)} ${INTERACTIVE_SURFACE_CLASS.card}`}>
    <header className="risk-card__header"><span className="risk-pill">{risk.level.label}</span><h3>{risk.name}</h3><span className={`explainability-badge explainability-badge--${risk.explainabilityState}`}>{getExplainabilityStateLabel(risk.explainabilityState)}</span></header>
    <div className="risk-card__body risk-card__body--summary">
      <section><span>发生了什么</span><p>{risk.fact}</p></section>
      <section><span>为什么需要关注</span><p>{risk.ruleReason}</p></section>
      <section><span>{risk.explainabilityState === "limited" ? "建议先补充" : "下一步建议"}</span><p>{risk.actions[0] ?? "请先确认当前项目事实。"}</p></section>
    </div>
    <button aria-controls={detailId} aria-expanded={detailsOpen} className="text-action risk-card__details-toggle" onClick={onToggle} type="button">{detailsOpen ? "收起详情" : "查看详情"}</button>
    <AnimatedDisclosure id={detailId} open={inlineDetails && detailsOpen}><div className="risk-card__details"><RiskDetails risk={risk} /></div></AnimatedDisclosure>
  </article>;
}

function RiskDetails({ risk }: { risk: RiskViewModel }) {
  return <div className="detail-content"><section><span>系统依据</span><ul>{risk.factualEvidence.map((evidence) => <li key={evidence}>{evidence}</li>)}</ul></section><section><span>可能影响</span><p>{risk.impact}</p></section>{risk.actions.length > 1 ? <section><span>完整建议</span><ul>{risk.actions.map((action) => <li key={action}>{action}</li>)}</ul></section> : null}{risk.limitations.length ? <section className="risk-card__limitations"><span>信息限制</span><p>{risk.limitations.join("；")}</p></section> : null}</div>;
}
