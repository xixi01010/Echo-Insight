import type { ModelAdapter } from "./provider/model-adapter.js";
import { DeepSeekAdapter, readDeepSeekModel } from "../../scripts/deepseek-adapter.js";
import { SiliconFlowGlobalInsightSynthesizer } from "./siliconflow-global-synthesizer.js";

/** Current production global synthesizer: official DeepSeek transport. */
export class DeepSeekGlobalInsightSynthesizer extends SiliconFlowGlobalInsightSynthesizer {
  constructor(
    adapter: ModelAdapter = { invoke: (request) => new DeepSeekAdapter().invoke(request) },
    model = readDeepSeekModel(),
    logger: Pick<Console, "info" | "error"> = console,
  ) {
    super(adapter, model, logger);
  }
}
