import type {
  HealthStatus,
  ProjectReport,
  RiskContext,
  RiskLevel,
  RiskSignal,
} from "../../services/api/types.js";
import { getHealthDisplay, toProductLanguage } from "../product-language/presentation.js";

export type HealthTone = "stable" | "watch" | "risk" | "high" | "critical";
export type RiskTone = "normal" | "watch" | "risk" | "high" | "critical";
export type RiskExplainabilityState = "verified" | "limited" | "unavailable";

export interface HealthPresentation {
  label: string;
  summary: string;
  tone: HealthTone;
}

export interface RiskLevelPresentation {
  label: string;
  tone: RiskTone;
}

export interface RiskViewModel {
  id: string;
  explainabilityState: RiskExplainabilityState;
  level: RiskLevelPresentation;
  name: string;
  fact: string;
  factualEvidence: string[];
  ruleReason: string;
  impact: string;
  actions: string[];
  aiReason?: string | undefined;
  limitations: string[];
}

export interface DataCompletenessNotice {
  count: number;
  message: string;
}

interface RiskCopy {
  name: string;
  fact: string;
  ruleReason: string;
  impact: string;
  actions: string[];
}

const RISK_COPY: Record<string, RiskCopy> = {
  TASK_OVERDUE: {
    name: "任务进度延期",
    fact: "任务已超过计划完成时间，当前仍未完成。",
    ruleReason: "系统将计划完成时间与当前日期进行比对，确认任务进度已落后于计划。",
    impact: "如果不及时调整，可能压缩后续任务和验收环节的可用时间。",
    actions: ["重新确认剩余工作量与完成时间", "同步受影响的后续任务并调整安排"],
  },
  TASK_BLOCKED: {
    name: "任务推进受阻",
    fact: "项目中存在暂时无法继续推进的任务。",
    ruleReason: "系统检测到任务处于阻塞状态，需要先解决前置问题才能恢复推进。",
    impact: "阻塞可能延迟当前任务，并向后影响相关计划与协作安排。",
    actions: ["确认阻塞原因与解除条件", "明确协助人和下一次检查时间"],
  },
  DEPENDENCY_BLOCKED: {
    name: "关键依赖受阻",
    fact: "任务依赖的前置事项尚未恢复，当前工作存在连带风险。",
    ruleReason: "系统识别到被依赖任务处于阻塞或异常状态，因此相关任务暂不具备稳定推进条件。",
    impact: "依赖链上的多个任务可能连续延后，影响项目关键路径。",
    actions: ["优先处理被依赖任务的阻塞问题", "评估是否存在可并行或替代的推进方案"],
  },
  MISSING_PROJECT_DATA: {
    name: "项目信息待补充",
    fact: "部分关键项目字段缺失，当前分析依据不完整。",
    ruleReason: "系统在已授权数据范围内未找到完成判断所需的关键信息。",
    impact: "信息缺失可能降低健康度判断与风险解释的完整性。",
    actions: ["补充缺失的项目或任务信息", "确认飞书多维表格字段与数据范围是否完整"],
  },
};

const RISK_LEVELS: Record<RiskLevel, RiskLevelPresentation> = {
  L1: { label: "正常", tone: "normal" },
  L2: { label: "轻微关注", tone: "watch" },
  L3: { label: "一般风险", tone: "risk" },
  L4: { label: "严重风险", tone: "high" },
  L5: { label: "关键风险", tone: "critical" },
};

export function getHealthPresentation(
  score: number,
  status: HealthStatus = score >= 80 ? "healthy" : score >= 60 ? "needs-attention" : "at-risk",
): HealthPresentation {
  const display = getHealthDisplay(status);
  return {
    label: display.label,
    tone: display.tone,
    summary: status === "healthy"
      ? "项目整体推进平稳，暂未发现需要优先处理的关键问题。"
      : status === "needs-attention"
        ? "项目基本可控，但已有需要持续观察并及时确认的信息。"
        : "项目已出现影响推进的风险，建议尽快明确处理顺序。",
  };
}

