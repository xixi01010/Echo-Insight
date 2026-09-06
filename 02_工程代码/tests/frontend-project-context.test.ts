import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  INITIAL_PROJECTS_STATE,
  mergeLastKnownSummaries,
  reduceProjectsState,
} from "../frontend/src/features/projects/project-state.js";
import {
  getProjectReportCacheKey,
  ProjectApiClient,
  ProjectApiError,
  readProjectReportCache,
  writeProjectReportCache,
  type ReportStorage,
} from "../frontend/src/services/api/index.js";
import type {
  ProjectReport,
  ProjectSummary,
} from "../frontend/src/services/api/types.js";
import {
  getProjectConsoleHealthOverview,
} from "../frontend/src/features/projects/project-summary-presentation.js";
import {
  createProjectDataSourceState,
  getVisibleProjectDataSourceState,
  reduceProjectDataSourceState,
} from "../frontend/src/features/projects/project-data-source-state.js";

const projectA: ProjectSummary = {
  id: "project-a",
  name: "Project A",
  currentUserRole: "owner",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T01:00:00.000Z",
};
const projectB: ProjectSummary = {
  ...projectA,
  id: "project-b",
  name: "Project B",
  currentUserRole: "member",
};

test("project state covers loading, error, empty, and successful list states", () => {
  const loading = reduceProjectsState(INITIAL_PROJECTS_STATE, { type: "load-start" });
  assert.equal(loading.projectsLoading, true);

  const failed = reduceProjectsState(loading, { type: "load-error", error: "unavailable" });
  assert.equal(failed.projectsLoading, false);
  assert.equal(failed.projectsError, "unavailable");

  const empty = reduceProjectsState(failed, { type: "load-success", projects: [] });
  assert.deepEqual(empty.projects, []);
  assert.equal(empty.projectsError, null);

  const loaded = reduceProjectsState(empty, { type: "load-success", projects: [projectA, projectB] });
  assert.deepEqual(loaded.projects, [projectA, projectB]);
  assert.equal(loaded.projectsLoading, false);
});

test("current project selection switches explicitly and clears inaccessible projects", () => {
  const loaded = reduceProjectsState(INITIAL_PROJECTS_STATE, {
    type: "load-success",
    projects: [projectA, projectB],
  });
  const selectedA = reduceProjectsState(loaded, { type: "select", projectId: projectA.id });
  const selectedB = reduceProjectsState(selectedA, { type: "select", projectId: projectB.id });
  assert.equal(selectedA.currentProjectId, "project-a");
  assert.equal(selectedB.currentProjectId, "project-b");

  const refreshed = reduceProjectsState(selectedB, {
    type: "load-success",
    projects: [projectA],
  });
  assert.equal(refreshed.currentProjectId, null);
});

test("project list retains last-known unavailable summaries but clears unconfigured ones", () => {
  const previouslyAvailable: ProjectSummary = {
    ...projectA,
    healthScore: 75,
    healthStatus: "needs-attention",
    riskCount: 1,
    summaryState: "available",
  };
  const state = reduceProjectsState(INITIAL_PROJECTS_STATE, {
    type: "load-success",
    projects: [previouslyAvailable],
  });
  const unavailable = reduceProjectsState(state, {
    type: "load-success",
    projects: [{ ...projectA, summaryState: "unavailable" }],
  });
  assert.deepEqual(unavailable.projects, [{
    ...projectA,
    healthScore: 75,
    healthStatus: "needs-attention",
    riskCount: 1,
    summaryState: "unavailable",
  }]);

  const unconfigured = reduceProjectsState(unavailable, {
    type: "load-success",
    projects: [{ ...projectA, summaryState: "unconfigured" }],
  });
  assert.deepEqual(unconfigured.projects, [{ ...projectA, summaryState: "unconfigured" }]);
});

test("project list does not treat a missing summary contract as current health", () => {
  const previous: ProjectSummary[] = [{
    ...projectA,
    id: "project-stale-contract",
    healthScore: 45,
    healthStatus: "at-risk",
    riskCount: 3,
    summaryState: "available",
  }];
  const incoming: ProjectSummary[] = [{
    ...projectA,
    id: "project-stale-contract",
  }];

  const merged = mergeLastKnownSummaries(previous, incoming);

  assert.equal(merged[0]?.healthScore, undefined);
  assert.equal(merged[0]?.healthStatus, undefined);
  assert.equal(merged[0]?.riskCount, undefined);
});

