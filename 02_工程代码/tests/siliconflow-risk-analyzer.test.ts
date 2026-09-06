import assert from "node:assert/strict";
import test from "node:test";

import { AiProviderTimeoutError, readReportModel, SiliconFlowRiskAnalyzer } from "../ai-service/src/siliconflow-risk-analyzer.js";
import { readSiliconFlowConfig, SiliconFlowAdapter } from "../scripts/siliconflow-adapter.js";
import type { ModelAdapter } from "../scripts/ai-model-test.js";

test("SiliconFlow risk analyzer delegates to the existing adapter and returns V2 output", async () => {
  let requestedModel = "";
  const adapter: ModelAdapter = {
    invoke: async (request) => {
      requestedModel = request.model;
      return {
        model: request.model,
        response: JSON.stringify({
          risks: [
            {
              id: "risk-1",
              title: "TASK_OVERDUE",
              evidenceRefs: ["signal-1"],
              reason: "任务已超过截止日期。",
              impact: "可能影响后续计划。",
              suggestedActions: ["确认新的交付安排。"],
            },
          ],
          limitations: ["仅基于输入证据。"],
        }),
        latency: 0,
        tokenUsage: null,
        timestamp: "2026-08-22T00:00:00.000Z",
      };
    },
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "test-model");

  const output = await analyzer.analyze({
    projectName: "Echo Project",
    riskSignals: [
      {
        signalId: "signal-1",
        type: "TASK_OVERDUE",
      },
    ],
    riskContexts: [
      {
        signalId: "signal-1",
        type: "TASK_OVERDUE",
        primaryTask: null,
        relatedTasks: [],
        factualEvidence: ["截止日期已过。"],
        dataLimitations: [],
      },
    ],
    limitations: [],
  });

  assert.equal(requestedModel, "test-model");
  assert.deepEqual(Object.keys(output).sort(), ["limitations", "risks"]);
  assert.equal(output.risks[0]?.title, "TASK_OVERDUE");
});

test("DeepSeek contract failures retry once and accept a valid second response", async () => {
  let attempts = 0;
  const logs: string[] = [];
  const validResponse = JSON.stringify({
    risks: [{
      id: "signal-1",
      title: "TASK_OVERDUE",
      evidenceRefs: ["signal-1"],
      reason: "任务已超过截止日期。",
      impact: "可能影响后续计划。",
      suggestedActions: ["确认新的交付安排。"],
    }],
    limitations: ["仅基于输入证据。"],
  });
  const adapter: ModelAdapter = {
    invoke: async (request) => {
      attempts += 1;
      return {
        model: request.model,
        response: attempts === 1 ? "not-valid-json" : validResponse,
        latency: 0,
        tokenUsage: null,
        timestamp: "2026-09-02T00:00:00.000Z",
      };
    },
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "deepseek-v4-flash", {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });

  const output = await analyzer.analyze(normalizationInput);

  assert.equal(attempts, 2);
  assert.equal(output.risks[0]?.id, "signal-1");
  const entries = logs.map((message) => JSON.parse(message) as Record<string, unknown>);
  assert.deepEqual(entries.filter((entry) => entry.event === "ai_output_contract_retry"), [{
    event: "ai_output_contract_retry",
    requestId: entries[0]?.requestId,
    stage: "ai-output",
    model: "deepseek-v4-flash",
    attempt: 1,
    outcome: "retry",
  }]);
  assert.equal(entries.at(-1)?.outcome, "success");
  assert.equal(entries.at(-1)?.attempt, 2);
});

test("report model selection reads AI_MODEL and preserves provider switching", () => {
  assert.equal(
    readReportModel({ AI_MODEL: "deepseek-ai/DeepSeek-V3" }),
    "deepseek-ai/DeepSeek-V3",
  );
  assert.equal(
    readReportModel({ AI_MODEL: "Qwen/Qwen2.5-72B-Instruct-128K" }),
    "Qwen/Qwen2.5-72B-Instruct-128K",
  );
  assert.throws(() => readReportModel({}), /Missing AI_MODEL/);
});

