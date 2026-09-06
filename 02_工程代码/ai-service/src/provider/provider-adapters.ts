import type {
  ModelAdapter,
  ModelAdapterRequest,
  ModelAdapterResult,
} from "./model-adapter.js";
import {
  isOfficialDashScopeHostname,
  normalizeCustomChatCompletionsUrl,
  normalizeOfficialChatCompletionsUrl,
} from "./endpoint-policy.js";
import {
  DEFAULT_SILICONFLOW_MODEL,
  SILICONFLOW_CHAT_COMPLETIONS_URL,
  type JsonResponseMode,
  type SiliconFlowAdapterLogger,
  SiliconFlowAdapter,
  type TokenLimitField,
} from "../../../scripts/siliconflow-adapter.js";

export const DASHSCOPE_CHAT_COMPLETIONS_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
export const DEFAULT_DASHSCOPE_MODEL = "qwen3.8-flash";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 35_000;

interface ProviderConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
}

export interface DashScopeConfig extends ProviderConfig {}

export interface OpenAiCompatibleConfig extends ProviderConfig {
  jsonMode: JsonResponseMode;
  tokenLimitField: TokenLimitField;
  providerName: string;
}

export function readDashScopeModel(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.DASHSCOPE_MODEL?.trim() || DEFAULT_DASHSCOPE_MODEL;
}

export function readDashScopeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DashScopeConfig {
  const apiKey = requireValue(environment.DASHSCOPE_API_KEY, "DASHSCOPE_API_KEY");
  const rawEndpoint = environment.DASHSCOPE_CHAT_COMPLETIONS_URL?.trim()
    || DASHSCOPE_CHAT_COMPLETIONS_URL;
  return {
    apiKey,
    model: readDashScopeModel(environment),
    endpoint: normalizeOfficialChatCompletionsUrl(rawEndpoint, {
      providerName: "DashScope",
      variableName: "DASHSCOPE_CHAT_COMPLETIONS_URL",
      isAllowedHostname: isOfficialDashScopeHostname,
    }),
    timeoutMs: parseTimeout(environment.DASHSCOPE_TIMEOUT_MS),
  };
}

export function readOpenAiCompatibleModel(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.OPENAI_COMPATIBLE_MODEL?.trim() || "unconfigured";
}

export function readOpenAiCompatibleConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleConfig {
  const apiKey = requireValue(
    environment.OPENAI_COMPATIBLE_API_KEY,
    "OPENAI_COMPATIBLE_API_KEY",
  );
  const model = requireValue(
    environment.OPENAI_COMPATIBLE_MODEL,
    "OPENAI_COMPATIBLE_MODEL",
  );
  const rawEndpoint = requireValue(
    environment.OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL,
    "OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL",
  );
  return {
    apiKey,
    model,
    endpoint: normalizeCustomChatCompletionsUrl(
      rawEndpoint,
      "OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL",
    ),
    timeoutMs: parseTimeout(environment.OPENAI_COMPATIBLE_TIMEOUT_MS),
    jsonMode: parseJsonMode(environment.OPENAI_COMPATIBLE_JSON_MODE),
    tokenLimitField: parseTokenLimitField(
      environment.OPENAI_COMPATIBLE_TOKEN_LIMIT_FIELD,
    ),
    providerName: "OpenAI-compatible",
  };
}

export function readLegacySiliconFlowCompatibleConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OpenAiCompatibleConfig {
  const apiKey = requireValue(environment.SILICONFLOW_API_KEY, "SILICONFLOW_API_KEY");
  const rawEndpoint = environment.SILICONFLOW_BASE_URL?.trim()
    || SILICONFLOW_CHAT_COMPLETIONS_URL;
  return {
    apiKey,
    model: environment.AI_MODEL_OVERRIDE?.trim()
      || environment.AI_MODEL?.trim()
      || DEFAULT_SILICONFLOW_MODEL,
    endpoint: normalizeCustomChatCompletionsUrl(
      rawEndpoint,
      "SILICONFLOW_BASE_URL",
      { allowBaseUrl: true },
    ),
    timeoutMs: parseTimeout(environment.SILICONFLOW_TIMEOUT_MS),
    jsonMode: "json_object",
    tokenLimitField: "max_tokens",
    providerName: "SiliconFlow",
  };
}

export class DashScopeAdapter implements ModelAdapter {
  private readonly transport: SiliconFlowAdapter;

  constructor(
    private readonly config: DashScopeConfig = readDashScopeConfig(),
    fetchImpl: typeof fetch = fetch,
    now: () => number = () => Date.now(),
    logger: SiliconFlowAdapterLogger = { error: (message) => console.error(message) },
  ) {
    this.transport = new SiliconFlowAdapter(
      {
        ...config,
        providerName: "DashScope",
        jsonMode: "json_object",
        tokenLimitField: "max_completion_tokens",
        extraRequestBody: { enable_thinking: false },
      },
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

export class OpenAiCompatibleAdapter implements ModelAdapter {
  private readonly transport: SiliconFlowAdapter;

  constructor(
    private readonly config: OpenAiCompatibleConfig = readOpenAiCompatibleConfig(),
    fetchImpl: typeof fetch = fetch,
    now: () => number = () => Date.now(),
    logger: SiliconFlowAdapterLogger = { error: (message) => console.error(message) },
  ) {
    this.transport = new SiliconFlowAdapter(
      {
        ...config,
        jsonMode: config.jsonMode,
        tokenLimitField: config.tokenLimitField,
      },
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

function parseJsonMode(value: string | undefined): JsonResponseMode {
  const normalized = value?.trim() || "json_object";
  if (normalized === "json_object" || normalized === "none") return normalized;
  throw new Error("OPENAI_COMPATIBLE_JSON_MODE must be json_object or none.");
}

function parseTokenLimitField(value: string | undefined): TokenLimitField {
  const normalized = value?.trim() || "max_tokens";
  if (
    normalized === "max_tokens"
    || normalized === "max_completion_tokens"
    || normalized === "none"
  ) {
    return normalized;
  }
  throw new Error(
    "OPENAI_COMPATIBLE_TOKEN_LIMIT_FIELD must be max_tokens, max_completion_tokens, or none.",
  );
}

function requireValue(value: string | undefined, variableName: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`Missing ${variableName} environment variable.`);
  return normalized;
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value ?? String(DEFAULT_TIMEOUT_MS));
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(parsed, MAX_TIMEOUT_MS);
}