export function getRiskLevelPresentation(level: RiskLevel): RiskLevelPresentation {
  return RISK_LEVELS[level];
}

export function getRiskToneClass(tone: RiskTone): `risk-tone--${RiskTone}` {
  return `risk-tone--${tone}`;
}

export function createRiskView(
  signal: RiskSignal,
  aiRisks: ProjectReport["aiReport"]["risks"] = [],
  riskContexts: RiskContext[] = [],
): RiskViewModel {
  const aiRisk = findAiRisk(signal, aiRisks);
  const riskContext = findRiskContext(signal, riskContexts);
  const factualEvidence = getFactualEvidence(riskContext);
  const explainabilityState = getRiskExplainabilityState(
    Boolean(aiRisk),
    riskContext,
    factualEvidence,
  );

  if (explainabilityState === "unavailable" || !riskContext) {
    return createUnavailableRiskView(signal.signalId, signal.level);
  }

  const copy = RISK_COPY[signal.code];
  const aiActions = unique(
    (aiRisk?.suggestedActions ?? []).map(sanitizeUserFacingText).filter(Boolean),
  );
  const limitations = getRiskLimitations(riskContext, !aiRisk);

  return {
    id: signal.signalId,
    explainabilityState,
    level: getRiskLevelPresentation(signal.level),
    name: getRiskDisplayName(signal.code, aiRisk?.title, riskContext),
    fact: createRiskFact(riskContext),
    factualEvidence,
    ruleReason: createRuleReason(signal.code, riskContext, copy?.ruleReason ?? "当前项目事实触发了需要确认的风险信号。"),
    impact: sanitizeUserFacingText(aiRisk?.impact)
      || createFallbackImpact(signal.code, riskContext, copy?.impact ?? "当前影响需要结合更多项目事实确认。"),
    actions: aiActions.length > 0
      ? aiActions
      : explainabilityState === "limited"
        ? createLimitedActions(limitations)
        : createFallbackActions(signal.code, riskContext, copy?.actions ?? []),
    aiReason: sanitizeUserFacingText(aiRisk?.reason) || undefined,
    limitations,
  };
}

export function createAiRiskView(
  report: ProjectReport,
  aiRisk: ProjectReport["aiReport"]["risks"][number],
): RiskViewModel {
  const signal = report.analysis.riskSignals.find((candidate) =>
    candidate.signalId === aiRisk.id || aiRisk.evidenceRefs.includes(candidate.signalId),
  );

  if (signal) {
    return createRiskView(signal, [aiRisk], report.riskContexts);
  }

  return createUnavailableRiskView(aiRisk.id, report.analysis.riskLevel);
}

export function getHealthReasonLines(report: ProjectReport): string[] {
  const risks = getFactBackedRiskViews(report);
  const dataCompletenessNotice = getDataCompletenessNotice(report);

  if (risks.length === 0) {
    return dataCompletenessNotice
      ? [dataCompletenessNotice.message]
      : ["当前没有触发健康度扣分的风险信号。"];
  }

  const visibleRisks = risks.slice(0, 3).map((risk) => {
    const evidence = risk.factualEvidence
      .filter((item) => /状态|截止日期|计划完成时间/.test(item))
      .slice(0, 2)
      .join("；") || risk.factualEvidence[0];
    return evidence ? `${risk.name}：${evidence}` : risk.name;
  });
  if (risks.length > visibleRisks.length) {
    visibleRisks.push(`另有 ${risks.length - visibleRisks.length} 项风险需要关注。`);
  }
  if (dataCompletenessNotice) visibleRisks.push(dataCompletenessNotice.message);

  return visibleRisks;
}

export function getFactBackedRiskViews(report: ProjectReport): RiskViewModel[] {
  return report.analysis.riskSignals
    .map((signal) => createRiskView(signal, report.aiReport.risks, report.riskContexts))
    .filter((risk) => risk.explainabilityState !== "unavailable");
}

