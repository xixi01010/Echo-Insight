import type { ModelAdapter } from "./provider/model-adapter.js";
import { DeepSeekAdapter, readDeepSeekModel } from "../../scripts/deepseek-adapter.js";
import { SiliconFlowRiskAnalyzer } from "./siliconflow-risk-analyzer.js";

export { AiProviderTimeoutError } from "./siliconflow-risk-analyzer.js";

/** Current production analyzer: official DeepSeek transport with the existing V2 normalizer. */
export class DeepSeekRiskAnalyzer extends SiliconFlowRiskAnalyzer {
  constructor(
    adapter: ModelAdapter = { invoke: (request) => new DeepSeekAdapter().invoke(request) },
    model = readDeepSeekModel(),
    logger: Pick<Console, "info" | "error"> = console,
  ) {
    super(adapter, model, logger);
  }
}
