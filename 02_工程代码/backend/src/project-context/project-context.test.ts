import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AiExplanationInput,
  AiExplanationOutput,
  RiskExplanationAnalyzer,
} from "../../../ai-service/src/index.js";
import type {
  ProjectDataReader,
  StandardProjectData,
} from "../../../feishu-connector/src/index.js";
import { ProjectReportService } from "../ai-analysis-service/index.js";
import { ProjectAnalysisService } from "../analysis-service/index.js";
import { toFeishuOpenIdIdentityRef } from "../current-user/index.js";
import {
  JsonProjectRepository,
  ProjectService,
} from "../project-service/index.js";
import {
  ProjectContextAccessDeniedError,
  ProjectContextReportService,
  ProjectContextService,
  type ProjectDataSourceVisibilityChecker,
  ProjectDataSourceResolver,
  JsonProjectDataSourceRegistry,
  toProjectDataSourceVisibility,
} from "./index.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const DATA_SOURCE_REF = "source-primary-feishu-base";
const REAL_BASE_TOKEN = "server-only-real-base-token";

async function createTestContext() {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-project-context-"));
  const projectStorePath = join(directory, "projects.json");
  const projectService = new ProjectService(
    new JsonProjectRepository(projectStorePath),
    () => NOW,
    () => "project-1",
  );
  const project = await projectService.createProject({
    name: "V2 Project",
    creatorId: "user-creator",
    ownerId: "user-owner",
    members: ["user-member"],
    dataSourceRefs: [DATA_SOURCE_REF],
  });
  const dataSourceResolver = new ProjectDataSourceResolver(
    new Map([
      [DATA_SOURCE_REF, { kind: "feishu-base", baseToken: REAL_BASE_TOKEN }],
    ]),
  );
  const contextService = new ProjectContextService(
    projectService,
    dataSourceResolver,
  );

  return {
    contextService,
    directory,
    project,
    projectService,
    projectStorePath,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("resolves an authorized Project Context with server-only data sources", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  const resolved = await testContext.contextService.resolve(
    testContext.project.id,
    "user-owner",
  );

  assert.equal(resolved.projectId, testContext.project.id);
  assert.equal(resolved.userId, "user-owner");
  assert.equal(resolved.membership.role, "owner");
  assert.equal(resolved.projectMetadata.name, "V2 Project");
  assert.deepEqual(resolved.resolvedDataSources, [{
    ref: DATA_SOURCE_REF,
    kind: "feishu-base",
    baseToken: REAL_BASE_TOKEN,
  }]);
});

test("does not resolve data sources for a user without project access", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  await assert.rejects(
    testContext.contextService.resolve(testContext.project.id, "user-outsider"),
    (error: unknown) => error instanceof ProjectContextAccessDeniedError,
  );
});

test("keeps data-source references separate from credentials and orchestrates the V1 report service", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  const persistedStore = await readFile(testContext.projectStorePath, "utf8");
  assert.equal(persistedStore.includes(DATA_SOURCE_REF), true);
  assert.equal(persistedStore.includes(REAL_BASE_TOKEN), false);

  const requestedTokens: string[] = [];
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      requestedTokens.push(baseToken);
      return projectData();
    },
  };
  const reportService = new ProjectReportService(
    new ProjectAnalysisService(reader, () => NOW),
    new EmptyExplanationAnalyzer(),
  );
  const contextReportService = new ProjectContextReportService(
    testContext.contextService,
    reportService,
  );

  const report = await contextReportService.createProjectReport(
    testContext.project.id,
    "user-member",
  );

  assert.deepEqual(requestedTokens, [REAL_BASE_TOKEN]);
  assert.equal(report.analysis.healthStatus, "healthy");
});

