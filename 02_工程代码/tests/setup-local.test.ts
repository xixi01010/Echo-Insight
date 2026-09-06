import assert from "node:assert/strict";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test, { type TestContext } from "node:test";

import {
  buildFeishuRedirectUri,
  collectProviderConfig,
  createEnvFileExclusive,
  generateVisitorAiAccountMasterKey,
  isSupportedNodeVersion,
  listTestFiles,
  normalizeFrontendOrigin,
  normalizeRuntimeDirectory,
  normalizeTimeout,
  probePort,
  renderFeishuPermissionChecklist,
  renderSetupEnv,
  runAllTests,
  runSetup,
  validateChatCompletionsUrl,
  verifyFeishuAppCredentials,
// @ts-ignore -- setup-local.mjs is intentionally a plain Node.js entrypoint.
} from "../scripts/setup-local.mjs";

async function makeTempDirectory(t: TestContext): Promise<string> {
  const prefix = join(tmpdir(), "echo-insight-setup-test-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    const target = resolve(directory);
    const safePrefix = resolve(tmpdir(), "echo-insight-setup-test-");
    assert.ok(target.startsWith(safePrefix));
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}

function deepSeekPrompter({
  aiLiveTest = false,
  feishuConfigured = true,
  feishuLiveTest = false,
} = {}) {
  return {
    write() {},
    async select(label: string) {
      assert.match(label, /Provider/u);
      return "deepseek";
    },
    async secret(label: string) {
      return /App Secret/u.test(label) ? "test-only-app-secret" : "test-only-api-key";
    },
    async input(label: string, defaultValue?: string) {
      if (/App ID/u.test(label)) return "cli_test_setup";
      if (/HTTPS Origin/u.test(label)) return "https://echo-insight.example.com";
      return defaultValue ?? "";
    },
    async confirm(label: string) {
      if (/已在飞书开放平台/u.test(label)) return feishuConfigured;
      if (/飞书 App 凭据/u.test(label)) return feishuLiveTest;
      return aiLiveTest;
    },
  };
}

test("Node version gate implements ^20.19.0 || >=22.12.0", () => {
  assert.equal(isSupportedNodeVersion("20.18.9"), false);
  assert.equal(isSupportedNodeVersion("20.19.0"), true);
  assert.equal(isSupportedNodeVersion("20.99.0"), true);
  assert.equal(isSupportedNodeVersion("21.7.0"), false);
  assert.equal(isSupportedNodeVersion("22.11.0"), false);
  assert.equal(isSupportedNodeVersion("22.12.0"), true);
  assert.equal(isSupportedNodeVersion("23.0.0"), true);
  assert.equal(isSupportedNodeVersion("invalid"), false);
});

test("timeout validation matches the runtime range of 1000 to 35000 ms", () => {
  assert.equal(normalizeTimeout("1000"), 1_000);
  assert.equal(normalizeTimeout("35000"), 35_000);
  assert.throws(() => normalizeTimeout("999"), /1000 到 35000/u);
  assert.throws(() => normalizeTimeout("35001"), /1000 到 35000/u);
  assert.throws(() => normalizeTimeout("1.5"), /1000 到 35000/u);
});

test("Feishu deployment values require a public HTTPS origin and absolute runtime directory", () => {
  assert.equal(
    normalizeFrontendOrigin("https://echo-insight.example.com/"),
    "https://echo-insight.example.com",
  );
  assert.equal(
    buildFeishuRedirectUri("https://echo-insight.example.com"),
    "https://echo-insight.example.com/api/auth/feishu/callback",
  );
  assert.throws(() => normalizeFrontendOrigin("http://echo-insight.example.test"), /HTTPS/u);
  assert.throws(() => normalizeFrontendOrigin("https://echo-insight.example.test/path"), /Origin/u);
  assert.throws(() => normalizeFrontendOrigin("https://echo-insight.example.test/?query=1"), /Origin/u);
  assert.throws(() => normalizeFrontendOrigin("https://localhost"), /公网主机/u);
  assert.throws(() => normalizeFrontendOrigin("https://192.168.1.20"), /公网主机/u);

  const absolute = resolve(".runtime", "setup-test");
  assert.equal(normalizeRuntimeDirectory(absolute), absolute);
  assert.throws(() => normalizeRuntimeDirectory("relative/runtime"), /绝对路径/u);
});

test("Feishu permission guide covers every current source and project-join authorization", () => {
  const guide = renderFeishuPermissionChecklist();
  for (const scope of [
    "offline_access",
    "bitable:app:readonly",
    "im:chat:readonly",
    "im:message:readonly",
    "im:message.group_msg",
    "task:task:readonly",
    "minutes:minutes.basic:read",
    "minutes:minutes.transcript:export",
    "minutes:minutes.artifacts:read",
    "docx:document:readonly",
    "wiki:wiki:readonly",
    "drive:drive.metadata:readonly",
    "calendar:calendar:readonly",
    "calendar:calendar.event:read",
    "docs:permission.member:auth",
  ]) {
    assert.ok(guide.includes(scope), `missing Feishu scope: ${scope}`);
  }
  assert.match(guide, /机器人/u);
  assert.match(guide, /目标 Base/u);
});

test("custom endpoint rejects credentials and insecure remote HTTP", () => {
  assert.equal(
    validateChatCompletionsUrl("http://127.0.0.1:11434/v1/chat/completions"),
    "http://127.0.0.1:11434/v1/chat/completions",
  );
  assert.equal(
    validateChatCompletionsUrl("https://models.example.test/v1/chat/completions"),
    "https://models.example.test/v1/chat/completions",
  );
  assert.throws(() => validateChatCompletionsUrl("http://models.example.test/v1/chat/completions"));
  assert.throws(() => validateChatCompletionsUrl("https://user:password@models.example.test/v1/chat/completions"));
  assert.throws(() => validateChatCompletionsUrl("https://models.example.test/v1/chat/completions?api-version=test"));
  assert.throws(() => validateChatCompletionsUrl("https://models.example.test/v1/chat/completions?"));
  assert.throws(() => validateChatCompletionsUrl("https://models.example.test/v1/chat/completions#"));
  assert.throws(() => validateChatCompletionsUrl("https://models.example.test/v1"));
});

test("complete setup environment contains Feishu deployment values and only the selected AI contract", () => {
  const content = renderSetupEnv({
    feishu: {
      appId: "cli_test_setup",
      appSecret: "test-only-app-secret",
      frontendOrigin: "https://echo-insight.example.com",
      redirectUri: "https://echo-insight.example.com/api/auth/feishu/callback",
      runtimeDirectory: resolve(".runtime", "setup-test"),
    },
    provider: {
      provider: "openai-compatible",
      apiKey: "test-only-api-key",
      model: "local-model",
      endpoint: "http://127.0.0.1:11434/v1/chat/completions",
      timeoutMs: 30_000,
      jsonMode: "none",
      tokenLimitField: "max_tokens",
    },
    visitorAiAccountMasterKey: Buffer.alloc(32, 1).toString("base64"),
  });
  assert.match(content, /^NODE_ENV="production"$/mu);
  assert.match(content, /^ECHO_INSIGHT_AI_ACCESS_MODE="server"$/mu);
  assert.match(content, /^FEISHU_APP_ID="cli_test_setup"$/mu);
  assert.match(content, /^FEISHU_APP_SECRET=/mu);
  assert.match(content, /^FEISHU_IDENTITY_REDIRECT_URI="https:\/\/echo-insight\.example\.com\/api\/auth\/feishu\/callback"$/mu);
  assert.match(content, /^FRONTEND_ORIGIN="https:\/\/echo-insight\.example\.com"$/mu);
  assert.match(content, /^ECHO_INSIGHT_RUNTIME_DIR=/mu);
  assert.match(content, /^ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY="[A-Za-z0-9+/]{43}="$/mu);
  assert.match(content, /^AI_PROVIDER="openai-compatible"$/mu);
  assert.match(content, /^OPENAI_COMPATIBLE_API_KEY=/mu);
  assert.match(content, /^OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL=/mu);
  assert.doesNotMatch(content, /VITE_|DASHSCOPE_|DEEPSEEK_|AI_API_KEY/u);
});

test("setup generates a canonical 32-byte visitor AI account master key", () => {
  const generated = generateVisitorAiAccountMasterKey(() => Buffer.alloc(32, 5));
  assert.equal(generated, Buffer.alloc(32, 5).toString("base64"));
  assert.throws(() => generateVisitorAiAccountMasterKey(() => Buffer.alloc(31)));
});

test("Qwen environment uses the DashScope server-side contract", () => {
  const content = renderSetupEnv({
    feishu: {
      appId: "cli_test_setup",
      appSecret: "test-only-app-secret",
      frontendOrigin: "https://echo-insight.example.com",
      redirectUri: "https://echo-insight.example.com/api/auth/feishu/callback",
      runtimeDirectory: resolve(".runtime", "setup-test"),
    },
    provider: {
      provider: "qwen",
      apiKey: "test-only-api-key",
      model: "qwen3.8-flash",
      endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
      timeoutMs: 30_000,
      tokenLimitField: "max_completion_tokens",
    },
  });
  assert.match(content, /^AI_PROVIDER="qwen"$/mu);
  assert.match(content, /^DASHSCOPE_API_KEY=/mu);
  assert.match(content, /^DASHSCOPE_MODEL="qwen3\.8-flash"$/mu);
  assert.match(content, /^DASHSCOPE_CHAT_COMPLETIONS_URL=/mu);
  assert.doesNotMatch(content, /OPENAI_COMPATIBLE_|DEEPSEEK_/u);
});

test("Qwen preset uses the Qianwen AI Platform endpoint without region or Workspace prompts", async () => {
  const prompts: string[] = [];
  const config = await collectProviderConfig({
    write(message: string) {
      prompts.push(message);
    },
    async select(label: string) {
      prompts.push(label);
      return "qwen";
    },
    async secret(label: string) {
      prompts.push(label);
      return "test-only-api-key";
    },
    async input(label: string, defaultValue?: string) {
      prompts.push(label);
      return defaultValue ?? "";
    },
  });

  assert.equal(config.model, "qwen3.8-flash");
  assert.equal(
    config.endpoint,
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
  );
  assert.doesNotMatch(prompts.join("\n"), /Workspace|地域/u);
});

test("Feishu credential verification checks only app credentials and never returns the token", async () => {
  let observedUrl = "";
  let observedBody = "";
  const status = await verifyFeishuAppCredentials(
    { appId: "cli_test_setup", appSecret: "test-only-app-secret" },
    async (input: URL | RequestInfo, init?: RequestInit) => {
      observedUrl = String(input);
      observedBody = String(init?.body);
      return new Response(JSON.stringify({
        code: 0,
        tenant_access_token: "test-only-tenant-token",
      }), { status: 200 });
    },
  );

  assert.equal(status, 200);
  assert.equal(
    observedUrl,
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
  );
  assert.deepEqual(JSON.parse(observedBody), {
    app_id: "cli_test_setup",
    app_secret: "test-only-app-secret",
  });
  assert.notEqual(status, "test-only-tenant-token");
});

test("Feishu credential verification errors never expose the App Secret", async () => {
  const appSecret = "test-only-app-secret";
  await assert.rejects(
    () => verifyFeishuAppCredentials(
      { appId: "cli_test_setup", appSecret },
      async () => new Response(JSON.stringify({ code: 10003 }), { status: 401 }),
    ),
    (error: Error) => {
      assert.match(error.message, /飞书 App 凭据验证未通过/u);
      assert.doesNotMatch(error.message, new RegExp(appSecret, "u"));
      return true;
    },
  );
});

test("installer source has no API that can read an existing env file", async () => {
  const source = await readFile(new URL("../scripts/setup-local.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:readFile|readFileSync|loadEnvFile)\b/u);
});

test("exclusive env creation never overwrites an existing file", async (t) => {
  const directory = await makeTempDirectory(t);
  const envPath = join(directory, ".env");
  const sentinel = "TEMP_TEST_SENTINEL=unchanged\n";
  await writeFile(envPath, sentinel, "utf8");

  assert.equal(createEnvFileExclusive(envPath, "replacement\n"), false);
  assert.equal(await readFile(envPath, "utf8"), sentinel);
});

test("test discovery recursively finds project tests and excludes generated trees", async (t) => {
  const directory = await makeTempDirectory(t);
  const testsDirectory = join(directory, "tests");
  await Promise.all([
    mkdir(join(testsDirectory, "nested"), { recursive: true }),
    mkdir(join(directory, "backend", "src"), { recursive: true }),
    mkdir(join(directory, "node_modules", "dependency"), { recursive: true }),
    mkdir(join(directory, "dist"), { recursive: true }),
    mkdir(join(directory, "coverage"), { recursive: true }),
    mkdir(join(directory, ".git"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(testsDirectory, "provider.test.ts"), "", "utf8"),
    writeFile(join(testsDirectory, "setup-local.test.ts"), "", "utf8"),
    writeFile(join(testsDirectory, "notes.ts"), "", "utf8"),
    writeFile(join(testsDirectory, "nested", "review.test.tsx"), "", "utf8"),
    writeFile(join(directory, "backend", "src", "route.test.ts"), "", "utf8"),
    writeFile(join(directory, "node_modules", "dependency", "ignored.test.ts"), "", "utf8"),
    writeFile(join(directory, "dist", "ignored.test.ts"), "", "utf8"),
    writeFile(join(directory, "coverage", "ignored.test.ts"), "", "utf8"),
    writeFile(join(directory, ".git", "ignored.test.ts"), "", "utf8"),
  ]);

  assert.deepEqual(
    listTestFiles(directory).map((path: string) => relative(directory, path).replaceAll("\\", "/")),
    [
      "backend/src/route.test.ts",
      "tests/nested/review.test.tsx",
      "tests/provider.test.ts",
      "tests/setup-local.test.ts",
    ],
  );
});

test("test runner disables disk env loading in its child process", () => {
  let observedEnv: NodeJS.ProcessEnv | undefined;
  const count = runAllTests({
    projectDirectory: process.cwd(),
    nodeVersion: "22.12.0",
    environment: {
      PATH: "test-path",
      FEISHU_APP_ID: "redacted",
      FEISHU_APP_SECRET: "redacted",
      FEISHU_BASE_TOKEN: "redacted",
      DEEPSEEK_API_KEY: "redacted",
      DASHSCOPE_API_KEY: "redacted",
      OPENAI_COMPATIBLE_API_KEY: "redacted",
      SILICONFLOW_API_KEY: "redacted",
      AI_MODEL_LEGACY: "redacted",
      AI_PROVIDER: "redacted",
      ECHO_INSIGHT_OTHER_FLAG: "redacted",
      FRONTEND_ORIGIN: "redacted",
      BACKEND_ORIGIN: "redacted",
      PORT: "redacted",
      RAILWAY_VOLUME_MOUNT_PATH: "redacted",
      VITE_API_BASE_URL: "redacted",
    },
    spawn(_command: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }) {
      observedEnv = options.env;
      return { status: 0 };
    },
  });

  assert.ok(count >= 1);
  assert.equal(observedEnv?.ECHO_INSIGHT_SKIP_ENV_FILE_LOAD, "1");
  assert.equal(observedEnv?.NODE_ENV, "test");
  for (const name of [
    "FEISHU_APP_ID",
    "FEISHU_APP_SECRET",
    "FEISHU_BASE_TOKEN",
    "DEEPSEEK_API_KEY",
    "DASHSCOPE_API_KEY",
    "OPENAI_COMPATIBLE_API_KEY",
    "SILICONFLOW_API_KEY",
    "AI_MODEL_LEGACY",
    "AI_PROVIDER",
    "ECHO_INSIGHT_OTHER_FLAG",
    "FRONTEND_ORIGIN",
    "BACKEND_ORIGIN",
    "PORT",
    "RAILWAY_VOLUME_MOUNT_PATH",
    "VITE_API_BASE_URL",
  ]) {
    assert.equal(Object.hasOwn(observedEnv ?? {}, name), false);
  }
});

test("setup detects both local ports", async (t) => {
  const directory = await makeTempDirectory(t);
  const probed: number[] = [];
  await runSetup({
    projectDirectory: directory,
    nodeVersion: "20.19.0",
    log() {},
    npmCi() {},
    async portProbe(port: number) {
      probed.push(port);
      return true;
    },
    prompter: deepSeekPrompter(),
  });
  assert.deepEqual(probed, [3000, 5173]);
});

test("an existing env skips every configuration prompt and remains unchanged", async (t) => {
  const directory = await makeTempDirectory(t);
  const envPath = join(directory, ".env");
  const sentinel = "TEMP_PRIVATE_VALUE=must-remain-unchanged\n";
  await writeFile(envPath, sentinel, "utf8");
  let npmCalls = 0;
  const forbiddenPrompter = new Proxy({}, {
    get() {
      throw new Error("configuration prompt must not be reached");
    },
  });

  const result = await runSetup({
    projectDirectory: directory,
    nodeVersion: "22.12.0",
    log() {},
    npmCi() {
      npmCalls += 1;
    },
    async portProbe() {
      return true;
    },
    prompter: forbiddenPrompter,
  });

  assert.equal(npmCalls, 0);
  assert.equal(result.reason, "existing-env");
  assert.equal(await readFile(envPath, "utf8"), sentinel);
});

test("setup stops without creating env until Feishu console steps are confirmed", async (t) => {
  const directory = await makeTempDirectory(t);
  let envWriterCalls = 0;

  await assert.rejects(
    () => runSetup({
      projectDirectory: directory,
      nodeVersion: "22.12.0",
      log() {},
      npmCi() {},
      async portProbe() {
        return true;
      },
      prompter: deepSeekPrompter({ feishuConfigured: false }),
      envWriter() {
        envWriterCalls += 1;
        return true;
      },
    }),
    /飞书后台配置尚未确认/u,
  );

  assert.equal(envWriterCalls, 0);
});

test("real API connectivity is opt-in and defaults to no request", async (t) => {
  const directory = await makeTempDirectory(t);
  let connectionCalls = 0;
  let feishuConnectionCalls = 0;
  const messages: string[] = [];
  const result = await runSetup({
    projectDirectory: directory,
    nodeVersion: "24.0.0",
    log(message: string) {
      messages.push(message);
    },
    npmCi() {},
    async portProbe() {
      return true;
    },
    prompter: deepSeekPrompter(),
    async feishuConnectionTest() {
      feishuConnectionCalls += 1;
    },
    async connectionTest() {
      connectionCalls += 1;
    },
  });

  assert.equal(connectionCalls, 0);
  assert.equal(feishuConnectionCalls, 0);
  assert.equal(result.liveTest, false);
  assert.equal(result.feishuLiveTest, false);
  assert.match(messages.join("\n"), /飞书后台配置与本地环境配置已收集/u);
  assert.match(messages.join("\n"), /真实浏览器/u);
  const content = await readFile(join(directory, ".env"), "utf8");
  assert.match(content, /^NODE_ENV="production"$/mu);
  assert.match(content, /^FEISHU_APP_ID="cli_test_setup"$/mu);
  assert.match(content, /^AI_PROVIDER="deepseek"$/mu);
  assert.match(content, /^DEEPSEEK_API_KEY=/mu);
  assert.match(content, /^ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY=/mu);
});

test("occupied application ports block the ready-to-start conclusion", async (t) => {
  const directory = await makeTempDirectory(t);
  const messages: string[] = [];
  const result = await runSetup({
    projectDirectory: directory,
    nodeVersion: "24.0.0",
    log(message: string) {
      messages.push(message);
    },
    npmCi() {},
    async portProbe(port: number) {
      return port !== 3000;
    },
    prompter: deepSeekPrompter(),
  });

  assert.equal(result.portsAvailable, false);
  assert.match(messages.join("\n"), /端口 3000 被占用/u);
  assert.doesNotMatch(messages.join("\n"), /可分别运行/u);
});

test("explicit connectivity opt-in uses an injected test without exposing the key", async (t) => {
  const directory = await makeTempDirectory(t);
  let connectionCalls = 0;
  const messages: string[] = [];
  const result = await runSetup({
    projectDirectory: directory,
    nodeVersion: "24.0.0",
    log(message: string) {
      messages.push(message);
    },
    npmCi() {},
    async portProbe() {
      return true;
    },
    prompter: deepSeekPrompter({ aiLiveTest: true }),
    async connectionTest(config: { provider: string }) {
      connectionCalls += 1;
      assert.equal(config.provider, "deepseek");
    },
  });

  assert.equal(connectionCalls, 1);
  assert.equal(result.liveTest, true);
  assert.doesNotMatch(messages.join("\n"), /test-only-api-key/u);
});

test("explicit Feishu credential verification is opt-in and never logs the App Secret", async (t) => {
  const directory = await makeTempDirectory(t);
  let feishuConnectionCalls = 0;
  const messages: string[] = [];
  const result = await runSetup({
    projectDirectory: directory,
    nodeVersion: "24.0.0",
    log(message: string) {
      messages.push(message);
    },
    npmCi() {},
    async portProbe() {
      return true;
    },
    prompter: deepSeekPrompter({ feishuLiveTest: true }),
    async feishuConnectionTest(config: { appId: string }) {
      feishuConnectionCalls += 1;
      assert.equal(config.appId, "cli_test_setup");
    },
  });

  assert.equal(feishuConnectionCalls, 1);
  assert.equal(result.feishuLiveTest, true);
  assert.doesNotMatch(messages.join("\n"), /test-only-app-secret/u);
});

test("port probe distinguishes an occupied loopback port", async () => {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  assert.equal(await probePort(address.port), false);
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => error ? reject(error) : resolvePromise());
  });
  assert.equal(await probePort(address.port), true);
});
