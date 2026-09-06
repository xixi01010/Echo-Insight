import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  readClientCacheEpoch,
} from "../frontend/src/features/ai-access/client-cache-epoch.js";
import {
  clearAiDerivedClientCaches,
  clearAuthenticatedClientCaches,
} from "../frontend/src/features/ai-access/clear-ai-caches.js";
import { globalSynthesisSession } from "../frontend/src/features/global-insights/synthesis-session.js";
import {
  AiSettingsApiClient,
  AiSettingsApiError,
} from "../frontend/src/services/api/ai-settings.js";
import { writeProjectIntelligenceCache } from "../frontend/src/services/api/intelligence-cache.js";
import { writeProjectReportCache } from "../frontend/src/services/api/report-cache.js";
import type {
  ProjectIntelligence,
  ProjectReport,
} from "../frontend/src/services/api/types.js";

test("AI connection changes clear browser AI caches without deleting unrelated preferences", async () => {
  const storage = new MemoryStorage([
    ["echo-insight:project-report:v2", "report"],
    ["echo-insight:project-report:v2:project:project-a", "report-a"],
    ["echo-insight:project-intelligence:v1:project:project-a", "intelligence-a"],
    ["echo-insight:project-list:v1", "project-list"],
    ["echo-insight:preferences:v1", "preferences"],
  ]);
  globalSynthesisSession.reset();
  await globalSynthesisSession.requestForVisit({
    getInsights: async () => ({ insights: [], partialFailure: false }),
    getSynthesis: async () => ({
      status: "available",
      summary: "old provider output",
      priorities: [],
      limitations: [],
    }),
  });
  assert.equal(globalSynthesisSession.read()?.summary, "old provider output");

  clearAiDerivedClientCaches(storage);

  assert.equal(globalSynthesisSession.read(), null);
  assert.equal(storage.getItem("echo-insight:project-report:v2"), null);
  assert.equal(storage.getItem("echo-insight:project-report:v2:project:project-a"), null);
  assert.equal(storage.getItem("echo-insight:project-intelligence:v1:project:project-a"), null);
  assert.equal(storage.getItem("echo-insight:project-list:v1"), "project-list");
  assert.equal(storage.getItem("echo-insight:preferences:v1"), "preferences");
});

test("logout also clears the browser project-list snapshot", () => {
  const storage = new MemoryStorage([
    ["echo-insight:project-list:v1", "project-list"],
    ["echo-insight:preferences:v1", "preferences"],
  ]);

  clearAuthenticatedClientCaches(storage);

  assert.equal(storage.getItem("echo-insight:project-list:v1"), null);
  assert.equal(storage.getItem("echo-insight:preferences:v1"), "preferences");
});

test("late AI responses cannot repopulate report or intelligence caches after invalidation", () => {
  const storage = new MemoryStorage([]);
  const requestEpoch = readClientCacheEpoch();
  clearAiDerivedClientCaches(storage);

  assert.equal(
    writeProjectReportCache(storage, safeReport, "project-a", requestEpoch),
    false,
  );
  assert.equal(
    writeProjectIntelligenceCache(storage, "project-a", safeIntelligence, requestEpoch),
    false,
  );
  assert.equal(storage.getItem("echo-insight:project-report:v2:project:project-a"), null);
  assert.equal(storage.getItem("echo-insight:project-intelligence:v1:project:project-a"), null);
});

test("AI settings client disables browser caching and returns only the strict status DTO", async () => {
  let requestInit: RequestInit | undefined;
  let requestUrl: RequestInfo | URL | undefined;
  const expected = {
    mode: "visitor" as const,
    configured: true,
    setupRequired: false,
    storage: "server-account-encrypted" as const,
    providerId: "deepseek" as const,
    providerName: "DeepSeek",
    model: "deepseek-chat",
  };
  const client = new AiSettingsApiClient(async (input, init) => {
    requestUrl = input;
    requestInit = init;
    return new Response(JSON.stringify(expected), { status: 200 });
  });

  assert.deepEqual(await client.getStatus(), expected);
  assert.equal(requestInit?.cache, "no-store");
  assert.equal(requestInit?.credentials, "include");
  assert.equal(requestUrl, "/api/settings/ai?storage-contract=account-v1");
});