test("resolves the report generator from the current server-only session subject", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);
  const resolvedSubjects: Array<{ userId: string; sessionId?: string }> = [];
  const contextReportService = new ProjectContextReportService(
    testContext.contextService,
    (subject) => {
      resolvedSubjects.push({
        userId: subject.userId,
        ...(subject.sessionId ? { sessionId: subject.sessionId } : {}),
      });
      return {
        createProjectReport: async () => ({
          analysis: { healthStatus: "healthy" },
          riskContexts: [],
          aiStatus: "available",
          aiReport: { risks: [], limitations: [] },
        }) as never,
      };
    },
  );

  await contextReportService.createProjectReport(testContext.project.id, {
    userId: "user-member",
    sessionId: "session-member",
  });

  assert.deepEqual(resolvedSubjects, [{
    userId: "user-member",
    sessionId: "session-member",
  }]);
});

test("keeps pending non-Base refs out of the V2 Base report path", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);
  const project = await testContext.contextService.resolve(testContext.project.id, "user-owner");
  const resolver = new ProjectDataSourceResolver(new Map([
    [DATA_SOURCE_REF, { kind: "feishu-base" as const, baseToken: REAL_BASE_TOKEN }],
    ["source-pending-chat", { kind: "feishu-chat" as const, enabled: false }],
  ]));
  const expandedProject = {
    ...testContext.project,
    dataSourceRefs: [...testContext.project.dataSourceRefs, "source-pending-chat"],
  };

  assert.equal(project.resolvedDataSources.length, 1);
  assert.deepEqual(resolver.resolve(expandedProject), [{
    ref: DATA_SOURCE_REF,
    kind: "feishu-base",
    baseToken: REAL_BASE_TOKEN,
  }]);
});

test("filters each Project Source before report analysis without extending Owner access to Members", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);
  const ownerOnlyRef = "source-owner-only";
  const unknownRef = "source-unknown";
  const expandedProject = await testContext.projectService.replaceDataSourceRefs(
    testContext.project.id,
    [DATA_SOURCE_REF, ownerOnlyRef, unknownRef],
  );
  assert.ok(expandedProject);

  const checker: ProjectDataSourceVisibilityChecker = {
    check: ({ sourceRef, subject }) => {
      if (sourceRef === unknownRef) {
        return { sourceAuthorization: "unknown", subjectEligibility: "unknown" };
      }
      if (sourceRef === ownerOnlyRef && subject.userId !== "user-owner") {
        return { sourceAuthorization: "authorized", subjectEligibility: "denied" };
      }
      return { sourceAuthorization: "authorized", subjectEligibility: "allowed" };
    },
  };
  const contextService = new ProjectContextService(
    testContext.projectService,
    new ProjectDataSourceResolver(new Map([
      [DATA_SOURCE_REF, { kind: "feishu-base", baseToken: REAL_BASE_TOKEN }],
      [ownerOnlyRef, { kind: "feishu-base", baseToken: "owner-only-token" }],
      [unknownRef, { kind: "feishu-base", baseToken: "unknown-token" }],
    ]), checker),
  );

  const ownerContext = await contextService.resolve(testContext.project.id, "user-owner");
  const memberContext = await contextService.resolve(testContext.project.id, "user-member");
  assert.deepEqual(ownerContext.resolvedDataSources.map((source) => source.ref), [DATA_SOURCE_REF, ownerOnlyRef]);
  assert.deepEqual(memberContext.resolvedDataSources.map((source) => source.ref), [DATA_SOURCE_REF]);

  const requestedTokens: string[] = [];
  const reportService = new ProjectContextReportService(contextService, {
    createProjectReport: async (baseToken) => {
      requestedTokens.push(baseToken);
      return { analysis: {}, riskContexts: [], aiReport: { risks: [], limitations: [] } } as never;
    },
  });
  await reportService.createProjectReport(testContext.project.id, "user-member");
  assert.deepEqual(requestedTokens, [REAL_BASE_TOKEN]);
});