test("report model selection uses AI_MODEL_OVERRIDE only when provided", () => {
  assert.equal(
    readReportModel({ AI_MODEL: "deepseek-ai/DeepSeek-V3" }),
    "deepseek-ai/DeepSeek-V3",
  );
  assert.equal(
    readReportModel({
      AI_MODEL: "deepseek-ai/DeepSeek-V3",
      AI_MODEL_OVERRIDE: "Qwen/Qwen2.5-72B-Instruct-128K",
    }),
    "Qwen/Qwen2.5-72B-Instruct-128K",
  );
});

const normalizationInput = {
  projectName: "Echo Project",
  riskSignals: [
    {
      signalId: "signal-1",
      type: "TASK_OVERDUE",
    },
  ],
  riskContexts: [
    {
      signalId: "signal-1",
      type: "TASK_OVERDUE",
      primaryTask: null,
      relatedTasks: [],
      factualEvidence: ["截止日期已过。"],
      dataLimitations: [],
    },
  ],
  limitations: [],
};

function createNormalizationAnalyzer(response: unknown): SiliconFlowRiskAnalyzer {
  const adapter: ModelAdapter = {
    invoke: async (request) => ({
      model: request.model,
      response,
      latency: 0,
      tokenUsage: null,
      timestamp: "2026-08-23T00:00:00.000Z",
    }),
  };
  return new SiliconFlowRiskAnalyzer(adapter, "test-model");
}

function createNormalizationResponse(risk: Record<string, unknown>): string {
  return JSON.stringify({
    risks: [risk],
    limitations: ["仅基于输入证据。"],
  });
}

function completeNormalizationRisk(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "risk-1",
    title: "TASK_OVERDUE",
    evidenceRefs: ["signal-1"],
    reason: "任务已超过截止日期。",
    impact: "可能影响后续计划。",
    suggestedActions: ["确认新的交付安排。"],
    ...overrides,
  };
}

test("normalizes a complete provider output into the canonical risk structure", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk()),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.deepEqual(output.risks[0], {
    id: "signal-1",
    title: "TASK_OVERDUE",
    evidenceRefs: ["signal-1"],
    reason: "任务已超过截止日期。",
    impact: "可能影响后续计划。",
    suggestedActions: ["确认新的交付安排。"],
  });
});

test("normalizes a missing id from a uniquely authorized evidence reference", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk({ id: undefined })),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.equal(output.risks[0]?.id, "signal-1");
});

test("normalizes a missing title from a uniquely authorized evidence reference", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk({ title: undefined })),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.equal(output.risks[0]?.title, "TASK_OVERDUE");
});

test("rejects evidence references that cannot match an authorized signal", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk({ evidenceRefs: ["unknown"] })),
  );

  await assert.rejects(analyzer.analyze(normalizationInput), /invalid risk explanation/);
});

test("rejects a risk explanation without reason", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk({ reason: undefined })),
  );

  await assert.rejects(analyzer.analyze(normalizationInput), /invalid risk explanation/);
});

test("rejects a risk explanation without impact", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk({ impact: undefined })),
  );

  await assert.rejects(analyzer.analyze(normalizationInput), /invalid risk explanation/);
});

test("rejects suggestedActions with an invalid type", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(
      completeNormalizationRisk({ suggestedActions: "确认新的交付安排。" }),
    ),
  );

  await assert.rejects(analyzer.analyze(normalizationInput), /invalid risk explanation/);
});

test("rejects forbidden rule fields before normalization", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(completeNormalizationRisk({ healthScore: 80 })),
  );

  await assert.rejects(analyzer.analyze(normalizationInput), /AI output failed V2 validation/);
});

