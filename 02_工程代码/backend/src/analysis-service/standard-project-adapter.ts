import type { JsonValue, StandardProjectData, StandardTask } from "../../../feishu-connector/src/index.js";
import type { RiskEngineTask, RiskLevel } from "../risk-engine/index.js";
import type { AdaptedRiskEngineInput } from "./types.js";

const COMPLETED_STATUSES = new Set(["已完成", "完成", "completed", "done"]);
const DEPENDENCY_FIELD_KEYS = ["dependencyIds", "依赖任务", "依赖"] as const;

export function toRiskEngineInput(
  projectData: StandardProjectData,
  now: Date,
): AdaptedRiskEngineInput {
  return {
    project: {
      id: projectData.project.id,
      name: projectData.project.name,
      sensitivityMode: "robust",
    },
    tasks: projectData.tasks.map((task) => toRiskEngineTask(task, now)),
    metadata: {
      source: "feishu-base",
      accessMode: "read-only",
      authorizedProjectIds: [projectData.project.id],
      generatedAt: projectData.metadata.retrievedAt,
    },
  };
}

function toRiskEngineTask(task: StandardTask, now: Date): RiskEngineTask {
  const deadline = normalizeDeadline(task.deadline);
  return {
    id: task.id,
    name: task.name,
    owner: task.owner,
    status: task.status,
    deadline,
    riskLevel: normalizeRiskLevel(task.riskLevel),
    isOverdue: isOverdue(deadline, task.status, now),
    dependencyIds: readDependencyIds(task.attributes),
    description: task.description,
  };
}

function normalizeDeadline(value: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;

  if (/^\d{10,13}$/u.test(text)) {
    const numericValue = Number(text);
    const milliseconds = text.length === 10 ? numericValue * 1000 : numericValue;
    const date = new Date(milliseconds);
    if (!Number.isNaN(date.valueOf())) return date.toISOString().slice(0, 10);
  }

  return Number.isNaN(Date.parse(text)) ? text : new Date(text).toISOString().slice(0, 10);
}

function normalizeRiskLevel(value: string | null): RiskLevel | null {
  return value && /^L[1-5]$/u.test(value) ? (value as RiskLevel) : null;
}

function isOverdue(
  deadline: string | null,
  status: string | null,
  now: Date,
): boolean {
  if (!deadline || COMPLETED_STATUSES.has(status?.trim().toLowerCase() ?? "")) {
    return false;
  }
  if (Number.isNaN(Date.parse(deadline))) return false;
  return deadline < now.toISOString().slice(0, 10);
}

function readDependencyIds(attributes: Record<string, JsonValue>): string[] {
  for (const key of DEPENDENCY_FIELD_KEYS) {
    const value = attributes[key];
    if (value !== undefined) return toStringArray(value);
  }
  return [];
}

function toStringArray(value: JsonValue): string[] {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (Array.isArray(value)) return value.flatMap(toStringArray);
  if (typeof value === "object" && value !== null) {
    for (const key of ["record_id", "id", "value"] as const) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) {
        return [candidate.trim()];
      }
    }
  }
  return [];
}
