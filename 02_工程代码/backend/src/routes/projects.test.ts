import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { ProjectAnalysisService } from "../analysis-service/index.js";
import { ProjectReportService } from "../ai-analysis-service/index.js";
import { FixedCurrentUserContextProvider } from "../current-user/index.js";
import { createEchoInsightServer } from "../index.js";
import {
  ProjectContextReportService,
  ProjectContextService,
  ProjectDataSourceResolver,
} from "../project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../project-service/index.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");
const TOKEN_A = "server-only-base-token-a";
const TOKEN_B = "server-only-base-token-b";

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-project-api-"));
  let nextId = 1;
  const projectService = new ProjectService(
    new JsonProjectRepository(join(directory, "projects.json")),
    () => NOW,
    () => `project-${String(nextId++)}`,
  );
  const ownerProject = await projectService.createProject({
    name: "Owner Project",
    creatorId: "creator-owner",
    ownerId: "user-owner",
    members: ["user-member"],
    dataSourceRefs: ["source-a"],
  });
  const otherProject = await projectService.createProject({
    name: "Other Project",
    creatorId: "creator-other",
    ownerId: "user-other",
    members: [],
    dataSourceRefs: ["source-b"],
  });
  const creatorOnlyProject = await projectService.createProject({
    name: "Creator Only Project",
    creatorId: "user-creator-only",
    ownerId: "user-other",
    members: [],
    dataSourceRefs: ["source-b"],
  });
  const requestedTokens: string[] = [];
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      requestedTokens.push(baseToken);
      return projectData(baseToken);
    },
  };
  const reportService = new ProjectReportService(
    new ProjectAnalysisService(reader, () => NOW),
    new EmptyExplanationAnalyzer(),
  );
  const dataSourceResolver = new ProjectDataSourceResolver(new Map([
    ["source-a", { kind: "feishu-base", baseToken: TOKEN_A }],
    ["source-b", { kind: "feishu-base", baseToken: TOKEN_B }],
  ]));
  const contextReportService = new ProjectContextReportService(
    new ProjectContextService(projectService, dataSourceResolver),
    reportService,
  );

  return {
    creatorOnlyProject,
    directory,
    otherProject,
    ownerProject,
    projectService,
    reader,
    contextReportService,
    requestedTokens,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function requestForUser(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  userId: string,
  path: string,
  options: RequestInit = {},
) {
  const server = createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider(userId),
    projectService: fixture.projectService,
    reader: fixture.reader,
    projectContextReportService: fixture.contextReportService,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const url = `http://127.0.0.1:${String(address.port)}${path}`;
    return await fetch(url, options);
  } finally {
    await closeServer(server);
  }
}

test("GET /api/projects returns only the current owner's projects as safe DTOs", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const response = await requestForUser(
    fixture,
    "user-owner",
    "/api/projects",
    { headers: { "x-user-id": "user-other" } },
  );
  const body = await response.json() as { projects: Record<string, unknown>[] };

  assert.equal(response.status, 200);
  assert.deepEqual(body.projects, [projectDto(fixture.ownerProject.id, "Owner Project", "owner")]);
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("dataSourceRefs"), false);
  assert.equal(serialized.includes(TOKEN_A), false);
  assert.equal(serialized.includes("creator-owner"), false);
  assert.equal(serialized.includes("user-member"), false);
});

test("GET /api/projects filters by Owner or Member, not Creator", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const memberResponse = await requestForUser(fixture, "user-member", "/api/projects");
  const creatorResponse = await requestForUser(fixture, "user-creator-only", "/api/projects");
  const memberBody = await memberResponse.json() as { projects: Record<string, unknown>[] };
  const creatorBody = await creatorResponse.json() as { projects: unknown[] };

  assert.equal(memberResponse.status, 200);
  assert.deepEqual(memberBody.projects, [projectDto(fixture.ownerProject.id, "Owner Project", "member")]);
  assert.equal(creatorResponse.status, 200);
  assert.deepEqual(creatorBody.projects, []);
  assert.equal(fixture.creatorOnlyProject.creatorId, "user-creator-only");
});

test("project detail hides unauthorized and nonexistent projects equally", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const unauthorized = await requestForUser(
    fixture,
    "user-owner",
    `/api/projects/${fixture.otherProject.id}`,
  );
  const nonexistent = await requestForUser(fixture, "user-owner", "/api/projects/project-missing");

  assert.equal(unauthorized.status, 404);
  assert.equal(nonexistent.status, 404);
  assert.deepEqual(await unauthorized.json(), await nonexistent.json());
});

test("project report enforces membership and uses the selected server-only data source", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const allowed = await requestForUser(
    fixture,
    "user-member",
    `/api/projects/${fixture.ownerProject.id}/report`,
    { method: "POST" },
  );
  const otherProjectReport = await requestForUser(
    fixture,
    "user-other",
    `/api/projects/${fixture.otherProject.id}/report`,
    { method: "POST" },
  );
  const denied = await requestForUser(
    fixture,
    "user-owner",
    `/api/projects/${fixture.otherProject.id}/report`,
    { method: "POST" },
  );
  const body = await allowed.json() as Record<string, unknown>;

  assert.equal(allowed.status, 200);
  assert.equal(otherProjectReport.status, 200);
  assert.deepEqual(fixture.requestedTokens, [TOKEN_A, TOKEN_B]);
  assert.equal(JSON.stringify(body).includes(TOKEN_A), false);
  assert.equal(denied.status, 404);
});

