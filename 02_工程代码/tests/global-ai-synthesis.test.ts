import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  normalizeGlobalSynthesisOutput,
  SiliconFlowGlobalInsightSynthesizer,
  type GlobalInsightSynthesizer,
  type GlobalSynthesisInput,
} from "../ai-service/src/index.js";
import { FixedCurrentUserContextProvider } from "../backend/src/current-user/index.js";
import {
  buildGlobalSynthesisInput,
  GlobalInsightSynthesisService,
  GLOBAL_SYNTHESIS_TOP_INSIGHT_COUNT,
} from "../backend/src/global-insight/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import {
  GlobalInsightsApiClient,
  GlobalInsightsApiError,
} from "../frontend/src/services/api/index.js";
import {
  createGlobalInsightsSnapshotFingerprint,
  GlobalSynthesisSession,
} from "../frontend/src/features/global-insights/synthesis-session.js";
import type { GlobalInsightsResult } from "../backend/src/global-insight/types.js";
import type { ModelAdapter } from "../scripts/ai-model-test.js";

test("global synthesis receives only Top N safe insights and calls the provider once", async () => {
  const facts = createFacts();
  const captured: GlobalSynthesisInput[] = [];
  const provider: GlobalInsightSynthesizer = {
    synthesize: async (input) => {
      captured.push(input);
      return outputFor(input);
    },
  };
  const service = new GlobalInsightSynthesisService({ getInsights: async () => facts }, provider);

  const first = await service.getSynthesis("user-a");
  const second = await service.getSynthesis("user-a");

  assert.equal(GLOBAL_SYNTHESIS_TOP_INSIGHT_COUNT, 3);
  assert.equal(captured.length, 1);
  assert.deepEqual(first, second);
  assert.deepEqual(captured[0]?.insights.map((insight) => insight.insightId), [
    "project-a:insight:1",
    "project-b:insight:1",
    "project-c:insight:1",
  ]);
  assert.equal(captured[0]?.insights[0]?.currentUserRole, "owner");
  assert.equal(captured[0]?.insights[1]?.currentUserRole, "member");
  assert.equal(JSON.stringify(captured).includes("secret-token"), false);
  assert.equal(JSON.stringify(captured).includes("data-source-ref"), false);
  assert.equal(first.priorities.map((priority) => priority.insightId).join(","),
    "project-a:insight:1,project-b:insight:1,project-c:insight:1");
});

test("global synthesis cache isolates user and underlying safe facts", async () => {
  let facts = createFacts();
  let calls = 0;
  const service = new GlobalInsightSynthesisService({ getInsights: async () => facts }, {
    synthesize: async (input) => {
      calls += 1;
      return outputFor(input);
    },
  });

  await service.getSynthesis("user-a");
  await service.getSynthesis("user-a");
  await service.getSynthesis("user-b");
  facts = {
    ...facts,
    insights: facts.insights.map((insight, index) => index === 0
      ? { ...insight, facts: ["已确认事实发生变化"] }
      : insight),
  };
  await service.getSynthesis("user-a");

  assert.equal(calls, 3);
});

test("global synthesis force refresh replaces cache and failed generations are retried", async () => {
  let calls = 0;
  let fail = false;
  const service = new GlobalInsightSynthesisService({ getInsights: async () => createFacts() }, {
    synthesize: async (input) => {
      calls += 1;
      if (fail) throw new Error("temporary provider failure");
      return { ...outputFor(input), summary: `generation-${String(calls)}` };
    },
  });

  assert.equal((await service.getSynthesis("user-a")).summary, "generation-1");
  assert.equal((await service.getSynthesis("user-a")).summary, "generation-1");
  assert.equal((await service.getSynthesis("user-a", { forceRefresh: true })).summary, "generation-2");
  assert.equal((await service.getSynthesis("user-a")).summary, "generation-2");

  fail = true;
  assert.equal((await service.getSynthesis("user-b")).status, "unavailable");
  fail = false;
  assert.equal((await service.getSynthesis("user-b")).status, "available");
  assert.equal(calls, 4);
});

