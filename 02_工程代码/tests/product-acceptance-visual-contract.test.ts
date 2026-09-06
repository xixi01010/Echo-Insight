import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readFrontend = (path: string) => readFile(new URL(`../frontend/src/${path}`, import.meta.url), "utf8");

test("favorites use accessible star controls and do not strand projects after the first three", async () => {
  const source = await readFrontend("pages/Projects/ProjectsPage.tsx");
  assert.match(source, /AppIcon name="star"/);
  assert.match(source, /aria-pressed/);
  assert.match(source, /showAllFavorites/);
  assert.match(source, /aria-controls="favorite-projects-extra"/);
  assert.match(source, /AnimatedDisclosure/);
  assert.match(source, /favoriteProjects\.slice\(3\)/);
});

test("home console renders from a project-list snapshot and shows a distinct refreshing state", async () => {
  const [page, context, styles] = await Promise.all([
    readFrontend("pages/Projects/ProjectsPage.tsx"),
    readFrontend("features/projects/ProjectContext.tsx"),
    readFrontend("styles/index.css"),
  ]);
  assert.match(context, /readProjectListSnapshot/);
  assert.match(context, /writeProjectListSnapshot/);
  assert.match(page, /projectsRefreshing/);
  assert.match(page, /is-refreshing/);
  assert.match(page, /dashboard-refresh-notice--updating/);
  assert.match(page, /dashboard-metrics dashboard-refresh-surface/);
  assert.match(styles, /\.dashboard-page\.is-refreshing \.dashboard-refresh-surface/);
});

test("project refresh keeps all intelligence surfaces visibly busy and places feedback near the action", async () => {
  const [space, dashboard, intelligence] = await Promise.all([
    readFrontend("pages/Project/ProjectSpacePage.tsx"),
    readFrontend("pages/Dashboard/DashboardPage.tsx"),
    readFrontend("pages/Project/ProjectIntelligencePanel.tsx"),
  ]);
  assert.match(space, /Promise\.all/);
  assert.match(space, /projectIntelligence\.refresh/);
  assert.match(dashboard, /dashboard-refresh-notice/);
  assert.match(dashboard, /dashboard-refresh-surface/);
  assert.match(intelligence, /ProjectIntelligenceSkeleton/);
});

test("desktop detail drawers and mobile accordion share an accessible detail contract", async () => {
  const [component, risk, report] = await Promise.all([
    readFrontend("components/AdaptiveDetail.tsx"),
    readFrontend("pages/RiskCenter/RiskCenterPage.tsx"),
    readFrontend("pages/AIReport/AIReportPage.tsx"),
  ]);
  assert.match(component, /aria-modal="true"/);
  assert.match(component, /event\.key === "Escape"/);
  assert.match(component, /event\.key !== "Tab"/);
  assert.match(risk, /收起详情/);
  assert.match(report, /收起详情/);
  assert.match(risk, /AnimatedDisclosure/);
  assert.match(report, /DetailDrawer/);
});

test("cross-project insights preserve the default ordering while adding full risk filters", async () => {
  const source = await readFrontend("pages/Insights/InsightsPage.tsx");
  assert.match(source, /浏览所有已确认风险/);
  assert.match(source, /风险等级/);
  assert.match(source, /全部项目/);
  assert.match(source, /按计划时间/);
  assert.match(source, /sortMode === "deadline"/);
  assert.match(source, /: filtered;/);
});

test("responsive source cards and motion respect product density and reduced-motion", async () => {
  const styles = await readFrontend("styles/index.css");
  assert.match(styles, /\.data-source-list \{[^}]*repeat\(auto-fill, minmax\(min\(100%, 240px\), 1fr\)\)/);
  assert.match(styles, /\.data-source-card \{[^}]*min-height: 1[0-9]\dpx;[^}]*padding: 1[4-6]px;/);
  assert.doesNotMatch(styles, /\.data-source-card \{[^}]*aspect-ratio/);
  assert.match(styles, /animated-disclosure/);
  assert.match(styles, /prefers-reduced-motion: reduce/);
  assert.match(styles, /align-items: start/);
  assert.doesNotMatch(styles, /risk-card-grid \.risk-card__header[^\n]+min-block-size: 104px/);
});

test("global risk rows use a two-line readable structure instead of a cramped single line", async () => {
  const [source, styles] = await Promise.all([
    readFrontend("pages/Insights/InsightsPage.tsx"),
    readFrontend("styles/index.css"),
  ]);
  assert.ok(source.includes('className="global-risk-row__header"><span className="risk-pill">{level.label}</span><strong>'));
  assert.ok(source.includes('</strong><Link className="text-action"'));
  assert.ok(source.includes('className="global-risk-row__meta">{insight.projectName}'));
  assert.ok(source.includes('\u4f9d\u636e\uff1a{sanitizeUserFacingText(insight.ruleBasis)}') || source.includes('依据：{sanitizeUserFacingText(insight.ruleBasis)}'));
  assert.doesNotMatch(source, /global-risk-row__main/);
  assert.match(styles, /\.global-risk-row \{[^}]*min-height: 6[0-9]px;[^}]*padding: 1[4-6]px 16px;/);
  assert.match(styles, /\.global-risk-row__header \{[^}]*display: flex;[^}]*flex-wrap: wrap;/);
  assert.match(styles, /\.global-risk-row__meta \{[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/);
  assert.doesNotMatch(styles, /\.global-risk-row p \{[^}]*-webkit-line-clamp/);
});
