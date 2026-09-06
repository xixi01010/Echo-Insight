import {
  createFeishuIdentityRef,
  type FeishuIdentityContext,
  type FeishuIdentityRef,
  type FeishuIdentityType,
} from "../../backend/src/current-user/index.js";
import type { FeishuApiClient, FeishuMinutesArtifacts, FeishuMinutesMetadata } from "./types.js";
import {
  classifySourceReadError,
  createSourceReadFailure,
  createSourceReadSuccess,
  createSourceReadUnavailable,
  isSourceReadable,
  SourceReadError,
  sourceReadErrorFromResponseCode,
  type ProjectSourceReader,
  type ProjectSourceReadContext,
  type ProjectSourceReadResult,
} from "./source-contract.js";

export interface FeishuMinutesLocator { minuteToken: string; }

export interface FeishuMinutesMetadataRecord {
  minuteToken: string;
  title?: string;
  owner?: FeishuIdentityRef;
  createTime?: string;
  duration?: string;
  noteId?: string;
}

export type FeishuMinutesTranscript =
  | { kind: "raw-transcript"; state: "available"; content: string }
  | { kind: "raw-transcript"; state: "unavailable" };

export type FeishuMinutesPlatformArtifact =
  | { kind: "platform-summary"; content: string }
  | { kind: "platform-chapter"; title?: string; startMs?: string; stopMs?: string; content?: string }
  | { kind: "platform-todo"; todoId?: string; content?: string; isDone?: boolean; operation?: string; unresolvedAssigneeIds?: string[] }
  | { kind: "platform-keyword"; content: string };

export interface FeishuMinutesSourceSnapshot {
  locator: FeishuMinutesLocator;
  metadata: FeishuMinutesMetadataRecord;
  transcript: FeishuMinutesTranscript;
  artifacts: FeishuMinutesPlatformArtifact[];
  meetingRelation: { state: "unknown" };
}

export interface FeishuMinutesSourceReadInput {
  context: ProjectSourceReadContext;
  locator: FeishuMinutesLocator;
}

export interface FeishuMinutesReaderOptions {
  identityContext: FeishuIdentityContext;
  ownerIdentityType?: FeishuIdentityType;
  now?: () => Date;
}

export class MinutesTranscriptUnavailableError extends Error {
  constructor() { super("Minutes transcript is unavailable."); this.name = "MinutesTranscriptUnavailableError"; }
}

/** Reads one explicit Minutes resource only; it never searches or discovers Minutes. */
export class FeishuMinutesReader implements ProjectSourceReader<FeishuMinutesSourceReadInput, FeishuMinutesSourceSnapshot> {
  private readonly now: () => Date;
  private readonly ownerIdentityType: FeishuIdentityType;

  constructor(private readonly client: Pick<FeishuApiClient, "minutes">, private readonly options: FeishuMinutesReaderOptions) {
    this.now = options.now ?? (() => new Date());
    this.ownerIdentityType = options.ownerIdentityType ?? "open_id";
  }

  async read(input: FeishuMinutesSourceReadInput): Promise<ProjectSourceReadResult<FeishuMinutesSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) return createSourceReadUnavailable({ context: input.context, freshness });
    if (input.context.sourceKind !== "feishu-minutes" || !input.locator.minuteToken.trim()) {
      return createSourceReadFailure({ context: input.context, category: "unknown", freshness });
    }
    const api = this.client.minutes?.v1;
    if (!api) return createSourceReadFailure({ context: input.context, category: "source-unavailable", freshness });

    try {
      const token = input.locator.minuteToken;
      const metadata = toMetadata(await readMetadata(api.minute, token, this.ownerIdentityType), token, this.options.identityContext, this.ownerIdentityType);
      const transcript = await readTranscript(api.minuteTranscript, token);
      const artifacts = toArtifacts(await readArtifacts(api.minute, token));
      return createSourceReadSuccess({
        context: input.context,
        data: { locator: { ...input.locator }, metadata, transcript, artifacts, meetingRelation: { state: "unknown" } },
        resources: [{ sourceRef: input.context.sourceRef, resourceType: "feishu-minutes", resourceId: token }],
        freshness,
      });
    } catch (error) {
      return createSourceReadFailure({ context: input.context, category: classifySourceReadError(error), freshness });
    }
  }
}

async function readMetadata(api: NonNullable<NonNullable<FeishuApiClient["minutes"]>["v1"]>["minute"], token: string, userIdType: FeishuIdentityType): Promise<FeishuMinutesMetadata> {
  const response = await api.get({ path: { minute_token: token }, params: { user_id_type: userIdType } });
  if (response.code !== 0 || !response.data?.minute) throw sourceReadErrorFromResponseCode(response.code);
  return response.data.minute;
}

async function readArtifacts(api: NonNullable<NonNullable<FeishuApiClient["minutes"]>["v1"]>["minute"], token: string): Promise<FeishuMinutesArtifacts> {
  const response = await api.artifacts({ path: { minute_token: token } });
  if (response.code !== 0 || !response.data) throw sourceReadErrorFromResponseCode(response.code);
  return response.data;
}

async function readTranscript(api: NonNullable<NonNullable<FeishuApiClient["minutes"]>["v1"]>["minuteTranscript"], token: string): Promise<FeishuMinutesTranscript> {
  try {
    const response = await api.get({ path: { minute_token: token }, params: { need_speaker: true, need_timestamp: true } });
    const chunks: string[] = [];
    for await (const chunk of response.getReadableStream()) chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return { kind: "raw-transcript", state: "available", content: chunks.join("") };
  } catch (error) {
    if (error instanceof MinutesTranscriptUnavailableError) return { kind: "raw-transcript", state: "unavailable" };
    throw error;
  }
}

function toMetadata(metadata: FeishuMinutesMetadata, minuteToken: string, identityContext: FeishuIdentityContext, ownerIdentityType: FeishuIdentityType): FeishuMinutesMetadataRecord {
  return {
    minuteToken,
    ...(metadata.title ? { title: metadata.title } : {}),
    ...(metadata.owner_id ? { owner: createFeishuIdentityRef({ type: ownerIdentityType, value: metadata.owner_id, context: identityContext }) } : {}),
    ...(metadata.create_time ? { createTime: metadata.create_time } : {}),
    ...(metadata.duration ? { duration: metadata.duration } : {}),
    ...(metadata.note_id ? { noteId: metadata.note_id } : {}),
  };
}

function toArtifacts(value: FeishuMinutesArtifacts): FeishuMinutesPlatformArtifact[] {
  return [
    ...(value.summary ? [{ kind: "platform-summary" as const, content: value.summary }] : []),
    ...(value.minute_chapters ?? []).map((chapter) => ({ kind: "platform-chapter" as const, ...(chapter.title ? { title: chapter.title } : {}), ...(chapter.start_ms ? { startMs: chapter.start_ms } : {}), ...(chapter.stop_ms ? { stopMs: chapter.stop_ms } : {}), ...(chapter.summary_content ? { content: chapter.summary_content } : {}) })),
    ...(value.minute_todos ?? []).map((todo) => ({ kind: "platform-todo" as const, ...(todo.todo_id ? { todoId: todo.todo_id } : {}), ...(todo.content ? { content: todo.content } : {}), ...(todo.is_done !== undefined ? { isDone: todo.is_done } : {}), ...(todo.operation ? { operation: todo.operation } : {}), ...(todo.assignees?.length ? { unresolvedAssigneeIds: [...todo.assignees] } : {}) })),
    ...(value.keywords ?? []).map((content) => ({ kind: "platform-keyword" as const, content })),
  ];
}