test("normalizes approved provider field aliases", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse({
      riskId: "signal-1",
      name: "TASK_OVERDUE",
      evidence_refs: ["signal-1"],
      reason: "任务已超过截止日期。",
      impact: "可能影响后续计划。",
      suggested_actions: ["确认新的交付安排。"],
    }),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.deepEqual(output.risks[0], {
    id: "signal-1",
    title: "TASK_OVERDUE",
    evidenceRefs: ["signal-1"],
    reason: "任务已超过截止日期。",
    impact: "可能影响后续计划。",
    suggestedActions: ["确认新的交付安排。"],
  });
});

test("SiliconFlow config defaults to 30 seconds and caps longer values", () => {
  assert.equal(
    readSiliconFlowConfig({ SILICONFLOW_API_KEY: "test-key" }).timeoutMs,
    30_000,
  );
  assert.equal(
    readSiliconFlowConfig({
      SILICONFLOW_API_KEY: "test-key",
      SILICONFLOW_TIMEOUT_MS: "60000",
    }).timeoutMs,
    35_000,
  );
});

test("SiliconFlow risk analyzer classifies provider timeout errors", async () => {
  const logs: string[] = [];
  const adapter: ModelAdapter = {
    invoke: async () => {
      const error = new Error("The operation was aborted due to timeout");
      error.name = "TimeoutError";
      throw error;
    },
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "test-model", {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });

  await assert.rejects(
    analyzer.analyze(normalizationInput),
    (error: unknown) => error instanceof AiProviderTimeoutError && error.code === "AI_PROVIDER_TIMEOUT",
  );

  const failureLog = logs.map((message) => JSON.parse(message) as Record<string, unknown>).at(-1);
  assert.equal(failureLog?.model, "test-model");
  assert.equal(failureLog?.errorCategory, "AI_PROVIDER_TIMEOUT");
});

test("SiliconFlow risk analyzer logs safe model and payload size metadata", async () => {
  const logs: string[] = [];
  const response = createNormalizationResponse(completeNormalizationRisk());
  const adapter: ModelAdapter = {
    invoke: async (request) => ({
      model: request.model,
      response,
      latency: 0,
      tokenUsage: null,
      timestamp: "2026-08-23T00:00:00.000Z",
    }),
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "diagnostic-model", {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });

  await analyzer.analyze(normalizationInput);

  const entries = logs.map((message) => JSON.parse(message) as Record<string, unknown>);
  assert.equal(entries[0]?.event, "ai_provider_started");
  assert.equal(entries[0]?.model, "diagnostic-model");
  assert.equal(entries[0]?.elapsedMs, 0);
  assert.ok(Number(entries[0]?.inputSizeBytes) > 0);
  assert.equal(entries[1]?.event, "ai_provider_completed");
  assert.equal(entries[1]?.model, "diagnostic-model");
  assert.ok(Number(entries[1]?.outputSizeBytes) > 0);
  assert.ok(Number(entries[1]?.elapsedMs) >= 0);
  assert.equal(logs.join("\n").includes(normalizationInput.projectName), false);
  assert.equal(
    logs.join("\n").includes(normalizationInput.riskContexts[0]!.factualEvidence[0]!),
    false,
  );
});

