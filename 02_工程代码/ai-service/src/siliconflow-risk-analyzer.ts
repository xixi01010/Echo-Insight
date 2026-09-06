import { randomUUID } from "node:crypto";

import {
  createPrompt,
  FORBIDDEN_V2_KEYS,
  SYSTEM_PROMPT_V2,
  validateV2Output,
} from "./provider/risk-output-contract.js";
import type { ModelAdapter } from "./provider/model-adapter.js";
import { SiliconFlowAdapter } from "../../scripts/siliconflow-adapter.js";
import type {
  AiExplanationInput,
  AiExplanationOutput,
  RiskExplanationAnalyzer,
} from "./explanation-types.js";
import { normalizeRiskOutput } from "./risk-output-normalizer.js";

export class AiProviderTimeoutError extends Error {
  readonly code = "AI_PROVIDER_TIMEOUT";

  constructor() {
    super("AI risk explanation service timed out.");
    this.name = "AiProviderTimeoutError";
  }
}

export function readReportModel(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const model = environment.AI_MODEL_OVERRIDE?.trim() || environment.AI_MODEL?.trim();
  if (!model) {
    throw new Error("Missing AI_MODEL environment variable.");
  }
  return model;
}

interface AiProviderLogger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * Adapts the existing SiliconFlow test adapter for the production report path.
 * It delegates model transport to the existing adapter and enforces V2-safe output.
 */
export class SiliconFlowRiskAnalyzer implements RiskExplanationAnalyzer {
  constructor(
    private readonly adapter: ModelAdapter | undefined = undefined,
    private readonly model?: string,
    private readonly logger: AiProviderLogger = console,
  ) {}

  async analyze(input: AiExplanationInput): Promise<AiExplanationOutput> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    let model = this.model;

    try {
      model ??= readReportModel();
      const testCase = {
        name: "project-report",
        filePath: "",
        input: input as unknown as Record<string, unknown>,
      };
      const prompt = createPrompt(testCase);
      const inputSizeBytes = byteLength(SYSTEM_PROMPT_V2) + byteLength(prompt);
      this.logger.info(
        JSON.stringify({
          event: "ai_provider_started",
          requestId,
          stage: "ai-provider",
          model,
          elapsedMs: 0,
          inputSizeBytes,
        }),
      );

      const adapter = this.adapter ?? new SiliconFlowAdapter();
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await adapter.invoke({
          model,
          systemPrompt: SYSTEM_PROMPT_V2,
          prompt,
          testCase,
        });

        logResponseFormatDiagnostic(this.logger, response.response);
        try {
          const output = normalizeProviderOutput(response.response, input, (strippedKeyCount) => {
            this.logger.info(
              JSON.stringify({
                event: "ai_output_contract_sanitized",
                requestId,
                stage: "ai-output",
                model,
                attempt,
                outcome: "sanitized",
                strippedKeyCount,
              }),
            );
          });
          this.logger.info(
            JSON.stringify({
              event: "ai_provider_completed",
              requestId,
              stage: "ai-provider",
              model,
              attempt,
              elapsedMs: Date.now() - startedAt,
              outputSizeBytes: byteLength(response.response),
              outcome: "success",
            }),
          );
          return output;
        } catch (error) {
          if (!(error instanceof AiOutputContractError) || attempt === 3) throw error;
          this.logger.info(
            JSON.stringify({
              event: "ai_output_contract_retry",
              requestId,
              stage: "ai-output",
              model,
              attempt,
              outcome: "retry",
            }),
          );
          if (error.violations.length > 0) {
            this.logger.info(
              JSON.stringify({
                event: "ai_output_contract_violation",
                requestId,
                stage: "ai-output",
                model,
                attempt,
                outcome: "violation",
                violationCount: error.violations.length,
              }),
            );
          }
        }
      }
      throw new AiOutputContractError();
    } catch (error) {
      const categorizedError = isProviderTimeoutError(error)
        ? new AiProviderTimeoutError()
        : error;
      this.logger.error(
        JSON.stringify({
          event: "ai_provider_completed",
          requestId,
          stage: "ai-provider",
          model: model ?? "unconfigured",
          elapsedMs: Date.now() - startedAt,
          outcome: "failure",
          errorCategory:
            categorizedError instanceof AiProviderTimeoutError
              ? "AI_PROVIDER_TIMEOUT"
              : categorizedError instanceof AiOutputContractError
                ? "AI_OUTPUT_CONTRACT_INVALID"
                : "AI_PROVIDER_FAILED",
        }),
      );
      throw categorizedError;
    }
  }
}

