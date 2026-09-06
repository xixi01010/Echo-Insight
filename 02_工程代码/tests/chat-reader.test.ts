import assert from "node:assert/strict";
import test from "node:test";

import type { EffectiveFact } from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import {
  FeishuChatReader,
  SourceReadError,
  type FeishuApiClient,
  type ProjectSourceReadContext,
} from "../feishu-connector/src/index.js";

const TIME = "2026-08-29T09:00:00.000Z";

test("reads only the explicit chat with pagination and retains message provenance", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const reader = new FeishuChatReader({
    im: {
      v1: {
        message: {
          list: async ({ params }) => {
            calls.push(params);
            return params.page_token
              ? { code: 0, data: { items: [message({ message_id: "message-2", sender: { id: "union-2", id_type: "union_id" } })], has_more: false } }
              : { code: 0, data: { items: [message({ root_id: "root-1", parent_id: "parent-1", thread_id: "thread-1", deleted: false, updated: true })], has_more: true, page_token: "next" } };
          },
        },
      },
    },
  }, options());

  const result = await reader.read({ context: context(), locator: { containerType: "chat", containerId: "chat-1" } });
  assert.equal(result.status, "success");
  if (result.status !== "success") throw new Error("Expected chat read success.");
  assert.deepEqual(calls, [
    { container_id_type: "chat", container_id: "chat-1", sort_type: "ByCreateTimeAsc", page_size: 50, with_sender_name: false },
    { container_id_type: "chat", container_id: "chat-1", sort_type: "ByCreateTimeAsc", page_size: 50, page_token: "next", with_sender_name: false },
  ]);
  assert.equal(result.data.messages.length, 2);
  assert.equal(result.data.messages[0]?.sender?.identity?.type, "open_id");
  assert.equal(result.data.messages[1]?.sender?.identity?.type, "union_id");
  assert.deepEqual(result.data.messages[0], {
    messageId: "message-1",
    sender: { identity: toFeishuOpenIdIdentityRef("open-1", "cli_echo"), senderType: "user" },
    createTime: "1724918400000",
    updateTime: "1724918500000",
    messageType: "text",
    content: "可能 9 月 4 日解决",
    rootId: "root-1",
    parentId: "parent-1",
    threadId: "thread-1",
    chatId: "chat-1",
    deleted: false,
    updated: true,
  });
  assert.deepEqual(result.resources, [{ sourceRef: "source-chat-1", resourceType: "chat", resourceId: "chat-1" }]);
  // @ts-expect-error A chat result is not an admitted project fact.
  const _notEffectiveFact: EffectiveFact<unknown> = result.data;
  void _notEffectiveFact;
});

test("thread locator returns only records for the explicit thread", async () => {
  const reader = new FeishuChatReader(clientWithMessages([
    message({ message_id: "thread-message", thread_id: "thread-1" }),
    message({ message_id: "other-thread", thread_id: "thread-2" }),
  ]), options());
  const result = await reader.read({ context: context(), locator: { containerType: "thread", containerId: "thread-1" } });

  assert.equal(result.status, "success");
  if (result.status !== "success") throw new Error("Expected thread read success.");
  assert.deepEqual(result.data.messages.map((item) => item.messageId), ["thread-message"]);
  assert.equal(result.resources[0]?.resourceType, "thread");
});

test("denied and unknown visibility never call the chat API or expose content", async () => {
  let calls = 0;
  const reader = new FeishuChatReader({
    im: { v1: { message: { list: async () => { calls += 1; return { code: 0, data: { items: [], has_more: false } }; } } } },
  }, options());
  const denied = await reader.read({ context: context("denied"), locator: { containerType: "chat", containerId: "chat-1" } });
  const unknown = await reader.read({ context: context("unknown"), locator: { containerType: "chat", containerId: "chat-1" } });

  assert.equal(denied.status, "unavailable");
  assert.equal(unknown.status, "unknown");
  assert.equal(calls, 0);
  assert.equal(JSON.stringify(denied).includes("可能"), false);
});

test("permission and rate-limit errors retain FND-04 categories without raw error text", async () => {
  for (const category of ["permission-denied", "rate-limited"] as const) {
    const reader = new FeishuChatReader({
      im: { v1: { message: { list: async () => { throw new SourceReadError(category); } } } },
    }, options());
    const result = await reader.read({ context: context(), locator: { containerType: "chat", containerId: "chat-1" } });
    assert.equal(result.status, "failure");
    assert.equal(result.status === "failure" && result.category, category);
    assert.equal(JSON.stringify(result).includes("Source read failed"), false);
  }
});

test("documented upstream permission response maps to the FND-04 permission category", async () => {
  const reader = new FeishuChatReader({
    im: { v1: { message: { list: async () => ({ code: 1770032 }) } } },
  }, options());
  const result = await reader.read({ context: context(), locator: { containerType: "chat", containerId: "chat-1" } });

  assert.equal(result.status, "failure");
  assert.equal(result.status === "failure" && result.category, "permission-denied");
});

test("unknown upstream errors never expose credential-like text", async () => {
  const reader = new FeishuChatReader({
    im: { v1: { message: { list: async () => { throw new Error("raw-token-should-not-leak"); } } } },
  }, options());
  const result = await reader.read({ context: context(), locator: { containerType: "chat", containerId: "chat-1" } });

  assert.equal(result.status, "failure");
  assert.equal(result.status === "failure" && result.category, "unknown");
  assert.equal(JSON.stringify(result).includes("raw-token-should-not-leak"), false);
});

function options() {
  return { identityContext: { applicationId: "cli_echo" }, now: () => new Date(TIME) };
}

function context(visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext {
  return {
    projectId: "project-1",
    sourceRef: "source-chat-1",
    sourceKind: "feishu-chat",
    subject: { userId: "user-1", identity: toFeishuOpenIdIdentityRef("open-viewer", "cli_echo") },
    authorization: visibility === "allowed"
      ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" }
      : { sourceAuthorization: "unknown", subjectEligibility: "unknown" },
    visibility,
  };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    message_id: "message-1",
    sender: { id: "open-1", id_type: "open_id", sender_type: "user" },
    create_time: "1724918400000",
    update_time: "1724918500000",
    msg_type: "text",
    body: { content: "可能 9 月 4 日解决" },
    chat_id: "chat-1",
    ...overrides,
  };
}

function clientWithMessages(messages: ReturnType<typeof message>[]): Pick<FeishuApiClient, "im"> {
  return {
    im: { v1: { message: { list: async () => ({ code: 0, data: { items: messages, has_more: false } }) } } },
  };
}
