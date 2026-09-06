import type { FeishuField } from "./types.js";

export type StandardTaskFieldName =
  | "name"
  | "owner"
  | "status"
  | "deadline"
  | "riskLevel"
  | "description";

export type SchemaMappingState = "confirmed" | "candidate" | "unresolved";

export interface BaseSchemaMapping {
  fieldId?: string;
  fieldName: string;
  target?: StandardTaskFieldName;
  state: SchemaMappingState;
  reason: "metadata-match" | "type-mismatch" | "unrecognized" | "ambiguous";
}

interface AdaptiveRule {
  fieldName: string;
  target: StandardTaskFieldName;
  uiType: string;
  requiresPrimary?: boolean;
}

const ADAPTIVE_RULES: readonly AdaptiveRule[] = [
  { fieldName: "事项", target: "name", uiType: "Text", requiresPrimary: true },
  { fieldName: "主R", target: "owner", uiType: "User" },
  { fieldName: "推进情况", target: "status", uiType: "SingleSelect" },
  { fieldName: "计划交付", target: "deadline", uiType: "DateTime" },
];

/**
 * Metadata can confirm only explicitly supported, type-compatible mappings.
 * Similar-looking fields remain candidates; this module never performs fuzzy
 * matching or ranks Sources.
 */
export function analyzeBaseSchema(fields: readonly FeishuField[]): BaseSchemaMapping[] {
  const mappings = fields.map(analyzeField);
  for (const target of new Set(
    mappings.flatMap((mapping) => mapping.state === "confirmed" && mapping.target ? [mapping.target] : []),
  )) {
    const confirmed = mappings.filter(
      (mapping) => mapping.state === "confirmed" && mapping.target === target,
    );
    if (confirmed.length > 1) {
      for (const mapping of confirmed) {
        mapping.state = "candidate";
        mapping.reason = "ambiguous";
      }
    }
  }
  return mappings;
}

export function resolveConfirmedSchemaFields(
  fields: readonly FeishuField[],
): Partial<Record<StandardTaskFieldName, string>> {
  return Object.fromEntries(
    analyzeBaseSchema(fields)
      .filter((mapping): mapping is BaseSchemaMapping & { target: StandardTaskFieldName } =>
        mapping.state === "confirmed" && Boolean(mapping.target),
      )
      .map((mapping) => [mapping.target, mapping.fieldName]),
  );
}

function analyzeField(field: FeishuField): BaseSchemaMapping {
  const fieldName = field.field_name?.trim() || "";
  const rule = ADAPTIVE_RULES.find((candidate) => candidate.fieldName === fieldName);
  const base = {
    ...(field.field_id ? { fieldId: field.field_id } : {}),
    fieldName,
  };
  if (!rule) return { ...base, state: "unresolved", reason: "unrecognized" };
  if (field.ui_type !== rule.uiType || (rule.requiresPrimary && field.is_primary !== true)) {
    return { ...base, target: rule.target, state: "candidate", reason: "type-mismatch" };
  }
  return { ...base, target: rule.target, state: "confirmed", reason: "metadata-match" };
}
