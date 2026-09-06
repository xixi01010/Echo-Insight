import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveApplicationEntryExperience } from "../frontend/src/app/entry-experience";

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

test("public demo source stays synthetic and outside project or AI clients", () => {
  const source = readFileSync(
    new URL("../frontend/src/app/PublicDemoWorkspace.tsx", import.meta.url),
    "utf8",
  );

  for (const project of ["品牌焕新计划", "秋季增长活动", "内容平台重构", "新产品探索", "智能招聘助手"]) {
    assert.match(source, new RegExp(project, "u"));
  }
  assert.match(source, /无需登录/u);
  assert.match(source, /不会调用 AI 模型或消耗 API Token/u);
  assert.match(source, /登录并查看我的真实项目/u);
  assert.doesNotMatch(source, /\b(?:fetch|useProjects|useProjectReport|useAiAccess)\b/u);
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