test("project report cache is isolated by project id", () => {
  const storage = createStorage();
  const reportA = createReport(81);
  const reportB = createReport(64);
  writeProjectReportCache(storage, reportA, projectA.id);

  assert.deepEqual(readProjectReportCache(storage, projectA.id), reportA);
  assert.equal(readProjectReportCache(storage, projectB.id), null);
  assert.notEqual(
    getProjectReportCacheKey(projectA.id),
    getProjectReportCacheKey(projectB.id),
  );

  writeProjectReportCache(storage, reportB, projectB.id);
  assert.deepEqual(readProjectReportCache(storage, projectA.id), reportA);
  assert.deepEqual(readProjectReportCache(storage, projectB.id), reportB);
});

test("home health overview counts only real project summaries", () => {
  const overview = getProjectConsoleHealthOverview([
    { ...projectA, healthScore: 100, healthStatus: "healthy", riskCount: 0 },
    { ...projectB, healthScore: 75, healthStatus: "needs-attention", riskCount: 1 },
    { ...projectB, id: "project-without-summary" },
  ]);

  assert.deepEqual(overview, {
    projectCount: 3,
    analyzedProjectCount: 2,
    healthyProjectCount: 1,
    attentionProjectCount: 1,
  });
});

test("a project report API error does not pollute another project's cache", async () => {
  const storage = createStorage();
  const reportA = createReport(81);
  writeProjectReportCache(storage, reportA, projectA.id);
  const client = new ProjectApiClient(async () => new Response(JSON.stringify({
    error: { code: "PROJECT_REPORT_FAILED", message: "Report unavailable." },
  }), { status: 500 }));

  await assert.rejects(client.getProjectReport(projectB.id), (error: unknown) => (
    error instanceof ProjectApiError && error.code === "PROJECT_REPORT_FAILED"
  ));
  assert.deepEqual(readProjectReportCache(storage, projectA.id), reportA);
  assert.equal(readProjectReportCache(storage, projectB.id), null);
});

