import type { ProjectDataSourceKind } from "../../backend/src/project-context/project-data-source-resolver.js";
import type {
  ProjectDataSourceAuthorization,
  ProjectDataSourceSubject,
  ProjectDataSourceVisibility,
} from "../../backend/src/project-context/project-data-source-visibility.js";

export type SourceReadFailureCategory =
  | "permission-denied"
  | "source-unavailable"
  | "not-found"
  | "rate-limited"
  | "invalid-credential"
  | "transient"
  | "unknown";

export interface ProjectSourceReadContext {
  projectId: string;
  sourceRef: string;
  sourceKind: ProjectDataSourceKind;
  subject: ProjectDataSourceSubject;
  authorization: ProjectDataSourceAuthorization;
  visibility: ProjectDataSourceVisibility;
}

export interface SourceResourceLocator {
  sourceRef: string;
  resourceType: string;
  resourceId?: string;
}

export interface SourceReadFreshness {
  fetchedAt: string;
  sourceUpdatedAt?: string;
  cursor?: string;
  revision?: string;
}

export interface SourceReadSuccess<T> {
  status: "success";
  context: ProjectSourceReadContext;
  data: T;
  resources: SourceResourceLocator[];
  freshness: SourceReadFreshness;
}

export interface SourceReadFailure {
  status: "failure";
  context: ProjectSourceReadContext;
  category: SourceReadFailureCategory;
  freshness: SourceReadFreshness;
}

export interface SourceReadUnavailable {
  status: "unavailable" | "unknown";
  context: ProjectSourceReadContext;
  freshness: SourceReadFreshness;
}

export type ProjectSourceReadResult<T> =
  | SourceReadSuccess<T>
  | SourceReadFailure
  | SourceReadUnavailable;

/** Each Source keeps its own input and output types behind this small boundary. */
export interface ProjectSourceReader<TInput, TOutput> {
  read(input: TInput): Promise<ProjectSourceReadResult<TOutput>>;
}

/** A safe, category-only error for a Source-specific adapter to expose. */
export class SourceReadError extends Error {
  constructor(readonly category: SourceReadFailureCategory) {
    super(`Source read failed: ${category}.`);
    this.name = "SourceReadError";
  }
}

export function createSourceReadSuccess<T>(input: {
  context: ProjectSourceReadContext;
  data: T;
  resources: SourceResourceLocator[];
  freshness: SourceReadFreshness;
}): SourceReadSuccess<T> {
  return { status: "success", ...input };
}

export function createSourceReadFailure(input: {
  context: ProjectSourceReadContext;
  category: SourceReadFailureCategory;
  freshness: SourceReadFreshness;
}): SourceReadFailure {
  return { status: "failure", ...input };
}

export function createSourceReadUnavailable(input: {
  context: ProjectSourceReadContext;
  freshness: SourceReadFreshness;
}): SourceReadUnavailable {
  return {
    status: input.context.visibility === "unknown" ? "unknown" : "unavailable",
    ...input,
  };
}

export function isSourceReadable(context: ProjectSourceReadContext): boolean {
  return context.visibility === "allowed";
}

export function classifySourceReadError(error: unknown): SourceReadFailureCategory {
  if (error instanceof SourceReadError) return error.category;
  return sourceReadErrorFromResponseCode(readFeishuResponseCode(error)).category;
}

/** Feishu documents 99991668 as an expired or invalid user access token. */
export function sourceReadErrorFromResponseCode(code: unknown): SourceReadError {
  if (code === 99991668) return new SourceReadError("invalid-credential");
  // Feishu documents 1770032 as a forbidden document-resource response.
  if (code === 1770032) return new SourceReadError("permission-denied");
  return new SourceReadError("unknown");
}

function readFeishuResponseCode(error: unknown): unknown {
  if (!isRecord(error) || !isRecord(error.response) || !isRecord(error.response.data)) return undefined;
  return error.response.data.code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
