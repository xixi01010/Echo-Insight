import { useState } from "react";
import { AnimatedDisclosure } from "../../components/AdaptiveDetail";
import { formatFactDisplay, formatFactSubject, formatProductDateTime, getSourceDataState, getSourceLabels, toProductLanguage, translateCandidateKind } from "../../features/product-language/presentation";
import type { ProjectIntelligence } from "../../services/api";

type ProjectInformationRefreshState = "idle" | "updating" | "success" | "partial" | "error";

export function ProjectIntelligencePanel({ intelligence, loading = false, refreshState = "idle", backgroundUpdating = false }: { intelligence: ProjectIntelligence | null; loading?: boolean; refreshState?: ProjectInformationRefreshState; backgroundUpdating?: boolean }) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  if (!intelligence) return loading ? <ProjectIntelligenceSkeleton /> : null;
  const sourceCount = new Set(intelligence.freshness.map((item) => item.sourceType)).size;
  const freshCount = intelligence.freshness.filter((item) => item.state === "fresh").length;

  const effectiveRefreshState: ProjectInformationRefreshState = refreshState === "idle" && backgroundUpdating ? "updating" : refreshState;
  const refreshCopy = getRefreshCopy(effectiveRefreshState);
  return <section className="project-intelligence-panel" aria-label="项目信息">
    <header><div><p className="section-kicker">项目信息</p><h2>已确认信息与待确认信息</h2></div><div className="project-intelligence-panel__status"><p className="project-intelligence-panel__summary">{sourceCount} 个来源 · {freshCount === sourceCount ? "全部已更新" : "部分数据需要留意"}</p>{refreshCopy ? <span aria-live="polite" className={`project-intelligence-panel__refresh project-intelligence-panel__refresh--${effectiveRefreshState}`}>{effectiveRefreshState === "updating" ? <i aria-hidden="true" /> : null}{refreshCopy}</span> : null}</div></header>
    <div className="project-intelligence-grid project-intelligence-grid--primary">
      <section><h3>已确认项目信息</h3>{intelligence.currentFacts.length ? <ul>{intelligence.currentFacts.slice(0, 3).map((fact) => <li key={`${fact.subject}:${fact.value}`}><span className="project-intelligence-fact__subject">{formatFactSubject(fact.subject)}</span><strong>{formatFactDisplay(fact.subject, fact.value)}</strong><span>来自：{getSourceLabels(fact.sourceTypes)}</span></li>)}</ul> : <p>当前没有额外的已确认信息。</p>}</section>
      <section><h3>待确认信息</h3>{intelligence.potentialSignals.length ? <ul>{intelligence.potentialSignals.slice(0, 3).map((signal) => <li key={signal.id}><strong>{toProductLanguage(signal.summary)}</strong><span>{translateCandidateKind(signal.kind)} · 来自：{getSourceLabels(signal.sourceTypes)}</span></li>)}</ul> : <p>当前没有待确认信息。</p>}{intelligence.conflicts.length ? <p className="project-intelligence-conflict-summary">信息冲突 · 需要确认：{getSourceLabels(intelligence.conflicts.flatMap((conflict) => conflict.sourceTypes))} 的信息不一致，系统不会自动选择答案。</p> : null}<small>待确认信息不会参与正式风险或健康度计算。</small></section>
    </div>
    <button aria-controls="project-intelligence-details" aria-expanded={detailsOpen} className="text-action project-intelligence-panel__toggle" onClick={() => setDetailsOpen((value) => !value)} type="button">{detailsOpen ? "收起数据状态与说明" : "查看数据状态与说明"}</button>
    <AnimatedDisclosure id="project-intelligence-details" open={detailsOpen}><div className="project-intelligence-details">
      <section><h3>数据状态</h3>{intelligence.freshness.length ? <ul>{intelligence.freshness.map((item, index) => <li key={`${item.sourceType}:${index}`}><strong>{getSourceLabels([item.sourceType])} · {getSourceDataState(item.state)}</strong><span>{item.lastSuccessfulReadAt ? `最近读取成功：${formatProductDateTime(item.lastSuccessfulReadAt)}` : "尚无成功读取记录"}</span></li>)}</ul> : <p>当前没有可展示的来源读取状态。</p>}</section>
      <section><h3>信息冲突</h3>{intelligence.conflicts.length ? <p>有 {intelligence.conflicts.length} 项信息冲突需要确认；系统不会自动选择答案。</p> : <p>暂无需要确认的信息冲突 ✓</p>}</section>
      <section className="project-intelligence-details__boundary"><h3>AI 分析说明</h3><p>AI 基于已确认事实及待确认信息提供解释，不会修改项目事实、健康度或风险判断。</p></section>
    </div></AnimatedDisclosure>
  </section>;
}

function ProjectIntelligenceSkeleton() {
  return <section aria-busy="true" aria-label="正在读取项目信息" className="project-intelligence-panel project-intelligence-panel--loading"><header><div><p className="section-kicker">项目信息</p><h2>正在读取项目信息</h2></div></header><div className="project-intelligence-grid project-intelligence-grid--primary"><section><div className="skeleton skeleton--line" /><div className="skeleton skeleton--line" /><div className="skeleton skeleton--line" /></section><section><div className="skeleton skeleton--line" /><div className="skeleton skeleton--line" /><div className="skeleton skeleton--line" /></section></div></section>;
}

function getRefreshCopy(state: ProjectInformationRefreshState): string {
  return ({ idle: "", updating: "正在更新", success: "已更新", partial: "部分来源未更新", error: "本次更新失败，已保留上次结果" })[state];
}

export const sourceLabels = getSourceLabels;
