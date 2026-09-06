import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FixedCurrentUserContextProvider, toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import { createBaseBackedProjectIntelligenceProvider, MultiSourceIntelligenceService, ProjectIntelligenceQueryService, toProjectIntelligenceDto } from "../backend/src/intelligence/index.js";
import {
  JsonProjectDataSourceRegistry,
  ProjectSourceConfigurationService,
} from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import {
  createSourceReadFailure,
  createSourceReadSuccess,
  type ProjectSourceReadContext,
  type FeishuApiClient,
  type StandardProjectData,
} from "../feishu-connector/src/index.js";
import { ProjectApiClient } from "../frontend/src/services/api/index.js";
import { V3_REVIEW_PROJECTS } from "./fixtures/v3-review-projects.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

test("Source management API is owner-only and returns no locator, sourceRef, or credential", async (context) => {
  const fixture = await sourceFixture();
  context.after(fixture.cleanup);
  const owner = await openServer(fixture, "owner-1");
  const member = await openServer(fixture, "member-1");
  context.after(owner.close); context.after(member.close);

  const createdBody = await fixture.sourceService.add(fixture.project.id, "owner-1", { displayName: "项目群", locator: { kind: "feishu-chat", containerType: "chat", containerId: "oc_private-chat-id" } });
  assert.equal(createdBody.status, "authorization-required");
  assert.equal(createdBody.activationState, "real-tenant-unverified");
  const ownerList = await fetch(`${owner.origin}/api/projects/${fixture.project.id}/sources`);
  const ownerText = await ownerList.text();
  assert.equal(ownerList.status, 200);
  for (const sensitive of ["oc_private-chat-id", "sourceRef", "locator", "credential", "token"]) assert.equal(ownerText.includes(sensitive), false);

  const memberAdd = await fetch(`${member.origin}/api/projects/${fixture.project.id}/sources`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ locator: { kind: "feishu-docs", documentToken: "doc-private" } }),
  });
  assert.equal(memberAdd.status, 400);
  const memberText = await (await fetch(`${member.origin}/api/projects/${fixture.project.id}/sources`)).text();
  assert.equal(memberText.includes("oc_private-chat-id"), false);

  const disabled = await fetch(`${owner.origin}/api/projects/${fixture.project.id}/sources/${createdBody.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }) });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { status: string }).status, "disabled");
  assert.equal((await fetch(`${owner.origin}/api/projects/${fixture.project.id}/sources/${createdBody.id}`, { method: "DELETE" })).status, 204);
});

test("frontend Source client accepts the safe multi-source contract and rejects leaked locators", async () => {
  const safe = { id: "public-chat", type: "feishu-chat", displayName: "项目群", enabled: true, accessMode: "read-only", status: "unverified", authorization: "unknown", visibility: "unknown", freshness: "unknown", activationState: "real-tenant-unverified" };
  const client = new ProjectApiClient(async () => new Response(JSON.stringify({ sources: [safe] }), { status: 200 }));
  assert.deepEqual(await client.getProjectSources("project-1"), [safe]);
  const unsafe = new ProjectApiClient(async () => new Response(JSON.stringify({ sources: [{ ...safe, locator: { containerId: "secret" } }] }), { status: 200 }));
  await assert.rejects(unsafe.getProjectSources("project-1"));
  const unsafeIntelligence = new ProjectApiClient(async () => new Response(JSON.stringify({
    currentFacts: [{ subject: "task", value: "blocked", sourceTypes: ["feishu-base"], sourceRef: "source-private" }],
    confirmedRisks: [], potentialSignals: [], conflicts: [], freshness: [],
    ai: { status: "unavailable", explanations: [], limitations: [] },
  }), { status: 200 }));
  await assert.rejects(unsafeIntelligence.getProjectIntelligence("project-1"));
});

test("Source configuration shows only current-user verified operational state, never its locator", async (context) => {
  const fixture = await sourceFixture(); context.after(fixture.cleanup);
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-chat", publicId: "public-chat", locator: { kind: "feishu-chat", containerType: "chat", containerId: "private-chat" } });
  await fixture.projectService.addDataSourceRef(fixture.project.id, "source-chat");
  const service = new ProjectSourceConfigurationService(
    fixture.projectService,
    fixture.registry,
    undefined,
    () => "public-unused",
    () => ({ freshness: "fresh", visibility: "allowed", lastSuccessfulReadAt: NOW.toISOString() }),
  );
  const dto = await service.list(fixture.project.id, { userId: "owner-1" });
  assert.deepEqual(dto.sources.map((item) => ({ status: item.status, visibility: item.visibility, freshness: item.freshness, activationState: item.activationState })), [{ status: "available", visibility: "allowed", freshness: "fresh", activationState: "verified" }]);
  assert.equal(JSON.stringify(dto).includes("private-chat"), false);
});

test("Project Intelligence DTO keeps candidate, conflict, stale, and AI failure distinct from confirmed risk", async () => {
  const service = new MultiSourceIntelligenceService(undefined, { extract: async () => [{ kind: "prediction", summary: "可能延期到下周" }] }, () => NOW);
  await service.build({ baseProjectData: baseData(), sourceResults: [source("base", baseSnapshot()), source("docs", { document: { title: "状态说明" }, blocks: [] })] });
  const result = await service.build({
    baseProjectData: baseData(),
    sourceResults: [
      source("base", baseSnapshot()),
      source("chat", { messages: [{ messageId: "message-1", content: "项目可能延期到下周" }] }),
      source("task", { tasks: [{ taskId: "task-1", due: { time: "2026-09-20" }, collaborators: [], followers: [] }] }),
      createSourceReadFailure({ context: sourceContext("docs"), category: "rate-limited", freshness: { fetchedAt: NOW.toISOString() } }),
    ],
  });
  const dto = toProjectIntelligenceDto(result);
  assert.equal(dto.confirmedRisks.length > 0, true);
  assert.equal(dto.potentialSignals.some((item) => item.state === "unconfirmed" && item.kind === "candidate"), true);
  assert.equal(dto.conflicts.some((item) => item.state === "unresolved"), true);
  assert.equal(dto.freshness.some((item) => item.sourceType === "feishu-docs" && item.state === "stale" && item.failureCategory === "rate-limited"), true);
  assert.equal(dto.ai.status, "unavailable");
  assert.equal(JSON.stringify(dto).includes("项目可能延期到下周"), false);
  assert.equal(JSON.stringify(dto).includes("source-docs"), false);
});

test("Project Intelligence API enforces project membership and survives absent AI output", async (context) => {
  const fixture = await sourceFixture(); context.after(fixture.cleanup);
  const result = await new MultiSourceIntelligenceService(undefined, undefined, () => NOW).build({ baseProjectData: baseData(), sourceResults: [source("base", baseSnapshot())] });
  const query = new ProjectIntelligenceQueryService(fixture.projectService, async () => ({ result }));
  const owner = await openServer(fixture, "owner-1", query); const stranger = await openServer(fixture, "stranger-1", query);
  context.after(owner.close); context.after(stranger.close);
  const allowed = await fetch(`${owner.origin}/api/projects/${fixture.project.id}/intelligence`);
  const body = await allowed.json() as { ai: { status: string }; confirmedRisks: unknown[] };
  assert.equal(allowed.status, 200); assert.equal(body.ai.status, "unavailable"); assert.equal(body.confirmedRisks.length > 0, true);
  assert.equal((await fetch(`${stranger.origin}/api/projects/${fixture.project.id}/intelligence`)).status, 404);
});

test("runtime provider reads only an authorized configured locator and keeps discovery disabled", async (context) => {
  const fixture = await sourceFixture(); context.after(fixture.cleanup);
  await fixture.registry.registerFeishuBase(fixture.project.id, "source-base", "base-private");
  await fixture.registry.registerConfiguredSource({ projectId: fixture.project.id, ref: "source-chat", publicId: "public-chat", locator: { kind: "feishu-chat", containerType: "chat", containerId: "chat-explicit" } });
  await fixture.projectService.replaceDataSourceRefs(fixture.project.id, ["source-base", "source-chat"]);
  const historyCalls: unknown[] = [];
  const membershipCalls: unknown[] = [];
  const observedRefs: string[] = [];
  const client = { im: { v1: {
    chatMembers: { isInChat: async (input: unknown) => { membershipCalls.push(input); return { code: 0, data: { is_in_chat: true } }; } },
    message: { list: async (input: unknown) => { historyCalls.push(input); return { code: 0, data: { items: [], has_more: false } }; } },
  } } } as unknown as FeishuApiClient;
  const provider = createBaseBackedProjectIntelligenceProvider(
    fixture.projectService,
    fixture.registry,
    { readProjectData: async () => baseData() },
    client,
    undefined,
    { getUserAccessToken: async () => "test-user-token" },
    undefined,
    (record) => observedRefs.push(record.sourceRef),
  );
  const output = await provider(fixture.project.id, { userId: "owner-1", identity: toFeishuOpenIdIdentityRef("owner-open", "cli_echo") });
  assert.deepEqual(membershipCalls, [{ path: { chat_id: "chat-explicit" } }]);
  assert.equal(historyCalls.length, 1);
  assert.equal(JSON.stringify(historyCalls[0]).includes("chat-explicit"), true);
  assert.equal(output.result.sourceFreshness.some((item) => item.sourceKind === "feishu-chat" && item.record.state === "fresh"), true);
  assert.deepEqual(observedRefs.sort(), ["source-base", "source-chat"]);
});

test("five deterministic review fixtures cover Base-only, confirmed risk, candidate, conflict, and permission/failure", () => {
  assert.equal(V3_REVIEW_PROJECTS.length, 5);
  assert.deepEqual(V3_REVIEW_PROJECTS.map((item) => item.role), ["healthy", "confirmed-risk", "candidate", "conflict", "source-limitation"]);
  assert.deepEqual(V3_REVIEW_PROJECTS[0]?.sourceTypes, ["feishu-base"]);
});

async function sourceFixture() {
  const directory = await mkdtemp(join(tmpdir(), "echo-v3-loop-"));
  const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")), () => NOW, () => "project-review");
  const project = await projectService.createProject({ name: "Review Project", creatorId: "owner-1", ownerId: "owner-1", members: ["member-1"] });
  const registry = new JsonProjectDataSourceRegistry(join(directory, "sources.json"));
  const sourceService = new ProjectSourceConfigurationService(projectService, registry, undefined, (() => { let id = 0; return () => `public-${++id}`; })());
  return { directory, project, projectService, registry, sourceService, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

async function openServer(fixture: Awaited<ReturnType<typeof sourceFixture>>, userId: string, query?: ProjectIntelligenceQueryService) {
  const server = createEchoInsightServer({ currentUserContextProvider: new FixedCurrentUserContextProvider(userId), projectService: fixture.projectService, projectSourceConfigurationService: fixture.sourceService, ...(query ? { projectIntelligenceQueryService: query } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  return { origin: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function baseData(): StandardProjectData { return { project: { id: "base-1", name: "Fixture", source: "feishu-base" }, tasks: [{ id: "task-1", tableId: "table-1", tableName: "Tasks", name: "Blocked", owner: null, status: "blocked", deadline: "2026-09-01", riskLevel: "L4", description: null, attributes: {} }], metadata: { baseToken: "server-only", tableCount: 1, recordCount: 1, retrievedAt: NOW.toISOString(), accessMode: "read-only", tables: [{ id: "table-1", name: "Tasks", recordCount: 1 }] } }; }
function baseSnapshot() { const value = baseData(); const { baseToken: _ignored, ...metadata } = value.metadata; return { project: { ...value.project, id: "safe-base" }, tasks: value.tasks, metadata }; }
function source(kind: string, data: unknown) { const context = sourceContext(kind); return createSourceReadSuccess({ context, data, resources: [{ sourceRef: context.sourceRef, resourceType: kind }], freshness: { fetchedAt: NOW.toISOString() } }); }
function sourceContext(kind: string): ProjectSourceReadContext { const sourceKind = kind === "base" ? "feishu-base" : kind === "chat" ? "feishu-chat" : kind === "task" ? "feishu-task" : "feishu-docs"; return { projectId: "project-review", sourceRef: `source-${kind}`, sourceKind, subject: { userId: "owner-1" }, authorization: { sourceAuthorization: "authorized", subjectEligibility: "allowed" }, visibility: "allowed" }; }
