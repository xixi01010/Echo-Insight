import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

import {
  DEFAULT_SILICONFLOW_MODEL,
  SiliconFlowAdapter,
  readSiliconFlowConfig,
} from "./siliconflow-adapter.js";
import {
  DEFAULT_DEEPSEEK_MODEL,
  DeepSeekAdapter,
} from "./deepseek-adapter.js";
import {
  createAiProviderBundle,
  DEFAULT_DASHSCOPE_MODEL,
} from "../ai-service/src/provider/index.js";
import type {
  ModelAdapter,
  ModelAdapterRequest,
  ModelAdapterResult,
  ModelTestCase,
  TokenUsage,
} from "../ai-service/src/provider/model-adapter.js";
import {
  createPrompt,
  FORBIDDEN_V2_KEYS,
  SYSTEM_PROMPT_V2,
  SYSTEM_PROMPT_V3,
  validateV2Output,
  type V2ValidationResult,
} from "../ai-service/src/provider/risk-output-contract.js";

export type {
  ModelAdapter,
  ModelAdapterRequest,
  ModelAdapterResult,
  ModelTestCase,
  TokenUsage,
};
export {
  createPrompt,
  FORBIDDEN_V2_KEYS,
  SYSTEM_PROMPT_V2,
  SYSTEM_PROMPT_V3,
  validateV2Output,
  type V2ValidationResult,
};

