import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { createBaseBackedProjectIntelligenceProvider } from "../backend/src/intelligence/index.js";
import { JsonProjectDataSourceRegistry } from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import type { ProjectDataReader, StandardProjectData } from "../feishu-connector/src/index.js";

const NOW = new Date("2026-09-12T00:00:00.000Z");

test("intelligence provider reads multiple Sources concurrently while preserving Source order", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-intel-parallel-"));
  try {
    const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")), () => NOW, () => "project-parallel");
    const project = await projectService.createProject({ name: "Parallel Project", creatorId: "owner-1", ownerId: "owner-1", members: [] });
    const registry = new JsonProjectDataSourceRegistry(join(directory, "sources.json"));
    // The first Base read is slower, so completion order is the reverse of
    // registration order; collected results must still follow ref order.
    await registry.registerFeishuBase(project.id, "source-base-1", "base-slow");
    await registry.registerFeishuBase(project.id, "source-base-2", "base-fast");
    await projectService.replaceDataSourceRefs(project.id, ["source-base-1", "source-base-2"]);

    let inFlight = 0;
    let maxInFlight = 0;
    let releaseSlow: (() => void) | undefined;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const reader: ProjectDataReader = {
      readProjectData: async (baseToken: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        if (baseToken === "base-slow") await slowReleased;
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
        return baseData(baseToken);
      },
    };
    const observedRefs: string[] = [];
    const provider = createBaseBackedProjectIntelligenceProvider(
      projectService,
      registry,
      reader,
      undefined,
      undefined,
      undefined,
      undefined,
      (record) => observedRefs.push(record.sourceRef),
    );

    const pending = provider(project.id, { userId: "owner-1", identity: toFeishuOpenIdIdentityRef("owner-open", "cli_echo") });
    for (let ticks = 0; ticks < 200 && maxInFlight < 2; ticks += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    releaseSlow?.();
    const output = await pending;

    // Two Base reads were in flight at the same time, which a serial loop
    // cannot produce, and the slower first Source finishing last still
    // preserves ref ordering in the aggregated result.
    assert.equal(maxInFlight, 2);
    assert.deepEqual(output.result.sourceFreshness.map((item) => item.record.sourceRef), ["source-base-1", "source-base-2"]);
    assert.deepEqual(observedRefs, ["source-base-1", "source-base-2"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function baseData(baseToken: string): StandardProjectData {
  return {
    project: { id: baseToken, name: `Base ${baseToken}`, source: "feishu-base" },
    tasks: [{ id: "task-1", tableId: "table-1", tableName: "Tasks", name: "推进读取", owner: null, status: "进行中", deadline: "2026-09-20", riskLevel: null, description: null, attributes: {} }],
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