test("AI settings client remains compatible with the previous storage status during deployment", async () => {
  const legacyStatus = {
    mode: "visitor" as const,
    configured: false,
    setupRequired: true,
    storage: "server-session-memory" as const,
  };
  const client = new AiSettingsApiClient(async () => new Response(
    JSON.stringify(legacyStatus),
    { status: 200 },
  ));

  assert.deepEqual(await client.getStatus(), legacyStatus);
});

test("AI settings client rejects additional API key and unknown response fields", async () => {
  const safeStatus = {
    mode: "visitor",
    configured: false,
    setupRequired: true,
    storage: "server-account-encrypted",
  };
  for (const payload of [
    { ...safeStatus, apiKey: "must-not-enter-client-contract" },
    { ...safeStatus, debug: "unexpected" },
  ]) {
    const client = new AiSettingsApiClient(async () => new Response(
      JSON.stringify(payload),
      { status: 200 },
    ));
    await assert.rejects(client.getStatus(), (error: unknown) => (
      error instanceof AiSettingsApiError && error.status === 200
    ));
  }
});

test("credential transitions invalidate caches before requests and clear the key field after failure", async () => {
  const aiAccessSource = await readFile(
    new URL("../frontend/src/features/ai-access/AiAccessContext.tsx", import.meta.url),
    "utf8",
  );
  const authSource = await readFile(
    new URL("../frontend/src/features/auth/AuthContext.tsx", import.meta.url),
    "utf8",
  );
  const formSource = await readFile(
    new URL("../frontend/src/features/ai-access/AiConnectionForm.tsx", import.meta.url),
    "utf8",
  );

  assertAppearsBefore(aiAccessSource, "const connect =", "clearAiDerivedClientCaches(window.localStorage);", "await client.connect");
  assertAppearsBefore(aiAccessSource, "const skip =", "clearAiDerivedClientCaches(window.localStorage);", "await client.skip");
  assertAppearsBefore(aiAccessSource, "const disconnect =", "clearAiDerivedClientCaches(window.localStorage);", "await client.disconnect");
  assertAppearsBefore(authSource, "const logout =", "clearAuthenticatedClientCaches(window.localStorage);", "await client.logout");
  assertAppearsBefore(authSource, "const refreshStatus =", "clearAuthenticatedClientCaches(window.localStorage);", "await client.getStatus");
  assert.match(
    formSource,
    /try \{\s*await aiAccess\.connect\(providerId, apiKey\);\s*\} finally \{\s*setApiKey\(""\);\s*\}/u,
  );
});

const safeReport: ProjectReport = {
  analysis: {
    healthScore: 100,
    healthStatus: "healthy",
    riskLevel: "L1",
    riskSignals: [],
    scoringDetails: { calculatedAt: "2026-09-05T00:00:00.000Z", totalDeduction: 0 },
  },
  riskContexts: [],
  aiReport: { risks: [], limitations: [] },
};

const safeIntelligence: ProjectIntelligence = {
  currentFacts: [],
  confirmedRisks: [],
  potentialSignals: [],
  conflicts: [],
  freshness: [],
  ai: { status: "unavailable", explanations: [], limitations: [] },
};

function assertAppearsBefore(
  source: string,
  sectionStart: string,
  first: string,
  second: string,
): void {
  const startIndex = source.indexOf(sectionStart);
  const firstIndex = source.indexOf(first, startIndex);
  const secondIndex = source.indexOf(second, startIndex);
  assert.notEqual(startIndex, -1);
  assert.ok(firstIndex > startIndex);
  assert.ok(secondIndex > firstIndex);
}

class MemoryStorage {
  private readonly values: Map<string, string>;

  constructor(entries: Array<[string, string]>) {
    this.values = new Map(entries);
  }

  get length(): number {
    return this.values.size;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
