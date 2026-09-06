import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { INTERACTIVE_SURFACE_CLASS } from "../frontend/src/animations/interactive-surface.js";
import {
  motionDuration,
  prefersReducedMotion,
  REDUCED_MOTION_QUERY,
  type MotionPreferenceSource,
} from "../frontend/src/animations/motion-preferences.js";
import { PAGE_TRANSITION_DURATION_MS } from "../frontend/src/animations/page-transition.js";
import {
  getRiskLevelPresentation,
  getRiskToneClass,
} from "../frontend/src/features/project-report/presentation.js";
import type { RiskLevel } from "../frontend/src/services/api/types.js";

function preferenceSource(matches: boolean): MotionPreferenceSource {
  return {
    matchMedia: (query) => ({
      matches: query === REDUCED_MOTION_QUERY && matches,
    }),
  };
}

test("motion preferences disable significant duration when reduced motion is requested", () => {
  assert.equal(prefersReducedMotion(preferenceSource(true)), true);
  assert.equal(motionDuration(0.2, preferenceSource(true)), 0);
  assert.equal(prefersReducedMotion(preferenceSource(false)), false);
  assert.equal(motionDuration(0.2, preferenceSource(false)), 0.2);
  assert.ok(PAGE_TRANSITION_DURATION_MS >= 160);
  assert.ok(PAGE_TRANSITION_DURATION_MS <= 220);
});

test("risk levels map to one shared semantic tone system", async () => {
  const expectedTones: Record<RiskLevel, string> = {
    L1: "normal",
    L2: "watch",
    L3: "risk",
    L4: "high",
    L5: "critical",
  };

  for (const [level, tone] of Object.entries(expectedTones)) {
    const presentation = getRiskLevelPresentation(level as RiskLevel);
    assert.equal(presentation.tone, tone);
    assert.equal(getRiskToneClass(presentation.tone), `risk-tone--${tone}`);
  }

  const css = await readFile(
    new URL("../frontend/src/styles/index.css", import.meta.url),
    "utf8",
  );
  for (const token of [
    "--risk-color-normal",
    "--risk-color-low",
    "--risk-color-medium",
    "--risk-color-high",
    "--risk-color-critical",
  ]) {
    assert.match(css, new RegExp(token));
  }
  assert.doesNotMatch(css, /risk-card--(?:normal|watch|risk|high|critical)/);
  assert.doesNotMatch(css, /risk-pill--(?:normal|watch|risk|high|critical)/);

  for (const pagePath of [
    "../frontend/src/pages/Dashboard/DashboardPage.tsx",
    "../frontend/src/pages/RiskCenter/RiskCenterPage.tsx",
    "../frontend/src/pages/AIReport/AIReportPage.tsx",
  ]) {
    const pageSource = await readFile(new URL(pagePath, import.meta.url), "utf8");
    assert.match(pageSource, /getRiskToneClass/);
  }
});

