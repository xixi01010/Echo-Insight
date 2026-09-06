import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveFact } from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { FeishuDocsReader, SourceReadError, type FeishuApiClient, type ProjectSourceReadContext } from "../feishu-connector/src/index.js";

const TIME = "2026-08-29T12:00:00.000Z";
test("reads one explicit document with block pagination and block locators", async () => {
  const calls: unknown[] = [];
  const reader = new FeishuDocsReader({ docx: { v1: { document: { get: async ({ path }) => { calls.push(path); return { code: 0, data: { document: { document_id: path.document_id, title: "项目方案", revision_id: 2 } } }; } }, documentBlock: { list: async ({ path, params }) => { calls.push({ path, params }); return params?.page_token ? { code: 0, data: { items: [{ block_id: "block-2", parent_id: "block-1", block_type: 2 }], has_more: false } } : { code: 0, data: { items: [{ block_id: "block-1", block_type: 1, text: { elements: [{ text_run: { content: "原始观察" } }] } }], has_more: true, page_token: "next" } }; } } } } }, { now: () => new Date(TIME) });
  const result = await reader.read({ context: context(), locator: { documentToken: "doc-1" } });
  assert.equal(result.status, "success");
  if (result.status !== "success") throw new Error("Expected success.");
  assert.deepEqual(calls, [{ document_id: "doc-1" }, { path: { document_id: "doc-1" }, params: { page_size: 100, document_revision_id: 2 } }, { path: { document_id: "doc-1" }, params: { page_size: 100, page_token: "next", document_revision_id: 2 } }]);
  assert.deepEqual(result.data.blocks[1], { blockId: "block-2", blockType: 2, parentId: "block-1" });
  assert.deepEqual(result.resources, [{ sourceRef: "source-docs", resourceType: "feishu-docx", resourceId: "doc-1" }]);
  // @ts-expect-error A document snapshot remains an observation, not a Fact.
  const _notFact: EffectiveFact<unknown> = result.data;
  void _notFact;
});
test("visibility short-circuits Docs before any content access", async () => {
  let calls = 0;
  const reader = new FeishuDocsReader({ docx: { v1: { document: { get: async () => { calls += 1; return { code: 0 }; } }, documentBlock: { list: async () => ({ code: 0 }) } } } });
  assert.equal((await reader.read({ context: context("denied"), locator: { documentToken: "doc-1" } })).status, "unavailable");
  assert.equal((await reader.read({ context: context("unknown"), locator: { documentToken: "doc-1" } })).status, "unknown");
  assert.equal(calls, 0);
});
test("Docs retains FND-04 categories and hides raw credential errors", async () => {
  for (const error of [new SourceReadError("permission-denied"), new SourceReadError("rate-limited"), new Error("credential-secret")]) {
    const reader = new FeishuDocsReader({ docx: { v1: { document: { get: async () => { throw error; } }, documentBlock: { list: async () => ({ code: 0 }) } } } });
    const result = await reader.read({ context: context(), locator: { documentToken: "doc-1" } });
    assert.equal(result.status, "failure");
    assert.equal(JSON.stringify(result).includes("credential-secret"), false);
  }
});
function context(visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext { return { projectId: "project-1", sourceRef: "source-docs", sourceKind: "feishu-docs", subject: { userId: "user-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: visibility === "allowed" ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" } : { sourceAuthorization: "unknown", subjectEligibility: "unknown" }, visibility }; }
