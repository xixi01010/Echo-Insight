import { FormEvent, useRef, useState } from "react";
import { INTERACTIVE_SURFACE_CLASS } from "../../animations/interactive-surface";
import { CustomSelect } from "../../components/CustomSelect";
import { SectionSkeleton } from "../../components/LoadingStates";
import { StatePanel } from "../../components/StatePanel";
import { formatProductDateTime, formatSourceDisplayName, getSourceBadge, getSourceDataState, getSourceLabel } from "../../features/product-language/presentation";
import type { ProjectDataSourceController } from "../../features/projects/useProjectDataSource";
import { ProjectApiError, type ProjectSourceStatus, type ProjectSourceType } from "../../services/api";
import { useDelayedLoadingVisibility } from "../../hooks/useDelayedLoadingVisibility";

interface ProjectDataSourcePanelProps { dataSourceController: ProjectDataSourceController; currentUserRole: "owner" | "member"; onConfigured: () => Promise<void>; }

const SOURCE_TYPES: readonly ProjectSourceType[] = [
  "feishu-base", "feishu-chat", "feishu-minutes", "feishu-docs", "feishu-wiki-drive", "feishu-task", "feishu-calendar",
] as const;
const SOURCE_OPTIONS: Array<{ value: ProjectSourceType; label: string }> = SOURCE_TYPES.map((value) => ({ value, label: getSourceLabel(value) }));

