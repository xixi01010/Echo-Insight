import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ProjectAnalysisService } from "../backend/src/analysis-service/index.js";
import { FixedCurrentUserContextProvider } from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import {
  ProjectContextService,
  ProjectContextSummaryService,
  type ProjectDataSourceVisibilityChecker,
  ProjectDataSourceResolver,
} from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import type { ProjectDataReader, StandardProjectData } from "../feishu-connector/src/index.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const TOKEN_A = "summary-source-a";
const TOKEN_B = "summary-source-b";

test("Project summary uses deterministic analysis, caches per project, and does not use AI", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const summaryA = await fixture.summaryService.createProjectSummary(
    fixture.projectA.id,
    "user-owner",
  );
  const cachedSummaryA = await fixture.summaryService.createProjectSummary(
    fixture.projectA.id,
    "user-owner",
  );
  const summaryB = await fixture.summaryService.createProjectSummary(
    fixture.projectB.id,
    "user-owner",
  );

  assert.deepEqual(summaryA, {
    healthScore: 75,
    healthStatus: "needs-attention",
    riskCount: 1,
  });
  assert.deepEqual(cachedSummaryA, summaryA);
  assert.deepEqual(summaryB, {
    healthScore: 100,
    healthStatus: "healthy",
    riskCount: 0,
  });
  assert.deepEqual(fixture.requestedTokens, [TOKEN_A, TOKEN_B]);

  const refreshedSummaryA = await fixture.summaryService.createProjectSummary(
    fixture.projectA.id,
    "user-owner",
    true,
  );
  assert.deepEqual(refreshedSummaryA, summaryA);
  assert.deepEqual(fixture.requestedTokens, [TOKEN_A, TOKEN_B, TOKEN_A]);

  await assert.rejects(
    fixture.summaryService.createProjectSummary(fixture.projectA.id, "user-other"),
  );
  const source = await readFile(
    new URL("../backend/src/project-context/project-context-summary-service.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /ProjectAnalysisService/);
  assert.doesNotMatch(source, /from "\.\.\/ai-analysis-service|SiliconFlow/);
});

test("concurrent force refreshes share one new deterministic summary request", async (context) => {
  let resolveCalls = 0;
  let releaseContexts: (() => void) | undefined;
  const contextsReady = new Promise<void>((resolve) => {
    releaseContexts = resolve;
  });
  const contextService = {
    resolve: async () => {
      resolveCalls += 1;
      if (resolveCalls < 2) await contextsReady;
      return {
        projectId: "project-a",
        userId: "user-owner",
        resolvedDataSources: [{ kind: "feishu-base", baseToken: TOKEN_A }],
      };
    },
  } as unknown as ProjectContextService;
  let readCount = 0;
  const summaryService = new ProjectContextSummaryService(
    contextService,
    new ProjectAnalysisService({
      readProjectData: async (baseToken) => {
        readCount += 1;
        return projectData(baseToken, "阻塞");
      },
    }, () => NOW),
  );

  const first = summaryService.createProjectSummary("project-a", "user-owner", true);
  const second = summaryService.createProjectSummary("project-a", "user-owner", true);
  releaseContexts?.();

  const [firstSummary, secondSummary] = await Promise.all([first, second]);
  assert.deepEqual(firstSummary, secondSummary);
  assert.equal(readCount, 1);
});

test("project summaries never reuse one member's visible Source result for another member", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-summary-visibility-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
  const project = await projectService.createProject({
    name: "Visibility", creatorId: "user-owner", ownerId: "user-owner", members: ["user-member"],
    dataSourceRefs: ["source-owner", "source-member"],
  });
  const checker: ProjectDataSourceVisibilityChecker = {
    check: ({ sourceRef, subject }) => ({
      sourceAuthorization: "authorized",
      subjectEligibility: sourceRef === `source-${subject.userId.replace("user-", "")}` ? "allowed" : "denied",
    }),
  };
  const requestedTokens: string[] = [];
  const summaryService = new ProjectContextSummaryService(
    new ProjectContextService(projectService, new ProjectDataSourceResolver(new Map([
      ["source-owner", { kind: "feishu-base", baseToken: TOKEN_A }],
      ["source-member", { kind: "feishu-base", baseToken: TOKEN_B }],
    ]), checker)),
    new ProjectAnalysisService({
      readProjectData: async (baseToken) => {
        requestedTokens.push(baseToken);
        return projectData(baseToken, baseToken === TOKEN_A ? "阻塞" : "进行中");
      },
    }, () => NOW),
  );

  const owner = await summaryService.createProjectSummary(project.id, "user-owner");
  const member = await summaryService.createProjectSummary(project.id, "user-member");
  assert.equal(owner.healthStatus, "needs-attention");
  assert.equal(member.healthStatus, "healthy");
  assert.deepEqual(requestedTokens, [TOKEN_A, TOKEN_B]);
});

test("project list adds available summaries without leaking sources or failing the whole list", async (context) => {
  const fixture = await createFixture({ registeredRefs: ["source-a"] });
  context.after(fixture.cleanup);
  const server = createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider("user-owner"),
    projectContextSummaryService: fixture.summaryService,
    projectService: fixture.projectService,
  });
  context.after(() => closeServer(server));
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/projects`);
  const body = await response.json() as { projects: Array<Record<string, unknown>> };
  const summaryA = body.projects.find((project) => project.id === fixture.projectA.id);
  const summaryB = body.projects.find((project) => project.id === fixture.projectB.id);

  assert.equal(response.status, 200);
  assert.deepEqual(summaryA?.healthScore, 75);
  assert.deepEqual(summaryA?.healthStatus, "needs-attention");
  assert.deepEqual(summaryA?.riskCount, 1);
  assert.equal(summaryB?.healthScore, undefined);
  assert.equal(summaryB?.healthStatus, undefined);
  assert.equal(summaryB?.riskCount, undefined);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes(TOKEN_A), false);
  assert.equal(serialized.includes("source-a"), false);
  assert.equal(serialized.includes("owner-internal-id"), false);
});

test("project summary list limits concurrent deterministic reads", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-summary-concurrency-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectService = new ProjectService(
    new JsonProjectRepository(join(directory, "projects.json")),
    () => NOW,
  );
  const registrations = new Map<string, { kind: "feishu-base"; baseToken: string }>();
  for (const index of [1, 2, 3, 4]) {
    await projectService.createProject({
      name: `Project ${String(index)}`,
      creatorId: "user-owner",
      ownerId: "user-owner",
      dataSourceRefs: [`source-${String(index)}`],
    });
    registrations.set(`source-${String(index)}`, {
      kind: "feishu-base",
      baseToken: `token-${String(index)}`,
    });
  }
  let activeReads = 0;
  let maximumActiveReads = 0;
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      activeReads -= 1;
      return projectData(baseToken, "进行中");
    },
  };
  const summaryService = new ProjectContextSummaryService(
    new ProjectContextService(projectService, new ProjectDataSourceResolver(registrations)),
    new ProjectAnalysisService(reader, () => NOW),
  );
  const server = createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider("user-owner"),
    projectContextSummaryService: summaryService,
    projectService,
  });
  context.after(() => closeServer(server));
  await listen(server);
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/projects`);
  const body = await response.json() as { projects: unknown[] };

  assert.equal(response.status, 200);
  assert.equal(body.projects.length, 4);
  assert.equal(maximumActiveReads <= 3, true);
});