test("AI response parse diagnostics expose structure without response content", async () => {
  const logs: string[] = [];
  const response = "\n```json\nnot-json-project-data";
  const adapter: ModelAdapter = {
    invoke: async (request) => ({
      model: request.model,
      response,
      latency: 0,
      tokenUsage: null,
      timestamp: "2026-08-24T00:00:00.000Z",
    }),
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "diagnostic-model", {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });

  await assert.rejects(
    analyzer.analyze(normalizationInput),
    /AI output failed V2 validation/,
  );

  const entries = logs.map((message) => JSON.parse(message) as Record<string, unknown>);
  const diagnostic = entries.find((entry) => entry.event === "ai_output_parse_diagnostic");
  assert.ok(diagnostic);
  assert.equal(diagnostic?.contentLength, response.length);
  assert.equal(diagnostic?.containsMarkdownCodeFence, true);
  assert.equal(diagnostic?.parseErrorType, "SyntaxError");
  assert.equal("firstNonWhitespaceCharacter" in diagnostic!, false);
  assert.equal("parseError" in diagnostic!, false);
  assert.deepEqual(diagnostic?.responseStructurePreview, {
    kind: "invalid-json-text",
    lineCount: 3,
    hasObjectStart: false,
    hasObjectEnd: false,
    hasArrayStart: false,
    hasArrayEnd: false,
    stringLiteralCount: 0,
    stringValues: "[REDACTED_STRING_VALUES]",
  });
  assert.equal(logs.join("\n").includes("not-json-project-data"), false);
  assert.equal(logs.join("\n").includes(normalizationInput.projectName), false);
  assert.equal(
    logs.join("\n").includes(normalizationInput.riskContexts[0]!.factualEvidence[0]!),
    false,
  );
});
test("SiliconFlow adapter logs only HTTP response metadata without response contents", async () => {
  const logs: string[] = [];
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-api-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async () =>
      new Response('{"error":"unauthorized","token":"sensitive-token"}', {
        status: 401,
        headers: {
          "content-type": "application/json",
          "content-length": String('{"error":"unauthorized","token":"sensitive-token"}'.length),
        },
      }),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await assert.rejects(
    adapter.invoke({
      model: "test-model",
      systemPrompt: "system prompt",
      prompt: "user prompt",
      testCase: { name: "test", filePath: "", input: {} },
    }),
    /HTTP 401/,
  );

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "ai_provider_http_error");
  assert.equal(entry.status, 401);
  assert.equal(entry.endpointHostname, "api.deepseek.com");
  assert.equal(entry.contentType, "application/json");
  assert.equal(entry.bodyLength, '{"error":"unauthorized","token":"sensitive-token"}'.length);
  assert.equal("responseBodyPreview" in entry, false);
  assert.equal(logs.join("\n").includes("sensitive-token"), false);
  assert.equal(logs.join("\n").includes("test-api-key"), false);
  assert.equal(logs.join("\n").includes("user-prompt"), false);
});

test("SiliconFlow adapter cancels an HTTP error body without reading it", async () => {
  const logs: string[] = [];
  let bodyCancelled = false;
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "test-model",
      endpoint: "https://api.example.test/chat/completions",
      timeoutMs: 30_000,
    },
    async () => new Response(
      new ReadableStream({
        cancel: () => {
          bodyCancelled = true;
        },
      }),
      { status: 400 },
    ),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await assert.rejects(
    adapter.invoke({
      model: "test-model",
      systemPrompt: "system prompt",
      prompt: "user prompt",
      testCase: { name: "test", filePath: "", input: {} },
    }),
    /HTTP 400/,
  );

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.status, 400);
  assert.equal(entry.bodyLength, null);
  assert.equal("responseBodyPreview" in entry, false);
  assert.equal(bodyCancelled, true);
});

