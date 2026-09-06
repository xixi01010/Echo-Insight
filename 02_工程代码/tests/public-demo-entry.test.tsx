import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { EntryChoiceScreen } from "../frontend/src/app/EntryChoiceScreen";
import {
  removeDemoModeFromSearch,
  resolveApplicationEntryExperience,
} from "../frontend/src/app/entry-experience";
import {
  createDemoApiFetch,
  resolveDemoApiEndpoint,
} from "../frontend/src/features/workspace/WorkspaceRuntimeContext";

test("anonymous visitors enter the synthetic demo instead of a login gate", () => {
  assert.equal(resolveApplicationEntryExperience({
    authenticated: false,
    loading: false,
    pathname: "/",
    search: "",
  }), "demo");
});

test("the public demo link asks for an explicit choice before entering either flow", () => {
  for (const state of [
    { authenticated: false, loading: true },
    { authenticated: false, loading: false },
    { authenticated: true, loading: false },
  ]) {
    assert.equal(resolveApplicationEntryExperience({
      ...state,
      pathname: "/",
      search: "?mode=demo",
    }), "choice");
  }
});

test("the internal demo route still represents an explicit demo choice", () => {
  assert.equal(resolveApplicationEntryExperience({
    authenticated: true,
    loading: true,
    pathname: "/demo",
    search: "",
  }), "demo");
});

test("leaving the public choice removes only the demo mode parameter", () => {
  assert.equal(removeDemoModeFromSearch("?mode=demo"), "");
  assert.equal(removeDemoModeFromSearch("?mode=demo&source=github"), "?source=github");
  assert.equal(removeDemoModeFromSearch("?source=github&mode=demo&lang=zh"), "?source=github&lang=zh");
});

test("the public entry choice explains both isolated paths in an accessible dialog", () => {
  const markup = renderToStaticMarkup(
    <EntryChoiceScreen
      authenticated={false}
      error={null}
      loginAvailable
      loginLoading={false}
      onChooseDemo={() => undefined}
      onEnterAccount={() => undefined}
    />,
  );

  assert.match(markup, /role="dialog"/u);
  assert.match(markup, /aria-modal="true"/u);
  assert.match(markup, /选择你的体验方式/u);
  assert.match(markup, /进入完整演示账号/u);
  assert.match(markup, /无需登录 · 5 个合成项目 · 不调用外部模型/u);
  assert.match(markup, /飞书登录并使用我的项目/u);
  assert.match(markup, /只属于你的真实工作区/u);
  assert.equal(markup.match(/<button/g)?.length, 2);
});

test("authenticated users enter their real workspace when demo was not requested", () => {
  assert.equal(resolveApplicationEntryExperience({
    authenticated: true,
    loading: false,
    pathname: "/projects",
    search: "",
  }), "workspace");
});

test("demo API adapter rewrites only API-path requests into the isolated namespace", async () => {
  assert.equal(resolveDemoApiEndpoint("/api/projects"), "/api/demo/projects");
  assert.equal(
    resolveDemoApiEndpoint("https://api.example.com/api/insights?limit=5"),
    "https://api.example.com/api/demo/insights?limit=5",
  );
  assert.throws(() => resolveDemoApiEndpoint("https://example.com/not-api"), /non-API/u);

  const requests: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    requests.push(String(input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  await createDemoApiFetch(fetcher)("/api/projects");
  assert.deepEqual(requests, ["/api/demo/projects"]);
});

test("anonymous demo reuses the complete product workspace and removes the divergent mini app", () => {
  const appSource = readFileSync(new URL("../frontend/src/app/App.tsx", import.meta.url), "utf8");
  const shellSource = readFileSync(new URL("../frontend/src/app/AppShell.tsx", import.meta.url), "utf8");
  const settingsSource = readFileSync(new URL("../frontend/src/pages/Settings/SettingsPage.tsx", import.meta.url), "utf8");
  const dataSourceSource = readFileSync(new URL("../frontend/src/pages/Project/ProjectDataSourcePanel.tsx", import.meta.url), "utf8");
  const runtimeSource = readFileSync(new URL("../frontend/src/features/workspace/WorkspaceRuntimeContext.tsx", import.meta.url), "utf8");
  const aiSetupSource = readFileSync(new URL("../frontend/src/features/ai-access/AiSetupBoundary.tsx", import.meta.url), "utf8");
  const projectsSource = readFileSync(new URL("../frontend/src/pages/Projects/ProjectsPage.tsx", import.meta.url), "utf8");

  assert.match(appSource, /entryExperience === "choice"/u);
  assert.match(
    appSource,
    /if \(entryExperience === "choice"\)[\s\S]+if \(entryExperience === "loading" && !demoOverride\)/u,
  );
  assert.doesNotMatch(appSource, /enterAccountFromChoice/u);
  assert.match(appSource, /runtime\.mode === "demo" \? <ApplicationWorkspace/u);
  assert.doesNotMatch(appSource, /PublicDemoWorkspace/u);
  assert.equal(existsSync(new URL("../frontend/src/app/PublicDemoWorkspace.tsx", import.meta.url)), false);
  assert.match(shellSource, /完整演示账号/u);
  assert.match(shellSource, /AI 解释为预生成示例/u);
  assert.match(shellSource, /登录服务暂未就绪/u);
  assert.match(shellSource, /role=\{authError \? "alert" : undefined\}/u);
  assert.match(settingsSource, /匿名体验不消耗 Token/u);
  assert.match(dataSourceSource, /演示账号为只读模式/u);
  assert.match(dataSourceSource, /currentUserRole === "owner" && !readOnly/u);
  assert.match(runtimeSource, /const resources = useMemo<WorkspaceRuntimeResources>/u);
  assert.match(runtimeSource, /synthesisSession: new GlobalSynthesisSession\(\),\s*\};\s*\}, \[mode\]\);/u);
  assert.doesNotMatch(runtimeSource, /\}, \[authenticated, mode, onEnterAccount\]\);/u);
  assert.match(aiSetupSource, /to="\/demo"/u);
  assert.match(projectsSource, /to="\/demo"/u);
});

test("public READMEs describe the entry choice instead of automatic demo entry", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const englishReadme = readFileSync(new URL("../../README.en.md", import.meta.url), "utf8");

  assert.match(readme, /先在提示框中选择「进入完整演示账号」或「飞书登录并使用我的项目」/u);
  assert.match(readme, /A\[打开在线入口\] --> B\{选择体验方式\}/u);
  assert.match(englishReadme, /then choose \*\*Enter the complete demo account\*\*/u);
  assert.match(englishReadme, /A\[Open the online entry\] --> B\{Choose an experience\}/u);
});

test("public README links the Chinese self-hosting entry and includes macOS guidance", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
  const englishReadme = readFileSync(new URL("../../README.en.md", import.meta.url), "utf8");

  assert.match(readme, /README\.md#安装引导/u);
  assert.doesNotMatch(readme, /README\.md#installation-guide/u);
  assert.match(readme, /sh \.\/setup-local\.sh/u);
  assert.match(readme, /install-macos-open-terminal\.svg/u);
  assert.match(englishReadme, /install-macos-open-terminal\.svg/u);
});