export function ProjectDataSourcePanel({ dataSourceController, currentUserRole, onConfigured }: ProjectDataSourcePanelProps) {
  const { addSource, configure, dataSource, error, getCalendarEventOptions, getSourceOptions, refresh, removeSource, setSourceEnabled, status } = dataSourceController;
  const [sourceType, setSourceType] = useState<ProjectSourceType>("feishu-base");
  const [sourceName, setSourceName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceOptions, setSourceOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [calendarSelectionId, setCalendarSelectionId] = useState("");
  const [eventOptions, setEventOptions] = useState<Array<{ id: string; title: string; startAt?: string; endAt?: string }>>([]);
  const [selectionId, setSelectionId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const mutationInFlightRef = useRef(false);
  const removeTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const showLoading = useDelayedLoadingVisibility(status === "idle" || status === "loading");

  if (status === "idle" || status === "loading") return showLoading ? <SectionSkeleton description="正在读取当前项目的数据连接状态。" title="正在加载数据配置" /> : <div className="loading-reveal-placeholder" />;
  if (status === "error") return <StatePanel action={{ label: "重新加载", onClick: () => void refresh() }} description={error ?? "暂时无法读取数据配置。"} title="数据配置暂不可用" />;

  const sources = dataSource?.sources ?? (dataSource?.configured ? [legacyBaseSource(dataSource?.displayName)] : []);
  const resetSourceInput = () => { setSourceName(""); setSourceUrl(""); setSourceOptions([]); setCalendarSelectionId(""); setEventOptions([]); setSelectionId(""); };
  const changeSourceType = (value: string) => { setSourceType(value as ProjectSourceType); resetSourceInput(); };
  const submitSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true; setSubmitting(true); setSubmitError(null);
    try {
      if (sourceType === "feishu-base") {
        const url = sourceUrl;
        if (!url.trim()) throw new ProjectApiError("Missing source URL", 400, "INVALID_DATA_SOURCE_URL");
        await configure(url.trim());
      } else {
        const input = selectionId ? { ...(sourceName.trim() ? { displayName: sourceName.trim() } : {}), selectionId } : { ...(sourceName.trim() ? { displayName: sourceName.trim() } : {}), sourceType, sourceUrl: sourceUrl.trim() };
        await addSource(input);
      }
      resetSourceInput(); await onConfigured();
    } catch (caughtError) { setSubmitError(getConfigurationErrorMessage(caughtError)); }
    finally { mutationInFlightRef.current = false; setSubmitting(false); }
  };
  const toggleSource = async (source: ProjectSourceStatus) => {
    if (mutationInFlightRef.current) return;
    mutationInFlightRef.current = true; setSubmitting(true); setActionError(null);
    try { await setSourceEnabled(source.id, !source.enabled); await onConfigured(); }
    catch (caughtError) { setActionError(getSourceActionErrorMessage(caughtError, source.enabled ? "暂停" : "恢复")); }
    finally { mutationInFlightRef.current = false; setSubmitting(false); }
  };
  const openRemoveConfirmation = (sourceId: string) => {
    if (mutationInFlightRef.current) return;
    setActionError(null); setRemovingId(sourceId);
  };
  const closeRemoveConfirmation = (sourceId: string) => {
    setRemovingId((current) => current === sourceId ? null : current);
    window.requestAnimationFrame(() => removeTriggerRefs.current.get(sourceId)?.focus());
  };
  const confirmRemove = async (source: ProjectSourceStatus) => {
    if (mutationInFlightRef.current || removingId !== source.id) return;
    mutationInFlightRef.current = true; setSubmitting(true); setActionError(null);
    try { await removeSource(source.id); setRemovingId(null); await onConfigured(); }
    catch (caughtError) { setActionError(getSourceActionErrorMessage(caughtError, "移除")); }
    finally { mutationInFlightRef.current = false; setSubmitting(false); }
  };

  return <section className="project-data-source-panel">
    <div className="project-data-source-panel__status"><p className="section-kicker">项目数据配置</p><h2>当前数据来源</h2><p>这里管理哪些已授权信息参与项目分析，以及它们当前是否正常。</p></div>
    {sources.length ? <div className="data-source-list" aria-label="当前数据来源">{sources.map((source) => <article className="data-source-card" key={source.id}>
      <div className="data-source-card__icon" aria-hidden="true">{getSourceBadge(source.type)}</div>
      <div className="data-source-card__identity"><strong>{formatSourceDisplayName(source.type, source.displayName)}</strong><small>数据状态：{getSourceDataState(source.freshness)}</small></div>
      <div className="data-source-card__meta"><span>{source.lastSuccessfulReadAt ? `最近读取成功：${formatProductDateTime(source.lastSuccessfulReadAt)}` : sourceStatusLabel(source)}</span>{source.failureCategory ? <small>{failureCategoryLabel(source.failureCategory)}</small> : null}</div>
      {currentUserRole === "owner" ? <div className="data-source-card__actions">
        <button className="secondary-action" disabled={submitting} onClick={() => void toggleSource(source)} type="button">{source.enabled ? "暂停使用" : "恢复使用"}</button>
        <button
          aria-controls={removingId === source.id ? getRemoveDialogId(source.id) : undefined}
          aria-expanded={removingId === source.id}
          aria-haspopup="dialog"
          className="secondary-action data-source-card__remove"
          disabled={submitting || removingId === source.id}
          onClick={() => openRemoveConfirmation(source.id)}
          ref={(button) => { if (button) removeTriggerRefs.current.set(source.id, button); else removeTriggerRefs.current.delete(source.id); }}
          type="button"
        >移除来源</button>
      </div> : null}
      {removingId === source.id ? <div
        aria-describedby={`${getRemoveDialogId(source.id)}-description`}
        aria-labelledby={`${getRemoveDialogId(source.id)}-title`}
        className="data-source-card__confirmation"
        id={getRemoveDialogId(source.id)}
        onKeyDown={(event) => { if (event.key === "Escape" && !submitting) { event.preventDefault(); event.stopPropagation(); closeRemoveConfirmation(source.id); } }}
        role="alertdialog"
      >
        <strong id={`${getRemoveDialogId(source.id)}-title`}>移除数据来源？</strong>
        <p id={`${getRemoveDialogId(source.id)}-description`}>移除后，该来源将停止参与项目分析。如需再次使用，需要重新添加该来源。此操作不会删除飞书中的原始数据。</p>
        <div className="data-source-card__actions">
          <button autoFocus className="secondary-action" disabled={submitting} onClick={() => closeRemoveConfirmation(source.id)} type="button">取消</button>
          <button className="secondary-action data-source-card__remove is-confirming" disabled={submitting} onClick={() => void confirmRemove(source)} type="button">{submitting ? "正在移除…" : "确认移除"}</button>
        </div>
      </div> : null}
    </article>)}</div> : <p className="dashboard-card-empty">尚未添加数据来源。</p>}
    {actionError ? <p className="inline-alert" role="alert">{actionError}</p> : null}
    {currentUserRole === "member" ? <p className="inline-alert">你可以查看数据状态；只有项目负责人可以添加、暂停或移除来源。</p> : <form className="project-form project-form--source" onSubmit={(event) => void submitSource(event)}>
      <h3>添加数据来源</h3>
      <label><span>来源类型</span><CustomSelect aria-label="来源类型" onChange={changeSourceType} options={SOURCE_OPTIONS} value={sourceType} /></label>
      <label><span>显示名称（可选）</span><input onChange={(event) => setSourceName(event.target.value)} value={sourceName} /></label>
      {sourceType === "feishu-base" ? <label><span>多维表格链接</span><input onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…/base/…" required type="url" value={sourceUrl} /></label> : null}
      {sourceType === "feishu-chat" ? <SourcePicker label="选择当前可访问的群聊" loadLabel="加载群聊" onLoad={async () => setSourceOptions((await getSourceOptions("chat")).items)} onSelected={setSelectionId} options={sourceOptions} selectionId={selectionId} /> : null}
      {sourceType === "feishu-calendar" ? <CalendarPicker calendarSelectionId={calendarSelectionId} eventOptions={eventOptions} onCalendars={async () => setSourceOptions((await getSourceOptions("calendar")).items)} onCalendarSelected={async (id) => { setCalendarSelectionId(id); setSelectionId(""); const now = new Date(); const end = new Date(now); end.setDate(end.getDate() + 90); setEventOptions((await getCalendarEventOptions(id, now.toISOString(), end.toISOString())).items); }} onEventSelected={setSelectionId} options={sourceOptions} selectionId={selectionId} /> : null}
      {!["feishu-base", "feishu-chat", "feishu-calendar"].includes(sourceType) ? <label><span>飞书资源链接</span><input onChange={(event) => { setSourceUrl(event.target.value); setSelectionId(""); }} placeholder={sourceUrlPlaceholder(sourceType as Exclude<ProjectSourceType, "feishu-base" | "feishu-chat" | "feishu-calendar">)} required type="url" value={sourceUrl} /></label> : null}
      <p className="project-form__role">只绑定你粘贴链接或明确选择的资源；系统不会自动发现项目内容，也不会展示内部资源标识。</p>
      {submitError ? <p className="inline-alert" role="alert">{submitError}</p> : null}
      <button className={`primary-action ${INTERACTIVE_SURFACE_CLASS.button}`} disabled={submitting || (sourceType !== "feishu-base" && !selectionId && !sourceUrl.trim())} type="submit">{submitting ? "正在确认…" : sourceType === "feishu-base" && sources.some((source) => source.type === "feishu-base") ? "重新绑定多维表格" : "添加数据来源"}</button>
    </form>}
    <div className="security-note data-source-security-note"><strong>安全读取说明</strong><p>Echo Insight 只读取已授权的项目数据，不会在页面中展示服务端凭据或内部数据源标识。</p></div>
  </section>;
}

function SourcePicker({ label, loadLabel, onLoad, onSelected, options, selectionId }: { label: string; loadLabel: string; onLoad: () => Promise<void>; onSelected: (id: string) => void; options: Array<{ id: string; label: string }>; selectionId: string }) { return <label><span>{label}</span><button className="secondary-action" onClick={() => void onLoad()} type="button">{loadLabel}</button>{options.length ? <CustomSelect aria-label={label} onChange={onSelected} options={[{ value: "", label: "请选择" }, ...options.map((option) => ({ value: option.id, label: option.label }))]} value={selectionId} /> : <p className="project-form__role">只显示当前账号可访问的有限资源元数据。</p>}</label>; }
function CalendarPicker({ calendarSelectionId, eventOptions, onCalendars, onCalendarSelected, onEventSelected, options, selectionId }: { calendarSelectionId: string; eventOptions: Array<{ id: string; title: string; startAt?: string; endAt?: string }>; onCalendars: () => Promise<void>; onCalendarSelected: (id: string) => Promise<void>; onEventSelected: (id: string) => void; options: Array<{ id: string; label: string }>; selectionId: string }) { return <><SourcePicker label="选择当前可访问的日历" loadLabel="加载日历" onLoad={onCalendars} onSelected={(id) => void onCalendarSelected(id)} options={options} selectionId={calendarSelectionId} />{eventOptions.length ? <label><span>选择日程</span><CustomSelect aria-label="选择日程" onChange={onEventSelected} options={[{ value: "", label: "请选择" }, ...eventOptions.map((option) => ({ value: option.id, label: `${option.title}${option.startAt ? ` · ${formatProductDateTime(option.startAt)}` : ""}` }))]} value={selectionId} /></label> : null}</>; }
function legacyBaseSource(displayName?: string): ProjectSourceStatus { return { id: "base", type: "feishu-base", displayName: displayName ?? "飞书多维表格", enabled: true, accessMode: "read-only", status: "available", authorization: "authorized", visibility: "allowed", freshness: "fresh", activationState: "verified" }; }
function sourceUrlPlaceholder(type: Exclude<ProjectSourceType, "feishu-base" | "feishu-chat" | "feishu-calendar">): string { return type === "feishu-minutes" ? "https://…/minutes/…" : type === "feishu-task" ? "https://…/todo/detail?guid=…" : type === "feishu-docs" ? "https://…/docx/… 或 /wiki/…" : "https://…/wiki/…"; }
function sourceStatusLabel(source: ProjectSourceStatus): string { return ({ available: "已更新", disabled: "已暂停使用", unverified: "等待首次读取", "authorization-required": "需要重新授权", unavailable: "暂不可用", "read-failed": "本次读取未成功", stale: "更新较早" })[source.status]; }
function failureCategoryLabel(category: NonNullable<ProjectSourceStatus["failureCategory"]>): string { return ({ "permission-denied": "当前用户没有该资源的读取权限", "source-unavailable": "该资源当前不可用", "not-found": "未找到已绑定的资源", "rate-limited": "飞书暂时限制读取频率，请稍后重试", "invalid-credential": "授权已失效，需要重新授权", transient: "服务暂时异常，请稍后重试", unknown: "本次读取未成功，请稍后重试" })[category]; }
function getRemoveDialogId(sourceId: string): string { return `remove-source-${sourceId.replace(/[^a-zA-Z0-9_-]/g, "-")}`; }
function getSourceActionErrorMessage(error: unknown, action: "暂停" | "恢复" | "移除"): string { if (error instanceof ProjectApiError && error.status === 403) return "只有项目负责人可以修改数据配置。"; return error instanceof TypeError ? `当前无法连接项目服务，未能${action}该数据来源。` : `暂时无法${action}该数据来源，请稍后重试。`; }
function getConfigurationErrorMessage(error: unknown): string { if (error instanceof ProjectApiError) { if (error.code === "INVALID_DATA_SOURCE_URL") return "请粘贴有效的多维表格链接。"; if (error.status === 403) return "只有项目负责人可以修改数据配置。"; } return error instanceof TypeError ? "当前无法连接项目服务，请检查网络后重试。" : "暂时无法保存该数据来源，请稍后重试。"; }
