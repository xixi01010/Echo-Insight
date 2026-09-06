import type {
  GlobalSynthesisInput,
  GlobalSynthesisOutput,
  GlobalSynthesisPriority,
} from "./global-synthesis-types.js";

const FORBIDDEN_FACT_KEYS = new Set([
  "riskLevel",
  "riskRanking",
  "ranking",
  "projectId",
  "ownerId",
  "memberIds",
  "baseToken",
  "dataSourceRef",
  "taskId",
  "recordId",
  "tableId",
]);

/**
 * Rejects model output that tries to introduce an unknown risk or system-owned
 * fields. The normalized priority order always follows the deterministic input.
 */
export function normalizeGlobalSynthesisOutput(
  value: unknown,
  input: GlobalSynthesisInput,
): GlobalSynthesisOutput {
  const parsed = parseRecord(value);
  assertExactKeys(parsed, ["summary", "priorities", "limitations"]);
  assertNoForbiddenKeys(parsed, "output");

  if (
    typeof parsed.summary !== "string"
    || !Array.isArray(parsed.priorities)
    || !isStringArray(parsed.limitations)
  ) {
    throw new Error("AI output does not match the global synthesis structure.");
  }

  const allowedIds = new Set(input.insights.map((insight) => insight.insightId));
  const priorities = parsed.priorities.map((priority) => normalizePriority(priority, allowedIds));
  const byId = new Map<string, GlobalSynthesisPriority>();
  for (const priority of priorities) {
    if (byId.has(priority.insightId)) {
      throw new Error("AI output contains duplicate global insight references.");
    }
    byId.set(priority.insightId, priority);
  }

  return {
    summary: parsed.summary,
    priorities: input.insights.flatMap((insight) => {
      const priority = byId.get(insight.insightId);
      return priority ? [priority] : [];
    }),
    limitations: parsed.limitations,
  };
}

function normalizePriority(
  value: unknown,
  allowedIds: ReadonlySet<string>,
): GlobalSynthesisPriority {
  const priority = parseRecord(value);
  assertExactKeys(priority, ["insightId", "explanation", "suggestedAction"]);
  if (
    typeof priority.insightId !== "string"
    || typeof priority.explanation !== "string"
    || typeof priority.suggestedAction !== "string"
    || !allowedIds.has(priority.insightId)
  ) {
    throw new Error("AI output contains an invalid global insight reference.");
  }
  return {
    insightId: priority.insightId,
    explanation: priority.explanation,
    suggestedAction: priority.suggestedAction,
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("AI output does not match the global synthesis structure.");
    }
  }
  if (!isRecord(parsed)) {
    throw new Error("AI output does not match the global synthesis structure.");
  }
  return parsed;
}

function assertExactKeys(value: Record<string, unknown>, expectedKeys: string[]): void {
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length
    || !expectedKeys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error("AI output contains unsupported global synthesis fields.");
  }
}

function assertNoForbiddenKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FACT_KEYS.has(key)) {
      throw new Error(`AI output contains a system-owned field: ${path}.${key}`);
    }
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
