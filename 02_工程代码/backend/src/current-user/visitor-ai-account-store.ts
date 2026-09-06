import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FeishuIdentityRef } from "./feishu-identity-reference.js";

const STORE_VERSION = 1;
const ENCRYPTED_RECORD_VERSION = 1;
const MASTER_KEY_BYTES = 32;
const IV_BYTES = 12;

export type VisitorAiProviderId = "deepseek" | "qwen";

export interface VisitorAiAccountConfiguration {
  providerId: VisitorAiProviderId;
  apiKey: string;
  revision: string;
}

export interface VisitorAiAccountStore {
  find(identity: FeishuIdentityRef): Promise<VisitorAiAccountConfiguration | undefined>;
  save(
    identity: FeishuIdentityRef,
    input: Pick<VisitorAiAccountConfiguration, "providerId" | "apiKey">,
  ): Promise<VisitorAiAccountConfiguration>;
  delete(identity: FeishuIdentityRef): Promise<void>;
}

interface EncryptedAccountRecord {
  version: 1;
  subject: string;
  iv: string;
  authTag: string;
  ciphertext: string;
  updatedAt: string;
}

interface EncryptedAccountFile {
  version: 1;
  keyId: string;
  records: EncryptedAccountRecord[];
}

interface EncryptedPayload extends VisitorAiAccountConfiguration {
  subject: string;
}

/**
 * Stores visitor-owned model access by stable Feishu identity. The lookup key is
 * an HMAC and the payload is AES-256-GCM encrypted; neither the Feishu open_id
 * nor API key is written to disk in plaintext.
 */
export class JsonVisitorAiAccountStore implements VisitorAiAccountStore {
  private readonly encryptionKey: Buffer;
  private readonly lookupKey: Buffer;
  private readonly keyId: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    masterKey: Buffer,
  ) {
    if (masterKey.length !== MASTER_KEY_BYTES) {
      throw new Error("Visitor AI account master key must contain exactly 32 bytes.");
    }
    this.encryptionKey = deriveKey(masterKey, "payload-encryption");
    this.lookupKey = deriveKey(masterKey, "subject-lookup");
    this.keyId = createHash("sha256").update(masterKey).digest("base64url").slice(0, 16);
  }

  /** Fails before the HTTP listener starts when an existing store or key is unusable. */
  async verify(): Promise<void> {
    await this.writeQueue;
    await this.readStore();
  }

  async find(identity: FeishuIdentityRef): Promise<VisitorAiAccountConfiguration | undefined> {
    await this.writeQueue;
    const subject = canonicalizeIdentity(identity);
    const subjectDigest = this.digestSubject(subject);
    const store = await this.readStore();
    const record = store.records.find((candidate) => candidate.subject === subjectDigest);
    if (!record) return undefined;
    return this.decryptRecord(record, subject);
  }

  async save(
    identity: FeishuIdentityRef,
    input: Pick<VisitorAiAccountConfiguration, "providerId" | "apiKey">,
  ): Promise<VisitorAiAccountConfiguration> {
    const configuration: VisitorAiAccountConfiguration = {
      providerId: input.providerId,
      apiKey: requireApiKey(input.apiKey),
      revision: randomUUID(),
    };
    const subject = canonicalizeIdentity(identity);
    const operation = this.writeQueue.then(async () => {
      const store = await this.readStore();
      const record = this.encryptRecord(subject, configuration);
      const index = store.records.findIndex((candidate) => candidate.subject === record.subject);
      if (index === -1) store.records.push(record);
      else store.records[index] = record;
      await this.writeStore(store);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
    return { ...configuration };
  }

  async delete(identity: FeishuIdentityRef): Promise<void> {
    const subjectDigest = this.digestSubject(canonicalizeIdentity(identity));
    const operation = this.writeQueue.then(async () => {
      const store = await this.readStore();
      const records = store.records.filter((candidate) => candidate.subject !== subjectDigest);
      if (records.length === store.records.length) return;
      await this.writeStore({ ...store, records });
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private digestSubject(subject: string): string {
    return createHmac("sha256", this.lookupKey).update(subject, "utf8").digest("base64url");
  }

  private encryptRecord(
    subject: string,
    configuration: VisitorAiAccountConfiguration,
  ): EncryptedAccountRecord {
    const subjectDigest = this.digestSubject(subject);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(createAdditionalAuthenticatedData(subjectDigest));
    const payload: EncryptedPayload = { subject, ...configuration };
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return {
      version: ENCRYPTED_RECORD_VERSION,
      subject: subjectDigest,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      updatedAt: new Date().toISOString(),
    };
  }

  private decryptRecord(
    record: EncryptedAccountRecord,
    expectedSubject: string,
  ): VisitorAiAccountConfiguration {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        decodeBase64(record.iv, IV_BYTES),
      );
      decipher.setAAD(createAdditionalAuthenticatedData(record.subject));
      decipher.setAuthTag(decodeBase64(record.authTag, 16));
      const plaintext = Buffer.concat([
        decipher.update(decodeBase64(record.ciphertext)),
        decipher.final(),
      ]).toString("utf8");
      const payload: unknown = JSON.parse(plaintext);
      if (!isEncryptedPayload(payload) || payload.subject !== expectedSubject) {
        throw new Error("invalid payload");
      }
      return {
        providerId: payload.providerId,
        apiKey: payload.apiKey,
        revision: payload.revision,
      };
    } catch {
      throw new Error("Visitor AI account record cannot be decrypted.");
    }
  }

  private async readStore(): Promise<EncryptedAccountFile> {
    let serialized: string;
    try {
      serialized = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return { version: STORE_VERSION, keyId: this.keyId, records: [] };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(serialized);
    } catch {
      throw new Error("Visitor AI account store contains invalid JSON.");
    }
    if (!isEncryptedAccountFile(parsed)) {
      throw new Error("Visitor AI account store contains unsupported data.");
    }
    if (parsed.keyId !== this.keyId) {
      throw new Error("Visitor AI account store master key does not match.");
    }
    return { ...parsed, records: [...parsed.records] };
  }

  private async writeStore(store: EncryptedAccountFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600);
  }
}

/** Test-only/injected store. Production wiring uses JsonVisitorAiAccountStore. */
export class InMemoryVisitorAiAccountStore implements VisitorAiAccountStore {
  private readonly records = new Map<string, VisitorAiAccountConfiguration>();

  async find(identity: FeishuIdentityRef): Promise<VisitorAiAccountConfiguration | undefined> {
    const record = this.records.get(canonicalizeIdentity(identity));
    return record ? { ...record } : undefined;
  }

  async save(
    identity: FeishuIdentityRef,
    input: Pick<VisitorAiAccountConfiguration, "providerId" | "apiKey">,
  ): Promise<VisitorAiAccountConfiguration> {
    const record = { ...input, apiKey: requireApiKey(input.apiKey), revision: randomUUID() };
    this.records.set(canonicalizeIdentity(identity), record);
    return { ...record };
  }

  async delete(identity: FeishuIdentityRef): Promise<void> {
    this.records.delete(canonicalizeIdentity(identity));
  }
}

export function readVisitorAiAccountMasterKey(environment: NodeJS.ProcessEnv): Buffer {
  const encoded = environment.ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY?.trim();
  if (!encoded) {
    throw new Error("ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY is required in visitor AI mode.");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(encoded)) {
    throw new Error("ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY must be a 32-byte Base64 value.");
  }
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length !== MASTER_KEY_BYTES || decoded.toString("base64") !== encoded) {
    throw new Error("ECHO_INSIGHT_USER_AI_CREDENTIAL_MASTER_KEY must be a 32-byte Base64 value.");
  }
  return decoded;
}