export function getFactBackedAiRiskViews(report: ProjectReport): RiskViewModel[] {
  return report.aiReport.risks
    .map((risk) => createAiRiskView(report, risk))
    .filter((risk) => risk.explainabilityState !== "unavailable");
}

export function getDataCompletenessNotice(
  report: ProjectReport,
): DataCompletenessNotice | undefined {
  const count = report.analysis.riskSignals.filter((signal) =>
    signal.code === "MISSING_PROJECT_DATA"
    && createRiskView(signal, report.aiReport.risks, report.riskContexts).explainabilityState === "unavailable",
  ).length;

  return count > 0
    ? {
        count,
        message: `当前有 ${count} 条任务记录缺少必要信息，因此未生成详细风险解释。`,
      }
    : undefined;
}

export function getRiskDisplayName(
  code: string,
  title?: string,
  riskContext?: RiskContext,
): string {
  const taskName = riskContext?.primaryTask?.name;
  if (taskName) {
    if (code === "TASK_OVERDUE") return `「${taskName}」存在延期风险`;
    if (code === "TASK_BLOCKED") return `「${taskName}」等待处理`;
    if (code === "DEPENDENCY_BLOCKED") {
      const dependencyName = riskContext.relatedTasks[0]?.name;
      return dependencyName
        ? `「${taskName}」受前置「${dependencyName}」影响`
        : `「${taskName}」存在依赖风险`;
    }
    if (code === "MISSING_PROJECT_DATA") return `「${taskName}」信息待补充`;
  }

  const mappedName = RISK_COPY[code]?.name;
  const safeTitle = sanitizeUserFacingText(title);
  return mappedName ?? (safeTitle || "项目风险待确认");
}

export function getExplainabilityStateLabel(state: RiskExplainabilityState): string {
  if (state === "verified") return "事实已验证";
  if (state === "limited") return "说明有限";
  return "暂不展示";
}

export function getUnavailableExplainabilityMessage(): string {
  return "该 AI 解释无法对应当前项目事实，因此未作为项目风险展示。";
}

export function formatTaskStatus(value?: string | null): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "状态待确认";
  if (normalized === "blocked" || normalized.includes("阻塞")) return "等待处理";
  if (normalized.includes("进行中") || normalized.includes("in progress")) return "正在推进";
  if (normalized.includes("未开始") || normalized.includes("not started")) return "尚未开始";
  if (normalized.includes("已完成") || normalized.includes("completed")) return "已完成";

  return sanitizeUserFacingText(value) || "状态待确认";
}

export function sanitizeUserFacingText(value?: string | null): string {
  if (!value) {
    return "";
  }

  return toProductLanguage(value
    .replace(/TASK_OVERDUE/g, "任务进度延期")
    .replace(/TASK_BLOCKED/g, "任务推进受阻")
    .replace(/DEPENDENCY_BLOCKED/g, "关键依赖受阻")
    .replace(/MISSING_PROJECT_DATA/g, "项目信息待补充")
    .replace(/(当前(?:任务)?状态为)[\s“"]*(?:BLOCKED|阻塞)[”"]?/gi, "$1等待处理")
    .replace(/\bBLOCKED\b/gi, "等待处理")
    .replace(/阻塞原因/g, "暂时无法推进的原因")
    .replace(/阻塞/g, "暂时无法推进")
    .replace(/signal[-_][A-Za-z0-9_-]+/gi, "相关风险")
    .replace(/task[-_][A-Za-z0-9_-]+/gi, "相关任务")
    .replace(/\brec[A-Za-z0-9_-]{6,}\b/gi, "相关任务")
    .replace(/\btbl[A-Za-z0-9_-]{6,}\b/gi, "相关数据表")
    .replace(/Risk Engine/gi, "系统规则")
    .replace(/AI Input Builder/gi, "分析输入")
    .replace(/\s+/g, " ")
    .trim());
}

