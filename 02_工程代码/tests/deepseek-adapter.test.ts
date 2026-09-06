import assert from "node:assert/strict";
import test from "node:test";

import { DeepSeekRiskAnalyzer } from "../ai-service/src/deepseek-risk-analyzer.js";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekAdapter,
  readDeepSeekConfig,
} from "../scripts/deepseek-adapter.js";
import type { ModelAdapter } from "../scripts/ai-model-test.js";

test("DeepSeek official config uses its own credential, endpoint, and V4 default", () => {
  const config = readDeepSeekConfig({ DEEPSEEK_API_KEY: "test-key" });
  assert.equal(config.model, DEFAULT_DEEPSEEK_MODEL);
  assert.equal(config.endpoint, "https://api.deepseek.com/chat/completions");
  assert.throws(() => readDeepSeekConfig({}), /Missing DEEPSEEK_API_KEY/);
});

test("DeepSeek new endpoint variable takes precedence over the legacy base URL", () => {
  const config = readDeepSeekConfig({
    DEEPSEEK_API_KEY: "test-key",
    DEEPSEEK_CHAT_COMPLETIONS_URL: "https://api.deepseek.com/v1/chat/completions",
    DEEPSEEK_BASE_URL: "https://api.deepseek.com/legacy",
  });
  assert.equal(config.endpoint, "https://api.deepseek.com/v1/chat/completions");
});

test("DeepSeek adapter sends a bounded non-thinking JSON request to the official endpoint", async () => {
  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const adapter = new DeepSeekAdapter(
    { apiKey: "test-key", model: "deepseek-v4-flash", endpoint: "https://api.deepseek.com/chat/completions", timeoutMs: 30_000 },
    async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "deepseek-v4-flash",
        choices: [{ message: { content: JSON.stringify({ risks: [], limitations: [] }) } }],
      }), { status: 200 });
    },
    () => 0,
    { error() {} },
  );

  await adapter.invoke({
    model: "deepseek-v4-flash",
    systemPrompt: "只返回 JSON。",
    prompt: "受限合成输入。",
    testCase: { name: "deepseek-test", filePath: "", input: {} },
  });

  assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(requestBody?.thinking, { type: "disabled" });
  assert.deepEqual(requestBody?.response_format, { type: "json_object" });
});

test("DeepSeek risk analyzer preserves the existing explanation-only normalizer contract", async () => {
  const adapter: ModelAdapter = {
    invoke: async (request) => ({
      model: request.model,
      response: JSON.stringify({
        risks: [{ id: "signal-1", title: "TASK_BLOCKED", evidenceRefs: ["signal-1"], reason: "结构化任务处于阻塞状态。", impact: "可能影响后续推进。", suggestedActions: ["确认阻塞解除条件。"] }],
        limitations: [],
      }),
      latency: 0,
      tokenUsage: null,
      timestamp: "2026-09-01T00:00:00.000Z",
    }),
  };
  const input = {
    projectName: "Synthetic Project",
    riskSignals: [{ signalId: "signal-1", type: "TASK_BLOCKED" }],
    riskContexts: [{ signalId: "signal-1", type: "TASK_BLOCKED", primaryTask: { name: "Synthetic task", status: "blocked", deadline: null }, relatedTasks: [], factualEvidence: ["Synthetic task is blocked."], dataLimitations: [] }],
    limitations: [],
  };
  const before = JSON.stringify(input);
  const output = await new DeepSeekRiskAnalyzer(adapter, "deepseek-v4-flash", { info() {}, error() {} }).analyze(input);

  assert.deepEqual(Object.keys(output).sort(), ["limitations", "risks"]);
  assert.equal(output.risks[0]?.title, "TASK_BLOCKED");
  assert.equal(JSON.stringify(input), before);
});