test("global synthesis coalesces concurrent generation and keeps a bounded result cache", async () => {
  let facts = createFacts();
  let calls = 0;
  let release: (() => void) | undefined;
  const firstGeneration = new Promise<void>((resolve) => { release = resolve; });
  const service = new GlobalInsightSynthesisService({ getInsights: async () => facts }, {
    synthesize: async (input) => {
      calls += 1;
      if (calls === 1) await firstGeneration;
      return outputFor(input);
    },
  }, 2);

  const first = service.getSynthesis("user-a");
  const concurrent = service.getSynthesis("user-a", { forceRefresh: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release?.();
  await Promise.all([first, concurrent]);

  for (const fact of ["facts-b", "facts-c"]) {
    facts = withFirstFact(facts, fact);
    await service.getSynthesis("user-a");
  }
  facts = createFacts();
  await service.getSynthesis("user-a");
  assert.equal(calls, 4);
});

test("global synthesis normalizes safe fact ordering before fingerprinting and provider input", async () => {
  let facts = withFirstFact(createFacts(), "second", "first", "second");
  const captured: GlobalSynthesisInput[] = [];
  const service = new GlobalInsightSynthesisService({ getInsights: async () => facts }, {
    synthesize: async (input) => {
      captured.push(input);
      return outputFor(input);
    },
  });

  await service.getSynthesis("user-a");
  facts = withFirstFact(facts, "first", "second");
  await service.getSynthesis("user-a");

  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0]?.insights[0]?.facts, ["first", "second"]);
});

test("frontend synthesis session forces only its first visit, revalidates revisits, and supports manual refresh", async () => {
  const forceRefreshes: boolean[] = [];
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const client = {
    getInsights: async () => createInsightsSnapshot(),
    getSynthesis: async (_signal?: AbortSignal, forceRefresh = false) => {
      calls += 1;
      forceRefreshes.push(forceRefresh);
      if (calls === 1) await blocked;
      return {
        status: "available" as const,
        summary: `session-${String(calls)}`,
        priorities: [],
        limitations: [],
      };
    },
  };
  const session = new GlobalSynthesisSession();

  const first = session.requestForVisit(client);
  const strictModeReplay = session.requestForVisit(client);
  release?.();
  await Promise.all([first, strictModeReplay]);
  assert.equal(calls, 1);
  assert.equal(session.read()?.summary, "session-1");

  await session.requestForVisit(client);
  await session.forceRefresh(client);
  assert.deepEqual(forceRefreshes, [true, false, true]);

  const newSession = new GlobalSynthesisSession();
  await newSession.requestForVisit(client);
  assert.equal(forceRefreshes.at(-1), true);
});

test("frontend session stores deterministic risks, revalidates revisits, and preserves usable snapshots", async () => {
  let nextSnapshot = createInsightsSnapshot();
  let insightCalls = 0;
  let failInsights = false;
  let release: (() => void) | undefined;
  const firstRead = new Promise<void>((resolve) => { release = resolve; });
  const client = {
    getInsights: async () => {
      insightCalls += 1;
      if (insightCalls === 1) await firstRead;
      if (failInsights) throw new Error("temporary insights failure");
      return nextSnapshot;
    },
    getSynthesis: async () => ({
      status: "available" as const,
      summary: "safe",
      priorities: [],
      limitations: [],
    }),
  };
  const session = new GlobalSynthesisSession();

  assert.equal(session.readInsights(), null);
  const initial = session.revalidateInsights(client);
  const strictModeReplay = session.revalidateInsights(client);
  release?.();
  const [first, replay] = await Promise.all([initial, strictModeReplay]);
  assert.equal(insightCalls, 1);
  assert.strictEqual(first, replay);
  assert.strictEqual(session.readInsights(), first);

  nextSnapshot = createInsightsSnapshot(["same fact"]);
  const changed = await session.revalidateInsights(client);
  assert.equal(insightCalls, 2);
  assert.notStrictEqual(changed, first);
  nextSnapshot = createInsightsSnapshot(["same fact"]);
  const unchanged = await session.revalidateInsights(client);
  assert.equal(insightCalls, 3);
  assert.strictEqual(unchanged, changed);

  failInsights = true;
  await assert.rejects(session.revalidateInsights(client));
  assert.strictEqual(session.readInsights(), changed);

  const newSession = new GlobalSynthesisSession();
  assert.equal(newSession.readInsights(), null);
  assert.equal(
    createGlobalInsightsSnapshotFingerprint(createInsightsSnapshot(["b", "a", "b"])),
    createGlobalInsightsSnapshotFingerprint(createInsightsSnapshot(["a", "b"])),
  );
});