test("interactive surface contract includes button, card, focus, and loading states", async () => {
  assert.match(INTERACTIVE_SURFACE_CLASS.button, /motion-surface--button/);
  assert.match(INTERACTIVE_SURFACE_CLASS.card, /motion-surface--card/);
  assert.match(
    INTERACTIVE_SURFACE_CLASS.interactiveCard,
    /motion-surface--interactive-card/,
  );

  const css = await readFile(
    new URL("../frontend/src/styles/index.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.motion-surface--card:hover/);
  assert.match(css, /\.motion-surface--button:hover/);
  assert.match(css, /\.motion-surface--button:active/);
  assert.match(css, /\.motion-surface--button:focus-visible/);
  assert.match(css, /\.motion-surface--button:disabled/);
  assert.match(css, /\[aria-busy="true"\]/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("V2 workspace shell keeps dashboard and project content fluid while preserving a reading width for settings", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [appShell, dashboard, modal, preferences, settings, styles] = await Promise.all([
    readFile(new URL("app/AppShell.tsx", root), "utf8"),
    readFile(new URL("pages/Projects/ProjectsPage.tsx", root), "utf8"),
    readFile(new URL("components/Modal.tsx", root), "utf8"),
    readFile(new URL("features/preferences/PreferenceContext.tsx", root), "utf8"),
    readFile(new URL("pages/Settings/SettingsPage.tsx", root), "utf8"),
    readFile(new URL("styles/index.css", root), "utf8"),
  ]);

  assert.match(appShell, /workspace-sidebar/);
  assert.match(appShell, /workspace-mobile-header/);
  assert.match(appShell, /workspace-viewport/);
  assert.match(appShell, /workspace-content/);
  assert.doesNotMatch(appShell, /app-tabbar|飞书 Base · 只读/);
  assert.match(dashboard, /CreateProjectModal/);
  assert.match(dashboard, /JoinProjectModal/);
  assert.equal((dashboard.match(/<Modal /g) ?? []).length, 2);
  assert.match(dashboard, /GlobalInsightsApiClient/);
  assert.match(modal, /createPortal/);
  assert.match(modal, /document\.body/);
  assert.match(modal, /modal-backdrop/);
  assert.match(preferences, /localStorage/);
  assert.match(preferences, /appearance: "light"/);
  assert.match(settings, /用户信息/);
  assert.match(settings, /首页设置/);
  assert.match(settings, /偏好设置/);
  assert.match(settings, /通用设置/);
  assert.match(styles, /@media \(max-width: 1024px\)/);
  assert.match(styles, /@media \(max-width: 768px\)/);
  assert.match(styles, /@media \(max-width: 480px\)/);
  assert.match(styles, /:root\[data-theme="dark"\]/);
  assert.match(styles, /\.workspace-shell \{[^}]*display: flex;[^}]*width: 100%;/s);
  assert.match(styles, /\.workspace-main \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;[^}]*width: calc\(100% - 68px\);/s);
  assert.match(styles, /\.workspace-viewport \{[^}]*width: 100%;/s);
  assert.match(styles, /\.workspace-content \{[^}]*padding:[^;]*clamp\(/s);
  assert.match(styles, /\.workspace-content--standard, \.workspace-content--wide \{ max-width: none; \}/);
  assert.match(styles, /\.workspace-content--settings \{[^}]*max-width: 1120px;/s);
  assert.doesNotMatch(styles, /\.workspace-content--(?:standard|wide) \{ max-width: \d+px; \}/);
  assert.match(styles, /\.project-card-grid \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 240px\), 1fr\)\)/s);
  assert.match(styles, /\.dashboard-metrics \{[^}]*repeat\(auto-fit,/s);
  assert.match(styles, /\.dashboard-focus-grid \{[^}]*repeat\(auto-fit,/s);
  assert.match(styles, /\.global-insight-list \{[^}]*repeat\(auto-fit,/s);
  assert.match(styles, /\.modal-layer \{[^}]*inset: 0;[^}]*position: fixed;[^}]*width: 100vw;/s);
});

test("workspace sidebar keeps one bottom-anchored footer and uses delayed desktop hover without affecting mobile navigation", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [appShell, preferences, styles] = await Promise.all([
    readFile(new URL("app/AppShell.tsx", root), "utf8"),
    readFile(new URL("features/preferences/PreferenceContext.tsx", root), "utf8"),
    readFile(new URL("styles/index.css", root), "utf8"),
  ]);

  assert.match(styles, /:root \{[^}]*--sidebar: #f8fafc;/s);
  assert.match(styles, /:root\[data-theme="dark"\] \{[^}]*--sidebar: #111929;/s);
  assert.match(styles, /\.workspace-sidebar \{[^}]*background: var\(--sidebar\);[^}]*color: var\(--sidebar-text\);/s);
  assert.match(styles, /\.workspace-sidebar\.is-expanded \{[^}]*width: 260px;/s);
  assert.match(styles, /\.workspace-sidebar__account-copy \{[^}]*flex: 1;[^}]*min-width: 0;/s);
  assert.match(styles, /\.workspace-sidebar\.is-expanded \.workspace-sidebar__logout \{ display: inline-flex; \}/);
  assert.match(styles, /\.workspace-sidebar__footer \{[^}]*margin-top: auto;/s);
  assert.match(styles, /\.workspace-sidebar__account \{[^}]*height: 64px;/s);
  assert.match(appShell, /aria-label="退出登录"/);
  assert.doesNotMatch(appShell, /workspace-sidebar__expand|aria-label=\{desktopExpanded \? "收起导航" : "展开导航"\}/);
  assert.match(appShell, /SIDEBAR_EXPAND_DELAY_MS = 900/);
  assert.match(appShell, /SIDEBAR_COLLAPSE_DELAY_MS = 340/);
  assert.match(appShell, /\(hover: hover\) and \(pointer: fine\) and \(min-width: 769px\)/);
  assert.match(appShell, /mobileOpen \? <button[^>]*className="workspace-mobile-overlay"/);
  assert.doesNotMatch(appShell, /desktopExpanded \|\| mobileOpen/);
  assert.match(styles, /\.workspace-mobile-overlay \{ display: none; \}/);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*\.workspace-mobile-overlay \{[^}]*display: block;[^}]*backdrop-filter: blur\(3px\);/);
  assert.doesNotMatch(styles, /\.workspace-sidebar:hover[^}]*width:/);
  assert.match(appShell, /onPointerEnter=\{handleSidebarPointerEnter\}/);
  assert.match(appShell, /onPointerLeave=\{handleSidebarPointerLeave\}/);
  assert.match(appShell, /onFocusCapture=\{handleSidebarFocus\}/);
  assert.match(appShell, /onBlurCapture=\{handleSidebarBlur\}/);
  assert.match(appShell, /clearExpandTimer\(\);[\s\S]*scheduleCollapse\(\);/);
  assert.match(appShell, /clearCollapseTimer\(\);[\s\S]*clearExpandTimer\(\);/);
  assert.match(appShell, /return \(\) => \{[\s\S]*clearExpandTimer\(\);[\s\S]*clearCollapseTimer\(\);/);
  assert.match(appShell, /if \(!media\.matches\)[\s\S]*collapseDesktopSidebar\(\)/);
  assert.match(preferences, /preferences\.appearance === "system"/);
  assert.match(preferences, /media\.addEventListener\("change", applyAppearance\)/);
  assert.match(preferences, /document\.documentElement\.dataset\.theme = resolvedTheme/);
});

