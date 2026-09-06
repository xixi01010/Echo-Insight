import assert from "node:assert/strict";
import test from "node:test";

import type { RiskExplanationAnalyzer } from "../ai-service/src/index.js";
import { AiProviderTimeoutError } from "../ai-service/src/siliconflow-risk-analyzer.js";
import { ProjectAnalysisService } from "../backend/src/analysis-service/index.js";
import { ProjectReportService } from "../backend/src/ai-analysis-service/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import type { ProjectDataReader } from "../feishu-connector/src/index.js";

function createReportDependencies() {
  const reader: ProjectDataReader = {
    readProjectData: async () => ({
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
    }),
  };
  const analyzer: RiskExplanationAnalyzer = {
    analyze: async () => ({ risks: [], limitations: ["仅基于可读取数据。"] }),
  };
  return {
    reader,
    baseToken: "base-1",
    reportService: new ProjectReportService(
      new ProjectAnalysisService(reader, () => new Date("2026-08-22T00:00:00.000Z")),
      analyzer,
    ),
  };
}

test("GET /api/project-report returns separate rule analysis and V2 AI report", async (context) => {
  const server = createEchoInsightServer(createReportDependencies());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/project-report`, {
    headers: { Origin: "https://demo.pages.dev" },
  });
  const body = (await response.json()) as {
    analysis: { healthScore: number; healthStatus: string; riskLevel: string };
    riskContexts: unknown[];
    aiReport: Record<string, unknown>;
  };

  assert.equal(response.status, 200);
  assert.equal(body.analysis.healthScore, 100);
  assert.equal(body.analysis.healthStatus, "healthy");
  assert.equal(body.analysis.riskLevel, "L1");
  assert.deepEqual(body.riskContexts, []);
  assert.deepEqual(Object.keys(body.aiReport).sort(), ["limitations", "risks"]);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
});

test("GET /api/project-report permits only the configured frontend origin", async (context) => {
  const server = createEchoInsightServer({
    ...createReportDependencies(),
    allowedFrontendOrigin: "https://demo.pages.dev",
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${String(address.port)}/api/project-report`;

  const allowed = await fetch(url, { headers: { Origin: "https://demo.pages.dev" } });
  const rejected = await fetch(url, { headers: { Origin: "https://other.pages.dev" } });
  const preflight = await fetch(url, { method: "OPTIONS", headers: { Origin: "https://demo.pages.dev" } });

  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://demo.pages.dev");
  assert.equal(allowed.headers.get("vary"), "Origin");
  assert.equal(rejected.headers.get("access-control-allow-origin"), null);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://demo.pages.dev");
});
test("GET /api/project-report preserves deterministic analysis when AI times out", async (context) => {
  const dependencies = createReportDependencies();
  const timeoutAnalyzer: RiskExplanationAnalyzer = {
    analyze: async () => {
      throw new AiProviderTimeoutError();
    },
  };
  const server = createEchoInsightServer({
    ...dependencies,
    reportService: new ProjectReportService(
      new ProjectAnalysisService(dependencies.reader, () => new Date("2026-08-22T00:00:00.000Z")),
      timeoutAnalyzer,
    ),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address === "object");
  const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/project-report`);
  const body = (await response.json()) as { aiStatus: string; analysis: { healthScore: number }; aiReport: { risks: unknown[]; limitations: string[] } };

  assert.equal(response.status, 200);
  assert.equal(body.analysis.healthScore, 100);
  assert.equal(body.aiStatus, "unavailable");
  assert.deepEqual(body.aiReport.risks, []);
  assert.match(body.aiReport.limitations[0] ?? "", /规则风险已正常更新/);
});