test("project data source state distinguishes configured, unconfigured, loading, and error", () => {
  const initial = createProjectDataSourceState(projectA.id);
  assert.equal(initial.status, "loading");

  const configured = reduceProjectDataSourceState(initial, {
    type: "load-success",
    projectId: projectA.id,
    configured: true,
  });
  assert.equal(configured.status, "configured");

  const loading = reduceProjectDataSourceState(configured, {
    type: "load-start",
    projectId: projectA.id,
  });
  const unconfigured = reduceProjectDataSourceState(loading, {
    type: "load-success",
    projectId: projectA.id,
    configured: false,
  });
  assert.equal(unconfigured.status, "unconfigured");

  const failed = reduceProjectDataSourceState(loading, {
    type: "load-error",
    projectId: projectA.id,
    error: "unavailable",
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "unavailable");
});

test("project data source state is isolated during project switches and late requests", () => {
  const configuredA = reduceProjectDataSourceState(
    createProjectDataSourceState(projectA.id),
    { type: "load-success", projectId: projectA.id, configured: true },
  );
  assert.equal(
    getVisibleProjectDataSourceState(configuredA, projectB.id).status,
    "loading",
  );

  const scopedB = reduceProjectDataSourceState(configuredA, {
    type: "scope-changed",
    projectId: projectB.id,
  });
  const afterLateA = reduceProjectDataSourceState(scopedB, {
    type: "load-success",
    projectId: projectA.id,
    configured: true,
  });
  const afterLateAStart = reduceProjectDataSourceState(afterLateA, {
    type: "load-start",
    projectId: projectA.id,
  });
  assert.equal(afterLateAStart.projectId, projectB.id);
  assert.equal(afterLateAStart.status, "loading");

  const unconfiguredB = reduceProjectDataSourceState(afterLateAStart, {
    type: "load-success",
    projectId: projectB.id,
    configured: false,
  });
  assert.equal(unconfiguredB.status, "unconfigured");
});

test("project route is explicit and reuses existing report pages", async () => {
  const appSource = await readFile(
    new URL("../frontend/src/app/App.tsx", import.meta.url),
    "utf8",
  );
  const projectSpaceSource = await readFile(
    new URL("../frontend/src/pages/Project/ProjectSpacePage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(appSource, /path="\/projects\/:projectId"/);
  assert.match(projectSpaceSource, /useProjectDetail\(projectId\)/);
  assert.match(projectSpaceSource, /useProjectReport\(projectId\)/);
  assert.match(projectSpaceSource, /<DashboardPage/);
  assert.match(projectSpaceSource, /<RiskCenterPage/);
  assert.match(projectSpaceSource, /<AIReportPage/);
  assert.match(projectSpaceSource, /无法访问该项目/);
  const projectsPageSource = await readFile(
    new URL("../frontend/src/pages/Projects/ProjectsPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(projectsPageSource, /project-health-score--\$\{project\.healthStatus\}/);
  assert.doesNotMatch(projectsPageSource, /ownerDisplayName|currentStage|deadline/);
});

test("project space keeps navigation, health facts, and responsive layout project-scoped", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [projectSpace, styles, riskCenter, aiReport] = await Promise.all([
    readFile(new URL("pages/Project/ProjectSpacePage.tsx", root), "utf8"),
    readFile(new URL("styles/index.css", root), "utf8"),
    readFile(new URL("pages/RiskCenter/RiskCenterPage.tsx", root), "utf8"),
    readFile(new URL("pages/AIReport/AIReportPage.tsx", root), "utf8"),
  ]);

  assert.match(projectSpace, /className="project-space"/);
  assert.match(projectSpace, /setCurrentProject\(project\.id\)/);
  assert.match(projectSpace, /navigate\(`\/projects\/\$\{encodeURIComponent\(nextProjectId\)\}`\)/);
  assert.match(projectSpace, /\/risks/);
  assert.match(projectSpace, /\/report/);
  assert.match(projectSpace, /project-health-score--\$\{healthStatus\}/);
  assert.match(projectSpace, /setOverviewRefreshState\("idle"\);\s*\}, \[projectId\]\)/);
  assert.match(projectSpace, /activeProjectIdRef\.current !== refreshProjectId/);
  assert.match(projectSpace, /currentRequest\?\.projectId === projectId/);
  assert.doesNotMatch(projectSpace, /ownerDisplayName|currentStage|deadline|dataSourceRef/);
  assert.match(riskCenter, /embedded = false/);
  assert.match(aiReport, /embedded = false/);
  assert.match(styles, /\.project-space \{[^}]*grid-template-columns/);
  assert.match(styles, /\.project-space__mobile-selector \{ display: none; \}/);
  assert.match(styles, /\.project-space__list \{ display: none; \}/);
  assert.match(styles, /--health-color-at-risk: var\(--risk-color-critical\)/);
  assert.match(styles, /\.health-hero--risk \{ --health-accent: var\(--health-color-at-risk\)/);
  assert.match(styles, /\.project-space__metrics strong:not\(\.project-health-score\) \{ color:/);
  assert.doesNotMatch(styles, /\.project-space__metrics strong \{ color:/);
});

test("project space and data configuration share one safe data source controller", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [projectSpace, dataSourcePanel, dataSourceHook] = await Promise.all([
    readFile(new URL("pages/Project/ProjectSpacePage.tsx", root), "utf8"),
    readFile(new URL("pages/Project/ProjectDataSourcePanel.tsx", root), "utf8"),
    readFile(new URL("features/projects/useProjectDataSource.ts", root), "utf8"),
  ]);

  assert.equal(projectSpace.match(/useProjectDataSource\(projectId\)/g)?.length, 1);
  assert.doesNotMatch(dataSourcePanel, /useProjectDataSource\(/);
  assert.match(dataSourcePanel, /dataSourceController/);
  assert.match(projectSpace, /projectDataSource\.status === "configured"/);
  assert.match(projectSpace, /projectDataSource\.status === "unconfigured"/);
  assert.match(projectSpace, /projectDataSource\.status === "idle"/);
  assert.match(projectSpace, /projectDataSource\.status === "loading"/);
  assert.match(projectSpace, /projectDataSource\.status === "error"/);
  assert.match(projectSpace, /Promise\.all\(\[refreshProjects\(\), projectReport\.refresh\(\)\]\)/);
  assert.match(dataSourcePanel, /await configure\(url\.trim\(\)\)/);
  assert.doesNotMatch(projectSpace + dataSourcePanel + dataSourceHook, /window\.location\.reload/);
  assert.doesNotMatch(projectSpace + dataSourcePanel + dataSourceHook, /baseToken|dataSourceRef|app_token/);
});

function createStorage(): ReportStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

function createReport(healthScore: number): ProjectReport {
  return {
    analysis: {
      healthScore,
      healthStatus: "needs-attention",
      riskLevel: "L3",
      riskSignals: [],
      scoringDetails: {
        calculatedAt: "2026-08-26T00:00:00.000Z",
        totalDeduction: 100 - healthScore,
      },
    },
    riskContexts: [],
    aiReport: { risks: [], limitations: [] },
  };
}
