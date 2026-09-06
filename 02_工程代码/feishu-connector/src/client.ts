import * as lark from "@larksuiteoapi/node-sdk";

import type { FeishuApiClient, FeishuCredentials } from "./types.js";

export function readFeishuCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): FeishuCredentials {
  const appId = environment.FEISHU_APP_ID?.trim();
  const appSecret = environment.FEISHU_APP_SECRET?.trim();

  if (!appId || !appSecret) {
    throw new Error(
      "Missing FEISHU_APP_ID or FEISHU_APP_SECRET environment variable.",
    );
  }

  return { appId, appSecret };
}

export function createFeishuClient(
  credentials: FeishuCredentials = readFeishuCredentials(),
): FeishuApiClient {
  return new lark.Client({
    appId: credentials.appId,
    appSecret: credentials.appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.warn,
  }) as unknown as FeishuApiClient;
}

/**
 * Limits a user credential to Reader capabilities that Feishu supports with
 * a user access token. The token never becomes part of a Source Result or
 * registry object.
 * The SDK keeps the token inside request options; it is never added to a
 * Source Result or registry object.
 */
export function createFeishuUserAccessClient(
  client: FeishuApiClient,
  userAccessToken: string,
): Pick<FeishuApiClient, "im" | "task" | "minutes" | "docx" | "wiki" | "drive" | "calendar"> {
  const token = userAccessToken.trim();
  if (!token) throw new Error("A user access token is required.");
  const requestOptions = lark.withUserAccessToken(token);
  const task = client.task?.v1?.task;
  const minutes = client.minutes?.v1;
  const im = client.im?.v1;
  const docx = client.docx?.v1;
  const wiki = client.wiki?.v2;
  const drive = client.drive?.v1;
  return {
    ...(im ? {
      im: { v1: {
        ...(im.chat ? { chat: {
          get: (request) => callWithUserToken(im.chat!.get, request, requestOptions),
          list: (request) => callWithUserToken(im.chat!.list, request, requestOptions),
        } } : {}),
        ...(im.chatMembers ? { chatMembers: {
          isInChat: (request) => callWithUserToken(im.chatMembers!.isInChat, request, requestOptions),
        } } : {}),
        message: { list: (request) => callWithUserToken(im.message.list, request, requestOptions) },
      } },
    } : {}),
    ...(task ? {
      task: { v1: { task: { get: (request) => callWithUserToken(task.get, request, requestOptions) } } },
    } : {}),
    ...(minutes ? {
      minutes: { v1: {
        minute: {
          get: (request) => callWithUserToken(minutes.minute.get, request, requestOptions),
          artifacts: (request) => callWithUserToken(minutes.minute.artifacts, request, requestOptions),
        },
        minuteTranscript: {
          get: (request) => callWithUserToken(minutes.minuteTranscript.get, request, requestOptions),
        },
      } },
    } : {}),
    ...(client.calendar?.v4?.calendarEvent ? {
      calendar: { v4: {
        ...(client.calendar?.v4?.calendar ? { calendar: {
          list: (request) => callWithUserToken(client.calendar!.v4!.calendar!.list, request, requestOptions),
          ...(client.calendar?.v4?.calendar?.primary ? { primary: (request) => callWithUserToken(client.calendar!.v4!.calendar!.primary!, request, requestOptions) } : {}),
        } } : {}),
        calendarEvent: {
          get: (request) => callWithUserToken(client.calendar!.v4!.calendarEvent.get, request, requestOptions),
          ...(client.calendar?.v4?.calendarEvent.list ? { list: (request) => callWithUserToken(client.calendar!.v4!.calendarEvent.list!, request, requestOptions) } : {}),
          ...(client.calendar?.v4?.calendarEvent.search ? { search: (request) => callWithUserToken(client.calendar!.v4!.calendarEvent.search!, request, requestOptions) } : {}),
        },
      } },
    } : {}),
    ...(docx ? {
      docx: { v1: {
        document: { get: (request) => callWithUserToken(docx.document.get, request, requestOptions) },
        documentBlock: { list: (request) => callWithUserToken(docx.documentBlock.list, request, requestOptions) },
      } },
    } : {}),
    ...(wiki ? {
      wiki: { v2: { space: { getNode: (request) => callWithUserToken(wiki.space.getNode, request, requestOptions) } } },
    } : {}),
    ...(drive ? {
      drive: { v1: { meta: { batchQuery: (request) => callWithUserToken(drive.meta.batchQuery, request, requestOptions) } } },
    } : {}),
  };
}

function callWithUserToken<TRequest, TResult>(
  operation: (request: TRequest) => Promise<TResult>,
  request: TRequest,
  options: unknown,
): Promise<TResult> {
  return (operation as unknown as (value: TRequest, requestOptions: unknown) => Promise<TResult>)(request, options);
}