test("global synthesis preserves deterministic order and safely degrades malformed or unavailable AI", async () => {
  const facts = { ...createFacts(), partialFailure: true };
  const reverseProvider: GlobalInsightSynthesizer = {
    synthesize: async (input) => ({
      summary: "综合说明",
      priorities: [...input.insights].reverse().map((insight) => ({
        insightId: insight.insightId,
        explanation: `${insight.title} 的解释`,
        suggestedAction: "查看已确认事实后决定下一步。",
      })),
      limitations: [],
    }),
  };
  const limited = await new GlobalInsightSynthesisService(
    { getInsights: async () => facts },
    reverseProvider,
  ).getSynthesis("user-a");
  assert.equal(limited.status, "limited");
  assert.deepEqual(limited.priorities.map((priority) => priority.insightId), [
    "project-a:insight:1",
    "project-b:insight:1",
    "project-c:insight:1",
  ]);
  assert.match(limited.limitations.join(""), /部分项目/);

  const unavailable = await new GlobalInsightSynthesisService(
    { getInsights: async () => createFacts() },
    { synthesize: async () => { throw new Error("provider failed"); } },
  ).getSynthesis("user-a");
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.priorities.length, 0);
  assert.equal(unavailable.limitations.join("").includes("provider failed"), false);

  assert.throws(() => normalizeGlobalSynthesisOutput({
    summary: "bad",
    priorities: [{ insightId: "invented-insight", explanation: "bad", suggestedAction: "bad" }],
    limitations: [],
  }, buildGlobalSynthesisInput(createFacts())));
});

test("SiliconFlow global synthesizer uses one adapter request and rejects hallucinated insight IDs", async () => {
  const requests: Array<{ prompt: string; systemPrompt: string }> = [];
  const adapter: ModelAdapter = {
    invoke: async (request) => {
      requests.push(request);
      return {
        model: request.model,
        response: JSON.stringify({
          summary: "综合说明",
          priorities: [{
            insightId: "project-a:insight:1",
            explanation: "已确认的任务阻塞影响当前推进。",
            suggestedAction: "先核实阻塞原因并同步下一步。",
          }],
          limitations: [],
        }),
        latency: 1,
        tokenUsage: null,
        timestamp: "2026-08-26T00:00:00.000Z",
      };
    },
  };
  const synthesizer = new SiliconFlowGlobalInsightSynthesizer(adapter, "test-model", {
    info: () => undefined,
    error: () => undefined,
  });
  const input = buildGlobalSynthesisInput(createFacts());
  const output = await synthesizer.synthesize(input);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.prompt.includes("secret-token"), false);
  assert.match(requests[0]?.systemPrompt ?? "", /不得修改、重新排序或新增风险/);
  assert.equal(output.priorities[0]?.insightId, "project-a:insight:1");
});

