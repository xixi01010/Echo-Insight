import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveFact } from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { FeishuWikiDriveReader, SourceReadError, type ProjectSourceReadContext } from "../feishu-connector/src/index.js";

test("reads one explicit Wiki node or Drive file without space or folder enumeration", async () => {
  const calls: unknown[] = [];
  const reader = new FeishuWikiDriveReader({ wiki: { v2: { space: { getNode: async ({ params }) => { calls.push(params); return { code: 0, data: { node: { node_token: "wiki-1", obj_token: "doc-1", obj_type: "docx", title: "Wiki 页面", obj_edit_time: "200" } } }; } } } }, drive: { v1: { meta: { batchQuery: async (request) => { calls.push(request); return { code: 0, data: { metas: [{ doc_token: "file-1", doc_type: "file", title: "附件", latest_modify_time: "300" }] } }; } } } } });
  const wiki = await reader.read({ context: context(), locator: { kind: "wiki-node", nodeToken: "wiki-1", objectType: "docx" } });
  const drive = await reader.read({ context: context(), locator: { kind: "drive-file", fileToken: "file-1", fileType: "file" } });
  assert.equal(wiki.status, "success"); assert.equal(drive.status, "success");
  assert.deepEqual(calls, [{ token: "wiki-1", obj_type: "docx" }, { data: { request_docs: [{ doc_token: "file-1", doc_type: "file" }], with_url: true } }]);
  if (wiki.status !== "success") throw new Error("Expected Wiki success.");
  // @ts-expect-error A resolved Wiki object is not an admitted project Fact.
  const _notFact: EffectiveFact<unknown> = wiki.data;
  void _notFact;
});
test("visibility blocks Wiki/Drive before resource access", async () => {
  let calls = 0;
  const reader = new FeishuWikiDriveReader({ wiki: { v2: { space: { getNode: async () => { calls += 1; return { code: 0 }; } } } } });
  assert.equal((await reader.read({ context: context("denied"), locator: { kind: "wiki-node", nodeToken: "wiki-1" } })).status, "unavailable");
  assert.equal(calls, 0);
});
test("Wiki/Drive maps allowed FND-04 errors and does not leak raw errors", async () => {
  for (const error of [new SourceReadError("not-found"), new SourceReadError("permission-denied"), new Error("token-secret")]) {
    const reader = new FeishuWikiDriveReader({ wiki: { v2: { space: { getNode: async () => { throw error; } } } } });
    const result = await reader.read({ context: context(), locator: { kind: "wiki-node", nodeToken: "wiki-1" } });
    assert.equal(result.status, "failure"); assert.equal(JSON.stringify(result).includes("token-secret"), false);
  }
});
test("Wiki/Drive maps Feishu forbidden resource code to permission-denied", async () => {
  const reader = new FeishuWikiDriveReader({ wiki: { v2: { space: { getNode: async () => ({ code: 1770032 }) } } } });
  const result = await reader.read({ context: context(), locator: { kind: "wiki-node", nodeToken: "wiki-1" } });
  assert.equal(result.status, "failure");
  if (result.status === "failure") assert.equal(result.category, "permission-denied");
});
test("Wiki/Drive maps an SDK-thrown forbidden response to permission-denied", async () => {
  const reader = new FeishuWikiDriveReader({ wiki: { v2: { space: { getNode: async () => { throw { response: { data: { code: 1770032 } } }; } } } } });
  const result = await reader.read({ context: context(), locator: { kind: "wiki-node", nodeToken: "wiki-1" } });
  assert.equal(result.status, "failure");
  if (result.status === "failure") assert.equal(result.category, "permission-denied");
});
function context(visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext { return { projectId: "project-1", sourceRef: "source-wiki", sourceKind: "feishu-wiki-drive", subject: { userId: "user-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: visibility === "allowed" ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" } : { sourceAuthorization: "unknown", subjectEligibility: "unknown" }, visibility }; }
