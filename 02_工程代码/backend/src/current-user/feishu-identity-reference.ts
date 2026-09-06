export type FeishuIdentityType = "open_id" | "union_id" | "user_id";

export interface FeishuIdentityContext {
  applicationId: string;
  tenantId?: string;
}

export interface FeishuIdentityRef {
  type: FeishuIdentityType;
  value: string;
  context: FeishuIdentityContext;
}

export type FeishuIdentityComparison = "same" | "different" | "unknown";

export interface CreateFeishuIdentityRefInput {
  type: FeishuIdentityType;
  value: string;
  context: FeishuIdentityContext;
}

/**
 * A server-side reference for a Feishu subject. Display names are deliberately
 * excluded: they are presentation data, never identity evidence.
 */
export function createFeishuIdentityRef(
  input: CreateFeishuIdentityRefInput,
): FeishuIdentityRef {
  return {
    type: input.type,
    value: requireText(input.value, "Feishu identity value"),
    context: {
      applicationId: requireText(input.context.applicationId, "Feishu application id"),
      ...(input.context.tenantId ? { tenantId: requireText(input.context.tenantId, "Feishu tenant id") } : {}),
    },
  };
}

export function toFeishuOpenIdIdentityRef(
  openId: string,
  applicationId: string,
): FeishuIdentityRef {
  return createFeishuIdentityRef({
    type: "open_id",
    value: openId,
    context: { applicationId },
  });
}

/**
 * Only exact identifier types in the same known application and tenant
 * context are comparable. Unknown is intentionally distinct from different.
 */
export function compareFeishuIdentityRefs(
  left: FeishuIdentityRef,
  right: FeishuIdentityRef,
): FeishuIdentityComparison {
  if (left.type !== right.type || !hasComparableContext(left, right)) return "unknown";
  return left.value === right.value ? "same" : "different";
}

function hasComparableContext(left: FeishuIdentityRef, right: FeishuIdentityRef): boolean {
  if (left.context.applicationId !== right.context.applicationId) return false;
  return left.context.tenantId === right.context.tenantId;
}

function requireText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${fieldName} is required.`);
  return normalized;
}
