import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  InvalidProjectNameError,
  JsonProjectRepository,
  ProjectService,
} from "./index.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");

async function createTestContext() {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-project-service-"));
  const filePath = join(directory, "projects.json");
  const repository = new JsonProjectRepository(filePath);
  let nextId = 1;
  const service = new ProjectService(
    repository,
    () => NOW,
    () => `project-${String(nextId++)}`,
  );

  return {
    directory,
    filePath,
    repository,
    service,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

test("creates and persists a project", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  const created = await testContext.service.createProject({
    name: "Launch Project",
    creatorId: "user-creator",
    ownerId: "user-owner",
    members: ["user-member"],
    dataSourceRefs: ["source-feishu-base-1"],
  });

  assert.deepEqual(created, {
    id: "project-1",
    name: "Launch Project",
    creatorId: "user-creator",
    ownerId: "user-owner",
    members: ["user-member"],
    dataSourceRefs: ["source-feishu-base-1"],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  const reloadedRepository = new JsonProjectRepository(testContext.filePath);
  assert.deepEqual(await reloadedRepository.findById(created.id), created);
});

test("accepts common Chinese and mixed-language project names", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  const names = [
    "品牌焕新计划",
    "【演示】品牌焕新计划",
    "品牌焕新计划（第二阶段）",
    "Echo Insight 2.0",
    "AI-项目控制台_02",
  ];

  for (const name of names) {
    const created = await testContext.service.createProject({
      name,
      creatorId: "user-creator",
      ownerId: "user-owner",
    });
    assert.equal(created.name, name);
    assert.equal((await testContext.repository.findById(created.id))?.name, name);
  }
});

test("rejects empty, overlong, and control-character project names", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  for (const name of ["", "   ", "项".repeat(121), "项目\n名称"]) {
    await assert.rejects(
      testContext.service.createProject({
        name,
        creatorId: "user-creator",
        ownerId: "user-owner",
      }),
      InvalidProjectNameError,
    );
  }
});

test("queries projects by owner and member relationship", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  const project = await testContext.service.createProject({
    name: "Relationship Project",
    creatorId: "user-creator",
    ownerId: "user-owner",
    members: ["user-member", "user-member", "user-owner"],
  });

  assert.equal(
    (await testContext.service.getMembership(project.id, "user-owner"))?.role,
    "owner",
  );
  assert.equal(
    (await testContext.service.getMembership(project.id, "user-member"))?.role,
    "member",
  );
  assert.equal(
    await testContext.service.getMembership(project.id, "user-creator"),
    null,
  );
  assert.deepEqual(project.members, ["user-member"]);
  assert.notEqual(project.creatorId, project.ownerId);
});

test("isolates projects from users without a project relationship", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);

  const first = await testContext.service.createProject({
    name: "First Project",
    creatorId: "user-a",
    ownerId: "user-a",
    members: ["user-shared"],
  });
  const second = await testContext.service.createProject({
    name: "Second Project",
    creatorId: "user-b",
    ownerId: "user-b",
    members: [],
  });

  assert.deepEqual(
    (await testContext.service.listProjects("user-shared")).map(({ id }) => id),
    [first.id],
  );
  assert.equal(await testContext.service.getProject(second.id, "user-shared"), null);
  assert.equal(
    await testContext.service.listMemberships(second.id, "user-shared"),
    null,
  );
  assert.equal((await testContext.service.getProject(second.id, "user-b"))?.id, second.id);
});

test("adds and removes individual data-source refs without replacing the project list", async (context) => {
  const testContext = await createTestContext();
  context.after(testContext.cleanup);
  const project = await testContext.service.createProject({
    name: "Multi-source project",
    creatorId: "user-owner",
    ownerId: "user-owner",
    dataSourceRefs: ["source-base"],
  });

  const withChat = await testContext.service.addDataSourceRef(project.id, "source-chat");
  assert.deepEqual(withChat?.dataSourceRefs, ["source-base", "source-chat"]);
  const deduplicated = await testContext.service.addDataSourceRef(project.id, "source-chat");
  assert.deepEqual(deduplicated?.dataSourceRefs, ["source-base", "source-chat"]);
  const withoutBase = await testContext.service.removeDataSourceRef(project.id, "source-base");
  assert.deepEqual(withoutBase?.dataSourceRefs, ["source-chat"]);
});
