import {
  createFeishuIdentityRef, type FeishuIdentityContext, type FeishuIdentityRef, type FeishuIdentityType,
} from "../../backend/src/current-user/index.js";
import type { FeishuApiClient, FeishuTask } from "./types.js";
import {
  classifySourceReadError, createSourceReadFailure, createSourceReadSuccess, createSourceReadUnavailable,
  isSourceReadable, sourceReadErrorFromResponseCode, type ProjectSourceReader, type ProjectSourceReadContext, type ProjectSourceReadResult,
} from "./source-contract.js";

export interface FeishuTaskLocator { taskIds: string[]; }
export interface FeishuTaskRecord {
  taskId: string; title?: string; description?: string; createTime?: string; updateTime?: string; completeTime?: string;
  due?: { time?: string; timezone?: string; isAllDay?: boolean }; creator?: FeishuIdentityRef; collaborators: FeishuIdentityRef[]; followers: FeishuIdentityRef[];
}
export interface FeishuTaskSourceSnapshot { locator: FeishuTaskLocator; tasks: FeishuTaskRecord[]; }
export interface FeishuTaskSourceReadInput { context: ProjectSourceReadContext; locator: FeishuTaskLocator; }
export interface FeishuTaskReaderOptions { identityContext: FeishuIdentityContext; identityType?: FeishuIdentityType; now?: () => Date; }

/** Reads only a caller-supplied finite task list; it never calls the user or tenant task-list endpoint. */
export class FeishuTaskReader implements ProjectSourceReader<FeishuTaskSourceReadInput, FeishuTaskSourceSnapshot> {
  private readonly identityType: FeishuIdentityType;
  private readonly now: () => Date;
  constructor(private readonly client: Pick<FeishuApiClient, "task">, private readonly options: FeishuTaskReaderOptions) {
    this.identityType = options.identityType ?? "open_id";
    this.now = options.now ?? (() => new Date());
  }
  async read(input: FeishuTaskSourceReadInput): Promise<ProjectSourceReadResult<FeishuTaskSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) return createSourceReadUnavailable({ context: input.context, freshness });
    const ids = [...new Set(input.locator.taskIds.map((id) => id.trim()).filter(Boolean))];
    if (input.context.sourceKind !== "feishu-task" || ids.length === 0) return createSourceReadFailure({ context: input.context, category: "unknown", freshness });
    const api = this.client.task?.v1?.task;
    if (!api) return createSourceReadFailure({ context: input.context, category: "source-unavailable", freshness });
    try {
      const tasks = await Promise.all(ids.map(async (taskId) => {
        const response = await api.get({ path: { task_id: taskId }, params: { user_id_type: this.identityType } });
        if (response.code !== 0 || !response.data?.task) throw sourceReadErrorFromResponseCode(response.code);
        return toTaskRecord(response.data.task, taskId, this.options.identityContext, this.identityType);
      }));
      return createSourceReadSuccess({ context: input.context, data: { locator: { taskIds: ids }, tasks }, resources: ids.map((resourceId) => ({ sourceRef: input.context.sourceRef, resourceType: "feishu-task", resourceId })), freshness });
    } catch (error) {
      return createSourceReadFailure({ context: input.context, category: classifySourceReadError(error), freshness });
    }
  }
}
function toTaskRecord(task: FeishuTask, fallbackId: string, context: FeishuIdentityContext, type: FeishuIdentityType): FeishuTaskRecord {
  const identity = (value: string): FeishuIdentityRef => createFeishuIdentityRef({ type, value, context });
  return {
    taskId: task.id ?? fallbackId, ...(task.summary ? { title: task.summary } : {}), ...(task.description ? { description: task.description } : {}), ...(task.create_time ? { createTime: task.create_time } : {}), ...(task.update_time ? { updateTime: task.update_time } : {}), ...(task.complete_time ? { completeTime: task.complete_time } : {}),
    ...(task.due ? { due: { ...(task.due.time ? { time: task.due.time } : {}), ...(task.due.timezone ? { timezone: task.due.timezone } : {}), ...(task.due.is_all_day !== undefined ? { isAllDay: task.due.is_all_day } : {}) } } : {}),
    ...(task.creator_id ? { creator: identity(task.creator_id) } : {}), collaborators: (task.collaborator_ids ?? []).map(identity), followers: (task.follower_ids ?? []).map(identity),
  };
}
