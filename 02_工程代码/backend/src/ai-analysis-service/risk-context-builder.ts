import type { StandardTask } from "../../../feishu-connector/src/index.js";
import type { ProjectAnalysisResult } from "../analysis-service/index.js";
import type {
  PrimaryTaskContext,
  RelatedTaskContext,
  RiskContext,
} from "./risk-context-types.js";

/**
 * Resolves rule-owned signal references into a safe, displayable fact layer.
 * Record IDs are used only for in-memory matching and never included in output.
 */
export function buildRiskContexts(result: ProjectAnalysisResult): RiskContext[] {
  const taskById = new Map(
    result.projectData.tasks
      .filter((task) => task.id.trim())
      .map((task) => [task.id, task] as const),
  );
  const recordIds = [...taskById.keys()];

  return result.analysis.riskSignals.map((signal) => {
    const primaryTask = signal.taskId ? taskById.get(signal.taskId) : undefined;
    const unresolvedRelatedTask = signal.relatedTaskIds.some(
      (taskId) => !taskById.has(taskId),
    );
    const relatedSourceTasks = [...new Set(signal.relatedTaskIds)]
      .map((taskId) => taskById.get(taskId))
      .filter((task): task is StandardTask => Boolean(task));
    const dataLimitations: string[] = [];

    if (!signal.taskId) {
      dataLimitations.push("该风险信号未关联具体任务。");
    } else if (!primaryTask) {
      dataLimitations.push("未能在当前授权项目数据中解析与该风险关联的任务。");
    }

    if (unresolvedRelatedTask) {
      dataLimitations.push("部分关联任务未能在当前授权项目数据中解析。");
    }

    const safePrimaryTask = primaryTask
      ? toPrimaryTask(primaryTask, recordIds, dataLimitations)
      : null;
    const safeRelatedTasks = relatedSourceTasks.map((task) =>
      toRelatedTask(task, recordIds, dataLimitations),
    );

    return {
      signalId: signal.signalId,
      type: signal.code,
      primaryTask: safePrimaryTask,
      relatedTasks: safeRelatedTasks,
      factualEvidence: buildFactualEvidence(
        signal.code,
        safePrimaryTask,
        safeRelatedTasks,
      ),
      dataLimitations: [...new Set(dataLimitations)],
    };
  });
}

function toPrimaryTask(
  task: StandardTask,
  recordIds: string[],
  limitations: string[],
): PrimaryTaskContext {
  const name = safeText(task.name, recordIds);
  const status = safeText(task.status, recordIds);
  const deadline = normalizeDeadline(safeText(task.deadline, recordIds));
  const owner = safeText(task.owner, recordIds);
  const description = safeText(task.description, recordIds);

  addMissingFieldLimitations(
    { name, status, deadline, owner, description },
    limitations,
  );

  return {
    name,
    status,
    deadline,
    ...(owner ? { owner } : {}),
    ...(description ? { description } : {}),
  };
}

function toRelatedTask(
  task: StandardTask,
  recordIds: string[],
  limitations: string[],
): RelatedTaskContext {
  const name = safeText(task.name, recordIds);
  const status = safeText(task.status, recordIds);
  const deadline = normalizeDeadline(safeText(task.deadline, recordIds));

  if (!name) limitations.push("关联任务缺少任务名称。");
  if (!status) limitations.push("关联任务缺少任务状态。");

  return {
    name,
    status,
    ...(deadline ? { deadline } : {}),
  };
}

function addMissingFieldLimitations(
  fields: {
    name: string | null;
    status: string | null;
    deadline: string | null;
    owner: string | null;
    description: string | null;
  },
  limitations: string[],
): void {
  if (!fields.name) limitations.push("关联任务缺少任务名称。");
  if (!fields.status) limitations.push("关联任务缺少任务状态。");
  if (!fields.deadline) limitations.push("关联任务缺少截止日期。");
  if (!fields.owner) limitations.push("关联任务缺少负责人信息。");
  if (!fields.description) limitations.push("关联任务缺少任务说明。");
}

function buildFactualEvidence(
  type: string,
  primaryTask: PrimaryTaskContext | null,
  relatedTasks: RelatedTaskContext[],
): string[] {
  const facts: string[] = [];

  if (primaryTask) {
    if (primaryTask.name) facts.push("风险关联任务为“" + primaryTask.name + "”。");
    if (primaryTask.status) facts.push("当前任务状态为“" + primaryTask.status + "”。");
    if (primaryTask.deadline) facts.push("任务截止日期为“" + primaryTask.deadline + "”。");
    if (primaryTask.owner) facts.push("任务负责人为“" + primaryTask.owner + "”。");
    if (primaryTask.description) facts.push("任务说明为“" + primaryTask.description + "”。");
  }

  for (const task of relatedTasks) {
    const relation = type === "DEPENDENCY_BLOCKED" ? "前置依赖任务" : "关联任务";
    const subject = task.name ? relation + "“" + task.name + "”" : relation;
    facts.push(
      task.status
        ? subject + "当前状态为“" + task.status + "”。"
        : subject + "已在当前授权数据中找到。",
    );
    if (task.deadline) facts.push(subject + "截止日期为“" + task.deadline + "”。");
  }

  return facts;
}

function safeText(
  value: string | null | undefined,
  recordIds: string[],
): string | null {
  const text = value?.trim();
  if (!text) return null;

  return recordIds.some((recordId) => recordId && text.includes(recordId))
    ? null
    : text;
}

function normalizeDeadline(value: string | null): string | null {
  if (!value) return null;

  if (/^\d{10,13}$/u.test(value)) {
    const numericValue = Number(value);
    const milliseconds = value.length === 10 ? numericValue * 1000 : numericValue;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString().slice(0, 10);
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toISOString().slice(0, 10);
}
