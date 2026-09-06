import assert from "node:assert/strict";
import test from "node:test";

import {
  createAiProviderBundle,
  normalizeCustomChatCompletionsUrl,
  readAiProviderId,
  readDashScopeConfig,
  readDashScopeModel,
  readOpenAiCompatibleConfig,
  OpenAiCompatibleAdapter,
} from "../ai-service/src/provider/index.js";
import { readDeepSeekConfig } from "../scripts/deepseek-adapter.js";

test("DeepSeek official endpoint requires a full new URL and normalizes the legacy base URL", () => {
  assert.equal(
    readDeepSeekConfig({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_COMPLETIONS_URL: "https://api.deepseek.com/chat/completions",
    }).endpoint,
    "https://api.deepseek.com/chat/completions",
  );
  assert.equal(
    readDeepSeekConfig({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/v1/",
    }).endpoint,
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.throws(
    () => readDeepSeekConfig({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_COMPLETIONS_URL: "https://api.deepseek.com",
    }),
    /complete \/chat\/completions URL/,
  );
  assert.throws(
    () => readDeepSeekConfig({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_COMPLETIONS_URL: "https://deepseek.example.com/v1",
    }),
    /official DeepSeek host/,
  );
  assert.throws(
    () => readDeepSeekConfig({
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_CHAT_COMPLETIONS_URL: "https://user:password@api.deepseek.com/v1",
    }),
    /must not contain URL credentials/,
  );
});

test("DashScope preset accepts official hosts only", () => {
  assert.equal(
    readDashScopeConfig({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_CHAT_COMPLETIONS_URL:
        "https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
    }).endpoint,
    "https://workspace-id.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.throws(
    () => readDashScopeConfig({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_CHAT_COMPLETIONS_URL: "https://maas.aliyuncs.com.example.test/v1",
    }),
    /official DashScope host/,
  );
  assert.throws(
    () => readDashScopeConfig({
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_CHAT_COMPLETIONS_URL: "http://dashscope.aliyuncs.com/v1",
    }),
    /must use HTTPS/,
  );
});

test("Qwen preset defaults to qwen3.8-flash", () => {
  assert.equal(readDashScopeModel({}), "qwen3.8-flash");
});

test("custom endpoint allows HTTPS and localhost HTTP but rejects remote HTTP and credentials", () => {
  assert.equal(
    normalizeCustomChatCompletionsUrl(
      "https://models.example.test/v1/chat/completions",
      "TEST_URL",
    ),
    "https://models.example.test/v1/chat/completions",
  );
  assert.equal(
    normalizeCustomChatCompletionsUrl(
      "http://127.0.0.1:11434/v1/chat/completions",
      "TEST_URL",
    ),
    "http://127.0.0.1:11434/v1/chat/completions",
  );
  assert.equal(
    normalizeCustomChatCompletionsUrl(
      "http://[::1]:11434/v1/chat/completions",
      "TEST_URL",
    ),
    "http://[::1]:11434/v1/chat/completions",
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl(
      "https://models.example.test/v1",
      "TEST_URL",
    ),
    /complete \/chat\/completions URL/,
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl("http://models.example.test/v1", "TEST_URL"),
    /HTTPS, except for localhost HTTP/,
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl(
      "https://user:password@models.example.test/v1",
      "TEST_URL",
    ),
    /must not contain URL credentials/,
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl(
      "https://models.example.test/v1/chat/completions?api-version=test",
      "TEST_URL",
    ),
    /must not contain query parameters/,
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl(
      "https://models.example.test/v1/chat/completions#fragment",
      "TEST_URL",
    ),
    /must not contain query parameters/,
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl(
      "https://models.example.test/v1/chat/completions?",
      "TEST_URL",
    ),
    /must not contain query parameters/,
  );
  assert.throws(
    () => normalizeCustomChatCompletionsUrl(
      "https://models.example.test/v1/chat/completions#",
      "TEST_URL",
    ),
    /must not contain query parameters/,
  );
});

test("Qwen preset shapes non-thinking JSON requests with max_completion_tokens", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  const bundle = createAiProviderBundle(
    {
      AI_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_MODEL: "qwen-plus",
      DASHSCOPE_CHAT_COMPLETIONS_URL:
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    },
    {
      fetchImpl: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const userPrompt = String(
          (body.messages as Array<{ content: string }> | undefined)?.[1]?.content,
        );
        const content = userPrompt.startsWith("以下是已完成确定性排序")
          ? { summary: "暂无风险", priorities: [], limitations: [] }
          : { risks: [], limitations: [] };
        return new Response(JSON.stringify({
          model: "qwen-plus",
          choices: [{ message: { content: JSON.stringify(content) } }],
        }), { status: 200 });
      },
      now: () => 0,
      transportLogger: { error() {} },
      serviceLogger: { info() {}, error() {} },
    },
  );

  await bundle.riskAnalyzer.analyze({
    projectName: "Synthetic Project",
    riskSignals: [],
    riskContexts: [],
    limitations: [],
  });
  await bundle.globalSynthesizer.synthesize({ insights: [], partialFailure: false });

  assert.equal(bundle.providerId, "qwen");
  assert.equal(bodies.length, 2);
  for (const body of bodies) {
    assert.equal(body.model, "qwen-plus");
    assert.equal(body.enable_thinking, false);
    assert.equal(body.max_completion_tokens, 3_072);
    assert.equal("max_tokens" in body, false);
    assert.deepEqual(body.response_format, { type: "json_object" });
  }
});

