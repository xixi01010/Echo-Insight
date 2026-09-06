import { randomUUID } from "node:crypto";

import type { ModelAdapter } from "./provider/model-adapter.js";
import { SiliconFlowAdapter } from "../../scripts/siliconflow-adapter.js";
import { readReportModel } from "./siliconflow-risk-analyzer.js";
import { normalizeGlobalSynthesisOutput } from "./global-synthesis-normalizer.js";
import type {
  GlobalInsightSynthesizer,
  GlobalSynthesisInput,
  GlobalSynthesisOutput,
} from "./global-synthesis-types.js";

const GLOBAL_SYNTHESIS_SYSTEM_PROMPT = [
  "你是 Echo Insight 的跨项目风险解释引擎，不是聊天机器人，也不是项目管理执行者。",
  "只使用输入 JSON 中已经确认的事实。规则系统已确定每条风险的等级、来源和排序；不得修改、重新排序或新增风险。",
  "不得声称查询了额外数据，不得推测负责人、项目阶段、截止日期或未提供的项目状态。",
  "角色仅用于调整解释与建议的侧重点：负责人强调协调影响，成员强调当前执行建议；不得隐藏或改变事实。",
  "只输出 JSON。顶层必须且只能包含 summary、priorities、limitations。",
  "priorities 中每一项必须且只能包含 insightId、explanation、suggestedAction。insightId 必须来自输入，且每个最多一次。",
  "按输入顺序输出 priorities；suggestedAction 是建议，不是自动执行命令。",
  "信息不足时写入 limitations，不能补造事实或风险。",
].join("\n");

interface AiProviderLogger {
  info(message: string): void;
  error(message: string): void;
}

/** Reuses the existing SiliconFlow transport with a protocol isolated from V1. */
export class SiliconFlowGlobalInsightSynthesizer implements GlobalInsightSynthesizer {
  constructor(
    private readonly adapter: ModelAdapter | undefined = undefined,
    private readonly model?: string,
    private readonly logger: AiProviderLogger = console,
  ) {}

  async synthesize(input: GlobalSynthesisInput): Promise<GlobalSynthesisOutput> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let model = this.model;

    try {
      model ??= readReportModel();
      this.logger.info(JSON.stringify({
        event: "global_synthesis_started",
        requestId,
        stage: "ai-provider",
        model,
        insightCount: input.insights.length,
      }));
      const response = await (this.adapter ?? new SiliconFlowAdapter()).invoke({
        model,
        systemPrompt: GLOBAL_SYNTHESIS_SYSTEM_PROMPT,
        prompt: createGlobalSynthesisPrompt(input),
        testCase: {
          name: "global-insight-synthesis",
          filePath: "",
          input: input as unknown as Record<string, unknown>,
        },
      });
      const output = normalizeGlobalSynthesisOutput(response.response, input);
      this.logger.info(JSON.stringify({
          event: "global_synthesis_completed",
        requestId,
        stage: "ai-provider",
        model,
        elapsedMs: Date.now() - startedAt,
        outcome: "success",
      }));
      return output;
    } catch (error) {
      this.logger.error(JSON.stringify({
        event: "global_synthesis_completed",
        requestId,
        stage: "ai-provider",
        model: model ?? "unconfigured",
        elapsedMs: Date.now() - startedAt,
        outcome: "failure",
        errorCategory: error instanceof Error && error.name === "TimeoutError"
          ? "AI_PROVIDER_TIMEOUT"
          : "AI_PROVIDER_FAILED",
      }));
      throw error;
    }
  }
}

export function createGlobalSynthesisPrompt(input: GlobalSynthesisInput): string {
  return [
    "以下是已完成确定性排序的跨项目风险事实。仅综合解释这些事实：",
    JSON.stringify(input),
  ].join("\n");
}
