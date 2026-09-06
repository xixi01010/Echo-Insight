import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FixedCurrentUserContextProvider } from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import {
  JsonProjectDataSourceRegistry,
  parseStandaloneFeishuBaseUrl,
  ProjectContextReportService,
  ProjectContextService,
  ProjectDataSourceConfigurationService,
  ProjectDataSourceResolver,
  ProjectDataSourceUrlError,
} from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import { ProjectApiClient, ProjectApiError } from "../frontend/src/services/api/index.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");

test("Project onboarding creates an unconfigured owner project without accepting identity fields", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const server = createServerFor(fixture, "user-a");
  context.after(() => closeServer(server));
  const origin = await listen(server);

  const created = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "New Project" }),
  });
  const project = await created.json() as Record<string, unknown>;
  assert.equal(created.status, 201);
  assert.equal(project.currentUserRole, "owner");
  assert.equal("creatorId" in project, false);
  assert.equal("ownerId" in project, false);
  assert.equal("dataSourceRefs" in project, false);

  const list = await fetch(`${origin}/api/projects`);
  const listBody = await list.json() as { projects: Array<{ name: string }> };
  assert.equal(listBody.projects.some((item) => item.name === "New Project"), true);

  const dataSource = await fetch(`${origin}/api/projects/${String(project.id)}/data-source`);
  assert.deepEqual(await dataSource.json(), { type: "feishu-base", configured: false, accessMode: "read-only" });

  const rejected = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Unsafe", ownerId: "another-user" }),
  });
  assert.equal(rejected.status, 400);
});

test("Project onboarding accepts the production demo name and reports invalid names precisely", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const server = createServerFor(fixture, "user-a");
  context.after(() => closeServer(server));
  const origin = await listen(server);

  const created = await fetch(`${origin}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "【演示】品牌焕新计划" }),
  });
  const project = await created.json() as { id: string; name: string };
  assert.equal(created.status, 201);
  assert.equal(project.name, "【演示】品牌焕新计划");
  assert.equal(
    (await fixture.projectService.getProject(project.id, "user-a"))?.name,
    "【演示】品牌焕新计划",
  );

  for (const name of ["", "   ", "项".repeat(121), "项目\n名称"]) {
    const rejected = await fetch(`${origin}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    assert.equal(rejected.status, 400);
    assert.deepEqual(await rejected.json(), {
      error: { code: "INVALID_PROJECT_NAME", message: "Project name is invalid." },
    });
  }
});

test("Creator and owner remain independent in the domain model", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Independent roles",
    creatorId: "creator-a",
    ownerId: "owner-b",
    members: ["member-c"],
  });
  assert.equal(project.creatorId, "creator-a");
  assert.equal(project.ownerId, "owner-b");
  assert.equal((await fixture.projectService.getMembership(project.id, "creator-a")), null);
  assert.equal((await fixture.projectService.getMembership(project.id, "owner-b"))?.role, "owner");
});

test("Owner binds a standalone Base URL to an opaque server-side registry and report uses it", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Configured project",
    creatorId: "creator-a",
    ownerId: "user-a",
  });
  await fixture.configurationService.configureFeishuBase(
    project.id,
    "user-a",
    "https://example.feishu.cn/base/bascnProjectResource?table=tblInternal",
  );
  const secondProject = await fixture.projectService.createProject({
    name: "Second configured project",
    creatorId: "creator-b",
    ownerId: "user-a",
  });
  await fixture.configurationService.configureFeishuBase(
    secondProject.id,
    "user-a",
    "https://example.feishu.cn/base/bascnSecondProject",
  );
  const stored = await fixture.projectService.getProject(project.id, "user-a");
  assert.ok(stored);
  assert.equal(stored.dataSourceRefs.length, 1);
  assert.equal(stored.dataSourceRefs[0]?.includes("bascnProjectResource"), false);
  assert.match(stored.dataSourceRefs[0] ?? "", /^source-/);
  const serializedProjectStore = await readFile(fixture.projectStorePath, "utf8");
  assert.equal(serializedProjectStore.includes("bascnProjectResource"), false);

  const contextService = new ProjectContextService(
    fixture.projectService,
    new ProjectDataSourceResolver(fixture.registry),
  );
  const reportTokens: string[] = [];
  const reportService = new ProjectContextReportService(contextService, {
    createProjectReport: async (baseToken) => {
      reportTokens.push(baseToken);
      return { analysis: {}, riskContexts: [], aiReport: { risks: [], limitations: [] } } as never;
    },
  });
  await reportService.createProjectReport(project.id, "user-a");
  await reportService.createProjectReport(secondProject.id, "user-a");
  assert.deepEqual(reportTokens, ["bascnProjectResource", "bascnSecondProject"]);
  assert.deepEqual(fixture.validatedTokens, ["bascnProjectResource", "bascnSecondProject"]);
});