test("dark mode readable-content semantics keep primary, body, supporting, muted, and disabled text distinct", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [dashboard, insights, aiReport, styles] = await Promise.all([
    readFile(new URL("pages/Dashboard/DashboardPage.tsx", root), "utf8"),
    readFile(new URL("pages/Insights/InsightsPage.tsx", root), "utf8"),
    readFile(new URL("pages/AIReport/AIReportPage.tsx", root), "utf8"),
    readFile(new URL("styles/index.css", root), "utf8"),
  ]);

  assert.match(styles, /:root \{[\s\S]*--text-primary:[^;]+;[\s\S]*--text-body:[^;]+;[\s\S]*--text-secondary:[^;]+;[\s\S]*--text-muted:[^;]+;[\s\S]*--text-disabled:[^;]+;/);
  assert.match(styles, /:root\[data-theme="dark"\] \{[\s\S]*--text-primary: #dfe7f3;[\s\S]*--text-body: #c6d1e0;[\s\S]*--text-secondary: #afbdd1;[\s\S]*--text-muted: #8494ab;[\s\S]*--text-disabled: #617087;/);
  assert.match(dashboard, /risk-summary-card--metric/);
  assert.match(styles, /:root\[data-theme="dark"\] \.risk-summary-card--metric > strong \{ color: var\(--text-primary\); \}/);
  assert.match(insights, /global-synthesis-card__summary/);
  assert.match(insights, /global-synthesis-card__body/);
  assert.match(insights, /global-synthesis-card__source-note/);
  assert.match(styles, /\.global-synthesis-card \.global-synthesis-card__summary,[\s\S]*var\(--text-body\)/);
  assert.match(styles, /\.global-synthesis-card \.global-synthesis-card__source-note \{ color: var\(--text-secondary\) !important; \}/);
  assert.match(styles, /\.global-insight-card \{ border-left-color: var\(--risk-accent, var\(--accent\)\); \}/);
  assert.match(styles, /:root\[data-theme="dark"\] \.global-insight-card \{ border-left-color: var\(--risk-accent, var\(--accent\)\); \}/);
  assert.match(insights, /getRiskToneClass\(level\.tone\)/);
  assert.match(insights, /aria-label="更新 AI 综合洞察"/);
  assert.match(aiReport, /report-boundary-card__body/);
  assert.match(styles, /\.report-boundary-card \.weui-panel__bd \.report-boundary-card__body \{ color: var\(--text-secondary\);/);
  assert.match(styles, /\.risk-summary-grid article p \{ color: var\(--text-secondary\); \}/);
  assert.match(styles, /\.dashboard-footer strong \{ color: var\(--text-secondary\); \}/);
  assert.match(styles, /:root\[data-theme="dark"\] \.system-evidence strong,[\s\S]*var\(--text-muted\)/);
  assert.match(styles, /:root\[data-theme="dark"\] \.context-limitation \{ color: var\(--text-secondary\) !important; \}/);
  assert.doesNotMatch(styles, /risk-summary-card--metric[^}]*var\(--text-disabled\)/);
});

test("whole-card responsive grids and module-scoped loading preserve workspace continuity without fake progress", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [riskCenter, aiReport, projectSpace, dashboard, insights, loadingStates, styles] = await Promise.all([
    readFile(new URL("pages/RiskCenter/RiskCenterPage.tsx", root), "utf8"),
    readFile(new URL("pages/AIReport/AIReportPage.tsx", root), "utf8"),
    readFile(new URL("pages/Project/ProjectSpacePage.tsx", root), "utf8"),
    readFile(new URL("pages/Dashboard/DashboardPage.tsx", root), "utf8"),
    readFile(new URL("pages/Insights/InsightsPage.tsx", root), "utf8"),
    readFile(new URL("components/LoadingStates.tsx", root), "utf8"),
    readFile(new URL("styles/index.css", root), "utf8"),
  ]);

  assert.match(riskCenter, /className="risk-card-grid"/);
  assert.doesNotMatch(riskCenter, /risk-card--wide|shouldSpanRiskCard/);
  assert.match(styles, /\.risk-card-grid, \.ai-report-card-grid \{[^}]*repeat\(auto-fit, minmax\(min\(100%, 410px\), 1fr\)\)/s);
  assert.match(styles, /\.risk-card-grid \.risk-card__header, \.ai-report-card-grid \.explanation-chain__header \{[^}]*min-block-size: 0;/s);
  assert.match(styles, /\.risk-card__body \{[^}]*grid-template-columns: 1fr;/s);
  assert.doesNotMatch(styles, /\.risk-card__body \{[^}]*grid-template-columns: 1fr 1fr;/s);
  assert.match(aiReport, /ai-report-page/);
  assert.match(aiReport, /className="ai-report-card-grid"/);
  assert.match(aiReport, /className=\{`explanation-chain/);
  assert.match(aiReport, /className=\{`ai-report-summary/);
  assert.doesNotMatch(styles, /\.ai-report-page \.explanation-chain \{[^}]*grid-template-columns:/s);
  assert.match(loadingStates, /createPortal/);
  assert.match(loadingStates, /document\.body/);
  assert.match(styles, /\.workspace-loading-layer \{[^}]*height: 100dvh;[^}]*position: fixed;[^}]*width: 100vw;/s);
  assert.match(projectSpace, /<WorkspaceLoadingOverlay/);
  assert.match(projectSpace, /<SectionSkeleton/);
  assert.match(projectSpace, /view === "report" && showReportLoading/);
  assert.match(projectSpace, /view === "risks" && showReportLoading/);
  assert.doesNotMatch(projectSpace, /view !== "overview"[\s\S]{0,120}reportLoading/);
  assert.doesNotMatch(projectSpace, /view === "data-source" && reportLoading/);
  assert.match(dashboard, /title="正在整理项目概览"/);
  assert.doesNotMatch(dashboard, /title="正在整理项目洞察"/);
  assert.match(insights, /<AiShimmer/);
  assert.match(insights, /<SectionSkeleton/);
  assert.doesNotMatch(loadingStates + insights, /aria-valuenow|<progress|\b\d{1,3}%/);
});