export function visitorAiAccountIdentityKey(identity: FeishuIdentityRef): string {
  return canonicalizeIdentity(identity);
}

function canonicalizeIdentity(identity: FeishuIdentityRef): string {
  const type = requireIdentityPart(identity.type);
  const value = requireIdentityPart(identity.value);
  const applicationId = requireIdentityPart(identity.context.applicationId);
  const tenantId = identity.context.tenantId === undefined
    ? null
    : requireIdentityPart(identity.context.tenantId);
  return JSON.stringify(["feishu", STORE_VERSION, applicationId, tenantId, type, value]);
}

function requireIdentityPart(value: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n\0]/u.test(normalized)) {
    throw new Error("Visitor AI account identity is invalid.");
  }
  return normalized;
}

function requireApiKey(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 2_048 || /[\r\n\0]/u.test(normalized)) {
    throw new Error("Visitor AI API key is invalid.");
  }
  return normalized;
}

function deriveKey(masterKey: Buffer, purpose: string): Buffer {
  return createHmac("sha256", masterKey)
    .update(`echo-insight:visitor-ai-account:v1:${purpose}`, "utf8")
    .digest();
}

function createAdditionalAuthenticatedData(subjectDigest: string): Buffer {
  return Buffer.from(`echo-insight:visitor-ai-account:v1:${subjectDigest}`, "utf8");
}

function decodeBase64(value: string, expectedLength?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("invalid base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new Error("invalid base64");
  }
  return decoded;
}

function isEncryptedAccountFile(value: unknown): value is EncryptedAccountFile {
  return isRecord(value)
    && value.version === STORE_VERSION
    && typeof value.keyId === "string"
    && Array.isArray(value.records)
    && value.records.every(isEncryptedAccountRecord);
}

function isEncryptedAccountRecord(value: unknown): value is EncryptedAccountRecord {
  return isRecord(value)
    && value.version === ENCRYPTED_RECORD_VERSION
    && typeof value.subject === "string"
    && typeof value.iv === "string"
    && typeof value.authTag === "string"
    && typeof value.ciphertext === "string"
    && typeof value.updatedAt === "string";
}

function isEncryptedPayload(value: unknown): value is EncryptedPayload {
  return isRecord(value)
    && typeof value.subject === "string"
    && (value.providerId === "deepseek" || value.providerId === "qwen")
    && typeof value.apiKey === "string"
    && typeof value.revision === "string";
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
