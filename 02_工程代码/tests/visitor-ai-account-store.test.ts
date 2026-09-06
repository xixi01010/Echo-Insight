import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  JsonVisitorAiAccountStore,
  readVisitorAiAccountMasterKey,
  toFeishuOpenIdIdentityRef,
} from "../backend/src/current-user/index.js";

const MASTER_KEY = Buffer.alloc(32, 7);
const OTHER_MASTER_KEY = Buffer.alloc(32, 8);

test("encrypted visitor AI account store survives reload without plaintext identity or API key", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-ai-account-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "visitor-ai-accounts.json");
  const identity = toFeishuOpenIdIdentityRef("ou_private_account_a", "cli_public_app");
  const secret = "test-only-provider-key-a";
  const store = new JsonVisitorAiAccountStore(filePath, MASTER_KEY);

  const saved = await store.save(identity, { providerId: "qwen", apiKey: secret });
  const firstSerialized = await readFile(filePath, "utf8");
  assert.equal(firstSerialized.includes(secret), false);
  assert.equal(firstSerialized.includes(identity.value), false);
  assert.equal(firstSerialized.includes(identity.context.applicationId), false);
  assert.equal(firstSerialized.includes("qwen"), false);

  const reloaded = new JsonVisitorAiAccountStore(filePath, MASTER_KEY);
  assert.deepEqual(await reloaded.find(identity), saved);
  assert.equal(
    await reloaded.find(toFeishuOpenIdIdentityRef(identity.value, "cli_different_app")),
    undefined,
  );
  assert.equal(
    await reloaded.find(toFeishuOpenIdIdentityRef("ou_private_account_b", "cli_public_app")),
    undefined,
  );

  await reloaded.save(identity, { providerId: "qwen", apiKey: secret });
  const secondSerialized = await readFile(filePath, "utf8");
  assert.notEqual(secondSerialized, firstSerialized);
  assert.equal(secondSerialized.includes(secret), false);

  const wrongKeyStore = new JsonVisitorAiAccountStore(filePath, OTHER_MASTER_KEY);
  await assert.rejects(wrongKeyStore.find(identity), /master key does not match/u);

  await reloaded.delete(identity);
  assert.equal(await new JsonVisitorAiAccountStore(filePath, MASTER_KEY).find(identity), undefined);
});

test("encrypted visitor AI account records reject cross-account ciphertext substitution", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-insight-ai-tamper-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "visitor-ai-accounts.json");
  const identityA = toFeishuOpenIdIdentityRef("ou_account_a", "cli_public_app");
  const identityB = toFeishuOpenIdIdentityRef("ou_account_b", "cli_public_app");
  const store = new JsonVisitorAiAccountStore(filePath, MASTER_KEY);

  await store.save(identityA, { providerId: "deepseek", apiKey: "test-only-a" });
  const afterA = JSON.parse(await readFile(filePath, "utf8")) as AccountFileFixture;
  const recordA = afterA.records[0];
  assert.ok(recordA);
  await store.save(identityB, { providerId: "qwen", apiKey: "test-only-b" });
  const afterB = JSON.parse(await readFile(filePath, "utf8")) as AccountFileFixture;
  const recordB = afterB.records.find((record) => record.subject !== recordA.subject);
  assert.ok(recordB);
  afterB.records = [recordA, { ...recordA, subject: recordB.subject }];
  await writeFile(filePath, `${JSON.stringify(afterB, null, 2)}\n`, "utf8");

  await assert.rejects(store.find(identityB), /cannot be decrypted/u);
});

test("visitor AI account master key parser requires canonical 32-byte Base64", () => {
  const encoded = MASTER_KEY.toString("base64");
  assert.deepEqual(readVisitorAiAccountMasterKey({
    ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY: encoded,
  }), MASTER_KEY);
  assert.throws(() => readVisitorAiAccountMasterKey({}), /is required/u);
  assert.throws(() => readVisitorAiAccountMasterKey({
    ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY: "not-a-key",
  }), /32-byte Base64/u);
});

interface AccountFileFixture {
  version: 1;
  keyId: string;
  records: Array<{
    version: 1;
    subject: string;
    iv: string;
    authTag: string;
    ciphertext: string;
    updatedAt: string;
  }>;
}