test("SiliconFlow adapter preserves successful response parsing", async () => {
  const logs: string[] = [];
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "test-model",
      endpoint: "https://api.example.test/chat/completions",
      timeoutMs: 30_000,
    },
    async () =>
      new Response(
        JSON.stringify({
          model: "test-model",
          choices: [{ message: { content: '{"risks":[],"limitations":[]}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  const result = await adapter.invoke({
    model: "test-model",
    systemPrompt: "system prompt",
    prompt: "user prompt",
    testCase: { name: "test", filePath: "", input: {} },
  });

  assert.equal(result.response, '{"risks":[],"limitations":[]}');
  assert.deepEqual(result.tokenUsage, {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 3,
  });
  assert.deepEqual(logs, []);
});

test("SiliconFlow adapter logs completion metadata for malformed assistant JSON", async () => {
  const logs: string[] = [];
  const malformedContent = '{"risks":[{"reason":"unterminated';
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "length", message: { content: malformedContent } }],
          usage: { prompt_tokens: 100, completion_tokens: 3_072, total_tokens: 3_172 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await adapter.invoke({
    model: "test-model",
    systemPrompt: "system prompt",
    prompt: "user prompt",
    testCase: { name: "test", filePath: "", input: {} },
  });

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "ai_provider_output_completion_diagnostic");
  assert.equal(entry.finishReason, "length");
  assert.equal(entry.completionTokens, 3_072);
  assert.equal(entry.maxTokens, 3_072);
  assert.equal(entry.jsonObjectClosed, false);
  assert.equal(logs.join("\n").includes(malformedContent), false);
  assert.equal(logs.join("\n").includes("test-key"), false);
});

test("SiliconFlow adapter disables DeepSeek thinking mode", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "deepseek-v4-flash",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "deepseek-v4-flash",
          choices: [{ message: { content: '{"risks":[],"limitations":[]}' } }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
    () => 0,
    { error: () => undefined },
  );

  const result = await adapter.invoke({
    model: "deepseek-v4-flash",
    systemPrompt: "system prompt",
    prompt: "user prompt",
    testCase: { name: "test", filePath: "", input: {} },
  });

  assert.equal(result.response, '{"risks":[],"limitations":[]}');
  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
  assert.equal(requestBody?.max_tokens, 3_072);
});
test("SiliconFlow adapter logs safe response structure when content is empty", async () => {
  const logs: string[] = [];
  const reasoning = "private reasoning content";
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "", reasoning_content: reasoning }, finish_reason: "stop" }],
          usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  const result = await adapter.invoke({
    model: "test-model",
    systemPrompt: "system prompt",
    prompt: "user prompt",
    testCase: { name: "test", filePath: "", input: {} },
  });
  assert.equal(result.response, "");

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "ai_provider_response_structure");
  assert.equal(entry.choicesLength, 1);
  assert.equal(entry.messageKeyCount, 2);
  assert.equal(entry.contentFieldPresent, true);
  assert.equal("messageKeys" in entry, false);
  assert.equal(entry.contentLength, 0);
  assert.equal(entry.reasoningContentPresent, true);
  assert.equal(entry.reasoningContentLength, reasoning.length);
  assert.equal(entry.finishReason, "stop");
  assert.equal(entry.usagePresent, true);
  assert.equal(logs.join("\n").includes(reasoning), false);
});

