import type {
  HealthStatus,
  RiskEngineInput,
  RiskEngineOptions,
  RiskEngineOutput,
  RiskEngineTask,
  RiskLevel,
  RiskSignal,
  RiskSignalCode,
  ScoringDeduction,
} from "./types.js";

const BASE_SCORE = 100 as const;
const RULE_VERSION = "mvp-v1" as const;

const DEDUCTIONS: Record<RiskSignalCode, number> = {
  TASK_OVERDUE: 15,
  TASK_BLOCKED: 25,
  DEPENDENCY_BLOCKED: 20,
  MISSING_PROJECT_DATA: 5,
};

const LEVELS: Record<RiskSignalCode, RiskLevel> = {
  TASK_OVERDUE: "L3",
  TASK_BLOCKED: "L4",
  DEPENDENCY_BLOCKED: "L4",
  MISSING_PROJECT_DATA: "L2",
};

const LEVEL_WEIGHT: Record<RiskLevel, number> = {
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L5: 5,
};

const COMPLETED_STATUSES = new Set(["已完成", "完成", "completed", "done"]);
const BLOCKED_STATUSES = new Set([
  "阻塞",
  "blocked",
  "无法继续",
  "无法继续执行",
]);

interface AddSignalInput {
  code: RiskSignalCode;
  taskId: string | null;
  relatedTaskIds?: string[];
  evidence: string;
  deduction?: number;
  countedDeduction?: number;
}

export function evaluateProjectHealth(
  input: RiskEngineInput,
  options: RiskEngineOptions = {},
): RiskEngineOutput {
  const now = options.now?.() ?? new Date();
  const calculatedAt = now.toISOString();
  const signals: RiskSignal[] = [];

  const addSignal = (signal: AddSignalInput): void => {
    const deduction = signal.deduction ?? DEDUCTIONS[signal.code];
    signals.push({
      signalId: `signal-${String(signals.length + 1).padStart(3, "0")}`,
      code: signal.code,
      level: LEVELS[signal.code],
      taskId: signal.taskId,
      relatedTaskIds: signal.relatedTaskIds ?? [],
      evidence: signal.evidence,
      deduction,
      countedDeduction: signal.countedDeduction ?? deduction,
    });
  };

  detectMissingProjectData(input, addSignal);

  const blockedTaskIds = new Set<string>();
  for (const task of input.tasks) {
    const taskId = normalizedId(task.id);
    const blocked = isBlocked(task.status);
    const overdue = isTaskOverdue(task, now);

    if (blocked && taskId) blockedTaskIds.add(taskId);

    if (blocked) {
      addSignal({
        code: "TASK_BLOCKED",
        taskId,
        evidence: blockedEvidence(task),
      });
    }

    if (overdue) {
      addSignal({
        code: "TASK_OVERDUE",
        taskId,
        evidence: overdueEvidence(task, calculatedAt),
        countedDeduction: blocked ? 0 : DEDUCTIONS.TASK_OVERDUE,
      });
    }
  }

  const dependencyKeys = new Set<string>();
  for (const task of input.tasks) {
    const taskId = normalizedId(task.id);
    if (!taskId || !Array.isArray(task.dependencyIds)) continue;

    for (const dependencyId of new Set(task.dependencyIds.filter(Boolean))) {
      const dependencyKey = `${taskId}->${dependencyId}`;
      if (dependencyKeys.has(dependencyKey) || !blockedTaskIds.has(dependencyId)) {
        continue;
      }
      dependencyKeys.add(dependencyKey);
      addSignal({
        code: "DEPENDENCY_BLOCKED",
        taskId,
        relatedTaskIds: [dependencyId],
        evidence: `任务 ${taskId} 依赖前置任务 ${dependencyId}，且前置任务处于阻塞状态。`,
      });
    }
  }

  const escalationReasons = findEscalationReasons(signals);
  const riskLevel = calculateRiskLevel(signals, escalationReasons);
  const deductions = buildScoringDeductions(signals);
  const totalDeduction = deductions.reduce(
    (total, item) => total + item.deduction,
    0,
  );
  const healthScore = clamp(BASE_SCORE - totalDeduction, 0, 100);
  const healthStatus = mapHealthStatus(healthScore, riskLevel);

  return {
    healthScore,
    healthStatus,
    riskLevel,
    riskSignals: sortRiskSignals(signals, input.tasks),
    scoringDetails: {
      baseScore: BASE_SCORE,
      totalDeduction,
      ruleVersion: RULE_VERSION,
      calculatedAt,
      deductions,
      escalationReasons,
    },
  };
}

