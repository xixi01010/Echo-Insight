import type {
  AiExplanationInput,
  AiExplanationOutput,
  AiExplanationRisk,
} from "./explanation-types.js";

const FORBIDDEN_V2_KEYS = new Set([
  "healthScore",
  "healthStatus",
  "riskLevel",
  "projectStatus",
  "taskStatus",
  "status",
]);

type AuthorizedRiskSignal = AiExplanationInput["riskSignals"][number];

/**
 * Converts a V2-safe provider response into the canonical explanation shape.
 * System-owned identifiers and evidence are derived only from authorized signals.
 */
export function normalizeRiskOutput(
  value: unknown,
  input: AiExplanationInput,
): AiExplanationOutput {
  const parsed = parseOutput(value);
  assertNoForbiddenFields(parsed, "output");

  if (!Array.isArray(parsed.risks) || !isStringArray(parsed.limitations)) {
    throw new Error("AI output does not match the V2 explanation structure.");
  }

  return {
    risks: parsed.risks.map((risk) => normalizeRisk(risk, input.riskSignals)),
    limitations: parsed.limitations,
  };
}

function parseOutput(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      throw new Error("AI output does not match the V2 explanation structure.");
    }
  }

  if (!isRecord(parsed)) {
    throw new Error("AI output does not match the V2 explanation structure.");
  }
  return parsed;
}

function normalizeRisk(
  value: unknown,
  signals: AuthorizedRiskSignal[],
): AiExplanationRisk {
  if (!isRecord(value)) {
    throwInvalidRiskExplanation();
  }

  const signal = resolveSignal(value, signals);
  const reason = value.reason;
  const impact = value.impact;
  const suggestedActions = readAliasedValue(
    value,
    "suggestedActions",
    "suggested_actions",
  );

  if (
    typeof reason !== "string" ||
    typeof impact !== "string" ||
    !isStringArray(suggestedActions)
  ) {
    throwInvalidRiskExplanation();
  }

  return {
    id: signal.signalId,
    title: signal.type,
    evidenceRefs: [signal.signalId],
    reason,
    impact,
    suggestedActions,
  };
}

function resolveSignal(
  value: Record<string, unknown>,
  signals: AuthorizedRiskSignal[],
): AuthorizedRiskSignal {
  const candidates = new Map<string, AuthorizedRiskSignal>();
  const evidenceRefs = readAliasedValue(value, "evidenceRefs", "evidence_refs");
  const id = readAliasedValue(value, "id", "riskId");
  const title = readAliasedValue(value, "title", "name");

  if (evidenceRefs !== undefined) {
    if (!isStringArray(evidenceRefs) || evidenceRefs.length === 0) {
      throwInvalidRiskExplanation();
    }
    const resolvedIds = new Set<string>();
    for (const ref of evidenceRefs) {
      const signal = signals.find((candidate) => candidate.signalId === ref);
      if (!signal) {
        throwInvalidRiskExplanation();
      }
      resolvedIds.add(signal.signalId);
    }
    if (resolvedIds.size !== 1) {
      throwInvalidRiskExplanation();
    }
    const [resolvedId] = resolvedIds;
    const matched = signals.find((candidate) => candidate.signalId === resolvedId);
    if (matched) candidates.set(matched.signalId, matched);
  }

  if (id !== undefined) {
    if (typeof id !== "string") {
      throwInvalidRiskExplanation();
    }
    const signal = signals.find((candidate) => candidate.signalId === id);
    if (signal) candidates.set(signal.signalId, signal);
  }

  if (title !== undefined) {
    if (typeof title !== "string") {
      throwInvalidRiskExplanation();
    }
    const titleMatches = signals.filter((candidate) => candidate.type === title);
    if (titleMatches.length === 1) {
      const [signal] = titleMatches;
      if (signal) candidates.set(signal.signalId, signal);
    }
  }

  if (candidates.size !== 1) {
    throwInvalidRiskExplanation();
  }

  const [signal] = candidates.values();
  if (!signal) {
    throwInvalidRiskExplanation();
  }
  return signal;
}

function readAliasedValue(
  value: Record<string, unknown>,
  canonicalKey: string,
  aliasKey: string,
): unknown {
  const hasCanonicalValue = Object.hasOwn(value, canonicalKey);
  const hasAliasValue = Object.hasOwn(value, aliasKey);

  if (hasCanonicalValue && hasAliasValue) {
    if (stableSerialize(value[canonicalKey]) === stableSerialize(value[aliasKey])) {
      return value[canonicalKey];
    }
    throwInvalidRiskExplanation();
  }
  return hasCanonicalValue ? value[canonicalKey] : value[aliasKey];
}

/** Key-order-insensitive JSON equality helper used to reconcile alias keys. */
function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertNoForbiddenFields(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenFields(item, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_V2_KEYS.has(key)) {
      throw new Error(`AI output contains forbidden V2 field: ${path}.${key}`);
    }
    assertNoForbiddenFields(child, `${path}.${key}`);
  }
}

function throwInvalidRiskExplanation(): never {
  throw new Error("AI output contains an invalid risk explanation.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