test("SiliconFlow adapter omits arbitrary message keys and normalizes unknown finish reasons", async () => {
  const logs: string[] = [];
  const maliciousMessageKey = "private-project-content-in-key";
  const maliciousFinishReason = "private-project-content-in-finish-reason";
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async () => new Response(JSON.stringify({
      choices: [{
        message: { content: "", [maliciousMessageKey]: "private-project-value" },
        finish_reason: maliciousFinishReason,
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await adapter.invoke({
    model: "test-model",
    systemPrompt: "system prompt",
    prompt: "user prompt",
    testCase: { name: "test", filePath: "", input: {} },
  });

  const entries = logs.map((message) => JSON.parse(message) as Record<string, unknown>);
  const structure = entries.find((entry) => entry.event === "ai_provider_response_structure");
  const completion = entries.find(
    (entry) => entry.event === "ai_provider_output_completion_diagnostic",
  );
  assert.ok(structure);
  assert.ok(completion);
  assert.equal(structure?.messageKeyCount, 2);
  assert.equal(structure?.contentFieldPresent, true);
  assert.equal(structure?.finishReason, "other");
  assert.equal("messageKeys" in structure!, false);
  assert.equal(completion?.finishReason, "other");
  const renderedLogs = logs.join("\n");
  assert.equal(renderedLogs.includes(maliciousMessageKey), false);
  assert.equal(renderedLogs.includes(maliciousFinishReason), false);
  assert.equal(renderedLogs.includes("private-project-value"), false);
});
test("SiliconFlow adapter logs JSON parse failure without response contents", async () => {
  const logs: string[] = [];
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-key",
      model: "test-model",
      endpoint: "https://api.example.test/chat/completions",
      timeoutMs: 30_000,
    },
    async () =>
      new Response("not-json-user-data", {
        status: 200,
        headers: { "content-type": "text/plain; private-project-content=secret-marker" },
      }),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await assert.rejects(
    adapter.invoke({
      model: "test-model",
      systemPrompt: "system prompt",
      prompt: "user prompt",
      testCase: { name: "test", filePath: "", input: {} },
    }),
    (error: unknown) => error instanceof Error
      && error.name === "AiProviderTransportError"
      && error.message === "SiliconFlow response could not be parsed."
      && !error.message.includes("not-json-user-data"),
  );

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "ai_provider_response_parse_failed");
  assert.equal(entry.parseErrorType, "SyntaxError");
  assert.deepEqual(entry.responseStructure, {
    contentType: "text/plain",
    bodyLength: "not-json-user-data".length,
  });
  assert.equal(logs.join("\n").includes("not-json-user-data"), false);
  assert.equal(logs.join("\n").includes("private-project-content"), false);
  assert.equal(logs.join("\n").includes("secret-marker"), false);
});

test("SiliconFlow adapter replaces fetch rejection details with a generic error", async () => {
  const logs: string[] = [];
  const originalError = new TypeError(
    "fetch failed for token=sensitive-token; prompt=user-prompt",
  );
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-api-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async () => {
      throw originalError;
    },
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await assert.rejects(
    adapter.invoke({
      model: "test-model",
      systemPrompt: "system prompt",
      prompt: "user prompt",
      testCase: { name: "test", filePath: "", input: {} },
    }),
    (error: unknown) => error instanceof Error
      && error !== originalError
      && error.name === "AiProviderTransportError"
      && error.message === "SiliconFlow request failed."
      && !error.message.includes("sensitive-token")
      && !error.message.includes("user-prompt"),
  );

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "ai_provider_fetch_failed");
  assert.equal(entry.errorName, "TypeError");
  assert.equal(entry.endpointHostname, "api.deepseek.com");
  assert.equal("errorMessage" in entry, false);
  assert.equal(logs.join("\n").includes("sensitive-token"), false);
  assert.equal(logs.join("\n").includes("user-prompt"), false);
  assert.equal(logs.join("\n").includes("test-api-key"), false);
});

test("SiliconFlow adapter preserves timeout classification without its original message", async () => {
  const logs: string[] = [];
  const timeout = new Error("timeout included token=sensitive-token");
  timeout.name = "TimeoutError";
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-api-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
      providerName: "DeepSeek",
    },
    async () => {
      throw timeout;
    },
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await assert.rejects(
    adapter.invoke({
      model: "test-model",
      systemPrompt: "system prompt",
      prompt: "user prompt",
      testCase: { name: "test", filePath: "", input: {} },
    }),
    (error: unknown) => error instanceof Error
      && error !== timeout
      && error.name === "TimeoutError"
      && error.message === "DeepSeek request timed out."
      && !error.message.includes("sensitive-token"),
  );
  assert.equal(logs.join("\n").includes("sensitive-token"), false);
  assert.equal(logs.join("\n").includes("test-api-key"), false);
});

const twoSignalNormalizationInput = {
  projectName: "Echo Project",
  riskSignals: [
    { signalId: "signal-1", type: "TASK_OVERDUE" },
    { signalId: "signal-2", type: "TASK_BLOCKED" },
  ],
  riskContexts: [
    {
      signalId: "signal-1",
      type: "TASK_OVERDUE",
      primaryTask: null,
      relatedTasks: [],
      factualEvidence: [],
      dataLimitations: [],
    },
    {
      signalId: "signal-2",
      type: "TASK_BLOCKED",
      primaryTask: null,
      relatedTasks: [],
      factualEvidence: [],
      dataLimitations: [],
    },
  ],
  limitations: [],
};

test("accepts multiple evidence references that resolve to the same authorized signal", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(
      completeNormalizationRisk({ evidenceRefs: ["signal-1", "signal-1"] }),
    ),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.deepEqual(output.risks[0]?.evidenceRefs, ["signal-1"]);
});