function detectMissingProjectData(
  input: RiskEngineInput,
  addSignal: (signal: AddSignalInput) => void,
): void {
  const missingProjectFields = [
    !normalizedId(input.project.id) ? "project.id" : undefined,
    !normalizedText(input.project.name) ? "project.name" : undefined,
  ].filter((field): field is string => Boolean(field));

  if (missingProjectFields.length > 0) {
    addSignal({
      code: "MISSING_PROJECT_DATA",
      taskId: null,
      evidence: `项目缺少关键字段：${missingProjectFields.join("、")}。`,
      countedDeduction: DEDUCTIONS.MISSING_PROJECT_DATA,
    });
  }

  input.tasks.forEach((task, index) => {
    const missingFields = [
      !normalizedId(task.id) ? "id" : undefined,
      !normalizedText(task.status) ? "status" : undefined,
      !normalizedText(task.deadline) ? "deadline" : undefined,
      !normalizedText(task.riskLevel) ? "riskLevel" : undefined,
      !Array.isArray(task.dependencyIds) ? "dependencyIds" : undefined,
    ].filter((field): field is string => Boolean(field));

    if (missingFields.length === 0) return;

    addSignal({
      code: "MISSING_PROJECT_DATA",
      taskId: normalizedId(task.id),
      evidence: `任务 ${normalizedId(task.id) ?? `#${index + 1}`} 缺少关键字段：${missingFields.join("、")}。`,
      countedDeduction: Math.min(
        10,
        missingFields.length * DEDUCTIONS.MISSING_PROJECT_DATA,
      ),
    });
  });
}

function isTaskOverdue(task: RiskEngineTask, now: Date): boolean {
  if (isCompleted(task.status)) return false;
  if (task.isOverdue === true) return true;

  const deadline = normalizedText(task.deadline);
  if (!deadline || Number.isNaN(Date.parse(deadline))) return false;
  const deadlineDate = new Date(deadline).toISOString().slice(0, 10);
  const calculationDate = now.toISOString().slice(0, 10);
  return deadlineDate < calculationDate;
}

function isCompleted(status: string | null | undefined): boolean {
  return COMPLETED_STATUSES.has(normalizedStatus(status));
}

function isBlocked(status: string | null | undefined): boolean {
  return BLOCKED_STATUSES.has(normalizedStatus(status));
}

function normalizedStatus(status: string | null | undefined): string {
  return status?.trim().toLowerCase() ?? "";
}

function normalizedId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function blockedEvidence(task: RiskEngineTask): string {
  const taskId = normalizedId(task.id) ?? "未知任务";
  const description = normalizedText(task.description);
  return description
    ? `任务 ${taskId} 状态为阻塞。说明：${description}`
    : `任务 ${taskId} 状态为阻塞。`;
}

function overdueEvidence(task: RiskEngineTask, calculatedAt: string): string {
  return `任务 ${normalizedId(task.id) ?? "未知任务"} 状态为 ${normalizedText(task.status) ?? "未知"}，截止日期为 ${normalizedText(task.deadline) ?? "未知"}，计算时间为 ${calculatedAt}。`;
}

function findEscalationReasons(signals: RiskSignal[]): string[] {
  const signalCodesByTask = new Map<string, Set<RiskSignalCode>>();
  for (const signal of signals) {
    if (!signal.taskId || signal.code === "MISSING_PROJECT_DATA") continue;
    const codes = signalCodesByTask.get(signal.taskId) ?? new Set<RiskSignalCode>();
    codes.add(signal.code);
    signalCodesByTask.set(signal.taskId, codes);
  }

  return [...signalCodesByTask.entries()]
    .filter(([, codes]) => codes.size >= 2)
    .map(
      ([taskId, codes]) =>
        `任务 ${taskId} 同时触发 ${[...codes].sort().join("、")}，项目风险升级至 L5。`,
    );
}

function calculateRiskLevel(
  signals: RiskSignal[],
  escalationReasons: string[],
): RiskLevel {
  if (escalationReasons.length > 0) return "L5";
  return signals.reduce<RiskLevel>(
    (highest, signal) =>
      LEVEL_WEIGHT[signal.level] > LEVEL_WEIGHT[highest] ? signal.level : highest,
    "L1",
  );
}

function buildScoringDeductions(signals: RiskSignal[]): ScoringDeduction[] {
  return signals
    .filter((signal) => signal.countedDeduction > 0)
    .map((signal) => ({
      signalId: signal.signalId,
      code: signal.code,
      taskId: signal.taskId,
      deduction: signal.countedDeduction,
      reason: signal.evidence,
    }));
}

function mapHealthStatus(
  healthScore: number,
  riskLevel: RiskLevel,
): HealthStatus {
  if (riskLevel === "L5" || healthScore < 60) return "at-risk";
  if (healthScore < 80) return "needs-attention";
  return "healthy";
}

function sortRiskSignals(
  signals: RiskSignal[],
  tasks: RiskEngineTask[],
): RiskSignal[] {
  const deadlineByTaskId = new Map(
    tasks
      .map((task) => [normalizedId(task.id), normalizedText(task.deadline)] as const)
      .filter((entry): entry is readonly [string, string | null] => Boolean(entry[0])),
  );

  return [...signals].sort((left, right) => {
    const levelDifference = LEVEL_WEIGHT[right.level] - LEVEL_WEIGHT[left.level];
    if (levelDifference !== 0) return levelDifference;
    const deductionDifference = right.deduction - left.deduction;
    if (deductionDifference !== 0) return deductionDifference;
    const leftDeadline = left.taskId
      ? (deadlineByTaskId.get(left.taskId) ?? "9999-12-31")
      : "9999-12-31";
    const rightDeadline = right.taskId
      ? (deadlineByTaskId.get(right.taskId) ?? "9999-12-31")
      : "9999-12-31";
    const deadlineDifference = leftDeadline.localeCompare(rightDeadline);
    if (deadlineDifference !== 0) return deadlineDifference;
    return (left.taskId ?? "").localeCompare(right.taskId ?? "");
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
