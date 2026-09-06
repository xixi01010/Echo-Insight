import { createPortal } from "react-dom";

export function WorkspaceLoadingOverlay({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return createPortal(
    <div className="workspace-loading-layer" role="status" aria-busy="true" aria-live="polite">
      <section className="workspace-loading-card">
        <span className="loading-spinner" aria-hidden="true" />
        <div><strong>{title}</strong><p>{description}</p></div>
      </section>
    </div>,
    document.body,
  );
}

export function SectionSkeleton({
  description,
  title,
}: {
  description: string;
  title: string;
}) {
  return (
    <section className="section-skeleton" aria-busy="true" aria-label={title}>
      <div className="section-skeleton__copy"><strong>{title}</strong><p>{description}</p></div>
      <div className="skeleton-line skeleton-line--wide" />
      <div className="skeleton-line" />
      <div className="skeleton-block" />
    </section>
  );
}

export function AiShimmer() {
  return (
    <section className="global-synthesis-card global-synthesis-card--loading ai-shimmer" aria-busy="true">
      <div className="ai-shimmer__heading"><span className="ai-shimmer__pulse" aria-hidden="true" /><div><p className="eyebrow">AI 综合洞察</p><strong>正在生成综合建议</strong></div></div>
      <p>项目风险已经可以查看，综合洞察仍在生成。</p>
      <div className="skeleton-line skeleton-line--wide" />
      <div className="skeleton-line" />
    </section>
  );
}
