import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveFact } from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { FeishuTaskReader, SourceReadError, type ProjectSourceReadContext } from "../feishu-connector/src/index.js";

test("reads only explicit finite task IDs and retains typed people", async () => {
  const calls: string[] = [];
  const reader = new FeishuTaskReader({ task: { v1: { task: {
    get: async ({ path }) => { calls.push(path.task_id); return { code: 0, data: { task: { id: path.task_id, summary: "任务", description: "观察", creator_id: "creator", collaborator_ids: ["collaborator"], follower_ids: ["follower"], due: { time: "100", timezone: "UTC" } } } }; },
  } } } }, options());
  const result = await reader.read({ context: context(), locator: { taskIds: ["task-1", "task-2", "task-1"] } });
  assert.equal(result.status, "success"); if (result.status !== "success") throw new Error("Expected success.");
  assert.deepEqual(calls, ["task-1", "task-2"]); assert.equal(result.data.tasks[0]?.creator?.type, "open_id"); assert.equal(result.data.tasks[0]?.collaborators[0]?.value, "collaborator");
  assert.deepEqual(result.resources.map((item) => item.resourceId), ["task-1", "task-2"]);
  // @ts-expect-error A task source record cannot become an EffectiveFact by reading it.
  const _notFact: EffectiveFact<unknown> = result.data; void _notFact;
});
test("visibility prevents task access and no all-task list exists in the reader", async () => {
  let calls = 0;
  const reader = new FeishuTaskReader({ task: { v1: { task: { get: async () => { calls += 1; return { code: 0 }; } } } } }, options());
  assert.equal((await reader.read({ context: context("denied"), locator: { taskIds: ["task-1"] } })).status, "unavailable");
  assert.equal((await reader.read({ context: context("unknown"), locator: { taskIds: ["task-1"] } })).status, "unknown"); assert.equal(calls, 0);
});
test("Task distinguishes categorized failures and hides raw credentials", async () => {
  for (const error of [new SourceReadError("permission-denied"), new SourceReadError("rate-limited"), new Error("secret-task-token")]) {
    const reader = new FeishuTaskReader({ task: { v1: { task: { get: async () => { throw error; } } } } }, options()); const result = await reader.read({ context: context(), locator: { taskIds: ["task-1"] } });
    assert.equal(result.status, "failure"); assert.equal(JSON.stringify(result).includes("secret-task-token"), false);
  }
});
function options() { return { identityContext: { applicationId: "cli_echo" } }; }
function context(visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext { return { projectId: "project-1", sourceRef: "source-task", sourceKind: "feishu-task", subject: { userId: "user-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: visibility === "allowed" ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" } : { sourceAuthorization: "unknown", subjectEligibility: "unknown" }, visibility }; }
