import type {
  FeishuApiClient,
  FeishuApiResponse,
  FeishuBaseInfo,
  FeishuField,
  FeishuPage,
  FeishuRecord,
  FeishuTable,
  JsonValue,
  ProjectDataReader,
  ProjectDataMetadata,
  StandardProject,
  StandardProjectData,
  StandardTask,
} from "./types.js";
import {
  resolveConfirmedSchemaFields,
  type StandardTaskFieldName,
} from "./base-schema-mapper.js";
import {
  classifySourceReadError,
  createSourceReadFailure,
  createSourceReadSuccess,
  createSourceReadUnavailable,
  isSourceReadable,
  type ProjectSourceReader,
  type ProjectSourceReadContext,
  type ProjectSourceReadResult,
} from "./source-contract.js";

const FIELD_ALIASES = {
  name: ["任务名称", "任务", "名称", "Task", "Name"],
  owner: ["负责人", "Owner", "Assignee"],
  status: ["状态", "Status"],
  deadline: ["截止日期", "截止时间", "Deadline", "Due Date"],
  riskLevel: ["风险等级", "风险", "Risk Level", "Risk"],
  description: ["说明", "描述", "Description", "Notes"],
} as const;

interface ReaderOptions {
  pageSize?: number;
  now?: () => Date;
}

interface TableRecords {
  table: FeishuTable;
  fields: FeishuField[];
  records: FeishuRecord[];
}

export class FeishuBaseReader implements ProjectDataReader {
  private readonly pageSize: number;
  private readonly now: () => Date;
  private readonly projectDataInFlight = new Map<string, Promise<StandardProjectData>>();

  constructor(
    private readonly client: FeishuApiClient,
    options: ReaderOptions = {},
  ) {
    this.pageSize = options.pageSize ?? 500;
    this.now = options.now ?? (() => new Date());
  }

  async getBaseInfo(baseToken: string): Promise<FeishuBaseInfo> {
    assertIdentifier(baseToken, "baseToken");

    const response = await this.client.bitable.v1.app.get({
      path: { app_token: baseToken },
    });
    const data = unwrapResponse(response, "read Base information");

    if (!data.app) {
      throw new Error("Feishu Base response did not include app information.");
    }

    return data.app;
  }

  async listTables(baseToken: string): Promise<FeishuTable[]> {
    assertIdentifier(baseToken, "baseToken");

    return collectPages((pageToken) =>
      this.client.bitable.v1.appTable.list({
        path: { app_token: baseToken },
        params: pageToken
          ? { page_size: this.pageSize, page_token: pageToken }
          : { page_size: this.pageSize },
      }),
    );
  }

  async listRecords(
    baseToken: string,
    tableId: string,
  ): Promise<FeishuRecord[]> {
    assertIdentifier(baseToken, "baseToken");
    assertIdentifier(tableId, "tableId");

    return collectPages((pageToken) =>
      this.client.bitable.v1.appTableRecord.list({
        path: { app_token: baseToken, table_id: tableId },
        params: pageToken
          ? { page_size: this.pageSize, page_token: pageToken }
          : { page_size: this.pageSize },
      }),
    );
  }

  async listFields(baseToken: string, tableId: string): Promise<FeishuField[]> {
    assertIdentifier(baseToken, "baseToken");
    assertIdentifier(tableId, "tableId");
    const fieldApi = this.client.bitable.v1.appTableField;
    if (!fieldApi) return [];

    try {
      return await collectPages((pageToken) =>
        fieldApi.list({
          path: { app_token: baseToken, table_id: tableId },
          params: pageToken
            ? { page_size: this.pageSize, page_token: pageToken }
            : { page_size: this.pageSize },
        }),
      );
    } catch {
      // Metadata is an optional V3 enhancement; preserve the V2 alias path.
      return [];
    }
  }

  async readProjectData(baseToken: string): Promise<StandardProjectData> {
    assertIdentifier(baseToken, "baseToken");
    const inFlight = this.projectDataInFlight.get(baseToken);
    if (inFlight) return inFlight;

    const request = this.readProjectDataOnce(baseToken);
    this.projectDataInFlight.set(baseToken, request);
    try {
      return await request;
    } finally {
      if (this.projectDataInFlight.get(baseToken) === request) {
        this.projectDataInFlight.delete(baseToken);
      }
    }
  }

  private async readProjectDataOnce(baseToken: string): Promise<StandardProjectData> {
    const [base, tables] = await Promise.all([
      this.getBaseInfo(baseToken),
      this.listTables(baseToken),
    ]);

    // Tables are read concurrently; Promise.all preserves result ordering and
    // a failing table still rejects the whole read.
    const tableRecords = await Promise.all(tables.map(async (table): Promise<TableRecords> => {
      const tableId = requireText(table.table_id, "Feishu table_id");
      const [fields, records] = await Promise.all([
        this.listFields(baseToken, tableId),
        this.listRecords(baseToken, tableId),
      ]);
      return { table, fields, records };
    }));

    return normalizeProjectData(baseToken, base, tableRecords, this.now());
  }
}

export interface FeishuBaseSourceReadInput {
  context: ProjectSourceReadContext;
  baseToken: string;
}

export interface FeishuBaseSourceSnapshot {
  project: StandardProject;
  tasks: StandardTask[];
  metadata: Omit<ProjectDataMetadata, "baseToken">;
}

/**
 * V3 compatibility adapter. It gates the legacy Base reader with the existing
 * Project visibility result and never returns the Base token in its snapshot.
 */
export class FeishuBaseSourceReaderAdapter implements ProjectSourceReader<
  FeishuBaseSourceReadInput,
  FeishuBaseSourceSnapshot
