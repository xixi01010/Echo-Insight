import assert from "node:assert/strict";
import test from "node:test";

import {
  FeishuBaseReader,
  FeishuBaseSourceReaderAdapter,
  SourceReadError,
  analyzeBaseSchema,
  createSourceReadSuccess,
  type FeishuApiClient,
  type FeishuField,
  type ProjectDataReader,
  type ProjectSourceReadContext,
} from "../feishu-connector/src/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";

test("reader paginates tables and records, then returns standardized JSON", async () => {
  const client: FeishuApiClient = {
    bitable: {
      v1: {
        app: {
          get: async () => ({
            code: 0,
            data: { app: { app_token: "base-1", name: "Echo Project" } },
          }),
        },
        appTable: {
          list: async ({ params }) =>
            params.page_token
              ? {
                  code: 0,
                  data: {
                    items: [{ table_id: "table-2", name: "Milestones" }],
                    has_more: false,
                  },
                }
              : {
                  code: 0,
                  data: {
                    items: [{ table_id: "table-1", name: "Tasks" }],
                    has_more: true,
                    page_token: "next-table-page",
                  },
                },
        },
        appTableRecord: {
          list: async ({ path }) => ({
            code: 0,
            data: {
              items:
                path.table_id === "table-1"
                  ? [
                      {
                        record_id: "record-1",
                        fields: {
                          任务名称: "完成数据读取",
                          负责人: [{ name: "Alice" }],
                          状态: "进行中",
                          截止日期: "2026-08-30",
                          风险等级: "L4",
                        },
                      },
                    ]
                  : [],
              has_more: false,
            },
          }),
        },
        appTableField: {
          list: async () => ({ code: 0, data: { items: [], has_more: false } }),
        },
      },
    },
  };

  const reader = new FeishuBaseReader(client, {
    now: () => new Date("2026-08-22T00:00:00.000Z"),
  });
  const result = await reader.readProjectData("base-1");

  assert.deepEqual(result.project, {
    id: "base-1",
    name: "Echo Project",
    source: "feishu-base",
  });
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.name, "完成数据读取");
  assert.equal(result.tasks[0]?.owner, "Alice");
  assert.equal(result.metadata.tableCount, 2);
  assert.equal(result.metadata.recordCount, 1);
  assert.equal(result.metadata.accessMode, "read-only");
  assert.equal(result.metadata.retrievedAt, "2026-08-22T00:00:00.000Z");
});

test("concurrent reads for the same Base token share one underlying API request", async () => {
  let baseInfoCalls = 0;
  let releaseBaseInfo: (() => void) | undefined;
  const baseInfoStarted = new Promise<void>((resolve) => {
    releaseBaseInfo = resolve;
  });
  const client = schemaClient({ fields: [], record: { 任务名称: "并发读取" } });
  client.bitable.v1.app.get = async () => {
    baseInfoCalls += 1;
    await baseInfoStarted;
    return { code: 0, data: { app: { app_token: "base-1", name: "Concurrent Base" } } };
  };
  const reader = new FeishuBaseReader(client);

  const first = reader.readProjectData("base-1");
  const second = reader.readProjectData("base-1");
  await Promise.resolve();
  assert.equal(baseInfoCalls, 1);

  releaseBaseInfo?.();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(baseInfoCalls, 1);
  assert.deepEqual(secondResult, firstResult);
});

