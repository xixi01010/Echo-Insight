import assert from "node:assert/strict";
import test from "node:test";

import {
  createFeishuClient,
  readFeishuCredentials,
} from "../feishu-connector/src/index.js";

test("connector initializes with environment credentials without making a request", () => {
  const credentials = readFeishuCredentials({
    FEISHU_APP_ID: "test-app-id",
    FEISHU_APP_SECRET: "test-app-secret",
  });
  const client = createFeishuClient(credentials);

  assert.equal(credentials.appId, "test-app-id");
  assert.equal(credentials.appSecret, "test-app-secret");
  assert.equal(typeof client, "object");
  assert.equal(typeof client.bitable.v1.app.get, "function");
});

test("connector rejects missing credentials", () => {
  assert.throws(
    () => readFeishuCredentials({}),
    /Missing FEISHU_APP_ID or FEISHU_APP_SECRET/,
  );
});