> {
  constructor(
    private readonly reader: ProjectDataReader,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(
    input: FeishuBaseSourceReadInput,
  ): Promise<ProjectSourceReadResult<FeishuBaseSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) {
      return createSourceReadUnavailable({ context: input.context, freshness });
    }
    try {
      const data = await this.reader.readProjectData(input.baseToken);
      return createSourceReadSuccess({
        context: input.context,
        data: toSafeBaseSnapshot(input.context.sourceRef, data),
        resources: [{ sourceRef: input.context.sourceRef, resourceType: "feishu-base" }],
        freshness: { fetchedAt: data.metadata.retrievedAt },
      });
    } catch (error) {
      return createSourceReadFailure({
        context: input.context,
        category: classifySourceReadError(error),
        freshness,
      });
    }
  }
}

export function normalizeProjectData(
  baseToken: string,
  base: FeishuBaseInfo,
  tableRecords: TableRecords[],
  retrievedAt: Date = new Date(),
): StandardProjectData {
  const tasks = tableRecords.flatMap(({ table, fields, records }) =>
    records.map((record) => normalizeTask(table, record, resolveConfirmedSchemaFields(fields))),
  );

  return {
    project: {
      id: base.app_token ?? baseToken,
      name: base.name?.trim() || "Unnamed Feishu Base",
      source: "feishu-base",
    },
    tasks,
    metadata: {
      baseToken,
      tableCount: tableRecords.length,
      recordCount: tasks.length,
      retrievedAt: retrievedAt.toISOString(),
      accessMode: "read-only",
      tables: tableRecords.map(({ table, records }) => ({
        id: table.table_id ?? "",
        name: table.name?.trim() || "Unnamed Table",
        recordCount: records.length,
      })),
    },
  };
}

function toSafeBaseSnapshot(
  sourceRef: string,
  data: StandardProjectData,
): FeishuBaseSourceSnapshot {
  const { baseToken: _baseToken, ...metadata } = data.metadata;
  return {
    project: { ...data.project, id: sourceRef },
    tasks: data.tasks,
    metadata,
  };
}

function normalizeTask(
  table: FeishuTable,
  record: FeishuRecord,
  schemaFields: Partial<Record<StandardTaskFieldName, string>>,
): StandardTask {
  const fields = record.fields ?? {};
  const recordId = record.record_id ?? "";
  const name = readMappedFieldText(fields, schemaFields.name, FIELD_ALIASES.name) || recordId || "Unnamed Task";

  return {
    id: recordId,
    tableId: table.table_id ?? "",
    tableName: table.name?.trim() || "Unnamed Table",
    name,
    owner: readNullableMappedFieldText(fields, schemaFields.owner, FIELD_ALIASES.owner),
    status: readNullableMappedFieldText(fields, schemaFields.status, FIELD_ALIASES.status),
    deadline: readNullableMappedFieldText(fields, schemaFields.deadline, FIELD_ALIASES.deadline),
    riskLevel: readNullableMappedFieldText(fields, schemaFields.riskLevel, FIELD_ALIASES.riskLevel),
    description: readNullableMappedFieldText(fields, schemaFields.description, FIELD_ALIASES.description),
    attributes: Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, toJsonValue(value)]),
    ),
  };
}

async function collectPages<T>(
  fetchPage: (
    pageToken?: string,
  ) => Promise<FeishuApiResponse<FeishuPage<T>>>,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;

  do {
    const response = await fetchPage(pageToken);
    const page = unwrapResponse(response, "read paginated Feishu data");
    items.push(...(page.items ?? []));

    if (page.has_more) {
      if (!page.page_token) {
        throw new Error("Feishu pagination indicated more data without a page token.");
      }
      pageToken = page.page_token;
    } else {
      pageToken = undefined;
    }
  } while (pageToken);

  return items;
}

function unwrapResponse<T>(
  response: FeishuApiResponse<T>,
  operation: string,
): T {
  if (response.code !== 0) {
    throw new Error(
      `Failed to ${operation}: ${response.msg ?? `Feishu error ${String(response.code)}`}`,
    );
  }

  if (!response.data) {
    throw new Error(`Failed to ${operation}: response data is missing.`);
  }

  return response.data;
}

function readNullableFieldText(
  fields: Record<string, unknown>,
  aliases: readonly string[],
): string | null {
  return readFieldText(fields, aliases) || null;
}

function readNullableMappedFieldText(
  fields: Record<string, unknown>,
  mappedFieldName: string | undefined,
  aliases: readonly string[],
): string | null {
  return readMappedFieldText(fields, mappedFieldName, aliases) || null;
}

function readMappedFieldText(
  fields: Record<string, unknown>,
  mappedFieldName: string | undefined,
  aliases: readonly string[],
): string {
  if (mappedFieldName && Object.hasOwn(fields, mappedFieldName)) {
    return valueToText(fields[mappedFieldName]);
  }
  return readFieldText(fields, aliases);
}

function readFieldText(
  fields: Record<string, unknown>,
  aliases: readonly string[],
): string {
  for (const alias of aliases) {
    if (Object.hasOwn(fields, alias)) {
      return valueToText(fields[alias]);
    }
  }
  return "";
}

function valueToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(valueToText).filter(Boolean).join(", ");
  }
  if (typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    for (const key of ["name", "text", "value", "display_name"]) {
      const text = valueToText(objectValue[key]);
      if (text) return text;
    }
  }
  return "";
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonValue(item),
      ]),
    );
  }
  return String(value);
}

function assertIdentifier(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty.`);
}

function requireText(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`${name} is missing.`);
  return value;
}