test("an unresolved typed identity cannot enter a Source until authorization evidence allows it", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);
  const contextService = new ProjectContextService(
    testContext.projectService,
    new ProjectDataSourceResolver(new Map([
      [DATA_SOURCE_REF, { kind: "feishu-base", baseToken: REAL_BASE_TOKEN }],
    ]), {
      check: ({ subject }) => subject.identity
        ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" }
        : { sourceAuthorization: "unknown", subjectEligibility: "unknown" },
    }),
  );

  const unresolved = await contextService.resolve(testContext.project.id, "user-member");
  assert.deepEqual(unresolved.resolvedDataSources, []);

  const resolved = await contextService.resolve(testContext.project.id, {
    userId: "user-member",
    identity: toFeishuOpenIdIdentityRef("ou_member", "echo-insight-app"),
  });
  assert.equal(resolved.resolvedDataSources.length, 1);
});

test("Source authorization states deny Context entry unless both Source and subject are allowed", () => {
  assert.equal(toProjectDataSourceVisibility({
    sourceAuthorization: "authorized", subjectEligibility: "allowed",
  }), "allowed");
  assert.equal(toProjectDataSourceVisibility({
    sourceAuthorization: "authorized", subjectEligibility: "denied",
  }), "denied");
  assert.equal(toProjectDataSourceVisibility({
    sourceAuthorization: "authorized", subjectEligibility: "unknown",
  }), "unknown");
  assert.equal(toProjectDataSourceVisibility({
    sourceAuthorization: "unavailable", subjectEligibility: "allowed",
  }), "source-unavailable");
  assert.equal(toProjectDataSourceVisibility({
    sourceAuthorization: "unknown", subjectEligibility: "allowed",
  }), "unknown");
});

test("loads legacy Base records and enforces project ownership for registry refs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-source-registry-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const registryPath = join(directory, "data-sources.json");
  await writeFile(registryPath, JSON.stringify({
    version: 1,
    sources: [{
      projectId: "project-a",
      ref: "source-legacy-base",
      kind: "feishu-base",
      baseToken: REAL_BASE_TOKEN,
    }],
  }), "utf8");
  const registry = new JsonProjectDataSourceRegistry(registryPath);
  await registry.ensureReady();

  assert.deepEqual(registry.getForProject("project-a", "source-legacy-base"), {
    kind: "feishu-base",
    baseToken: REAL_BASE_TOKEN,
  });
  assert.equal(registry.getForProject("project-b", "source-legacy-base"), undefined);
  assert.throws(() => new ProjectDataSourceResolver(registry).resolve({
    id: "project-b",
    name: "Foreign source project",
    creatorId: "user-b",
    ownerId: "user-b",
    members: [],
    dataSourceRefs: ["source-legacy-base"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  }), /not registered/u);

  await registry.registerPendingSource("project-a", "source-pending-chat", "feishu-chat");
  assert.deepEqual(registry.getForProject("project-a", "source-pending-chat"), {
    kind: "feishu-chat",
    enabled: false,
  });
  await assert.rejects(
    registry.setEnabled("project-a", "source-pending-chat", true),
    /cannot be enabled/u,
  );
  assert.equal(await registry.remove("project-b", "source-pending-chat"), false);
  assert.equal(await registry.remove("project-a", "source-pending-chat"), true);

  const persisted = await readFile(registryPath, "utf8");
  assert.equal(persisted.includes(REAL_BASE_TOKEN), true);
  assert.equal(persisted.includes("source-pending-chat"), false);
});

class EmptyExplanationAnalyzer implements RiskExplanationAnalyzer {
  async analyze(_input: AiExplanationInput): Promise<AiExplanationOutput> {
    return { risks: [], limitations: [] };
  }
}

function projectData(): StandardProjectData {
  return {
    project: {
      id: "feishu-project-1",
      name: "V2 Project",
      source: "feishu-base",
    },
    tasks: [],
    metadata: {
      baseToken: REAL_BASE_TOKEN,
      tableCount: 0,
      recordCount: 0,
      retrievedAt: NOW.toISOString(),
      accessMode: "read-only",
      tables: [],
    },
  };
}
