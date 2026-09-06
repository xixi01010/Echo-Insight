import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEchoInsightServer } from "../backend/src/index.js";
import {
  ensureRuntimeStorageDirectory,
  resolveRuntimeStoragePaths,
} from "../backend/src/runtime-storage.js";
import type {
  ProjectDataReader,
  StandardProjectData,
} from "../feishu-connector/src/index.js";

test("GET /api/project-data returns standardized project data", async (context) => {
  const expected: StandardProjectData = {
    project: { id: "base-1", name: "Echo Project", source: "feishu-base" },
    tasks: [],
    metadata: {
      baseToken: "base-1",
      tableCount: 0,
      recordCount: 0,
      retrievedAt: "2026-08-22T00:00:00.000Z",
      accessMode: "read-only",
      tables: [],
    },
  };
  const reader: ProjectDataReader = {
    readProjectData: async (baseToken) => {
      assert.equal(baseToken, "base-1");
      return expected;
    },
  };
  const server = createEchoInsightServer({ reader, baseToken: "base-1" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");

  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/api/project-data`,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
});

test("runtime storage uses one durable directory and fails closed in production", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-runtime-storage-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const developmentFallback = join(directory, "development-runtime");
  const railwayDirectory = join(directory, "railway-volume");
  const explicitDirectory = join(directory, "explicit-runtime");

  const development = resolveRuntimeStoragePaths(
    { NODE_ENV: "development" },
    developmentFallback,
  );
  assert.equal(development.directory, developmentFallback);

  const railway = resolveRuntimeStoragePaths(
    { NODE_ENV: "production", RAILWAY_VOLUME_MOUNT_PATH: railwayDirectory },
    developmentFallback,
  );
  assert.equal(railway.directory, railwayDirectory);
  assert.equal(railway.projectStorePath, join(railwayDirectory, "projects.json"));
  assert.equal(railway.dataSourceRegistryPath, join(railwayDirectory, "data-sources.json"));
  assert.equal(railway.visitorAiAccountStorePath, join(railwayDirectory, "visitor-ai-accounts.json"));

  const explicit = resolveRuntimeStoragePaths(
    {
      NODE_ENV: "production",
      ECHO_INSIGHT_RUNTIME_DIR: explicitDirectory,
      RAILWAY_VOLUME_MOUNT_PATH: railwayDirectory,
    },
    developmentFallback,
  );
  assert.equal(explicit.directory, explicitDirectory);
  ensureRuntimeStorageDirectory(explicit);
  await access(explicit.directory);

  assert.throws(
    () => resolveRuntimeStoragePaths({ NODE_ENV: "production" }, developmentFallback),
    /requires ECHO_INSIGHT_RUNTIME_DIR or RAILWAY_VOLUME_MOUNT_PATH/u,
  );
  assert.throws(
    () => resolveRuntimeStoragePaths(
      { NODE_ENV: "production", ECHO_INSIGHT_RUNTIME_DIR: "relative-runtime" },
      developmentFallback,
    ),
    /must be an absolute path/u,
  );
});