const LOCAL_ENV_FILE = resolve(dirname(fileURLToPath(import.meta.url)), "../.env");
if (process.env.ECHO_INSIGHT_SKIP_ENV_FILE_LOAD !== "1") {
  try {
    loadEnvFile(LOCAL_ENV_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export const MODEL_FAMILIES = ["Qwen", "DeepSeek"] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];

export interface TestRunRecord {
  testCase: string;
  model: string;
  status: "not-run" | "completed" | "failed" | "invalid-output";
  result: ModelAdapterResult;
  error?: string;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const projectRoot = resolve(scriptDirectory, "..", "..");
const engineeringRoot = resolve(scriptDirectory, "..");
export const testDataDirectory = join(
  engineeringRoot,
  "tests",
  "fixtures",
  "ai-model",
);
export const testResultDirectory = join(
  engineeringRoot,
  ".runtime",
  "ai-model-test-results",
);

export async function loadTestCases(
  directory = testDataDirectory,
): Promise<ModelTestCase[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();

  const cases: ModelTestCase[] = [];
  for (const fileName of jsonFiles) {
    const filePath = join(directory, fileName);
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!isObjectRecord(parsed)) {
      throw new Error(`Test case must be a JSON object: ${fileName}`);
    }
    cases.push({
      name: fileName.replace(/\.json$/u, ""),
      filePath,
      input: parsed,
    });
  }

  return cases;
}

/**
 * Safe local adapter used until a provider is explicitly approved.
 * It never performs network I/O and intentionally returns a not-run result.
 */
export class DryRunModelAdapter implements ModelAdapter {
  constructor(private readonly model: string) {}

  async invoke(request: ModelAdapterRequest): Promise<ModelAdapterResult> {
    if (request.model !== this.model) {
      throw new Error("Model Adapter request model does not match adapter model.");
    }

    return {
      model: request.model,
      response: {
        status: "not-run",
        reason: "No real model adapter is configured.",
      },
      latency: null,
      tokenUsage: null,
      timestamp: new Date().toISOString(),
    };
  }
}

export async function runDryRun(
  model: string,
  cases: ModelTestCase[],
): Promise<TestRunRecord[]> {
  const adapter = new DryRunModelAdapter(model);
  const records: TestRunRecord[] = [];

  for (const testCase of cases) {
    const result = await adapter.invoke({
      model,
      systemPrompt: SYSTEM_PROMPT_V2,
      prompt: createPrompt(testCase),
      testCase,
    });
    records.push({
      testCase: testCase.name,
      model,
      status: "not-run",
      result,
    });
  }

  return records;
}

export async function runSiliconFlowTests(
  model: string,
  cases: ModelTestCase[],
): Promise<TestRunRecord[]> {
  const adapter = new SiliconFlowAdapter({
    ...readSiliconFlowConfig(),
    model,
  });
  const records: TestRunRecord[] = [];

  for (const testCase of cases) {
    try {
      const result = await adapter.invoke({
        model,
        systemPrompt: SYSTEM_PROMPT_V2,
        prompt: createPrompt(testCase),
        testCase,
      });
      const validation = validateV2Output(result.response);
      records.push({
        testCase: testCase.name,
        model,
        status: validation.valid ? "completed" : "invalid-output",
        result,
        ...(validation.valid
          ? {}
          : { error: `V2 output validation failed: ${validation.violations.join("; ")}` }),
      });
    } catch (error) {
      records.push({
        testCase: testCase.name,
        model,
        status: "failed",
        result: {
          model,
          response: null,
          latency: null,
          tokenUsage: null,
          timestamp: new Date().toISOString(),
        },
        error: error instanceof Error ? error.message : "Unknown SiliconFlow error.",
      });
    }
  }

  return records;
}

export async function runDeepSeekTests(
  model: string,
  cases: ModelTestCase[],
): Promise<TestRunRecord[]> {
  const adapter = new DeepSeekAdapter();
  const records: TestRunRecord[] = [];
  for (const testCase of cases) {
    try {
      const result = await adapter.invoke({
        model,
        systemPrompt: SYSTEM_PROMPT_V2,
        prompt: createPrompt(testCase),
        testCase,
      });
      const validation = validateV2Output(result.response);
      records.push({
        testCase: testCase.name,
        model,
        status: validation.valid ? "completed" : "invalid-output",
        result,
        ...(validation.valid ? {} : { error: `V2 output validation failed: ${validation.violations.join("; ")}` }),
      });
    } catch (error) {
      records.push({
        testCase: testCase.name,
        model,
        status: "failed",
        result: { model, response: null, latency: null, tokenUsage: null, timestamp: new Date().toISOString() },
        error: error instanceof Error ? error.message : "Unknown DeepSeek error.",
      });
    }
  }
  return records;
}

export async function runConfiguredProviderTests(
  adapter: ModelAdapter,
  model: string,
  cases: ModelTestCase[],
  providerName: string,
): Promise<TestRunRecord[]> {
  const records: TestRunRecord[] = [];
  for (const testCase of cases) {
    try {
      const result = await adapter.invoke({
        model,
        systemPrompt: SYSTEM_PROMPT_V2,
        prompt: createPrompt(testCase),
        testCase,
      });
      const validation = validateV2Output(result.response);
      records.push({
        testCase: testCase.name,
        model,
        status: validation.valid ? "completed" : "invalid-output",
        result,
        ...(validation.valid
          ? {}
          : { error: `V2 output validation failed: ${validation.violations.join("; ")}` }),
      });
    } catch (error) {
      records.push({
        testCase: testCase.name,
        model,
        status: "failed",
        result: {
          model,
          response: null,
          latency: null,
          tokenUsage: null,
          timestamp: new Date().toISOString(),
        },
        error: error instanceof Error ? error.message : `Unknown ${providerName} error.`,
      });
    }
  }
  return records;
}

export async function writeDryRunManifest(
  records: TestRunRecord[],
  directory = testResultDirectory,
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const outputPath = join(directory, "dry-run-manifest.json");
  await writeFile(
    outputPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), records }, null, 2)}\n`,
    "utf8",
  );
  return outputPath;
}

function getResultFileName(model: string, variant = "legacy"): string {
  if (variant === "v2") {
    return model.toLowerCase().includes("deepseek")
      ? "deepseek-v2-test-result.json"
      : "qwen-v2-test-result.json";
  }
  return model.toLowerCase().includes("deepseek")
    ? "deepseek-test-result.json"
    : "qwen-test-result.json";
}

export async function writeModelTestResult(
  records: TestRunRecord[],
  model: string,
  variant = "legacy",
  directory = testResultDirectory,
  provider = "siliconflow",
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const outputPath = join(directory, getResultFileName(model, variant));
  await writeFile(
    outputPath,
    `${JSON.stringify(
      {
        provider,
        model,
        generatedAt: new Date().toISOString(),
        records,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return outputPath;
}
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getArgument(args: string[], name: string): string | undefined {
  const equalsArgument = args.find((arg) => arg.startsWith(`${name}=`));
  if (equalsArgument) return equalsArgument.slice(name.length + 1);

  const index = args.indexOf(name);
  const next = index >= 0 ? args[index + 1] : undefined;
  return next && !next.startsWith("--") ? next : undefined;
}

function getModelArgument(args: string[], provider: string): string {
  if (provider === "deepseek") {
    return getArgument(args, "--model") || process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  }
  if (provider === "qwen") {
    return getArgument(args, "--model") || process.env.DASHSCOPE_MODEL?.trim() || DEFAULT_DASHSCOPE_MODEL;
  }
  if (provider === "openai-compatible" || provider === "openai_compatible") {
    return getArgument(args, "--model")
      || process.env.OPENAI_COMPATIBLE_MODEL?.trim()
      || "unconfigured";
  }
  return (
    getArgument(args, "--model") ||
    process.env.AI_MODEL?.trim() ||
    DEFAULT_SILICONFLOW_MODEL
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const provider =
    getArgument(args, "--provider") || process.env.AI_PROVIDER?.trim() || "dry-run";
  const model = getModelArgument(args, provider);
  const cases = await loadTestCases();
  const configuredProvider = [
    "deepseek",
    "qwen",
    "openai-compatible",
    "openai_compatible",
    "siliconflow",
  ].includes(provider);
  const records = configuredProvider
    ? await runConfiguredProviderTests(
        createAiProviderBundle({ ...process.env, AI_PROVIDER: provider }).modelAdapter,
        model,
        cases,
        provider,
      )
    : await runDryRun(model, cases);

  if (configuredProvider) {
    const outputPath = await writeModelTestResult(records, model, "v2", testResultDirectory, provider);
    console.log(`${provider} result written: ${outputPath}`);
  } else if (args.includes("--write-manifest")) {
    const outputPath = await writeDryRunManifest(records);
    console.log(`Dry-run manifest written: ${outputPath}`);
  }

  console.log(`Loaded ${cases.length} test cases for provider ${provider}, model: ${model}`);
  for (const testCase of cases) {
    const record = records.find((candidate) => candidate.testCase === testCase.name);
    console.log(`- ${testCase.name}: ${record?.status ?? "not-run"}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}






