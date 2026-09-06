#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..");
const DEFAULT_TIMEOUT_MS = 30_000;
const QWEN_CHAT_COMPLETIONS_URL =
  "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const FEISHU_APP_CONSOLE_URL = "https://open.feishu.cn/app";
const FEISHU_TENANT_ACCESS_TOKEN_URL =
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const FEISHU_SCOPE_DOCUMENTATION_URL =
  "https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/scope-list";
const QWEN_TOKEN_PLAN_DOCUMENTATION_URL =
  "https://platform.qianwenai.com/docs/token-plan/overview";

function parseNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(String(version).trim());
  return match ? match.slice(1).map(Number) : null;
}

export function isSupportedNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  if (major === 20) return minor >= 19;
  if (major === 21) return false;
  if (major === 22) return minor >= 12;
  return major > 22;
}

function assertSupportedNodeVersion(version) {
  if (!isSupportedNodeVersion(version)) {
    throw new Error(
      `当前 Node.js ${version} 不受支持；请安装 ^20.19.0 或 >=22.12.0。`,
    );
  }
}

function requireSingleLine(value, label) {
  const normalized = String(value).trim();
  if (!normalized) throw new Error(`${label}不能为空。`);
  if (/[\r\n\0]/u.test(normalized)) throw new Error(`${label}必须是单行值。`);
  return normalized;
}

function normalizeModel(value) {
  return requireSingleLine(value, "模型名称");
}

export function normalizeTimeout(value) {
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 35_000) {
    throw new Error("超时时间必须是 1000 到 35000 之间的整数毫秒数。");
  }
  return parsed;
}

export function normalizeFrontendOrigin(value) {
  const raw = requireSingleLine(value, "前端 HTTPS Origin");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("前端 HTTPS Origin 不是有效 URL。");
  }
  if (url.protocol !== "https:") throw new Error("前端 Origin 必须使用 HTTPS。");
  if (url.username || url.password) throw new Error("前端 Origin 不得包含用户名或密码。");
  if (raw.includes("?") || raw.includes("#") || url.search || url.hash || url.pathname !== "/") {
    throw new Error("前端 Origin 只能包含协议、主机与可选端口，不能包含路径、query 或 fragment。");
  }
  const hostname = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const reservedHostname = hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".test")
    || hostname.endsWith(".example")
    || hostname.endsWith(".invalid")
    || (!hostname.includes(".") && isIP(hostname) === 0);
  const ipv4 = isIP(hostname) === 4 ? hostname.split(".").map(Number) : null;
  const privateIpv4 = ipv4 && (
    ipv4[0] === 0
    || ipv4[0] === 10
    || ipv4[0] === 127
    || (ipv4[0] === 100 && ipv4[1] >= 64 && ipv4[1] <= 127)
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168)
  );
  const privateIpv6 = isIP(hostname) === 6 && (
    hostname === "::"
    || hostname === "::1"
    || hostname.startsWith("fc")
    || hostname.startsWith("fd")
    || /^fe[89ab]/u.test(hostname)
  );
  if (reservedHostname || privateIpv4 || privateIpv6) {
    throw new Error("前端 Origin 必须使用面向飞书回调的公网主机，不能使用本机、私网或保留地址。");
  }
  return url.origin;
}

export function buildFeishuRedirectUri(frontendOrigin) {
  return new URL(
    "/api/auth/feishu/callback",
    normalizeFrontendOrigin(frontendOrigin),
  ).href;
}

export function normalizeRuntimeDirectory(value) {
  const directory = requireSingleLine(value, "运行时目录");
  if (!isAbsolute(directory)) throw new Error("运行时目录必须是绝对路径。");
  return resolve(directory);
}

export function validateChatCompletionsUrl(value) {
  const raw = requireSingleLine(value, "Chat Completions Endpoint");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Chat Completions Endpoint 不是有效 URL。");
  }

  if (url.username || url.password) {
    throw new Error("Endpoint 不得包含用户名或密码。");
  }
  if (raw.includes("#") || url.hash) throw new Error("Endpoint 不得包含 URL fragment。");
  if (raw.includes("?") || url.search) throw new Error("Endpoint 不得包含 query 参数。");
  if (!url.pathname.endsWith("/chat/completions")) {
    throw new Error("必须提供以 /chat/completions 结尾的完整 Endpoint。");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  const localHttp = url.protocol === "http:" && localHosts.has(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    throw new Error("远端 Endpoint 必须使用 HTTPS；HTTP 仅允许本机回环地址。");
  }
  return url.href;
}