test("project sticky header uses desktop hysteresis, animation-frame throttling, and complete cleanup", async () => {
  const projectSpace = await readFile(
    new URL("../frontend/src/pages/Project/ProjectSpacePage.tsx", import.meta.url),
    "utf8",
  );

  assert.match(projectSpace, /PROJECT_HEADER_COLLAPSE_SCROLL_Y = 140/);
  assert.match(projectSpace, /PROJECT_HEADER_EXPAND_SCROLL_Y = 72/);
  assert.match(projectSpace, /current[\s\S]*PROJECT_HEADER_EXPAND_SCROLL_Y[\s\S]*PROJECT_HEADER_COLLAPSE_SCROLL_Y/);
  assert.match(projectSpace, /requestAnimationFrame\(updateHeader\)/);
  assert.match(projectSpace, /if \(next === current\) return;/);
  assert.match(projectSpace, /removeEventListener\("scroll", requestHeaderUpdate\)/);
  assert.match(projectSpace, /cancelAnimationFrame\(animationFrame\)/);
  assert.match(projectSpace, /\(min-width: 769px\)/);
  assert.doesNotMatch(projectSpace, /scrollY > 92/);
});

test("HOTFIX-005 uses unified controls, delayed loading, semantic health, and safe source presentation", async () => {
  const root = new URL("../frontend/src/", import.meta.url);
  const [
    projects,
    settings,
    projectSpace,
    appShell,
    customSelect,
    segmentedControl,
    delayedLoading,
    dataSourcePanel,
    styles,
  ] = await Promise.all([
    readFile(new URL("pages/Projects/ProjectsPage.tsx", root), "utf8"),
    readFile(new URL("pages/Settings/SettingsPage.tsx", root), "utf8"),
    readFile(new URL("pages/Project/ProjectSpacePage.tsx", root), "utf8"),
    readFile(new URL("app/AppShell.tsx", root), "utf8"),
    readFile(new URL("components/CustomSelect.tsx", root), "utf8"),
    readFile(new URL("components/SegmentedControl.tsx", root), "utf8"),
    readFile(new URL("hooks/useDelayedLoadingVisibility.ts", root), "utf8"),
    readFile(new URL("pages/Project/ProjectDataSourcePanel.tsx", root), "utf8"),
    readFile(new URL("styles/index.css", root), "utf8"),
  ]);

  assert.doesNotMatch(projects, /health-track|healthScore}%/);
  assert.match(projects, /project-health-score--/);
  assert.doesNotMatch(settings + projectSpace, /<select/);
  assert.match(settings, /<CustomSelect/);
  assert.match(projectSpace, /<CustomSelect/);
  assert.match(settings, /<SegmentedControl/);
  for (const key of ["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"]) {
    assert.match(customSelect, new RegExp(`event\\.key === "${key}"`));
  }
  assert.match(customSelect, /createPortal/);
  assert.match(customSelect, /position: fixed|custom-select__menu/);
  assert.match(segmentedControl, /role="radiogroup"/);
  assert.match(segmentedControl, /--active-index/);
  assert.match(styles, /segmented-control__indicator[^}]*transform: translateX/s);
  assert.match(delayedLoading, /LOADING_REVEAL_DELAY_MS = 160/);
  assert.match(delayedLoading, /LOADING_MIN_VISIBLE_MS = 220/);
  assert.match(delayedLoading, /window\.clearTimeout\(timer\)/);
  assert.match(appShell, /pointerInsideRef/);
  assert.match(appShell, /focusInsideRef/);
  assert.match(dataSourcePanel, /dataSource\?\.displayName/);
  assert.match(dataSourcePanel, /当前数据来源/);
  assert.doesNotMatch(dataSourcePanel, /baseToken|dataSourceRef|appToken|accessToken/);
  assert.match(styles, /:root\[data-theme="dark"\][\s\S]*--text-primary: #dfe7f3;/);
});