test("synthesis API is optional, safe, and frontend treats it independently from blocker facts", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-global-synthesis-route-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
  const synthesisService = new GlobalInsightSynthesisService(
    { getInsights: async () => createFacts() },
    { synthesize: async (input) => outputFor(input) },
  );
  const server = createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider("user-a"),
    projectService,
    globalInsightSynthesisService: synthesisService,
  });
  context.after(() => closeServer(server));
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const response = await fetch(`${origin}/api/insights/synthesis`, { method: "POST" });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(body).includes("secret-token"), false);
  assert.equal(JSON.stringify(body).includes("data-source-ref"), false);
  const refreshed = await fetch(`${origin}/api/insights/synthesis?forceRefresh=true`, {
    method: "POST",
  });
  assert.equal(refreshed.status, 200);

  const productionServer = createEchoInsightServer({
    allowedFrontendOrigin: "https://echo.example",
    currentUserContextProvider: new FixedCurrentUserContextProvider("user-a"),
    environment: { NODE_ENV: "production" },
    globalInsightSynthesisService: synthesisService,
    projectService,
  });
  context.after(() => closeServer(productionServer));
  await listen(productionServer);
  const productionAddress = productionServer.address();
  assert.ok(productionAddress && typeof productionAddress === "object");
  const productionOrigin = `http://127.0.0.1:${String(productionAddress.port)}`;
  const crossOriginRefresh = await fetch(`${productionOrigin}/api/insights/synthesis?forceRefresh=true`, {
    method: "POST",
  });
  assert.equal(crossOriginRefresh.status, 403);
  const sameOriginRefresh = await fetch(`${productionOrigin}/api/insights/synthesis?forceRefresh=true`, {
    headers: { Origin: "https://echo.example" },
    method: "POST",
  });
  assert.equal(sameOriginRefresh.status, 200);

  const requestedUrls: string[] = [];
  const requestedMethods: string[] = [];
  const client = new GlobalInsightsApiClient(async (input, init) => {
    requestedUrls.push(String(input));
    requestedMethods.push(init?.method ?? "GET");
    return new Response(JSON.stringify({
      status: "available",
      summary: "safe",
      priorities: [{ insightId: "project-a:insight:1", explanation: "safe", suggestedAction: "safe" }],
      limitations: [],
    }), { status: 200 });
  });
  assert.equal((await client.getSynthesis()).status, "available");
  assert.equal((await client.getSynthesis(undefined, true)).status, "available");
  assert.deepEqual(requestedUrls, [
    "/api/insights/synthesis",
    "/api/insights/synthesis?forceRefresh=true",
  ]);
  assert.deepEqual(requestedMethods, ["POST", "POST"]);
  const unsafeClient = new GlobalInsightsApiClient(async () => new Response(JSON.stringify({
    status: "available",
    summary: "safe",
    priorities: [{ insightId: "project-a:insight:1", explanation: "safe", suggestedAction: "safe", baseToken: "forbidden" }],
    limitations: [],
  }), { status: 200 }));
  await assert.rejects(unsafeClient.getSynthesis(), (error: unknown) => (
    error instanceof GlobalInsightsApiError && error.code === "INVALID_INSIGHT_SYNTHESIS_RESPONSE"
  ));

  const page = await readFile(
    new URL("../frontend/src/pages/Insights/InsightsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /void loadInsights\(\);\s+void loadSynthesis\(\);/);
  assert.match(page, /更新 AI 洞察/);
  assert.match(page, /globalSynthesisSession\.forceRefresh/);
  assert.match(page, /globalSynthesisSession\.readInsights\(\)/);
  assert.match(page, /status === "loading" && !result/);
  assert.match(page, /await globalSynthesisSession\.revalidateInsights\(client\);[\s\S]*await globalSynthesisSession\.forceRefresh\(client\);/);
  assert.match(page, /AI 综合洞察/);
  assert.doesNotMatch(page, /<input|chat|问问 AI|Prompt/iu);
});

function createFacts(): GlobalInsightsResult {
  return {
    insights: [
      insight("project-a:insight:1", "Project A", "owner", "L5", "任务阻塞", ["当前任务状态为阻塞。"]),
      insight("project-b:insight:1", "Project B", "member", "L4", "任务逾期", ["计划完成时间已过。"]),
      insight("project-c:insight:1", "Project C", "member", "L3", "依赖受阻", ["前置事项未完成。"]),
      insight("project-d:insight:1", "Project D", "owner", "L2", "信息待补充", ["缺少部分项目事实。"]),
    ],
    partialFailure: false,
  };
}

function insight(
  id: string,
  projectName: string,
  currentUserRole: "owner" | "member",
  riskLevel: "L1" | "L2" | "L3" | "L4" | "L5",
  title: string,
  facts: string[],
) {
  return {
    id,
    projectId: `internal-${id}`,
    projectName,
    currentUserRole,
    riskLevel,
    title,
    facts,
    ruleBasis: "系统规则已确认该风险事实。",
  };
}

function outputFor(input: GlobalSynthesisInput) {
  return {
    summary: "已按系统确定的风险顺序综合解释当前重点。",
    priorities: input.insights.map((insight) => ({
      insightId: insight.insightId,
      explanation: `${insight.title}需要优先关注。`,
      suggestedAction: "基于已确认事实确认下一步处理人和动作。",
    })),
    limitations: [],
  };
}

function createInsightsSnapshot(facts = ["initial fact"]) {
  return {
    insights: [{
      id: "project-a:insight:1",
      projectId: "project-a",
      projectName: "Project A",
      currentUserRole: "owner" as const,
      riskLevel: "L5" as const,
      title: "任务阻塞",
      facts,
      ruleBasis: "系统规则已确认该风险事实。",
    }],
    partialFailure: false,
  };
}

function withFirstFact(
  facts: GlobalInsightsResult,
  ...firstInsightFacts: string[]
): GlobalInsightsResult {
  return {
    ...facts,
    insights: facts.insights.map((insight, index) => index === 0
      ? { ...insight, facts: firstInsightFacts }
      : insight),
  };
}

async function listen(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