test("rejects evidence references that resolve to different authorized signals", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(
      completeNormalizationRisk({ evidenceRefs: ["signal-1", "signal-2"] }),
    ),
  );

  await assert.rejects(
    analyzer.analyze(twoSignalNormalizationInput),
    /invalid risk explanation/,
  );
});

test("accepts canonical and alias keys when their values are equal", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse({
      id: "signal-1",
      riskId: "signal-1",
      title: "TASK_OVERDUE",
      name: "TASK_OVERDUE",
      evidenceRefs: ["signal-1"],
      evidence_refs: ["signal-1"],
      reason: "任务已超过截止日期。",
      impact: "可能影响后续计划。",
      suggestedActions: ["确认新的交付安排。"],
      suggested_actions: ["确认新的交付安排。"],
    }),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.deepEqual(output.risks[0], {
    id: "signal-1",
    title: "TASK_OVERDUE",
    evidenceRefs: ["signal-1"],
    reason: "任务已超过截止日期。",
    impact: "可能影响后续计划。",
    suggestedActions: ["确认新的交付安排。"],
  });
});

test("rejects canonical and alias keys when their values disagree", async () => {
  const analyzer = createNormalizationAnalyzer(
    createNormalizationResponse(
      completeNormalizationRisk({
        suggestedActions: ["确认新的交付安排。"],
        suggested_actions: ["补充新的交付计划。"],
      }),
    ),
  );

  await assert.rejects(analyzer.analyze(normalizationInput), /invalid risk explanation/);
});

test("strips extra top-level keys and keeps a contract-valid payload", async () => {
  const analyzer = createNormalizationAnalyzer(
    JSON.stringify({
      risks: [completeNormalizationRisk()],
      limitations: ["仅基于输入证据。"],
      confidence: 0.9,
      summary: "模型附加说明",
    }),
  );

  const output = await analyzer.analyze(normalizationInput);

  assert.equal(output.risks[0]?.id, "signal-1");
});

test("rejects extra top-level keys that are forbidden system fields", async () => {
  const analyzer = createNormalizationAnalyzer(
    JSON.stringify({
      risks: [completeNormalizationRisk()],
      limitations: ["仅基于输入证据。"],
      riskLevel: "high",
    }),
  );

  await assert.rejects(
    analyzer.analyze(normalizationInput),
    /AI output failed V2 validation/,
  );
});

test("nested forbidden fields block sanitizing extra top-level keys", async () => {
  const analyzer = createNormalizationAnalyzer(
    JSON.stringify({
      risks: [completeNormalizationRisk({ healthStatus: "at-risk" })],
      limitations: ["仅基于输入证据。"],
      confidence: 0.9,
    }),
  );

  await assert.rejects(
    analyzer.analyze(normalizationInput),
    /AI output failed V2 validation/,
  );
});

test("accepts a valid third response after two contract failures", async () => {
  let attempts = 0;
  const adapter: ModelAdapter = {
    invoke: async (request) => {
      attempts += 1;
      return {
        model: request.model,
        response:
          attempts <= 2
            ? "not-valid-json"
            : createNormalizationResponse(completeNormalizationRisk()),
        latency: 0,
        tokenUsage: null,
        timestamp: "2026-09-03T00:00:00.000Z",
      };
    },
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "test-model");

  const output = await analyzer.analyze(normalizationInput);

  assert.equal(attempts, 3);
  assert.equal(output.risks[0]?.id, "signal-1");
});

test("gives up after three contract failures", async () => {
  let attempts = 0;
  const adapter: ModelAdapter = {
    invoke: async (request) => {
      attempts += 1;
      return {
        model: request.model,
        response: "not-valid-json",
        latency: 0,
        tokenUsage: null,
        timestamp: "2026-09-03T00:00:00.000Z",
      };
    },
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "test-model");

  await assert.rejects(
    analyzer.analyze(normalizationInput),
    /AI output failed V2 validation/,
  );
  assert.equal(attempts, 3);
});