test("Configure Base replaces only the Base ref and preserves pending future Sources", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Future-ready project",
    creatorId: "creator-a",
    ownerId: "user-a",
  });
  await fixture.registry.registerPendingSource(project.id, "source-pending-chat", "feishu-chat");
  await fixture.projectService.addDataSourceRef(project.id, "source-pending-chat");

  await fixture.configurationService.configureFeishuBase(
    project.id,
    "user-a",
    "https://feishu.cn/base/bascnBaseWithPendingChat",
  );

  const stored = await fixture.projectService.getProject(project.id, "user-a");
  assert.ok(stored);
  assert.equal(stored.dataSourceRefs.includes("source-pending-chat"), true);
  assert.equal(stored.dataSourceRefs.length, 2);
  const baseRef = stored.dataSourceRefs.find((ref) => ref !== "source-pending-chat");
  assert.ok(baseRef);
  assert.equal(fixture.registry.getForProject(project.id, baseRef)?.kind, "feishu-base");
  assert.deepEqual(
    await fixture.configurationService.getStatus(project.id, "user-a"),
    { type: "feishu-base", configured: true, accessMode: "read-only", displayName: "Demo Base" },
  );

  const contextService = new ProjectContextService(
    fixture.projectService,
    new ProjectDataSourceResolver(fixture.registry),
  );
  const resolved = await contextService.resolve(project.id, "user-a");
  assert.equal(resolved.resolvedDataSources.length, 1);
  assert.equal(resolved.resolvedDataSources[0]?.kind, "feishu-base");
});

test("Data-source API enforces owner authorization and never exposes references or Base identifiers", async (context) => {
  const fixture = await createFixture();
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Owner project",
    creatorId: "creator-a",
    ownerId: "owner-a",
    members: ["member-a"],
  });
  const ownerServer = createServerFor(fixture, "owner-a");
  const memberServer = createServerFor(fixture, "member-a");
  const strangerServer = createServerFor(fixture, "stranger-a");
  context.after(() => closeServer(ownerServer));
  context.after(() => closeServer(memberServer));
  context.after(() => closeServer(strangerServer));
  const [ownerOrigin, memberOrigin, strangerOrigin] = await Promise.all([
    listen(ownerServer), listen(memberServer), listen(strangerServer),
  ]);

  const memberUpdate = await fetch(`${memberOrigin}/api/projects/${project.id}/data-source`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://feishu.cn/base/bascnMemberDenied" }),
  });
  assert.equal(memberUpdate.status, 403);
  const strangerUpdate = await fetch(`${strangerOrigin}/api/projects/${project.id}/data-source`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://feishu.cn/base/bascnStrangerDenied" }),
  });
  assert.equal(strangerUpdate.status, 404);

  const ownerUpdate = await fetch(`${ownerOrigin}/api/projects/${project.id}/data-source`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://feishu.cn/base/bascnOwnerConfigured" }),
  });
  assert.deepEqual(await ownerUpdate.json(), { type: "feishu-base", configured: true, accessMode: "read-only", displayName: "Demo Base" });
  const status = await fetch(`${ownerOrigin}/api/projects/${project.id}/data-source`);
  const text = await status.text();
  assert.equal(text.includes("source-"), false);
  assert.equal(text.includes("bascnOwnerConfigured"), false);
  assert.equal(text.includes("baseToken"), false);
  assert.equal(text.includes("Demo Base"), true);
});