function findAiRisk(
  signal: RiskSignal,
  aiRisks: ProjectReport["aiReport"]["risks"],
): ProjectReport["aiReport"]["risks"][number] | undefined {
  return aiRisks.find(
    (risk) =>
      risk.id === signal.signalId ||
      risk.evidenceRefs.includes(signal.signalId) ||
      risk.title === signal.code,
  );
}

function findRiskContext(
  signal: RiskSignal,
  riskContexts: RiskContext[],
): RiskContext | undefined {
  return riskContexts.find((context) => context.signalId === signal.signalId);
}

function createRiskFact(
  riskContext: RiskContext,
): string {
  const primaryTask = riskContext?.primaryTask;
  const facts: string[] = [];

  if (primaryTask) {
    const taskReference = primaryTask.name ? `「${primaryTask.name}」` : "该任务";
    facts.push(
      primaryTask.status
        ? `${taskReference}当前处于${formatTaskStatus(primaryTask.status)}状态。`
        : `${taskReference}当前状态待确认。`,
    );
    if (primaryTask.deadline) facts.push(`计划完成时间为${formatDate(primaryTask.deadline)}。`);
    if (primaryTask.owner) facts.push(`当前负责人为${primaryTask.owner}。`);
    if (primaryTask.description) facts.push(`任务说明：${sanitizeUserFacingText(primaryTask.description)}。`);
  }

  for (const relatedTask of riskContext?.relatedTasks ?? []) {
    const relatedReference = relatedTask.name ? `前置事项「${relatedTask.name}」` : "相关前置事项";
    facts.push(
      relatedTask.status
        ? `${relatedReference}当前处于${formatTaskStatus(relatedTask.status)}状态。`
        : `${relatedReference}当前状态待确认。`,
    );
    if (relatedTask.deadline) facts.push(`${relatedReference}计划完成时间为${formatDate(relatedTask.deadline)}。`);
  }

  return facts.join("");
}

function createRuleReason(
  code: string,
  riskContext: RiskContext | undefined,
  fallback: string,
): string {
  const taskReference = riskContext?.primaryTask?.name
    ? `「${riskContext.primaryTask.name}」`
    : "该任务";

  if (code === "TASK_OVERDUE") {
    return `系统根据${taskReference}的计划完成时间与当前日期判断，任务进度已落后于原计划。`;
  }
  if (code === "TASK_BLOCKED") {
    return `系统根据${taskReference}的当前状态、截止时间和已授权的关联信息判断，该任务需要优先确认。`;
  }
  if (code === "DEPENDENCY_BLOCKED") {
    const dependencyReference = riskContext?.relatedTasks[0]?.name
      ? `前置事项「${riskContext.relatedTasks[0].name}」`
      : "前置事项";
    return `系统发现${taskReference}依赖的${dependencyReference}尚未具备稳定推进条件，因此提示依赖风险。`;
  }
  if (code === "MISSING_PROJECT_DATA") {
    return `系统发现${taskReference}缺少完成判断所需的项目事实，因此当前分析需要保留信息限制。`;
  }

  return fallback;
}

function createFallbackImpact(
  code: string,
  riskContext: RiskContext | undefined,
  fallback: string,
): string {
  const taskReference = riskContext?.primaryTask?.name
    ? `「${riskContext.primaryTask.name}」`
    : "该任务";

  if (code === "TASK_OVERDUE") {
    return `${taskReference}未按计划完成，可能压缩后续工作和验收环节的可用时间。`;
  }
  if (code === "TASK_BLOCKED") {
    return `${taskReference}暂未恢复推进，可能影响关联工作按原计划继续安排。`;
  }
  if (code === "DEPENDENCY_BLOCKED") {
    return `${taskReference}需要等待前置事项恢复，相关工作可能无法按原计划衔接。`;
  }

  return fallback;
}

