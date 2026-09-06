import {
  DeepSeekAdapter,
  readDeepSeekConfig,
  readDeepSeekModel,
} from "../../../scripts/deepseek-adapter.js";
import {
  DEFAULT_SILICONFLOW_MODEL,
  type SiliconFlowAdapterLogger,
} from "../../../scripts/siliconflow-adapter.js";
import { SiliconFlowGlobalInsightSynthesizer } from "../siliconflow-global-synthesizer.js";
import { SiliconFlowRiskAnalyzer } from "../siliconflow-risk-analyzer.js";
import type { GlobalInsightSynthesizer } from "../global-synthesis-types.js";
import type { RiskExplanationAnalyzer } from "../explanation-types.js";
import type { ModelAdapter, ModelAdapterRequest, ModelAdapterResult } from "./model-adapter.js";
import {
  DashScopeAdapter,
  OpenAiCompatibleAdapter,
  readDashScopeConfig,
  readDashScopeModel,
  readLegacySiliconFlowCompatibleConfig,
  readOpenAiCompatibleConfig,
  readOpenAiCompatibleModel,
} from "./provider-adapters.js";

export const AI_PROVIDER_IDS = ["deepseek", "qwen", "openai-compatible"] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];

export interface AiProviderBundle {
  providerId: AiProviderId;
  displayName: string;
  model: string;
  modelAdapter: ModelAdapter;
  riskAnalyzer: RiskExplanationAnalyzer;
  globalSynthesizer: GlobalInsightSynthesizer;
}

export interface AiProviderFactoryDependencies {
  fetchImpl?: typeof fetch;
  now?: () => number;
  transportLogger?: SiliconFlowAdapterLogger;
  serviceLogger?: Pick<Console, "info" | "error">;
}

interface ProviderSelection {
  providerId: AiProviderId;
  legacySiliconFlow: boolean;
}

export function createAiProviderBundle(
  environment: NodeJS.ProcessEnv = process.env,
  dependencies: AiProviderFactoryDependencies = {},
): AiProviderBundle {
  const selection = readProviderSelection(environment);
  const model = readSelectedModel(selection, environment);
  const displayName = readDisplayName(selection);
  const modelAdapter = createLazyAdapter(() => createSelectedAdapter(
    selection,
    environment,
    dependencies,
  ));
  const serviceLogger = dependencies.serviceLogger ?? console;

  return {
    providerId: selection.providerId,
    displayName,
    model,
    modelAdapter,
    riskAnalyzer: new SiliconFlowRiskAnalyzer(modelAdapter, model, serviceLogger),
    globalSynthesizer: new SiliconFlowGlobalInsightSynthesizer(
      modelAdapter,
      model,
      serviceLogger,
    ),
  };
}

export function readAiProviderId(
  environment: NodeJS.ProcessEnv = process.env,
): AiProviderId {
  return readProviderSelection(environment).providerId;
}

function readProviderSelection(environment: NodeJS.ProcessEnv): ProviderSelection {
  const configured = environment.AI_PROVIDER?.trim().toLowerCase() || "deepseek";
  if (configured === "deepseek" || configured === "qwen") {
    return { providerId: configured, legacySiliconFlow: false };
  }
  if (configured === "openai-compatible" || configured === "openai_compatible") {
    return { providerId: "openai-compatible", legacySiliconFlow: false };
  }
  if (configured === "siliconflow") {
    return { providerId: "openai-compatible", legacySiliconFlow: true };
  }
  throw new Error(
    "Unsupported AI_PROVIDER. Supported values: deepseek, qwen, openai-compatible.",
  );
}

function readSelectedModel(
  selection: ProviderSelection,
  environment: NodeJS.ProcessEnv,
): string {
  if (selection.providerId === "deepseek") return readDeepSeekModel(environment);
  if (selection.providerId === "qwen") return readDashScopeModel(environment);
  if (selection.legacySiliconFlow) {
    return environment.AI_MODEL_OVERRIDE?.trim()
      || environment.AI_MODEL?.trim()
      || DEFAULT_SILICONFLOW_MODEL;
  }
  return readOpenAiCompatibleModel(environment);
}

function readDisplayName(selection: ProviderSelection): string {
  if (selection.providerId === "deepseek") return "DeepSeek";
  if (selection.providerId === "qwen") return "Qwen (DashScope)";
  return selection.legacySiliconFlow ? "SiliconFlow (legacy)" : "OpenAI-compatible";
}

function createSelectedAdapter(
  selection: ProviderSelection,
  environment: NodeJS.ProcessEnv,
  dependencies: AiProviderFactoryDependencies,
): ModelAdapter {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const now = dependencies.now ?? (() => Date.now());
  const logger = dependencies.transportLogger
    ?? { error: (message: string) => console.error(message) };

  if (selection.providerId === "deepseek") {
    return new DeepSeekAdapter(
      readDeepSeekConfig(environment),
      fetchImpl,
      now,
      logger,
    );
  }
  if (selection.providerId === "qwen") {
    return new DashScopeAdapter(
      readDashScopeConfig(environment),
      fetchImpl,
      now,
      logger,
    );
  }
  const config = selection.legacySiliconFlow
    ? readLegacySiliconFlowCompatibleConfig(environment)
    : readOpenAiCompatibleConfig(environment);
  return new OpenAiCompatibleAdapter(config, fetchImpl, now, logger);
}

function createLazyAdapter(factory: () => ModelAdapter): ModelAdapter {
  let adapter: ModelAdapter | undefined;
  return {
    async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
      adapter ??= factory();
      return await adapter.invoke(request);
    },
  };
}