test("Qwen preset rejects output that violates the risk explanation contract", async () => {
  let attempts = 0;
  const bundle = createAiProviderBundle(
    {
      AI_PROVIDER: "qwen",
      DASHSCOPE_API_KEY: "test-key",
      DASHSCOPE_MODEL: "qwen-plus",
      DASHSCOPE_CHAT_COMPLETIONS_URL:
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    },
    {
      fetchImpl: async () => {
        attempts += 1;
        return new Response(JSON.stringify({
          model: "qwen-plus",
          choices: [{ message: { content: JSON.stringify({ risks: "invalid" }) } }],
        }), { status: 200 });
      },
      now: () => 0,
      transportLogger: { error() {} },
      serviceLogger: { info() {}, error() {} },
    },
  );

  await assert.rejects(
    () => bundle.riskAnalyzer.analyze({
      projectName: "Synthetic Project",
      riskSignals: [],
      riskContexts: [],
      limitations: [],
    }),
    /AI output failed V2 validation/,
  );
  assert.equal(attempts, 3);
});

test("custom provider supports optional JSON mode and token-limit field", async () => {
  let body: Record<string, unknown> | undefined;
  const config = readOpenAiCompatibleConfig({
    OPENAI_COMPATIBLE_API_KEY: "test-key",
    OPENAI_COMPATIBLE_MODEL: "custom-model",
    OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL:
      "https://models.example.test/v1/chat/completions",
    OPENAI_COMPATIBLE_JSON_MODE: "none",
    OPENAI_COMPATIBLE_TOKEN_LIMIT_FIELD: "max_completion_tokens",
  });
  const adapter = new OpenAiCompatibleAdapter(
    config,
    async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        model: "custom-model",
        choices: [{ message: { content: "plain response" } }],
      }), { status: 200 });
    },
    () => 0,
    { error() {} },
  );

  await adapter.invoke({
    model: "custom-model",
    systemPrompt: "system",
    prompt: "user",
    testCase: { name: "custom", filePath: "", input: {} },
  });

  assert.equal(body?.max_completion_tokens, 3_072);
  assert.equal("max_tokens" in (body ?? {}), false);
  assert.equal("response_format" in (body ?? {}), false);
});

test("explicit provider selection never falls back across providers", async () => {
  assert.equal(readAiProviderId({}), "deepseek");
  assert.equal(readAiProviderId({ AI_PROVIDER: "siliconflow" }), "openai-compatible");
  assert.throws(
    () => readAiProviderId({ AI_PROVIDER: "unknown-provider" }),
    /Unsupported AI_PROVIDER/,
  );

  const defaultProvider = createAiProviderBundle({
    SILICONFLOW_API_KEY: "legacy-key-must-not-select-a-provider",
  });
  assert.equal(defaultProvider.providerId, "deepseek");
  await assert.rejects(
    () => defaultProvider.modelAdapter.invoke({
      model: defaultProvider.model,
      systemPrompt: "Return JSON.",
      prompt: "{}",
      testCase: { name: "default-does-not-auto-select", filePath: "", input: {} },
    }),
    /Missing DEEPSEEK_API_KEY/,
  );

  const qwen = createAiProviderBundle({
    AI_PROVIDER: "qwen",
    DEEPSEEK_API_KEY: "must-not-be-used",
  });
  await assert.rejects(
    () => qwen.modelAdapter.invoke({
      model: qwen.model,
      systemPrompt: "Return JSON.",
      prompt: "{}",
      testCase: { name: "no-fallback", filePath: "", input: {} },
    }),
    /Missing DASHSCOPE_API_KEY/,
  );

  assert.throws(
    () => readOpenAiCompatibleConfig({
      SILICONFLOW_API_KEY: "legacy-key-must-not-be-mixed",
      SILICONFLOW_BASE_URL: "https://api.siliconflow.cn/v1/chat/completions",
    }),
    /Missing OPENAI_COMPATIBLE_API_KEY/,
  );

  const legacySiliconFlow = createAiProviderBundle({
    AI_PROVIDER: "siliconflow",
    SILICONFLOW_API_KEY: "legacy-key",
    AI_MODEL: "legacy-model",
  }, {
    fetchImpl: async () => new Response(JSON.stringify({
      model: "legacy-model",
      choices: [{ message: { content: '{"risks":[],"limitations":[]}' } }],
    }), { status: 200 }),
    now: () => 0,
    transportLogger: { error() {} },
    serviceLogger: { info() {}, error() {} },
  });
  assert.equal(legacySiliconFlow.displayName, "SiliconFlow (legacy)");
  assert.equal(legacySiliconFlow.model, "legacy-model");
  await legacySiliconFlow.modelAdapter.invoke({
    model: legacySiliconFlow.model,
    systemPrompt: "Return JSON.",
    prompt: "{}",
    testCase: { name: "explicit-legacy-provider", filePath: "", input: {} },
  });
});
