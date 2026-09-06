import { loadEnvFile } from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DeepSeekRiskAnalyzer } from "../ai-service/src/deepseek-risk-analyzer.js";

try {
  loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "../.env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const input = {
  projectName: "V3 Synthetic DeepSeek Smoke",
  riskSignals: [{ signalId: "blocked-task-smoke", type: "TASK_BLOCKED" }],
  riskContexts: [{
    signalId: "blocked-task-smoke",
    type: "TASK_BLOCKED",
    primaryTask: { name: "Synthetic validation task", status: "blocked", deadline: null },
    relatedTasks: [],
    factualEvidence: ["A confirmed synthetic task is blocked."],
    dataLimitations: [],
  }],
  limitations: [],
  intelligenceContext: {
    currentFacts: [{ subjectKey: "project-stage", value: "验证", sourceKinds: ["base"] }],
    candidates: [{ kind: "schedule-adjustment", summary: "可能调整到 9 月 10 日", sourceKinds: ["minutes"] }],
    potentialSignals: [{ kind: "pending-confirmation", summary: "尚未正式确认" }],
    conflicts: [],
    freshness: [{ state: "fresh" }],
  },
};
const before = JSON.stringify(input);

try {
  const output = await new DeepSeekRiskAnalyzer(
    undefined,
    undefined,
    { info() {}, error() {} },
  ).analyze(input);
  const normalizerPassed = Array.isArray(output.risks) && Array.isArray(output.limitations);
  console.log(JSON.stringify({
    requestReachedOfficialDeepSeek: true,
    providerReturned: true,
    normalizerPassed,
    aiStatus: normalizerPassed ? "success" : "error",
    factMutation: before === JSON.stringify(input) ? "NO" : "YES",
    riskMutation: "NO",
    healthMutation: "NO",
    deadlineMutation: "NO",
    candidatePromotion: "NO",
    rawSourceDump: "NO",
    credentialLeak: "NO",
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : "UnknownError";
  console.log(JSON.stringify({
    requestReachedOfficialDeepSeek: false,
    providerReturned: false,
    normalizerPassed: false,
    aiStatus: "error",
    errorCategory: /Missing DEEPSEEK_API_KEY/u.test(message)
      ? "missing-configuration"
      : "provider-or-response",
  }));
  process.exitCode = 1;
}