function quoteEnv(value) {
  const normalized = requireSingleLine(value, "环境变量值");
  return JSON.stringify(normalized);
}

function renderProviderVariables(config) {
  const common = [
    `AI_PROVIDER=${quoteEnv(config.provider)}`,
  ];

  const variables = config.provider === "deepseek"
    ? [
        ["DEEPSEEK_API_KEY", config.apiKey],
        ["DEEPSEEK_MODEL", config.model],
        ["DEEPSEEK_CHAT_COMPLETIONS_URL", config.endpoint],
        ["DEEPSEEK_TIMEOUT_MS", String(config.timeoutMs)],
      ]
    : config.provider === "qwen"
      ? [
          ["DASHSCOPE_API_KEY", config.apiKey],
          ["DASHSCOPE_MODEL", config.model],
          ["DASHSCOPE_CHAT_COMPLETIONS_URL", config.endpoint],
          ["DASHSCOPE_TIMEOUT_MS", String(config.timeoutMs)],
        ]
      : config.provider === "openai-compatible"
        ? [
            ["OPENAI_COMPATIBLE_API_KEY", config.apiKey],
            ["OPENAI_COMPATIBLE_MODEL", config.model],
            ["OPENAI_COMPATIBLE_CHAT_COMPLETIONS_URL", config.endpoint],
            ["OPENAI_COMPATIBLE_TIMEOUT_MS", String(config.timeoutMs)],
            ["OPENAI_COMPATIBLE_JSON_MODE", config.jsonMode],
            ["OPENAI_COMPATIBLE_TOKEN_LIMIT_FIELD", config.tokenLimitField],
          ]
        : null;

  if (!variables) throw new Error("不支持的 AI Provider。");
  return [...common, ...variables.map(([name, value]) => `${name}=${quoteEnv(value)}`)];
}

export function generateVisitorAiAccountMasterKey(randomBytesImpl = randomBytes) {
  const value = randomBytesImpl(32);
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new Error("无法生成在线访客 AI 凭据主密钥。");
  }
  return value.toString("base64");
}

export function renderSetupEnv({
  feishu,
  provider,
  visitorAiAccountMasterKey = generateVisitorAiAccountMasterKey(),
}) {
  const values = [
    "# Generated by Echo Insight local setup.",
    "# Server-side only. Never commit this file or expose it to the frontend.",
    `NODE_ENV=${quoteEnv("production")}`,
    `ECHO_INSIGHT_AI_ACCESS_MODE=${quoteEnv("server")}`,
    `FRONTEND_ORIGIN=${quoteEnv(feishu.frontendOrigin)}`,
    `ECHO_INSIGHT_RUNTIME_DIR=${quoteEnv(feishu.runtimeDirectory)}`,
    `ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY=${quoteEnv(visitorAiAccountMasterKey)}`,
    `FEISHU_APP_ID=${quoteEnv(feishu.appId)}`,
    `FEISHU_APP_SECRET=${quoteEnv(feishu.appSecret)}`,
    `FEISHU_IDENTITY_REDIRECT_URI=${quoteEnv(feishu.redirectUri)}`,
    "",
    ...renderProviderVariables(provider),
  ];
  return `${values.join("\n")}\n`;
}

export function createEnvFileExclusive(path, content) {
  try {
    writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export function listTestFiles(projectDirectory = PROJECT_DIRECTORY) {
  const excludedDirectories = new Set(["node_modules", "dist", "coverage", ".git"]);
  const pendingDirectories = [resolve(projectDirectory)];
  const tests = [];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name.toLowerCase())) {
          pendingDirectories.push(resolve(directory, entry.name));
        }
      } else if (entry.isFile() && /\.test\.tsx?$/u.test(entry.name)) {
        tests.push(resolve(directory, entry.name));
      }
    }
  }

  return tests.sort((left, right) => left.localeCompare(right, "en"));
}