test("V2 routes fail closed when no trusted current-user provider is configured", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const server = createEchoInsightServer({
    environment: { NODE_ENV: "development" },
    projectService: fixture.projectService,
    projectContextReportService: fixture.contextReportService,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/projects`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: {
        code: "CURRENT_USER_CONTEXT_UNAVAILABLE",
        message: "Project API is unavailable.",
      },
    });
  } finally {
    await closeServer(server);
  }
});

test("production runtime ignores the development user environment variable", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);

  const server = createEchoInsightServer({
    environment: {
      NODE_ENV: "production",
      ECHO_INSIGHT_DEV_USER_ID: "must-not-be-trusted",
    },
    projectService: fixture.projectService,
    projectContextReportService: fixture.contextReportService,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/projects`);
    assert.equal(response.status, 503);
  } finally {
    await closeServer(server);
  }
});

test("default development runtime seeds a safe project and composes all V2 APIs", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-default-runtime-"));
  const projectStorePath = join(directory, "projects.json");
  const requestedTokens: string[] = [];
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      requestedTokens.push(baseToken);
      return projectData(baseToken);
    },
  };
  const reportService = new ProjectReportService(
    new ProjectAnalysisService(reader, () => NOW),
    new EmptyExplanationAnalyzer(),
  );
  const server = createEchoInsightServer({
    baseToken: "v1-default-token",
    environment: {
      NODE_ENV: "development",
      ECHO_INSIGHT_DEV_USER_ID: "dev-user",
      ECHO_INSIGHT_DEV_DATA_SOURCE_REF: "local-feishu-base",
      ECHO_INSIGHT_DEV_SEED_PROJECT: "true",
      ECHO_INSIGHT_ENABLE_LEGACY_API: "1",
      FEISHU_BASE_TOKEN: TOKEN_A,
    },
    projectStorePath,
    reader,
    reportService,
  });
  context.after(async () => {
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${String(address.port)}`;

  const list = await fetch(`${origin}/api/projects`);
  const listBody = await list.json() as { projects: Record<string, unknown>[] };
  const projectId = listBody.projects[0]?.id;
  assert.equal(list.status, 200);
  assert.equal(listBody.projects.length, 1);
  assert.equal(listBody.projects[0]?.currentUserRole, "owner");
  assert.equal(typeof projectId, "string");
  assert.equal(JSON.stringify(listBody).includes(TOKEN_A), false);

  const detail = await fetch(`${origin}/api/projects/${projectId}`);
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(await detail.json()).includes(TOKEN_A), false);

  const report = await fetch(`${origin}/api/projects/${projectId}/report`, { method: "POST" });
  assert.equal(report.status, 200);
  assert.equal(JSON.stringify(await report.json()).includes(TOKEN_A), false);
  assert.deepEqual(requestedTokens, [TOKEN_A, TOKEN_A]);

  const storedProjects = await readFile(projectStorePath, "utf8");
  assert.equal(storedProjects.includes(TOKEN_A), false);
  assert.equal(storedProjects.includes("local-feishu-base"), true);

  const v1Report = await fetch(`${origin}/api/project-report`);
  assert.equal(v1Report.status, 200);
  assert.deepEqual(requestedTokens, [TOKEN_A, TOKEN_A, "v1-default-token"]);
});

test("default runtime fails closed when an authorized project has no data source registration", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-missing-registry-"));
  const projectStorePath = join(directory, "projects.json");
  let readerCalls = 0;
  const inertReader: ProjectDataReader = {
    readProjectData: async () => {
      readerCalls += 1;
      throw new Error("The project reader must not run for an unregistered source.");
    },
  };
  const projectService = new ProjectService(
    new JsonProjectRepository(projectStorePath),
    () => NOW,
    () => "project-with-missing-source",
  );
  const project = await projectService.createProject({
    name: "Missing Source Project",
    creatorId: "dev-user",
    ownerId: "dev-user",
    dataSourceRefs: ["unregistered-source"],
  });
  const server = createEchoInsightServer({
    environment: {
      NODE_ENV: "development",
      ECHO_INSIGHT_DEV_USER_ID: "dev-user",
    },
    projectStorePath,
    reader: inertReader,
  });
  context.after(async () => {
    await closeServer(server);
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/api/projects/${project.id}/report`,
    { method: "POST" },
  );
  const body = await response.json() as { error: { code: string; message: string } };

  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    error: {
      code: "PROJECT_REPORT_UNAVAILABLE",
      message: "Project report is unavailable.",
    },
  });
  assert.equal(JSON.stringify(body).includes("unregistered-source"), false);
  assert.equal(readerCalls, 0);
});

class EmptyExplanationAnalyzer implements RiskExplanationAnalyzer {
  async analyze(_input: AiExplanationInput): Promise<AiExplanationOutput> {
    return { risks: [], limitations: [] };
  }
}

function projectDto(id: string, name: string, currentUserRole: "owner" | "member") {
  return {
    id,
    name,
    currentUserRole,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    summaryState: "unconfigured",
  };
}

function projectData(baseToken: string): StandardProjectData {
  return {
    project: { id: `base-for-${baseToken}`, name: "Report Project", source: "feishu-base" },
    tasks: [],
    metadata: {
      baseToken,
      tableCount: 0,
      recordCount: 0,
      retrievedAt: NOW.toISOString(),
      accessMode: "read-only",
      tables: [],
    },
  };
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
