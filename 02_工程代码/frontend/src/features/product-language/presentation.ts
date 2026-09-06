import type { HealthStatus, ProjectSourceType } from "../../services/api/index.js";

const SOURCE_LABELS: Record<ProjectSourceType, string> = {
  "feishu-base": "多维表格",
  "feishu-chat": "群聊",
  "feishu-minutes": "妙记",
  "feishu-docs": "文档",
  "feishu-wiki-drive": "知识库/云盘",
  "feishu-task": "任务",
  "feishu-calendar": "日历/日程",
};

const SOURCE_BADGES: Record<ProjectSourceType, string> = {
  "feishu-base": "表",
  "feishu-chat": "群",
  "feishu-minutes": "记",
  "feishu-docs": "文",
  "feishu-wiki-drive": "知",
  "feishu-task": "务",
  "feishu-calendar": "历",
};

export interface HealthDisplay {
  label: string;
  tone: "stable" | "watch" | "risk";
}

export function getHealthDisplay(status: HealthStatus): HealthDisplay {
  const displays: Record<HealthStatus, HealthDisplay> = {
    healthy: { label: "健康稳定", tone: "stable" },
    "needs-attention": { label: "需要关注", tone: "watch" },
    "at-risk": { label: "存在风险", tone: "risk" },
  };
  return displays[status];
}

export function getSourceLabel(type: ProjectSourceType): string {
  return SOURCE_LABELS[type] ?? "项目来源";
}

export function getSourceBadge(type: ProjectSourceType): string {
  return SOURCE_BADGES[type] ?? "源";
}

export function formatSourceDisplayName(type: ProjectSourceType, displayName: string): string {
  const legacyDefaults: Partial<Record<ProjectSourceType, readonly string[]>> = {
    "feishu-chat": ["飞书群聊 / Thread", "飞书群聊/Thread"],
    "feishu-wiki-drive": ["飞书知识库 / 云盘"],
  };
  return legacyDefaults[type]?.includes(displayName.trim())
    ? `飞书${getSourceLabel(type)}`
    : toProductLanguage(displayName);
}

export function getSourceLabels(types: string[]): string {
  return [...new Set(types.map((type) => SOURCE_LABELS[type as ProjectSourceType] ?? "项目来源"))].join("、");
}

export function getSourceDataState(state: "fresh" | "stale" | "unknown" | "unavailable"): string {
  return ({
    fresh: "已更新",
    stale: "更新较早",
    unknown: "等待首次读取",
    unavailable: "暂不可用",
  })[state];
}

export function formatProductDateTime(value?: string): string {
  if (!value) return "暂无成功读取记录";
  const numeric = /^\d{10,13}$/.test(value.trim());
  const timestamp = numeric
    ? Number(value) * (value.trim().length === 10 ? 1_000 : 1)
    : Date.parse(value);
  if (Number.isNaN(timestamp)) return "时间待确认";
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  if (isToday) return `今天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function translateCandidateKind(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "proposal") return "待确认提议";
  if (normalized === "prediction") return "待确认判断";
  return "待确认信息";
}

const FACT_VALUE_LABELS: Record<string, string> = {
  blocked: "受阻",
  completed: "已完成",
  done: "已完成",
  false: "否",
  healthy: "健康稳定",
  "in-progress": "进行中",
  "in_progress": "进行中",
  pending: "待处理",
  proposal: "待确认提议",
  true: "是",
};

/** Formats project facts without leaking storage-oriented timestamps or enums. */
export function formatFactDisplay(subject: string, value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (FACT_VALUE_LABELS[normalized]) return FACT_VALUE_LABELS[normalized];

  const timestamp = parseTimestamp(trimmed);
  if (timestamp !== null) return formatFactDate(timestamp, subject, trimmed);

  if (/^(?:\d+(?:\.\d+)?)$/u.test(trimmed)) {
    return new Intl.NumberFormat("zh-CN").format(Number(trimmed));
  }
  return toProductLanguage(trimmed);
}

/** Converts storage subject keys into stable user-facing field names. */
export function formatFactSubject(subject: string): string {
  const normalized = subject.trim().toLowerCase();
  const field = normalized.split(/[.:]/u).at(-1) ?? normalized;
  const labels: Record<string, string> = {
    deadline: "项目计划完成时间",
    "task-deadline": "任务截止时间",
    "task-status": "任务状态",
    "task-completion": "任务完成时间",
    owner: "负责人",
    status: "当前状态",
    name: "事项名称",
  };
  if (labels[field]) return labels[field];
  if (normalized.includes(":")) return "项目已确认信息";
  return toProductLanguage(subject).replace(/[._-]+/gu, " ").trim();
}

function parseTimestamp(value: string): number | null {
  if (/^\d{10,13}$/u.test(value)) {
    const timestamp = Number(value) * (value.length === 10 ? 1_000 : 1);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/u.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function formatFactDate(timestamp: number, subject: string, raw: string): string {
  const date = new Date(timestamp);
  const hasTime = /[T\s]\d{2}:\d{2}/u.test(raw)
    || /时间|更新|会议|日程/u.test(subject);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    ...(hasTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  }).format(date);
}

export function toProductLanguage(value: string): string {
  return value
    .replace(/(?<!\d)\d{13}(?!\d)/gu, (timestamp) => formatProductDateTime(timestamp))
    .replace(/\bfeishu-wiki-drive\b/gi, "知识库/云盘")
    .replace(/\bfeishu-(?:base|chat|minutes|docs|task|calendar)\b/gi, (sourceType) => (
      SOURCE_LABELS[sourceType.toLowerCase() as ProjectSourceType] ?? "项目来源"
    ))
    .replace(/\bpending-confirmation\b/gi, "待确认信息")
    .replace(/\bprediction\b/gi, "待确认判断")
    .replace(/\bproposal\b/gi, "待确认提议")
    .replace(/\bcurrent fact\b/gi, "已确认项目信息")
    .replace(/\bpotential signal\b/gi, "待确认信号")
    .replace(/\bfreshness\b/gi, "数据状态")
    .replace(/\bwiki\s*\/\s*drive\b/gi, "知识库/云盘")
    .replace(/\bthread\b/gi, "会话")
    .replace(/\bbase\b/gi, "多维表格")
    .replace(/\bchat\b/gi, "群聊")
    .replace(/\bminutes\b/gi, "妙记")
    .replace(/\bdocs?\b/gi, "文档")
    .replace(/\bwiki\b/gi, "知识库")
    .replace(/\bdrive\b/gi, "云盘")
    .replace(/\btask\b/gi, "任务")
    .replace(/\bcalendar\b/gi, "日历/日程");
}