export function createTestEnvironment(sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment };
  const exactSecrets = new Set([
    "AI_PROVIDER",
    "FRONTEND_ORIGIN",
    "BACKEND_ORIGIN",
    "PORT",
    "RAILWAY_VOLUME_MOUNT_PATH",
    "VITE_API_BASE_URL",
  ]);
  const secretPrefixes = [
    "FEISHU_",
    "ECHO_INSIGHT_",
    "DEEPSEEK_",
    "DASHSCOPE_",
    "OPENAI_COMPATIBLE_",
    "SILICONFLOW_",
    "AI_MODEL",
  ];

  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      exactSecrets.has(normalizedName)
      || secretPrefixes.some((prefix) => normalizedName.startsWith(prefix))
    ) {
      delete environment[name];
    }
  }
  environment.NODE_ENV = "test";
  environment.ECHO_INSIGHT_SKIP_ENV_FILE_LOAD = "1";
  environment.ECHO_INSIGHT_AI_ACCESS_MODE = "server";
  environment.ECHO_INSIGHT_ENABLE_LEGACY_API = "1";
  return environment;
}

export function runAllTests({
  projectDirectory = PROJECT_DIRECTORY,
  nodeVersion = process.versions.node,
  spawn = spawnSync,
  environment = process.env,
} = {}) {
  assertSupportedNodeVersion(nodeVersion);
  const tests = listTestFiles(projectDirectory);
  if (tests.length === 0) throw new Error("未找到项目内 TypeScript 测试文件。");

  const require = createRequire(resolve(projectDirectory, "package.json"));
  const tsxCli = require.resolve("tsx/cli");
  const result = spawn(process.execPath, [tsxCli, "--test", ...tests], {
    cwd: projectDirectory,
    env: createTestEnvironment(environment),
    stdio: "inherit",
  });
  if (result.error || result.status !== 0) {
    throw new Error(`测试未通过（退出码 ${result.status ?? "unknown"}）。`);
  }
  return tests.length;
}

function runNpmCi(projectDirectory, spawn = spawnSync) {
  const command = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : "npm";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "npm ci"]
    : ["ci"];
  const result = spawn(command, args, { cwd: projectDirectory, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`npm ci 未完成（退出码 ${result.status ?? "unknown"}）。`);
  }
}

export function probePort(port, host = "127.0.0.1") {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolvePromise(false);
      } else {
        reject(error);
      }
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolvePromise(true));
    });
  });
}

async function questionOnce(label, defaultValue, input = stdin, output = stdout) {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const reader = createInterface({ input, output, terminal: true });
  try {
    const answer = await reader.question(`${label}${suffix}: `);
    return answer.trim() || defaultValue || "";
  } finally {
    reader.close();
  }
}

