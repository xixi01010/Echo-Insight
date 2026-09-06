import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { resolveApplicationEntryExperience } from "../frontend/src/app/entry-experience";
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

test("an explicit demo request wins even for an authenticated visitor", () => {
  assert.equal(resolveApplicationEntryExperience({
    authenticated: true,
    loading: true,
    pathname: "/",
    search: "?mode=demo",
  }), "demo");
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
