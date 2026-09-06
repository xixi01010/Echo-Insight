import assert from "node:assert/strict";
import test from "node:test";

import type { EffectiveFact } from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import {
  FeishuMinutesReader,
  MinutesTranscriptUnavailableError,
  SourceReadError,
  type FeishuApiClient,
  type ProjectSourceReadContext,
} from "../feishu-connector/src/index.js";

const TIME = "2026-08-29T10:00:00.000Z";

test("reads one explicit Minutes, completes transcript stream, and separates platform artifacts", async () => {
  const calls: string[] = [];
  const reader = new FeishuMinutesReader(client({ calls, transcript: ["[00:00] Alice: 开始\n", "[00:10] Bob: 讨论完成\n"] }), options());
  const result = await reader.read({ context: context(), locator: { minuteToken: "minute-1" } });

  assert.equal(result.status, "success");
  if (result.status !== "success") throw new Error("Expected Minutes success.");
  assert.deepEqual(calls, ["metadata:minute-1", "transcript:minute-1", "artifacts:minute-1"]);
  assert.equal(result.data.metadata.owner?.type, "open_id");
  assert.deepEqual(result.data.transcript, { kind: "raw-transcript", state: "available", content: "[00:00] Alice: 开始\n[00:10] Bob: 讨论完成\n" });
  assert.deepEqual(result.data.artifacts.map((item) => item.kind), ["platform-summary", "platform-chapter", "platform-todo", "platform-keyword"]);
  assert.deepEqual(result.data.meetingRelation, { state: "unknown" });
  assert.deepEqual(result.resources, [{ sourceRef: "source-minutes-1", resourceType: "feishu-minutes", resourceId: "minute-1" }]);
  // @ts-expect-error A Minutes snapshot is not an admitted fact.
  const _notEffective: EffectiveFact<unknown> = result.data;
  void _notEffective;
});

test("unavailable transcript is an observable state, not a source failure", async () => {
  const result = await new FeishuMinutesReader(client({ transcriptError: new MinutesTranscriptUnavailableError() }), options()).read({ context: context(), locator: { minuteToken: "minute-1" } });
  assert.equal(result.status, "success");
  assert.deepEqual(result.status === "success" && result.data.transcript, { kind: "raw-transcript", state: "unavailable" });
});

test("denied and unknown visibility do not call Minutes APIs", async () => {
  let calls = 0;
  const reader = new FeishuMinutesReader(client({ onCall: () => { calls += 1; } }), options());
  const denied = await reader.read({ context: context("denied"), locator: { minuteToken: "minute-1" } });
  const unknown = await reader.read({ context: context("unknown"), locator: { minuteToken: "minute-1" } });
  assert.equal(denied.status, "unavailable");
  assert.equal(unknown.status, "unknown");
  assert.equal(calls, 0);
});

test("FND-04 errors are categorized and raw credential-like errors stay hidden", async () => {
  for (const error of [new SourceReadError("permission-denied"), new SourceReadError("not-found"), new SourceReadError("rate-limited"), new Error("credential-secret")]) {
    const result = await new FeishuMinutesReader(client({ metadataError: error }), options()).read({ context: context(), locator: { minuteToken: "minute-1" } });
    assert.equal(result.status, "failure");
    assert.equal(JSON.stringify(result).includes("credential-secret"), false);
  }
});

function options() { return { identityContext: { applicationId: "cli_echo" }, now: () => new Date(TIME) }; }
function context(visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext {
  return { projectId: "project-1", sourceRef: "source-minutes-1", sourceKind: "feishu-minutes", subject: { userId: "user-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: visibility === "allowed" ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" } : { sourceAuthorization: "unknown", subjectEligibility: "unknown" }, visibility };
}
function client(input: { calls?: string[]; transcript?: string[]; transcriptError?: Error; metadataError?: Error; onCall?: () => void } = {}): Pick<FeishuApiClient, "minutes"> {
  const called = (name: string) => { input.calls?.push(name); input.onCall?.(); };
  return { minutes: { v1: {
    minute: {
      get: async ({ path }) => { called(`metadata:${path.minute_token}`); if (input.metadataError) throw input.metadataError; return { code: 0, data: { minute: { owner_id: "owner-1", create_time: "100", title: "项目例会", duration: "600" } } }; },
      artifacts: async ({ path }) => { called(`artifacts:${path.minute_token}`); return { code: 0, data: { summary: "平台摘要", minute_chapters: [{ title: "章节", start_ms: "0", stop_ms: "100", summary_content: "章节摘要" }], minute_todos: [{ todo_id: "todo-1", content: "平台待办", assignees: ["unknown-id"], is_done: false }], keywords: ["项目"] } }; },
    },
    minuteTranscript: { get: async ({ path }) => { called(`transcript:${path.minute_token}`); if (input.transcriptError) throw input.transcriptError; return { getReadableStream: async function* () { yield* input.transcript ?? ["原始转写"]; } }; } },
  } } };
}
