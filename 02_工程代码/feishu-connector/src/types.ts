export interface FeishuCredentials {
  appId: string;
  appSecret: string;
}

export interface FeishuBaseInfo {
  app_token?: string;
  name?: string;
  revision?: number;
}

export interface FeishuTable {
  table_id?: string;
  name?: string;
  revision?: number;
}

export interface FeishuRecord {
  record_id?: string;
  fields?: Record<string, unknown>;
  created_time?: number | string;
  last_modified_time?: number | string;
}

export interface FeishuField {
  field_id?: string;
  field_name?: string;
  type?: number;
  ui_type?: string;
  is_primary?: boolean;
  property?: {
    options?: Array<{ id?: string; name?: string }>;
    [key: string]: unknown;
  };
}

export interface FeishuChatMessageSender {
  id?: string;
  id_type?: string;
  sender_type?: string;
}

export interface FeishuChatMessage {
  message_id?: string;
  root_id?: string;
  parent_id?: string;
  thread_id?: string;
  msg_type?: string;
  create_time?: string;
  update_time?: string;
  deleted?: boolean;
  updated?: boolean;
  chat_id?: string;
  sender?: FeishuChatMessageSender;
  body?: { content?: string };
}

export interface FeishuMinutesMetadata {
  token?: string;
  owner_id?: string;
  create_time?: string;
  title?: string;
  duration?: string;
  note_id?: string;
}

export interface FeishuMinutesArtifacts {
  summary?: string;
  minute_chapters?: Array<{ title?: string; start_ms?: string; stop_ms?: string; summary_content?: string }>;
  minute_todos?: Array<{ content?: string; assignees?: string[]; is_done?: boolean; todo_id?: string; operation?: string }>;
  keywords?: string[];
}

export interface FeishuDocumentMetadata {
  document_id?: string;
  revision_id?: number;
  title?: string;
}

export interface FeishuDocumentBlock {
  block_id?: string;
  parent_id?: string;
  children?: string[];
  block_type?: number;
  text?: { elements?: Array<{ text_run?: { content?: string } }> };
}

export interface FeishuWikiNode {
  space_id?: string;
  node_token?: string;
  obj_token?: string;
  obj_type?: string;
  parent_node_token?: string;
  node_type?: string;
  title?: string;
  obj_create_time?: string;
  obj_edit_time?: string;
  creator?: string;
  owner?: string;
  url?: string;
}

export interface FeishuDriveFileMetadata {
  doc_token: string;
  doc_type: string;
  title: string;
  owner_id?: string;
  create_time?: string;
  latest_modify_user?: string;
  latest_modify_time?: string;
  url?: string;
}

export interface FeishuTask {
  id?: string;
  summary?: string;
  description?: string;
  complete_time?: string;
  creator_id?: string;
  create_time?: string;
  update_time?: string;
  due?: { time?: string; timezone?: string; is_all_day?: boolean };
  collaborator_ids?: string[];
  follower_ids?: string[];
}

export interface FeishuCalendarEvent {
  event_id?: string;
  summary?: string;
  description?: string;
  start_time?: { date?: string; timestamp?: string; timezone?: string };
  end_time?: { date?: string; timestamp?: string; timezone?: string };
  create_time?: string;
  recurring_event_id?: string;
  event_organizer?: { user_id?: string; display_name?: string };
  attendees?: Array<{ attendee_id?: string; display_name?: string; type?: string }>;
}

export interface FeishuDownloadResponse {
  getReadableStream(): AsyncIterable<Uint8Array | string>;
}

export interface FeishuApiResponse<T> {
  code?: number;
  msg?: string;
  data?: T;
}

export interface FeishuPage<T> {
  items?: T[];
  has_more?: boolean;
  page_token?: string;
  total?: number;
}