function createFallbackActions(
  code: string,
  riskContext: RiskContext | undefined,
  fallback: string[],
): string[] {
  const task = riskContext?.primaryTask;
  if (!task?.name || !task.owner || !task.deadline) {
    return ["当前信息不足，建议补充负责人和计划时间后，再确认处理安排。"];
  }

  const taskReference = `「${task.name}」`;
  if (code === "TASK_OVERDUE") {
    return [
      `请与负责人${task.owner}确认${taskReference}的剩余工作和新的完成时间。`,
      `根据新的完成时间同步检查后续工作安排。`,
    ];
  }
  if (code === "TASK_BLOCKED") {
    return [
      `请与负责人${task.owner}确认${taskReference}恢复推进的条件和预计时间。`,
      `在${formatDate(task.deadline)}前同步需要调整的相关安排。`,
    ];
  }
  if (code === "DEPENDENCY_BLOCKED") {
    const dependencyName = riskContext?.relatedTasks[0]?.name;
    return [
      dependencyName
        ? `请先确认前置事项「${dependencyName}」的恢复时间，再更新${taskReference}的计划。`
        : `请先确认前置事项的恢复时间，再更新${taskReference}的计划。`,
      `请与负责人${task.owner}确认${taskReference}可重新推进的条件。`,
    ];
  }

  return fallback;
}

function createLimitedActions(limitations: string[]): string[] {
  if (limitations.length > 0) {
    return ["当前信息不足，建议补充相关任务事实后，再确认处理安排。"];
  }

  return ["当前仅能依据已授权的项目事实提供有限说明。"];
}

function getRiskExplainabilityState(
  hasAiRisk: boolean,
  riskContext: RiskContext | undefined,
  factualEvidence: string[],
): RiskExplainabilityState {
  if (!riskContext || factualEvidence.length === 0) return "unavailable";
  if (!hasAiRisk || riskContext.dataLimitations.length > 0) return "limited";
  return "verified";
}

function createUnavailableRiskView(id: string, level: RiskLevel): RiskViewModel {
  return {
    id,
    explainabilityState: "unavailable",
    level: getRiskLevelPresentation(level),
    name: "风险详情暂不展示",
    fact: "",
    factualEvidence: [],
    ruleReason: "",
    impact: "",
    actions: [],
    limitations: ["当前没有可用于验证该解释的项目事实。"],
  };
}

function getFactualEvidence(riskContext: RiskContext | undefined): string[] {
  return unique(
    (riskContext?.factualEvidence ?? []).map(sanitizeUserFacingText).filter(Boolean),
  );
}

function getRiskLimitations(
  riskContext: RiskContext,
  isMissingAiExplanation: boolean,
): string[] {
  const limitations = riskContext.dataLimitations
    .map(toUserFacingLimitation)
    .filter(Boolean);

  if (isMissingAiExplanation) {
    limitations.push("当前没有可关联的 AI 解释，系统仅展示已确认的项目事实。");
  }

  return unique(limitations);
}

function toUserFacingLimitation(value: string): string {
  return sanitizeUserFacingText(value)
    .replace(/^关联任务/, "当前任务")
    .replace(/^该风险信号/, "当前风险");
}

export function formatDate(value: string): string {
  const normalizedValue = normalizeDateValue(value);
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalizedValue);
  if (!match) return sanitizeUserFacingText(normalizedValue);

  const [, year, month, day] = match;
  return `${year}年${Number(month)}月${Number(day)}日`;
}

function normalizeDateValue(value: string): string {
  const text = value.trim();
  if (!/^\d{10,13}$/u.test(text)) return text;

  const numericValue = Number(text);
  const milliseconds = text.length === 10 ? numericValue * 1000 : numericValue;
  const date = new Date(milliseconds);
  return Number.isNaN(date.valueOf()) ? text : date.toISOString().slice(0, 10);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
