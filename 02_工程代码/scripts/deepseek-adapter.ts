import type {
  ModelAdapter,
  ModelAdapterRequest,
  ModelAdapterResult,
} from "../ai-service/src/provider/model-adapter.js";
import {
  type SiliconFlowAdapterLogger,
  SiliconFlowAdapter,
} from "./siliconflow-adapter.js";
import {
  isOfficialDeepSeekHostname,
  normalizeOfficialChatCompletionsUrl,
} from "../ai-service/src/provider/endpoint-policy.js";

export const DEEPSEEK_CHAT_COMPLETIONS_URL = "https://api.deepseek.com/chat/completions";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

export interface DeepSeekConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
}

export function readDeepSeekModel(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
}

/** Reads the official DeepSeek configuration without reusing SiliconFlow credentials. */
export function readDeepSeekConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DeepSeekConfig {
  const apiKey = environment.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) throw new Error("Missing DEEPSEEK_API_KEY environment variable.");

  const rawEndpoint = environment.DEEPSEEK_CHAT_COMPLETIONS_URL?.trim()
    || environment.DEEPSEEK_BASE_URL?.trim()
    || DEEPSEEK_CHAT_COMPLETIONS_URL;

  return {
    apiKey,
    model: readDeepSeekModel(environment),
    endpoint: normalizeOfficialChatCompletionsUrl(rawEndpoint, {
      providerName: "DeepSeek",
      variableName: environment.DEEPSEEK_BASE_URL?.trim()
        && !environment.DEEPSEEK_CHAT_COMPLETIONS_URL?.trim()
        ? "DEEPSEEK_BASE_URL"
        : "DEEPSEEK_CHAT_COMPLETIONS_URL",
      isAllowedHostname: isOfficialDeepSeekHostname,
      allowBaseUrl: Boolean(
        environment.DEEPSEEK_BASE_URL?.trim()
        && !environment.DEEPSEEK_CHAT_COMPLETIONS_URL?.trim(),
      ),
    }),
    timeoutMs: parseTimeout(environment.DEEPSEEK_TIMEOUT_MS),
  };
}

/** Official DeepSeek transport reusing the existing safe OpenAI-compatible response handling. */
export class DeepSeekAdapter implements ModelAdapter {
  private readonly transport: SiliconFlowAdapter;

  constructor(
    private readonly config: DeepSeekConfig = readDeepSeekConfig(),
    fetchImpl: typeof fetch = fetch,
    now: () => number = () => Date.now(),
    logger: SiliconFlowAdapterLogger = { error: (message) => console.error(message) },
  ) {
    this.transport = new SiliconFlowAdapter(
      { ...config, providerName: "DeepSeek" },
      fetchImpl,
      now,
      logger,
    );
  }

  invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
    return this.transport.invoke({
      ...request,
      model: request.model || this.config.model,
    });
  }
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value ?? "30000");
  if (!Number.isFinite(parsed) || parsed <= 0) return 30_000;
  return Math.min(parsed, 35_000);
}