async function createFixture(options: {
  registeredRefs?: string[];
  readProjectData?: (baseToken: string) => Promise<StandardProjectData>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-project-summary-"));
  const projectService = new ProjectService(
    new JsonProjectRepository(join(directory, "projects.json")),
    () => NOW,
  );
  const projectA = await projectService.createProject({
    name: "Project A",
    creatorId: "creator-a",
    ownerId: "user-owner",
    dataSourceRefs: ["source-a"],
  });
  const projectB = await projectService.createProject({
    name: "Project B",
    creatorId: "creator-b",
    ownerId: "user-owner",
    dataSourceRefs: ["source-b"],
  });
  const requestedTokens: string[] = [];
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      if (options.readProjectData) return options.readProjectData(baseToken);
      requestedTokens.push(baseToken);
      return projectData(baseToken, baseToken === TOKEN_A ? "阻塞" : "进行中");
    },
  };
  const allRegistrations = new Map([
    ["source-a", { kind: "feishu-base" as const, baseToken: TOKEN_A }],
    ["source-b", { kind: "feishu-base" as const, baseToken: TOKEN_B }],
  ]);
  const registrations = new Map(
    (options.registeredRefs ?? ["source-a", "source-b"]).map((ref) => [
      ref,
      allRegistrations.get(ref)!,
    ]),
  );
  const summaryService = new ProjectContextSummaryService(
    new ProjectContextService(projectService, new ProjectDataSourceResolver(registrations)),
    new ProjectAnalysisService(reader, () => NOW),
  );

  return {
    projectA,
    projectB,
    projectService,
    requestedTokens,
    summaryService,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

function projectData(baseToken: string, status: string): StandardProjectData {
  return {
    project: { id: `project-for-${baseToken}`, name: "Analyzed Project", source: "feishu-base" },
    tasks: [{
      id: `task-for-${baseToken}`,
      tableId: "table-1",
      tableName: "Tasks",
      name: "Implementation",
      owner: "Task Owner",
      status,
      deadline: "2026-08-30",
      riskLevel: "L3",
      description: null,
      attributes: {},
    }],
    metadata: {
      baseToken,
      tableCount: 1,
      recordCount: 1,
      retrievedAt: NOW.toISOString(),
      accessMode: "read-only",
      tables: [{ id: "table-1", name: "Tasks", recordCount: 1 }],
    },
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
