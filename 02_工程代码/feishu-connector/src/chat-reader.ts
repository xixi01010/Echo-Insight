import {
  createFeishuIdentityRef,
  type FeishuIdentityContext,
  type FeishuIdentityRef,
  type FeishuIdentityType,
} from "../../backend/src/current-user/index.js";
import type {
  FeishuApiClient,
  FeishuApiResponse,
  FeishuChatMessage,
  FeishuPage,
} from "./types.js";
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

export interface FeishuChatLocator {
  containerType: "chat" | "thread";
  containerId: string;
}

export interface FeishuChatMessageRecord {
  messageId: string;
  sender?: {
    identity?: FeishuIdentityRef;
    unresolvedIdType?: string;
    senderType?: string;
  };
  createTime?: string;
  updateTime?: string;
  messageType?: string;
  content?: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  chatId?: string;
  deleted?: boolean;
  updated?: boolean;
}

export interface FeishuChatSourceSnapshot {
  locator: FeishuChatLocator;
  messages: FeishuChatMessageRecord[];
}

export interface FeishuChatSourceReadInput {
  context: ProjectSourceReadContext;
  locator: FeishuChatLocator;
}

export interface FeishuChatReaderOptions {
  identityContext: FeishuIdentityContext;
  pageSize?: number;
  now?: () => Date;
}

/** Reads one explicit Chat or Thread only. It never discovers chats by user. */
export class FeishuChatReader implements ProjectSourceReader<
  FeishuChatSourceReadInput,
  FeishuChatSourceSnapshot
> {
  private readonly pageSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly client: Pick<FeishuApiClient, "im">,
    private readonly options: FeishuChatReaderOptions,
  ) {
    this.pageSize = options.pageSize ?? 50;
    this.now = options.now ?? (() => new Date());
  }

  async read(
    input: FeishuChatSourceReadInput,
  ): Promise<ProjectSourceReadResult<FeishuChatSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) {
      return createSourceReadUnavailable({ context: input.context, freshness });
    }
    if (input.context.sourceKind !== "feishu-chat" || !input.locator.containerId.trim()) {
      return createSourceReadFailure({ context: input.context, category: "unknown", freshness });
    }
    const messageApi = this.client.im?.v1?.message;
    if (!messageApi) {
      return createSourceReadFailure({ context: input.context, category: "source-unavailable", freshness });
    }

    try {
      const messages = await collectMessagePages((pageToken) =>
        messageApi.list({
          params: {
            container_id_type: input.locator.containerType,
            container_id: input.locator.containerId,
            sort_type: "ByCreateTimeAsc",
            page_size: this.pageSize,
            ...(pageToken ? { page_token: pageToken } : {}),
            with_sender_name: false,
          },
        }),
      );
      const visibleMessages = input.locator.containerType === "thread"
        ? messages.filter((message) => message.thread_id === input.locator.containerId)
        : messages;
      return createSourceReadSuccess({
        context: input.context,
        data: {
          locator: { ...input.locator },
          messages: visibleMessages.map((message) => toMessageRecord(message, this.options.identityContext)),
        },
        resources: [{
          sourceRef: input.context.sourceRef,
          resourceType: input.locator.containerType,
          resourceId: input.locator.containerId,
        }],
        freshness,
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

async function collectMessagePages(
  fetchPage: (pageToken?: string) => Promise<FeishuApiResponse<FeishuPage<FeishuChatMessage>>>,
): Promise<FeishuChatMessage[]> {
  const messages: FeishuChatMessage[] = [];
  let pageToken: string | undefined;
  do {
    const response = await fetchPage(pageToken);
    const page = unwrapMessagePage(response);
    messages.push(...(page.items ?? []));
    if (page.has_more) {
      if (!page.page_token) throw new SourceReadError("transient");
      pageToken = page.page_token;
    } else {
      pageToken = undefined;
    }
  } while (pageToken);
  return messages;
}

function unwrapMessagePage(
  response: FeishuApiResponse<FeishuPage<FeishuChatMessage>>,
): FeishuPage<FeishuChatMessage> {
  if (response.code !== 0) throw sourceReadErrorFromResponseCode(response.code);
  if (!response.data) throw new SourceReadError("unknown");
  return response.data;
}

function toMessageRecord(
  message: FeishuChatMessage,
  identityContext: FeishuIdentityContext,
): FeishuChatMessageRecord {
  const messageId = message.message_id?.trim();
  if (!messageId) throw new SourceReadError("unknown");
  return {
    messageId,
    ...(message.sender ? { sender: toSender(message.sender, identityContext) } : {}),
    ...(message.create_time ? { createTime: message.create_time } : {}),
    ...(message.update_time ? { updateTime: message.update_time } : {}),
    ...(message.msg_type ? { messageType: message.msg_type } : {}),
    ...(message.body?.content ? { content: message.body.content } : {}),
    ...(message.root_id ? { rootId: message.root_id } : {}),
    ...(message.parent_id ? { parentId: message.parent_id } : {}),
    ...(message.thread_id ? { threadId: message.thread_id } : {}),
    ...(message.chat_id ? { chatId: message.chat_id } : {}),
    ...(message.deleted !== undefined ? { deleted: message.deleted } : {}),
    ...(message.updated !== undefined ? { updated: message.updated } : {}),
  };
}

function toSender(
  sender: NonNullable<FeishuChatMessage["sender"]>,
  identityContext: FeishuIdentityContext,
): NonNullable<FeishuChatMessageRecord["sender"]> {
  const identityType = toIdentityType(sender.id_type);
  if (!identityType || !sender.id?.trim()) {
    return {
      ...(sender.id_type ? { unresolvedIdType: sender.id_type } : {}),
      ...(sender.sender_type ? { senderType: sender.sender_type } : {}),
    };
  }
  return {
    identity: createFeishuIdentityRef({
      type: identityType,
      value: sender.id,
      context: identityContext,
    }),
    ...(sender.sender_type ? { senderType: sender.sender_type } : {}),
  };
}

function toIdentityType(value: string | undefined): FeishuIdentityType | undefined {
  return value === "open_id" || value === "union_id" || value === "user_id"
    ? value
    : undefined;
}
