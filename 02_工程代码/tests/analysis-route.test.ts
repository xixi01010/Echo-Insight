import assert from "node:assert/strict";
import test from "node:test";

import { createEchoInsightServer } from "../backend/src/index.js";
import type {
  ProjectDataReader,
  StandardProjectData,
} from "../feishu-connector/src/index.js";

test("GET /api/project-analysis returns standardized project data and rule analysis", async (context) => {
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
    `http://127.0.0.1:${String(address.port)}/api/project-analysis`,
  );
  const body = (await response.json()) as {
    projectData: StandardProjectData;
    analysis: { healthScore: number; healthStatus: string; riskLevel: string };
  };

  assert.equal(response.status, 200);
  assert.deepEqual(body.projectData, expected);
  assert.equal(body.analysis.healthScore, 100);
  assert.equal(body.analysis.healthStatus, "healthy");
  assert.equal(body.analysis.riskLevel, "L1");
});