export interface FeishuApiClient {
  bitable: {
    v1: {
      app: {
        get(request: {
          path: { app_token: string };
        }): Promise<FeishuApiResponse<{ app?: FeishuBaseInfo }>>;
      };
      appTable: {
        list(request: {
          path: { app_token: string };
          params: { page_size: number; page_token?: string };
        }): Promise<FeishuApiResponse<FeishuPage<FeishuTable>>>;
      };
      appTableRecord: {
        list(request: {
          path: { app_token: string; table_id: string };
          params: { page_size: number; page_token?: string };
        }): Promise<FeishuApiResponse<FeishuPage<FeishuRecord>>>;
      };
      appTableField?: {
        list(request: {
          path: { app_token: string; table_id: string };
          params: { page_size: number; page_token?: string };
        }): Promise<FeishuApiResponse<FeishuPage<FeishuField>>>;
      };
    };
  };
  im?: {
    v1?: {
      chat?: {
        get(request: { path: { chat_id: string }; params?: { user_id_type?: "user_id" | "union_id" | "open_id" } }): Promise<FeishuApiResponse<unknown>>;
        list(request: { params?: { user_id_type?: "user_id" | "union_id" | "open_id"; page_size?: number; page_token?: string } }): Promise<FeishuApiResponse<FeishuPage<{ chat_id?: string; name?: string }>>>;
      };
      chatMembers?: {
        isInChat(request: { path: { chat_id: string } }): Promise<FeishuApiResponse<{ is_in_chat?: boolean }>>;
      };
      message: {
        list(request: {
          params: {
            container_id_type: string;
            container_id: string;
            sort_type?: "ByCreateTimeAsc" | "ByCreateTimeDesc";
            page_size?: number;
            page_token?: string;
            with_sender_name?: boolean;
          };
        }): Promise<FeishuApiResponse<FeishuPage<FeishuChatMessage>>>;
      };
    };
  };
  minutes?: {
    v1?: {
      minute: {
        get(request: { params?: { user_id_type?: "user_id" | "union_id" | "open_id" }; path: { minute_token: string } }): Promise<FeishuApiResponse<{ minute?: FeishuMinutesMetadata }>>;
        artifacts(request: { path: { minute_token: string } }): Promise<FeishuApiResponse<FeishuMinutesArtifacts>>;
      };
      minuteTranscript: {
        get(request: { params?: { need_speaker?: boolean; need_timestamp?: boolean }; path: { minute_token: string } }): Promise<FeishuDownloadResponse>;
      };
    };
  };
  docx?: {
    v1?: {
      document: {
        get(request: { path: { document_id: string } }): Promise<FeishuApiResponse<{ document?: FeishuDocumentMetadata }>>;
      };
      documentBlock: {
        list(request: { path: { document_id: string }; params?: { page_size?: number; page_token?: string; document_revision_id?: number } }): Promise<FeishuApiResponse<FeishuPage<FeishuDocumentBlock>>>;
      };
    };
  };
  wiki?: {
    v2?: {
      space: {
        getNode(request: { params: { token: string; obj_type?: string } }): Promise<FeishuApiResponse<{ node?: FeishuWikiNode }>>;
      };
    };
  };
  drive?: {
    v1?: {
      meta: {
        batchQuery(request: { data: { request_docs: Array<{ doc_token: string; doc_type: string }>; with_url?: boolean } }): Promise<FeishuApiResponse<{ metas?: FeishuDriveFileMetadata[]; failed_list?: Array<{ token?: string }> }>>;
      };
    };
  };
  task?: {
    v1?: {
      task: {
        get(request: { path: { task_id: string }; params?: { user_id_type?: "user_id" | "union_id" | "open_id" } }): Promise<FeishuApiResponse<{ task?: FeishuTask }>>;
      };
    };
  };
  calendar?: {
    v4?: {
      calendar?: {
        list(request: { params?: { page_size?: number; page_token?: string } }): Promise<FeishuApiResponse<{ has_more?: boolean; page_token?: string; calendar_list?: Array<{ calendar_id: string; is_primary?: boolean }> }>>;
        primary?(request: { params?: { user_id_type?: "user_id" | "union_id" | "open_id" } }): Promise<FeishuApiResponse<{ calendars?: Array<{ calendar?: { calendar_id: string } }> }>>;
      };
      calendarEvent: {
        get(request: { path: { calendar_id: string; event_id: string }; params?: { need_attendee?: boolean; user_id_type?: "user_id" | "union_id" | "open_id" } }): Promise<FeishuApiResponse<{ event?: FeishuCalendarEvent }>>;
        list?(request: { path: { calendar_id: string }; params?: { page_size?: number; page_token?: string; start_time?: string; end_time?: string; user_id_type?: "user_id" | "union_id" | "open_id" } }): Promise<FeishuApiResponse<FeishuPage<FeishuCalendarEvent>>>;
        search?(request: { path: { calendar_id: string }; data: { query: string; filter?: { start_time?: { timestamp?: string; timezone?: string }; end_time?: { timestamp?: string; timezone?: string } } }; params?: { page_size?: number; page_token?: string; user_id_type?: "user_id" | "union_id" | "open_id" } }): Promise<FeishuApiResponse<FeishuPage<FeishuCalendarEvent>>>;
      };
    };
  };
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface StandardProject {
  id: string;
  name: string;
  source: "feishu-base";
}

export interface StandardTask {
  id: string;
  tableId: string;
  tableName: string;
  name: string;
  owner: string | null;
  status: string | null;
  deadline: string | null;
  riskLevel: string | null;
  description: string | null;
  attributes: Record<string, JsonValue>;
}

export interface ProjectDataMetadata {
  baseToken: string;
  tableCount: number;
  recordCount: number;
  retrievedAt: string;
  accessMode: "read-only";
  tables: Array<{
    id: string;
    name: string;
    recordCount: number;
  }>;
}

export interface StandardProjectData {
  project: StandardProject;
  tasks: StandardTask[];
  metadata: ProjectDataMetadata;
}

export interface ProjectDataReader {
  readProjectData(baseToken: string): Promise<StandardProjectData>;
}