test("URL parsing and read validation fail safely", async (context) => {
  assert.equal(
    parseStandaloneFeishuBaseUrl("https://www.feishu.cn/base/bascnSafeResource/"),
    "bascnSafeResource",
  );
  assert.throws(
    () => parseStandaloneFeishuBaseUrl("https://feishu.cn/wiki/wikcnUnsupported"),
    (error: unknown) => error instanceof ProjectDataSourceUrlError
      && error.code === "UNSUPPORTED_DATA_SOURCE_URL",
  );
  assert.throws(
    () => parseStandaloneFeishuBaseUrl("http://feishu.cn/base/bascnInsecure"),
    ProjectDataSourceUrlError,
  );

  const fixture = await createFixture({ validate: async () => { throw new Error("not accessible"); } });
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Validation failure",
    creatorId: "creator-a",
    ownerId: "user-a",
  });
  const server = createServerFor(fixture, "user-a");
  context.after(() => closeServer(server));
  const origin = await listen(server);
  const response = await fetch(`${origin}/api/projects/${project.id}/data-source`, {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: "https://feishu.cn/base/bascnUnreadable" }),
  });
  const body = await response.text();
  assert.equal(response.status, 422);
  assert.equal(body.includes("not accessible"), false);
  assert.equal(body.includes("bascnUnreadable"), false);
});

test("Base display metadata is best effort and never hides a configured source", async (context) => {
  let metadataAvailable = true;
  const fixture = await createFixture({
    validate: async () => {
      if (!metadataAvailable) throw new Error("metadata unavailable");
      return { displayName: "Safe Base Name" };
    },
  });
  context.after(fixture.cleanup);
  const project = await fixture.projectService.createProject({
    name: "Metadata project",
    creatorId: "creator-a",
    ownerId: "user-a",
  });
  const configured = await fixture.configurationService.configureFeishuBase(
    project.id,
    "user-a",
    "https://feishu.cn/base/bascnMetadataSource",
  );
  assert.equal(configured.displayName, "Safe Base Name");

  metadataAvailable = false;
  assert.deepEqual(
    await fixture.configurationService.getStatus(project.id, "user-a"),
    { type: "feishu-base", configured: true, accessMode: "read-only" },
  );
});

test("Frontend contracts keep project creation and configuration safe", async () => {
  const client = new ProjectApiClient(async () => new Response(JSON.stringify({
    type: "feishu-base", configured: true, accessMode: "read-only", displayName: "Demo Base",
  }), { status: 200 }));
  assert.deepEqual(await client.getProjectDataSource("project-a"), { type: "feishu-base", configured: true, accessMode: "read-only", displayName: "Demo Base" });
  const unsafeClient = new ProjectApiClient(async () => new Response(JSON.stringify({
    type: "feishu-base", configured: true, accessMode: "read-only", baseToken: "fake-value",
  }), { status: 200 }));
  await assert.rejects(unsafeClient.getProjectDataSource("project-a"), (error: unknown) => (
    error instanceof ProjectApiError && error.code === "INVALID_PROJECT_RESPONSE"
  ));
  const [createPage, projectSpace] = await Promise.all([
    readFile(new URL("../frontend/src/pages/Projects/CreateProjectPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../frontend/src/pages/Project/ProjectSpacePage.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(createPage, /normalizeProjectNameInput\(name\)/);
  assert.match(createPage, /createProject\(normalizedName\)/);
  assert.doesNotMatch(createPage, /ownerId|creatorId|dataSourceRefs/);
  assert.match(projectSpace, /项目尚未绑定数据源/);
  assert.match(projectSpace, /data-source/);
});

async function createFixture(options: { validate?: (baseToken: string) => Promise<void | { displayName?: string }> } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-project-onboarding-"));
  const projectStorePath = join(directory, "projects.json");
  const projectService = new ProjectService(
    new JsonProjectRepository(projectStorePath),
    () => NOW,
    (() => {
      let id = 0;
      return () => `project-${String(++id)}`;
    })(),
  );
  const registry = new JsonProjectDataSourceRegistry(join(directory, "data-sources.json"));
  const validatedTokens: string[] = [];
  const configurationService = new ProjectDataSourceConfigurationService(
    projectService,
    registry,
    async (baseToken) => {
      validatedTokens.push(baseToken);
      return (options.validate ?? (async () => ({ displayName: "Demo Base" })))(baseToken);
    },
  );
  return {
    cleanup: () => rm(directory, { recursive: true, force: true }),
    configurationService,
    projectService,
    projectStorePath,
    registry,
    validatedTokens,
  };
}

function createServerFor(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  userId: string,
) {
  return createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider(userId),
    reader: {
      readProjectData: async () => {
        throw new Error("The sealed onboarding test must not contact a project data source.");
      },
    },
    projectService: fixture.projectService,
    projectDataSourceConfigurationService: fixture.configurationService,
  });
}

async function listen(server: import("node:http").Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return `http://127.0.0.1:${String(address.port)}`;
}

function closeServer(server: import("node:http").Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