function normalizeProviderOutput(
  response: unknown,
  input: AiExplanationInput,
  onSanitized?: (strippedKeyCount: number) => void,
): AiExplanationOutput {
  let effectiveResponse: unknown = response;
  const rawValidation = validateV2Output(response);
  if (!rawValidation.valid) {
    const sanitized = tryStripExtraTopLevelKeys(response, rawValidation.violations);
    if (!sanitized) {
      throw new AiOutputContractError(
        "AI output failed V2 validation.",
        rawValidation.violations,
      );
    }
    onSanitized?.(sanitized.strippedKeys.length);
    effectiveResponse = sanitized.value;
  }

  let output: AiExplanationOutput;
  try {
    output = normalizeRiskOutput(effectiveResponse, input);
  } catch {
    throw new AiOutputContractError(
      "AI output contains an invalid risk explanation.",
    );
  }
  const normalizedValidation = validateV2Output(output);
  if (!normalizedValidation.valid) {
    throw new AiOutputContractError(
      "Normalized AI output failed V2 validation.",
      normalizedValidation.violations,
    );
  }
  return output;
}

/**
 * Strips extra top-level keys only when the sole raw-validation violations are
 * those keys and none of them is a forbidden system-owned key. Forbidden keys,
 * JSON structure errors, and nested violations always fail closed.
 */
function tryStripExtraTopLevelKeys(
  response: unknown,
  violations: string[],
): { value: Record<string, unknown>; strippedKeys: string[] } | undefined {
  let parsed: unknown = response;
  if (typeof response === "string") {
    try {
      parsed = JSON.parse(response) as unknown;
    } catch {
      return undefined;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;

  const strippable = new Set<string>();
  for (const violation of violations) {
    const match = /^forbidden top-level field: (.+)$/u.exec(violation);
    const key = match?.[1];
    if (!key || FORBIDDEN_V2_KEYS.has(key)) return undefined;
    strippable.add(key);
  }
  if (strippable.size === 0) return undefined;

  const value: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (!strippable.has(key)) value[key] = child;
  }
  const revalidation = validateV2Output(value);
  if (!revalidation.valid) return undefined;
  return { value, strippedKeys: [...strippable] };
}

function logResponseFormatDiagnostic(logger: AiProviderLogger, value: unknown): void {
  if (typeof value !== "string") return;

  try {
    JSON.parse(value);
    return;
  } catch (error) {
    logger.error(
      JSON.stringify({
        event: "ai_output_parse_diagnostic",
        stage: "ai-output",
        contentLength: value.length,
        containsMarkdownCodeFence: /```(?:json)?/iu.test(value),
        parseErrorType: error instanceof Error ? error.name : "UnknownError",
        responseStructurePreview: summarizeUnparseableResponse(value),
      }),
    );
  }
}

class AiOutputContractError extends Error {
  readonly violations: string[];

  constructor(message = "AI output did not satisfy the explanation contract.", violations: string[] = []) {
    super(message);
    this.name = "AiOutputContractError";
    this.violations = violations;
  }
}

function summarizeUnparseableResponse(value: string): Record<string, unknown> {
  return {
    kind: "invalid-json-text",
    lineCount: value.split(/\r?\n/u).length,
    hasObjectStart: value.includes("{"),
    hasObjectEnd: value.includes("}"),
    hasArrayStart: value.includes("["),
    hasArrayEnd: value.includes("]"),
    stringLiteralCount: (value.match(/"(?:\\.|[^"\\])*"/gu) ?? []).length,
    stringValues: "[REDACTED_STRING_VALUES]",
  };
}

function byteLength(value: unknown): number {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.byteLength(serialized ?? "", "utf8");
}

function isProviderTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  return (
    error.name === "TimeoutError" ||
    (error.name === "AbortError" && /timeout/iu.test(error.message)) ||
    /aborted due to timeout/iu.test(error.message)
  );
}
