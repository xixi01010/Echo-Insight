import type { ModelTestCase } from "./model-adapter.js";

export function createPrompt(testCase: ModelTestCase): string {
  return [
    "请基于输入项目数据生成 Echo Insight 的 AI 风险解释。",
    "只返回符合 AI 输出协议 V2 的 JSON，不返回 Markdown 或额外解释。",
    "规则引擎已经计算健康度、健康状态、风险等级和项目状态事实；不要重新计算、复制或输出这些字段。",
    "允许输出的顶层字段只有 risks 和 limitations。每个 risks 条目只能包含风险解释、原因、影响、证据引用和建议行动。",
    "每个 risks 条目必须且只能包含 id、title、evidenceRefs、reason、impact、suggestedActions；字段名使用 camelCase。",
    "每个 risks 条目必须对应一个唯一的输入 riskContexts.signalId；id 和 evidenceRefs 必须引用同一 signalId，title 必须对应该风险的 type。",
    "生成每条解释时，优先使用对应 riskContext 的 primaryTask、relatedTasks、factualEvidence 和 dataLimitations；不要用其他风险的事实替代。",
    "reason 必须说明发生了什么并引用已提供的任务事实；impact 必须解释该事实为什么会影响项目推进；suggestedActions 必须针对该风险的已知事实。",
    "同一风险类型的不同条目也必须分别解释各自任务、状态、截止日期或依赖事实；不得复用相同的 reason、impact 或 suggestedActions 句子。",
    "不要输出泛化表述，例如“项目可能延期”“需要协调资源”“排查阻塞原因”，除非对应 riskContext 已明确提供支持该表述的事实。",
    "如果缺少负责人、阻塞原因、影响对象或其他必要事实，必须写入 limitations，不能自行推断。",
    "signalId 仅用于 id 和 evidenceRefs 引用；不得在 reason、impact、suggestedActions 或 limitations 中提及 signalId、任务记录ID或其他内部ID。",
    "测试样本：" + testCase.name,
    "项目输入 JSON：",
    JSON.stringify(testCase.input, null, 2),
  ].join("\n");
}

/** Prompt V3: richer fact-grounding while preserving the V2 output protocol. */
export const SYSTEM_PROMPT_V3 = [
  "你是 Echo Insight 的 AI 项目风险观察员，不是聊天机器人，也不是项目驾驶员。",
  "只使用输入 JSON 中已经授权和结构化的事实，不补造缺失信息。",
  "规则引擎负责 healthScore、healthStatus、riskLevel 以及项目和任务状态事实；你只能解释规则信号，不能输出或改写这些字段。",
  "你只能输出 JSON 顶层字段 risks 和 limitations。",
  "每个 risks 条目只能包含 id、title、evidenceRefs、reason、impact、suggestedActions。",
  "每个 risks 条目必须包含 id、title、evidenceRefs、reason、impact、suggestedActions，字段名使用 camelCase。",
  "每个 risks 条目必须对应唯一 riskContexts.signalId；id 和 evidenceRefs 引用该 signalId，title 对应其 type。",
  "reason 必须以对应 riskContext 的 factualEvidence、primaryTask、relatedTasks 中的事实说明发生了什么。",
  "impact 必须说明该事实对项目推进的具体影响；只可基于已知任务、状态、截止日期、依赖关系或任务说明推断。",
  "suggestedActions 必须回应该风险已经提供的事实，不能使用与上下文无关的通用管理建议。",
  "输出必须保持简洁：每个 reason 和 impact 最多使用两个短句；suggestedActions 只提供一到两条可执行动作；limitations 只列出影响判断的关键缺失事实。",
  "同一事实在同一风险中只说明一次，不要在 reason、impact、suggestedActions 或 limitations 中重复复述。",
  "同类型但 signalId 不同的风险必须使用各自上下文生成不同的 reason、impact 和 suggestedActions；不得复用相同句子。",
  "不得使用“项目可能延期”“需要协调资源”“排查阻塞原因”等泛化表述，除非对应 riskContext 明确提供了支持该表述的事实。",
  "input.limitations、riskContext.dataLimitations 或事实字段表明信息不足时，必须在 limitations 中说明缺少的事实；不得推断负责人、阻塞根因或未提供的影响对象。",
  "signalId 仅可出现在 id 和 evidenceRefs；不得在 reason、impact、suggestedActions 或 limitations 中输出内部ID。",
  "风险原因和影响仅用于解释，建议行动仅供负责人参考，不是自动执行命令。",
  "不得评价员工能力、态度或绩效，不得跨项目推断，不得修改项目数据。",
  "如果证据不足，写入 limitations；只返回符合协议 V2 的 JSON。",
].join("\n");

/** @deprecated V2 denotes the output protocol; production uses the Prompt V3 content. */
export const SYSTEM_PROMPT_V2 = SYSTEM_PROMPT_V3;

/** Exported for the production sanitizer; the key list itself is unchanged. */
export const FORBIDDEN_V2_KEYS = new Set([
  "healthScore",
  "healthStatus",
  "riskLevel",
  "projectStatus",
  "taskStatus",
  "status",
]);

const ALLOWED_V2_TOP_LEVEL_KEYS = new Set(["risks", "limitations"]);

export interface V2ValidationResult {
  valid: boolean;
  violations: string[];
}

export function validateV2Output(value: unknown): V2ValidationResult {
  const violations: string[] = [];
  let parsed: unknown = value;

  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return { valid: false, violations: ["response is not valid JSON"] };
    }
  }

  if (!isObjectRecord(parsed)) {
    return { valid: false, violations: ["response must be a JSON object"] };
  }

  for (const key of Object.keys(parsed)) {
    if (!ALLOWED_V2_TOP_LEVEL_KEYS.has(key)) {
      violations.push(`forbidden top-level field: ${key}`);
    }
  }

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (!isObjectRecord(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (FORBIDDEN_V2_KEYS.has(key)) {
        violations.push(`forbidden field: ${path}.${key}`);
      }
      walk(child, `${path}.${key}`);
    }
  };
  walk(parsed, "output");

  if (!("risks" in parsed) || !Array.isArray(parsed.risks)) {
    violations.push("risks must be an array");
  }
  if (!("limitations" in parsed) || !Array.isArray(parsed.limitations)) {
    violations.push("limitations must be an array");
  }

  return { valid: violations.length === 0, violations };
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