test("readProjectData fans out table record requests concurrently and keeps table order", async () => {
  let recordInFlight = 0;
  let maxRecordInFlight = 0;
  const pendingRecordRequests: Array<() => void> = [];
  const client = schemaClient({ fields: [], record: { 任务名称: "并发表" } });
  client.bitable.v1.appTable.list = async () => ({
    code: 0,
    data: {
      items: [
        { table_id: "table-1", name: "Tasks" },
        { table_id: "table-2", name: "Milestones" },
      ],
      has_more: false,
    },
  });
  client.bitable.v1.appTableRecord.list = async () => {
    recordInFlight += 1;
    maxRecordInFlight = Math.max(maxRecordInFlight, recordInFlight);
    await new Promise<void>((resolve) => pendingRecordRequests.push(resolve));
    recordInFlight -= 1;
    return { code: 0, data: { items: [], has_more: false } };
  };

  const reader = new FeishuBaseReader(client);
  const read = reader.readProjectData("base-1");
  for (let ticks = 0; ticks < 100 && pendingRecordRequests.length < 2; ticks += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  pendingRecordRequests.forEach((resolve) => resolve());
  const data = await read;

  assert.equal(maxRecordInFlight, 2);
  assert.deepEqual(data.metadata.tables.map((table) => table.id), ["table-1", "table-2"]);
});

test("reads request Feishu pages with the default page_size of 500", async () => {
  const pageSizes: number[] = [];
  const client = schemaClient({ fields: [], record: { 任务名称: "分页大小" } });
  client.bitable.v1.appTable.list = async ({ params }) => {
    pageSizes.push(params.page_size);
    return { code: 0, data: { items: [{ table_id: "table-1", name: "Tasks" }], has_more: false } };
  };
  client.bitable.v1.appTableField = {
    list: async ({ params }) => {
      pageSizes.push(params.page_size);
      return { code: 0, data: { items: [], has_more: false } };
    },
  };
  client.bitable.v1.appTableRecord.list = async ({ params }) => {
    pageSizes.push(params.page_size);
    return { code: 0, data: { items: [], has_more: false } };
  };

  await new FeishuBaseReader(client).readProjectData("base-1");
  assert.equal(pageSizes.length >= 3, true);
  assert.deepEqual([...new Set(pageSizes)], [500]);
});

test("a failing table rejects the whole read even with concurrent fan-out", async () => {
  const client = schemaClient({ fields: [], record: { 任务名称: "失败表" } });
  client.bitable.v1.appTable.list = async () => ({
    code: 0,
    data: {
      items: [
        { table_id: "table-1", name: "Tasks" },
        { table_id: "table-2", name: "Milestones" },
      ],
      has_more: false,
    },
  });
  client.bitable.v1.appTableRecord.list = async ({ path }) => {
    if (path.table_id === "table-2") throw new Error("table-2 unavailable");
    return { code: 0, data: { items: [], has_more: false } };
  };

  await assert.rejects(
    () => new FeishuBaseReader(client).readProjectData("base-1"),
    /table-2 unavailable/,
  );
});

test("metadata-confirmed adaptive fields standardize a differently named Base schema", async () => {
  const reader = new FeishuBaseReader(schemaClient({
    fields: [
      { field_id: "f-name", field_name: "事项", ui_type: "Text", is_primary: true },
      { field_id: "f-owner", field_name: "主R", ui_type: "User" },
      { field_id: "f-status", field_name: "推进情况", ui_type: "SingleSelect", property: { options: [{ name: "阻塞" }] } },
      { field_id: "f-date", field_name: "计划交付", ui_type: "DateTime" },
    ],
    record: {
      事项: "迁移 Schema",
      主R: [{ name: "Alice" }],
      推进情况: "阻塞",
      计划交付: "2026-09-10",
    },
  }));

  const data = await reader.readProjectData("base-1");
  assert.deepEqual(data.tasks[0], {
    id: "record-1",
    tableId: "table-1",
    tableName: "Tasks",
    name: "迁移 Schema",
    owner: "Alice",
    status: "阻塞",
    deadline: "2026-09-10",
    riskLevel: null,
    description: null,
    attributes: {
      事项: "迁移 Schema",
      主R: [{ name: "Alice" }],
      推进情况: "阻塞",
      计划交付: "2026-09-10",
    },
  });
});

test("ambiguous metadata stays candidate or unresolved and cannot create Risk fields", async () => {
  const fields = [
    { field_id: "f-owner", field_name: "主R", ui_type: "Text" },
    { field_id: "f-date", field_name: "计划交付", ui_type: "Text" },
    { field_id: "f-status", field_name: "推进情况", ui_type: "Text" },
    { field_id: "f-node", field_name: "节点", ui_type: "Text" },
    { field_id: "f-time", field_name: "时间", ui_type: "Text" },
  ];
  const mappings = analyzeBaseSchema(fields);
  assert.deepEqual(mappings.map(({ fieldName, state, target }) => ({ fieldName, state, target })), [
    { fieldName: "主R", state: "candidate", target: "owner" },
    { fieldName: "计划交付", state: "candidate", target: "deadline" },
    { fieldName: "推进情况", state: "candidate", target: "status" },
    { fieldName: "节点", state: "unresolved", target: undefined },
    { fieldName: "时间", state: "unresolved", target: undefined },
  ]);

  const data = await new FeishuBaseReader(schemaClient({
    fields,
    record: { 主R: "not-a-user", 计划交付: "说明文本", 推进情况: "阻塞", 节点: "M1", 时间: "尽快" },
  })).readProjectData("base-1");
  assert.equal(data.tasks[0]?.owner, null);
  assert.equal(data.tasks[0]?.deadline, null);
  assert.equal(data.tasks[0]?.status, null);
  assert.deepEqual(data.tasks[0]?.attributes, {
    主R: "not-a-user", 计划交付: "说明文本", 推进情况: "阻塞", 节点: "M1", 时间: "尽快",
  });
});

test("metadata read failure falls back to unchanged V2 aliases", async () => {
  const client = schemaClient({
    fields: [],
    record: { 任务名称: "V2 任务", 负责人: [{ name: "Alice" }], 截止日期: "2026-09-01" },
  });
  client.bitable.v1.appTableField = {
    list: async () => ({ code: 999, msg: "metadata scope unavailable" }),
  };

  const data = await new FeishuBaseReader(client).readProjectData("base-1");
  assert.equal(data.tasks[0]?.name, "V2 任务");
  assert.equal(data.tasks[0]?.owner, "Alice");
  assert.equal(data.tasks[0]?.deadline, "2026-09-01");
});

test("all V3 Source kinds retain Project ownership, identity, visibility, and Source-specific payloads", () => {
  const kinds = [
    "feishu-base",
    "feishu-chat",
    "feishu-minutes",
    "feishu-docs",
    "feishu-wiki-drive",
    "feishu-task",
    "feishu-calendar",
  ] as const;
  for (const sourceKind of kinds) {
    const context = sourceContext(sourceKind);
    const result = createSourceReadSuccess({
      context,
      data: { sourceSpecificField: sourceKind },
      resources: [{ sourceRef: context.sourceRef, resourceType: sourceKind }],
      freshness: { fetchedAt: "2026-08-28T00:00:00.000Z", cursor: "next-cursor" },
    });
    assert.equal(result.context.projectId, "project-a");
    assert.equal(result.context.sourceRef, `source-${sourceKind}`);
    assert.equal(result.context.subject.identity?.type, "open_id");
    assert.equal(result.context.visibility, "allowed");
    assert.equal(result.data.sourceSpecificField, sourceKind);
  }
});

test("Base adapter preserves V2 reading while enforcing visibility and removing credentials", async () => {
  let calls = 0;
  const legacyReader: ProjectDataReader = {
    readProjectData: async () => {
      calls += 1;
      return {
        project: { id: "sensitive-base-token", name: "Base", source: "feishu-base" },
        tasks: [],
        metadata: {
          baseToken: "sensitive-base-token",
          tableCount: 0,
          recordCount: 0,
          retrievedAt: "2026-08-28T00:00:00.000Z",
          accessMode: "read-only",
          tables: [],
        },
      };
    },
  };
  const adapter = new FeishuBaseSourceReaderAdapter(legacyReader);
  const allowed = await adapter.read({
    context: sourceContext("feishu-base"),
    baseToken: "sensitive-base-token",
  });
  assert.equal(allowed.status, "success");
  if (allowed.status !== "success") throw new Error("Expected a successful Base Source read.");
  assert.equal(allowed.data.project.id, "source-feishu-base");
  assert.equal(JSON.stringify(allowed).includes("sensitive-base-token"), false);
  assert.equal(JSON.stringify(allowed).includes("baseToken"), false);
  assert.equal(calls, 1);

  const denied = await adapter.read({
    context: sourceContext("feishu-base", "denied"),
    baseToken: "must-not-be-read",
  });
  assert.equal(denied.status, "unavailable");
  const unknown = await adapter.read({
    context: sourceContext("feishu-base", "unknown"),
    baseToken: "must-not-be-read",
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(calls, 1);
});

test("Base adapter retains Source error categories without exposing upstream error text", async () => {
  const permissionDeniedReader: ProjectDataReader = {
    readProjectData: async () => { throw new SourceReadError("permission-denied"); },
  };
  const rateLimitedReader: ProjectDataReader = {
    readProjectData: async () => { throw new SourceReadError("rate-limited"); },
  };
  const unknownFailureReader: ProjectDataReader = {
    readProjectData: async () => { throw new Error("upstream response includes a credential"); },
  };
  const permissionDenied = await new FeishuBaseSourceReaderAdapter(permissionDeniedReader).read({
    context: sourceContext("feishu-base"), baseToken: "not-returned",
  });
  assert.equal(permissionDenied.status, "failure");
  assert.equal(permissionDenied.status === "failure" && permissionDenied.category, "permission-denied");
  const rateLimited = await new FeishuBaseSourceReaderAdapter(rateLimitedReader).read({
    context: sourceContext("feishu-base"), baseToken: "not-returned",
  });
  assert.equal(rateLimited.status, "failure");
  assert.equal(rateLimited.status === "failure" && rateLimited.category, "rate-limited");
  const unknown = await new FeishuBaseSourceReaderAdapter(unknownFailureReader).read({
    context: sourceContext("feishu-base"), baseToken: "not-returned",
  });
  assert.equal(unknown.status, "failure");
  assert.equal(unknown.status === "failure" && unknown.category, "unknown");
  assert.equal(JSON.stringify(unknown).includes("credential"), false);
});

function sourceContext(
  sourceKind: ProjectSourceReadContext["sourceKind"],
  visibility: ProjectSourceReadContext["visibility"] = "allowed",
): ProjectSourceReadContext {
  return {
    projectId: "project-a",
    sourceRef: `source-${sourceKind}`,
    sourceKind,
    subject: {
      userId: "feishu:ou_user_a",
      identity: toFeishuOpenIdIdentityRef("ou_user_a", "echo-insight-app"),
    },
    authorization: visibility === "allowed"
      ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" }
      : { sourceAuthorization: "authorized", subjectEligibility: visibility === "denied" ? "denied" : "unknown" },
    visibility,
  };
}

function schemaClient(input: {
  fields: FeishuField[];
  record: Record<string, unknown>;
}): FeishuApiClient {
  return {
    bitable: {
      v1: {
        app: {
          get: async () => ({ code: 0, data: { app: { app_token: "base-1", name: "Schema Base" } } }),
        },
        appTable: {
          list: async () => ({
            code: 0,
            data: { items: [{ table_id: "table-1", name: "Tasks" }], has_more: false },
          }),
        },
        appTableField: {
          list: async () => ({ code: 0, data: { items: input.fields, has_more: false } }),
        },
        appTableRecord: {
          list: async () => ({
            code: 0,
            data: { items: [{ record_id: "record-1", fields: input.record }], has_more: false },
          }),
        },
      },
    },
  };
}
