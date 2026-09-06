import type {
  ModelAdapter,
  ModelAdapterRequest,
  ModelAdapterResult,
} from "../ai-service/src/provider/model-adapter.js";
import { normalizeCustomChatCompletionsUrl } from "../ai-service/src/provider/endpoint-policy.js";

export const SILICONFLOW_CHAT_COMPLETIONS_URL =
  "https://api.siliconflow.cn/v1/chat/completions";
export const DEFAULT_SILICONFLOW_MODEL = "Qwen/Qwen2.5-72B-Instruct-128K";
const DEFAULT_SILICONFLOW_TIMEOUT_MS = 30_000;
const MAX_SILICONFLOW_TIMEOUT_MS = 35_000;
const MAX_SILICONFLOW_OUTPUT_TOKENS = 3_072;

export type JsonResponseMode = "json_object" | "none";
export type TokenLimitField = "max_tokens" | "max_completion_tokens" | "none";

export interface SiliconFlowConfig {
  apiKey: string;
  model: string;
  endpoint: string;
  timeoutMs: number;
  providerName?: string;
  jsonMode?: JsonResponseMode;
  tokenLimitField?: TokenLimitField;
  maxOutputTokens?: number;
  extraRequestBody?: Readonly<Record<string, unknown>>;
}

interface SiliconFlowApiResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: unknown;
    message?: {
      content?: unknown;
      reasoning_content?: unknown;
      [key: string]: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface SiliconFlowAdapterLogger {
  error(message: string): void;
}

export function readSiliconFlowConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SiliconFlowConfig {
  const apiKey = environment.SILICONFLOW_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing SILICONFLOW_API_KEY environment variable.");
  }

  return {
    apiKey,
    model: environment.AI_MODEL?.trim() || DEFAULT_SILICONFLOW_MODEL,
    endpoint: normalizeCustomChatCompletionsUrl(
      environment.SILICONFLOW_BASE_URL?.trim() || SILICONFLOW_CHAT_COMPLETIONS_URL,
      "SILICONFLOW_BASE_URL",
      { allowBaseUrl: true },
    ),
    timeoutMs: parseTimeout(environment.SILICONFLOW_TIMEOUT_MS),
  };
}

export class SiliconFlowAdapter implements ModelAdapter {
  constructor(
    private readonly config: SiliconFlowConfig = readSiliconFlowConfig(),
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = () => Date.now(),
    private readonly logger: SiliconFlowAdapterLogger = {
      error: (message) => console.error(message),
    },
  ) {}

  async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
    const startedAt = this.now();
    const maxOutputTokens = this.config.maxOutputTokens ?? MAX_SILICONFLOW_OUTPUT_TOKENS;
    const tokenLimitField = this.config.tokenLimitField ?? "max_tokens";
    const jsonMode = this.config.jsonMode ?? "json_object";
    const requestBody: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.prompt },
      ],
      stream: false,
      temperature: 0.2,
      ...(tokenLimitField === "none"
        ? {}
        : { [tokenLimitField]: maxOutputTokens }),
      ...(jsonMode === "json_object"
        ? { response_format: { type: "json_object" } }
        : {}),
      ...(isDeepSeekEndpoint(this.config.endpoint)
        ? { thinking: { type: "disabled" } }
        : {}),
      ...this.config.extraRequestBody,
    };
    let response: Response;
    try {
      response = await this.fetchImpl(this.config.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "ai_provider_fetch_failed",
          stage: "ai-provider",
          endpointHostname: getEndpointHostname(this.config.endpoint),
          errorName: normalizeErrorName(error),
        }),
      );
      if (error instanceof Error && error.name === "TimeoutError") {
        throw createTransportError(
          `${this.config.providerName ?? "SiliconFlow"} request timed out.`,
          "TimeoutError",
        );
      }
      throw createTransportError(
        `${this.config.providerName ?? "SiliconFlow"} request failed.`,
      );
    }

    if (!response.ok) {
      this.logger.error(
        JSON.stringify({
          event: "ai_provider_http_error",
          stage: "ai-provider",
          endpointHostname: getEndpointHostname(this.config.endpoint),
          status: response.status,
          contentType: normalizeContentType(response.headers.get("content-type")),
          bodyLength: readContentLength(response.headers.get("content-length")),
        }),
      );
      try {
        await response.body?.cancel();
      } catch {
        // The status error remains authoritative even if the transport cannot cancel the body.
      }
      throw new Error(`${this.config.providerName ?? "SiliconFlow"} request failed with HTTP ${response.status}.`);
    }

    let rawBody: string;
    try {
      rawBody = await response.text();
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "ai_provider_response_read_failed",
          stage: "ai-provider",
          endpointHostname: getEndpointHostname(this.config.endpoint),
          errorName: normalizeErrorName(error),
        }),
      );
      throw createTransportError(
        `${this.config.providerName ?? "SiliconFlow"} response body could not be read.`,
      );
    }
    let payload: SiliconFlowApiResponse;
    try {
      payload = JSON.parse(rawBody) as SiliconFlowApiResponse;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "ai_provider_response_parse_failed",
          stage: "ai-provider",
          endpointHostname: getEndpointHostname(this.config.endpoint),
          parseErrorType: normalizeErrorName(error),
          responseStructure: summarizeResponseStructure(rawBody, response),
        }),
      );
      throw createTransportError(
        `${this.config.providerName ?? "SiliconFlow"} response could not be parsed.`,
      );
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      logResponseStructureDiagnostic(this.logger, payload);
    }
    logMalformedOutputCompletionDiagnostic(
      this.logger,
      payload,
      content,
      maxOutputTokens,
    );
    if (typeof content !== "string") {
      throw new Error(`${this.config.providerName ?? "SiliconFlow"} response did not contain text content.`);
    }

    return {
      model: payload.model ?? request.model,
      response: content,
      latency: this.now() - startedAt,
      tokenUsage: {
        inputTokens: payload.usage?.prompt_tokens ?? null,
        outputTokens: payload.usage?.completion_tokens ?? null,
        totalTokens: payload.usage?.total_tokens ?? null,
      },
      timestamp: new Date().toISOString(),
    };
  }
}

