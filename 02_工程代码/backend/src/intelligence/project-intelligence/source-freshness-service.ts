import type {
  ProjectSourceReader,
  ProjectSourceReadContext,
  ProjectSourceReadResult,
  SourceReadFailureCategory,
  SourceReadSuccess,
} from "../../../../feishu-connector/src/source-contract.js";

export type SourceFreshnessState = "fresh" | "stale" | "unknown" | "unavailable";

export interface SourceFreshnessRecord {
  projectId: string;
  sourceRef: string;
  subjectUserId: string;
  state: SourceFreshnessState;
  authorizationState: ProjectSourceReadContext["visibility"];
  lastAttemptAt: string;
  lastSuccessfulReadAt?: string;
  latestFailureCategory?: SourceReadFailureCategory;
  cursor?: string;
  revision?: string;
}

interface StoredSourceState extends SourceFreshnessRecord { lastSuccessfulResult?: SourceReadSuccess<unknown>; }

/** In-memory, subject-scoped state. Runtime restarts intentionally clear it rather than pretending persistence. */
export class SourceFreshnessService {
  private readonly states = new Map<string, StoredSourceState>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  async revalidate<TInput, TOutput>(reader: ProjectSourceReader<TInput, TOutput>, input: TInput & { context: ProjectSourceReadContext }): Promise<ProjectSourceReadResult<TOutput>> {
    const result = await reader.read(input);
    this.record(result);
    return result;
  }

  record<T>(result: ProjectSourceReadResult<T>): SourceFreshnessRecord {
    const key = toKey(result.context);
    const previous = this.states.get(key);
    const attemptedAt = this.now().toISOString();
    if (result.status === "success") {
      const next: StoredSourceState = {
        projectId: result.context.projectId, sourceRef: result.context.sourceRef, subjectUserId: result.context.subject.userId,
        state: "fresh", authorizationState: result.context.visibility, lastAttemptAt: attemptedAt, lastSuccessfulReadAt: attemptedAt,
        ...(result.freshness.cursor ? { cursor: result.freshness.cursor } : {}), ...(result.freshness.revision ? { revision: result.freshness.revision } : {}),
        lastSuccessfulResult: result as SourceReadSuccess<unknown>,
      };
      this.states.set(key, next); return withoutCachedResult(next);
    }
    if (result.context.visibility !== "allowed") {
      const next: StoredSourceState = { projectId: result.context.projectId, sourceRef: result.context.sourceRef, subjectUserId: result.context.subject.userId, state: result.status === "unknown" ? "unknown" : "unavailable", authorizationState: result.context.visibility, lastAttemptAt: attemptedAt };
      this.states.set(key, next); return withoutCachedResult(next);
    }
    const next: StoredSourceState = {
      projectId: result.context.projectId, sourceRef: result.context.sourceRef, subjectUserId: result.context.subject.userId,
      state: previous?.lastSuccessfulResult ? "stale" : "unknown", authorizationState: result.context.visibility, lastAttemptAt: attemptedAt,
      ...(previous?.lastSuccessfulReadAt ? { lastSuccessfulReadAt: previous.lastSuccessfulReadAt } : {}),
      ...(result.status === "failure" ? { latestFailureCategory: result.category } : {}),
      ...(previous?.cursor ? { cursor: previous.cursor } : {}), ...(previous?.revision ? { revision: previous.revision } : {}),
      ...(previous?.lastSuccessfulResult ? { lastSuccessfulResult: previous.lastSuccessfulResult } : {}),
    };
    this.states.set(key, next); return withoutCachedResult(next);
  }

  get(context: ProjectSourceReadContext): SourceFreshnessRecord | undefined { const state = this.states.get(toKey(context)); return state && withoutCachedResult(state); }
  getLastKnownUsable<T>(context: ProjectSourceReadContext): SourceReadSuccess<T> | undefined {
    const state = this.states.get(toKey(context));
    return state?.authorizationState === "allowed" && state.state === "stale" ? state.lastSuccessfulResult as SourceReadSuccess<T> | undefined : undefined;
  }
}

function toKey(context: ProjectSourceReadContext): string { return `${context.projectId}\u0000${context.sourceRef}\u0000${context.subject.userId}`; }
function withoutCachedResult(state: StoredSourceState): SourceFreshnessRecord { const { lastSuccessfulResult: _ignored, ...record } = state; return record; }