function hiddenQuestion(label, input = stdin, output = stdout) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("敏感值只能在交互式终端中隐藏输入。请在终端重新运行安装器。");
  }

  return new Promise((resolvePromise, reject) => {
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = input.isPaused();
    let value = "";

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
    };
    const finish = () => {
      cleanup();
      output.write("\n");
      resolvePromise(value.trim());
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new Error("安装已取消。"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    output.write(`${label}: `);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export function createConsolePrompter({ input = stdin, output = stdout } = {}) {
  return {
    write(message) {
      output.write(`${message}\n`);
    },
    async select(label, choices, defaultId) {
      while (true) {
        output.write(`${label}\n`);
        choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label}\n`));
        const defaultIndex = choices.findIndex((choice) => choice.id === defaultId) + 1;
        const answer = await questionOnce("请选择", String(defaultIndex), input, output);
        const index = Number(answer) - 1;
        if (Number.isInteger(index) && choices[index]) return choices[index].id;
        output.write("请输入有效的选项编号。\n");
      }
    },
    input(label, defaultValue) {
      return questionOnce(label, defaultValue, input, output);
    },
    secret(label) {
      return hiddenQuestion(label, input, output);
    },
    async confirm(label, defaultValue = false) {
      while (true) {
        const hint = defaultValue ? "Y/n" : "y/N";
        const answer = (await questionOnce(`${label} (${hint})`, "", input, output)).toLowerCase();
        if (!answer) return defaultValue;
        if (["y", "yes"].includes(answer)) return true;
        if (["n", "no"].includes(answer)) return false;
        output.write("请输入 y 或 n。\n");
      }
    },
  };
}

async function promptValidated(prompter, method, args, validator) {
  while (true) {
    const value = await prompter[method](...args);
    try {
      return validator(value);
    } catch (error) {
      prompter.write(`输入无效：${error.message}`);
    }
  }
}

export function renderFeishuPermissionChecklist() {
  return [
    "飞书只读权限清单（在开发者后台的「权限管理」中按权限代码搜索）：",
    "  登录与令牌续期：offline_access",
    "  Base：bitable:app:readonly",
    "  Chat：im:chat:readonly、im:message:readonly、im:message.group_msg",
    "  Minutes：minutes:minutes.basic:read、minutes:minutes.transcript:export、minutes:minutes.artifacts:read",
    "  Docs：docx:document:readonly",
    "  Wiki / Drive：wiki:wiki:readonly、drive:drive.metadata:readonly",
    "  Task：task:task:readonly",
    "  Calendar：calendar:calendar:readonly、calendar:calendar.event:read",
    "  加入项目时的资源权限校验：docs:permission.member:auth",
    "",
    "资源访问仍需单独满足：目标 Base 必须允许应用读取；读取群历史消息前必须启用机器人能力并将机器人加入目标群；登录用户必须对所选 Minutes、Docs、Wiki / Drive、Task 和 Calendar 资源本身有权。",
    `权限参考：${FEISHU_SCOPE_DOCUMENTATION_URL}`,
  ].join("\n");
}

export async function collectFeishuConfig(prompter, projectDirectory = PROJECT_DIRECTORY) {
  prompter.write("飞书配置 1/3：创建一个企业自建应用并取得 App ID 与 App Secret。");
  prompter.write(`飞书开放平台：${FEISHU_APP_CONSOLE_URL}`);
  const appId = await promptValidated(
    prompter,
    "input",
    ["飞书 App ID"],
    (value) => requireSingleLine(value, "飞书 App ID"),
  );
  const appSecret = await promptValidated(
    prompter,
    "secret",
    ["飞书 App Secret（输入内容不会显示）"],
    (value) => requireSingleLine(value, "飞书 App Secret"),
  );
  const frontendOrigin = await promptValidated(
    prompter,
    "input",
    ["已部署前端的公开 HTTPS Origin（例如 https://echo.example.com）"],
    normalizeFrontendOrigin,
  );
  const redirectUri = buildFeishuRedirectUri(frontendOrigin);
  const runtimeDirectory = await promptValidated(
    prompter,
    "input",
    ["后端持久化运行时目录（绝对路径）", resolve(projectDirectory, ".runtime", "echo-insight")],
    normalizeRuntimeDirectory,
  );

  prompter.write("飞书配置 2/3：在「安全设置」中登记下面这个精确重定向 URL：");
  prompter.write(`  ${redirectUri}`);
  prompter.write("飞书配置 3/3：启用机器人能力，并按当前代码申请以下权限：");
  prompter.write(renderFeishuPermissionChecklist());
  const confirmed = await prompter.confirm(
    "我已在飞书开放平台登记上述回调、启用所需权限、配置应用可用范围，并发布或安装当前应用版本",
    false,
  );
  if (!confirmed) {
    throw new Error("飞书后台配置尚未确认；安装器已停止且未创建 .env。完成后请重新运行。");
  }

  return { appId, appSecret, frontendOrigin, redirectUri, runtimeDirectory };
}

export async function collectProviderConfig(prompter) {
  const provider = await prompter.select("选择 AI Provider", [
    { id: "deepseek", label: "DeepSeek" },
    { id: "qwen", label: "通义千问 / Alibaba Cloud Model Studio" },
    { id: "openai-compatible", label: "OpenAI-compatible 自定义服务" },
  ], "deepseek");

  if (provider === "deepseek") {
    prompter.write("DeepSeek API Key：https://platform.deepseek.com/api_keys");
    prompter.write("DeepSeek 接入文档：https://api-docs.deepseek.com/quick_start/first_request");
    prompter.write("DeepSeek 动态价格：https://api-docs.deepseek.com/quick_start/pricing/");
  } else if (provider === "qwen") {
    prompter.write("千问AI平台工作台：https://platform.qianwenai.com/home");
    prompter.write("千问 API Key 指引：https://platform.qianwenai.com/docs/api-reference/preparation/api-key");
    prompter.write("千问动态价格：https://platform.qianwenai.com/docs/developer-guides/getting-started/pricing");
    prompter.write("千问预设使用通用按量付费 API Key 与标准 Endpoint。");
    prompter.write(`Token Plan 用户请改选 OpenAI-compatible，并按官方说明填写专属 Key 与完整专属 Endpoint：${QWEN_TOKEN_PLAN_DOCUMENTATION_URL}`);
  } else {
    prompter.write("自定义 Provider 可能收取模型调用费，请先核对服务商的 API Key、隐私与计费文档。");
  }
  prompter.write("AI API 调用由所选模型平台计费，不是 Echo Insight 收费。费用通常随项目数量、信息来源数量及上下文长度增加。");

  const apiKey = await promptValidated(
    prompter,
    "secret",
    ["API Key（输入内容不会显示）"],
    (value) => requireSingleLine(value, "API Key"),
  );

  if (provider === "deepseek") {
    return {
      provider,
      apiKey,
      model: await promptValidated(prompter, "input", ["模型", "deepseek-v4-flash"], normalizeModel),
      endpoint: await promptValidated(
        prompter,
        "input",
        ["完整 Chat Completions Endpoint", "https://api.deepseek.com/chat/completions"],
        validateChatCompletionsUrl,
      ),
      timeoutMs: await promptValidated(prompter, "input", ["超时毫秒", String(DEFAULT_TIMEOUT_MS)], normalizeTimeout),
      tokenLimitField: "max_tokens",
    };
  }

  if (provider === "qwen") {
    return {
      provider,
      apiKey,
      model: await promptValidated(prompter, "input", ["模型", "qwen3.8-flash"], normalizeModel),
      endpoint: QWEN_CHAT_COMPLETIONS_URL,
      timeoutMs: await promptValidated(prompter, "input", ["超时毫秒", String(DEFAULT_TIMEOUT_MS)], normalizeTimeout),
      tokenLimitField: "max_completion_tokens",
    };
  }

  return {
    provider,
    apiKey,
    endpoint: await promptValidated(
      prompter,
      "input",
      ["完整 Chat Completions Endpoint"],
      validateChatCompletionsUrl,
    ),
    model: await promptValidated(prompter, "input", ["模型"], normalizeModel),
    timeoutMs: await promptValidated(prompter, "input", ["超时毫秒", String(DEFAULT_TIMEOUT_MS)], normalizeTimeout),
    jsonMode: await prompter.select("JSON 输出模式", [
      { id: "json_object", label: "json_object" },
      { id: "none", label: "不添加 response_format" },
    ], "json_object"),
    tokenLimitField: await prompter.select("Token 上限字段", [
      { id: "max_tokens", label: "max_tokens" },
      { id: "max_completion_tokens", label: "max_completion_tokens" },
      { id: "none", label: "不发送 Token 上限字段" },
    ], "max_tokens"),
  };
}

export async function verifyProviderConnection(config, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const body = {
    model: config.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    stream: false,
  };
  if (config.tokenLimitField && config.tokenLimitField !== "none") {
    body[config.tokenLimitField] = 1;
  }

  try {
    const response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    await response.body?.cancel?.();
    if (!response.ok) throw new Error(`真实连通测试返回 HTTP ${response.status}。`);
    return response.status;
  } catch (error) {
    if (error?.message?.startsWith("真实连通测试返回 HTTP ")) throw error;
    throw new Error("真实连通测试无法连接服务；未读取响应正文，也未写入 .env。");
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyFeishuAppCredentials(config, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetchImpl(FEISHU_TENANT_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
      signal: controller.signal,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("飞书 App 凭据验证未通过；飞书未返回可识别的验证结果。");
    }
    if (
      !response.ok
      || payload?.code !== 0
      || typeof payload.tenant_access_token !== "string"
      || !payload.tenant_access_token.trim()
    ) {
      throw new Error("飞书 App 凭据验证未通过；请检查 App ID、App Secret 与应用状态。");
    }
    return response.status;
  } catch (error) {
    if (error?.message?.startsWith("飞书 App 凭据验证未通过")) throw error;
    throw new Error("无法连接飞书凭据验证服务；未输出响应正文，也未写入 .env。");
  } finally {
    clearTimeout(timer);
  }
}

export async function runSetup({
  projectDirectory = PROJECT_DIRECTORY,
  nodeVersion = process.versions.node,
  log = (message) => console.log(message),
  npmCi = runNpmCi,
  portProbe = probePort,
  envExists = existsSync,
  envWriter = createEnvFileExclusive,
  prompter,
  feishuConnectionTest = verifyFeishuAppCredentials,
  connectionTest = verifyProviderConnection,
} = {}) {
  assertSupportedNodeVersion(nodeVersion);
  const envPath = resolve(projectDirectory, ".env");
  const envAlreadyExists = envExists(envPath);

  log(`[Echo Insight] Node.js ${nodeVersion} 已通过版本检查。`);
  if (envAlreadyExists) {
    log("[Echo Insight] 已检测到 .env；安装器在依赖安装前停止，既不读取也不修改该文件。");
    return { envCreated: false, reason: "existing-env", ports: [] };
  }

  log("[Echo Insight] 正在通过 npm ci 安装锁定依赖……");
  await npmCi(projectDirectory);

  const ports = [];
  for (const port of [3000, 5173]) {
    const available = await portProbe(port);
    ports.push({ port, available });
    log(`[Echo Insight] 端口 ${port}: ${available ? "可用" : "已被占用"}。`);
  }

  const activePrompter = prompter || createConsolePrompter();
  const feishuConfig = await collectFeishuConfig(activePrompter, projectDirectory);
  log("[Echo Insight] 飞书后台配置与本地环境配置已收集；尚未验证真实浏览器登录与资源访问。");
  const shouldTestFeishu = await activePrompter.confirm(
    "是否现在验证飞书 App 凭据？这会向飞书发起一次真实请求，但不会读取业务数据",
    false,
  );
  if (shouldTestFeishu) {
    await feishuConnectionTest(feishuConfig);
    log("[Echo Insight] 飞书 App 凭据验证通过；验证响应中的令牌未被保存或输出。");
  } else {
    log("[Echo Insight] 已按默认策略跳过飞书 App 凭据网络验证。");
  }

  const config = await collectProviderConfig(activePrompter);
  const shouldTest = await activePrompter.confirm(
    "是否现在发起一次真实 AI API 连通测试？这会产生一次可能由模型平台计费的真实请求",
    false,
  );
  if (shouldTest) {
    await connectionTest(config);
    log("[Echo Insight] 真实 AI API 连通测试通过。");
  } else {
    log("[Echo Insight] 已按默认策略跳过真实 AI API 调用。");
  }

  const created = envWriter(envPath, renderSetupEnv({
    feishu: feishuConfig,
    provider: config,
    visitorAiAccountMasterKey: generateVisitorAiAccountMasterKey(),
  }));
  if (!created) {
    log("[Echo Insight] .env 在配置期间已由其他进程创建；安装器未读取或覆盖它。");
    return { envCreated: false, reason: "concurrent-env", ports };
  }

  log("[Echo Insight] 已创建仅供服务端使用的 .env；App Secret、API Key 与访客凭据主密钥从未回显。");
  log("[Echo Insight] 依赖、飞书环境与 AI Provider 配置已完成；这不等于完整产品已可体验。");
  log("[Echo Insight] 安装器不能代替飞书管理员审批、版本发布或安装、机器人入群、具体资源授权，也不会创建云端 HTTPS 部署。");
  log("[Echo Insight] 上线前必须在真实浏览器验证飞书登录、OAuth 回调、项目权限与七类信息来源读取。");
  const occupiedPorts = ports.filter(({ available }) => !available).map(({ port }) => port);
  if (occupiedPorts.length > 0) {
    log(`[Echo Insight] 依赖与配置已完成，但端口 ${occupiedPorts.join(", ")} 被占用；当前未确认可以启动。`);
    log("[Echo Insight] 请先释放端口或调整本地端口配置，再启动服务。");
  } else {
    log("[Echo Insight] 服务端配置已生成。请按根目录 README 的「完整自托管」章节完成前端生产构建、HTTPS 发布与同源 /api 代理；不要把本地开发服务器当作生产部署。");
  }
  return {
    envCreated: true,
    provider: config.provider,
    ports,
    feishuLiveTest: shouldTestFeishu,
    liveTest: shouldTest,
    portsAvailable: occupiedPorts.length === 0,
  };
}

function printHelp() {
  console.log(`Echo Insight 本地安装器

用法：
  node scripts/setup-local.mjs              安装依赖并引导配置飞书与 AI Provider
  node scripts/setup-local.mjs --run-tests  递归枚举并运行项目内全部 TypeScript 测试
  node scripts/setup-local.mjs --help        显示帮助

范围：本入口收集服务端配置、生成 OAuth callback、列出七类来源权限并等待确认；不会创建、发布或安装飞书应用，也不会创建云端部署或代替真实浏览器验收。
安全约定：已有 .env 只检测存在性，绝不读取或覆盖；App Secret 与 API Key 隐藏输入；访客凭据主密钥自动随机生成且不回显；真实网络请求默认关闭。`);
}

async function main(args) {
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  if (args.includes("--run-tests")) {
    const count = runAllTests();
    console.log(`[Echo Insight] 已运行 ${count} 个测试文件。`);
    return;
  }
  if (args.length > 0) throw new Error("未知参数。使用 --help 查看支持的用法。");
  await runSetup();
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`[Echo Insight] 安装未完成：${error.message}`);
    process.exitCode = 1;
  });
}