function logResponseStructureDiagnostic(
  logger: SiliconFlowAdapterLogger,
  payload: SiliconFlowApiResponse,
): void {
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const firstChoice = choices[0];
  const message = firstChoice?.message;
  const content = message?.content;
  const reasoningContent = message && "reasoning_content" in message
    ? message.reasoning_content
    : undefined;

  logger.error(
    JSON.stringify({
      event: "ai_provider_response_structure",
      stage: "ai-provider",
      choicesLength: choices.length,
      messageKeyCount: message && typeof message === "object" ? Object.keys(message).length : 0,
      contentFieldPresent: Boolean(message && Object.hasOwn(message, "content")),
      contentLength: typeof content === "string" ? content.length : null,
      reasoningContentPresent: reasoningContent !== undefined,
      reasoningContentLength: typeof reasoningContent === "string" ? reasoningContent.length : null,
      finishReason: firstChoice && "finish_reason" in firstChoice
        ? normalizeFinishReason(firstChoice.finish_reason)
        : null,
      usagePresent: payload.usage !== undefined,
    }),
  );
}

function logMalformedOutputCompletionDiagnostic(
  logger: SiliconFlowAdapterLogger,
  payload: SiliconFlowApiResponse,
  content: unknown,
  maxOutputTokens: number,
): void {
  if (typeof content !== "string" || isJsonText(content)) return;

  const firstChoice = payload.choices?.[0];
  logger.error(
    JSON.stringify({
      event: "ai_provider_output_completion_diagnostic",
      stage: "ai-provider",
      finishReason: normalizeFinishReason(firstChoice?.finish_reason),
      completionTokens:
        typeof payload.usage?.completion_tokens === "number"
          ? payload.usage.completion_tokens
          : null,
      maxTokens: maxOutputTokens,
      jsonObjectClosed: content.trimEnd().endsWith("}"),
    }),
  );
}

function isJsonText(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function isDeepSeekEndpoint(endpoint: string): boolean {
  return getEndpointHostname(endpoint) === "api.deepseek.com";
}
function getEndpointHostname(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "invalid-endpoint";
  }
}

function summarizeResponseStructure(value: string, response: Response): Record<string, unknown> {
  return {
    contentType: normalizeContentType(response.headers.get("content-type")),
    bodyLength: value.length,
  };
}

function readContentLength(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function normalizeFinishReason(
  value: unknown,
): "stop" | "length" | "content_filter" | "tool_calls" | "function_call" | "other" | null {
  if (typeof value !== "string") return null;
  if (
    value === "stop"
    || value === "length"
    || value === "content_filter"
    || value === "tool_calls"
    || value === "function_call"
  ) {
    return value;
  }
  return "other";
}

function normalizeContentType(
  value: string | null,
): "application/json" | "text/plain" | "other" | null {
  if (value === null) return null;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "application/json" || mediaType?.endsWith("+json")) {
    return "application/json";
  }
  if (mediaType === "text/plain") return "text/plain";
  return "other";
}

function normalizeErrorName(
  error: unknown,
): "Error" | "TypeError" | "SyntaxError" | "AbortError" | "TimeoutError" | "UnknownError" {
  if (!(error instanceof Error)) return "UnknownError";
  if (
    error.name === "Error"
    || error.name === "TypeError"
    || error.name === "SyntaxError"
    || error.name === "AbortError"
    || error.name === "TimeoutError"
  ) {
    return error.name;
  }
  return "UnknownError";
}

function createTransportError(message: string, name = "AiProviderTransportError"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function parseTimeout(value: string | undefined): number {
  const parsed = Number(value ?? String(DEFAULT_SILICONFLOW_TIMEOUT_MS));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SILICONFLOW_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_SILICONFLOW_TIMEOUT_MS);
}