test("logs only a sanitized key count without model-controlled key names", async () => {
  const logs: string[] = [];
  const maliciousKey = "private-project-content-in-key";
  const adapter: ModelAdapter = {
    invoke: async (request) => ({
      model: request.model,
      response: JSON.stringify({
        risks: [completeNormalizationRisk()],
        limitations: [],
        [maliciousKey]: "sensitive-marker",
      }),
      latency: 0,
      tokenUsage: null,
      timestamp: "2026-09-03T00:00:00.000Z",
    }),
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "test-model", {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });

  const output = await analyzer.analyze(normalizationInput);

  assert.equal(output.risks[0]?.id, "signal-1");
  const entries = logs.map((message) => JSON.parse(message) as Record<string, unknown>);
  const sanitized = entries.find((entry) => entry.event === "ai_output_contract_sanitized");
  assert.equal(sanitized?.strippedKeyCount, 1);
  assert.equal("strippedKeys" in sanitized!, false);
  assert.equal(logs.join("\n").includes(maliciousKey), false);
  assert.equal(logs.join("\n").includes("sensitive-marker"), false);
});

test("contract retries log only a violation count without model-controlled paths", async () => {
  let attempts = 0;
  const logs: string[] = [];
  const maliciousKey = "private-project-content-in-key";
  const adapter: ModelAdapter = {
    invoke: async (request) => {
      attempts += 1;
      return {
        model: request.model,
        response:
          attempts === 1
            ? JSON.stringify({
                risks: [{ [maliciousKey]: { status: "secret-marker" } }],
                limitations: [],
              })
            : createNormalizationResponse(completeNormalizationRisk()),
        latency: 0,
        tokenUsage: null,
        timestamp: "2026-09-03T00:00:00.000Z",
      };
    },
  };
  const analyzer = new SiliconFlowRiskAnalyzer(adapter, "test-model", {
    info: (message) => logs.push(message),
    error: (message) => logs.push(message),
  });

  await analyzer.analyze(normalizationInput);

  const entries = logs.map((message) => JSON.parse(message) as Record<string, unknown>);
  const violation = entries.find((entry) => entry.event === "ai_output_contract_violation");
  assert.ok(violation);
  assert.equal(violation?.violationCount, 1);
  assert.equal("violations" in violation!, false);
  assert.equal(logs.join("\n").includes(maliciousKey), false);
  assert.equal(logs.join("\n").includes("secret-marker"), false);
});

test("SiliconFlow adapter replaces response body read details with a generic error", async () => {
  const logs: string[] = [];
  const bodyError = new TypeError("response body read failed for prompt=user-prompt");
  const adapter = new SiliconFlowAdapter(
    {
      apiKey: "test-api-key",
      model: "test-model",
      endpoint: "https://api.deepseek.com/chat/completions",
      timeoutMs: 30_000,
    },
    async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw bodyError;
      },
    } as unknown as Response),
    () => 0,
    { error: (message) => logs.push(message) },
  );

  await assert.rejects(
    adapter.invoke({
      model: "test-model",
      systemPrompt: "system prompt",
      prompt: "user prompt",
      testCase: { name: "test", filePath: "", input: {} },
    }),
    (error: unknown) => error instanceof Error
      && error !== bodyError
      && error.name === "AiProviderTransportError"
      && error.message === "SiliconFlow response body could not be read."
      && !error.message.includes("user-prompt"),
  );

  const entry = JSON.parse(logs[0]!) as Record<string, unknown>;
  assert.equal(entry.event, "ai_provider_response_read_failed");
  assert.equal(entry.errorName, "TypeError");
  assert.equal(entry.endpointHostname, "api.deepseek.com");
  assert.equal("errorMessage" in entry, false);
  assert.equal(logs.join("\n").includes("user-prompt"), false);
  assert.equal(logs.join("\n").includes("test-api-key"), false);
});
