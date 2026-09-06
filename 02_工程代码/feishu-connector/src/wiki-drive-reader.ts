import type { FeishuApiClient, FeishuDriveFileMetadata, FeishuWikiNode } from "./types.js";
import {
  classifySourceReadError, createSourceReadFailure, createSourceReadSuccess, createSourceReadUnavailable,
  isSourceReadable, SourceReadError, sourceReadErrorFromResponseCode, type ProjectSourceReader, type ProjectSourceReadContext, type ProjectSourceReadResult,
} from "./source-contract.js";

export type FeishuWikiDriveLocator =
  | { kind: "wiki-node"; nodeToken: string; objectType?: string }
  | { kind: "drive-file"; fileToken: string; fileType: string };
export interface FeishuWikiDriveSourceSnapshot {
  locator: FeishuWikiDriveLocator;
  object: { token: string; type: string; title?: string; createTime?: string; updateTime?: string; parentToken?: string; url?: string; ownerId?: string; creatorId?: string };
}
export interface FeishuWikiDriveSourceReadInput { context: ProjectSourceReadContext; locator: FeishuWikiDriveLocator; }

/** Resolves exactly one Wiki node or Drive object; folders and spaces are never enumerated. */
export class FeishuWikiDriveReader implements ProjectSourceReader<FeishuWikiDriveSourceReadInput, FeishuWikiDriveSourceSnapshot> {
  constructor(private readonly client: Pick<FeishuApiClient, "wiki" | "drive">, private readonly now: () => Date = () => new Date()) {}
  async read(input: FeishuWikiDriveSourceReadInput): Promise<ProjectSourceReadResult<FeishuWikiDriveSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) return createSourceReadUnavailable({ context: input.context, freshness });
    if (input.context.sourceKind !== "feishu-wiki-drive" || !locatorToken(input.locator)) return createSourceReadFailure({ context: input.context, category: "unknown", freshness });
    try {
      const object = input.locator.kind === "wiki-node" ? await this.readWiki(input.locator) : await this.readDrive(input.locator);
      return createSourceReadSuccess({ context: input.context, data: { locator: { ...input.locator }, object }, resources: [{ sourceRef: input.context.sourceRef, resourceType: input.locator.kind, resourceId: object.token }], freshness });
    } catch (error) {
      return createSourceReadFailure({ context: input.context, category: classifySourceReadError(error), freshness });
    }
  }
  private async readWiki(locator: Extract<FeishuWikiDriveLocator, { kind: "wiki-node" }>): Promise<FeishuWikiDriveSourceSnapshot["object"]> {
    const api = this.client.wiki?.v2?.space;
    if (!api) throw new SourceReadError("source-unavailable");
    const response = await api.getNode({ params: { token: locator.nodeToken, ...(locator.objectType ? { obj_type: locator.objectType } : {}) } });
    if (response.code !== 0) throw sourceReadErrorFromResponseCode(response.code);
    if (!response.data?.node) throw new SourceReadError("unknown");
    return toWikiObject(response.data.node, locator.nodeToken);
  }
  private async readDrive(locator: Extract<FeishuWikiDriveLocator, { kind: "drive-file" }>): Promise<FeishuWikiDriveSourceSnapshot["object"]> {
    const api = this.client.drive?.v1?.meta;
    if (!api) throw new SourceReadError("source-unavailable");
    const response = await api.batchQuery({ data: { request_docs: [{ doc_token: locator.fileToken, doc_type: locator.fileType }], with_url: true } });
    const metadata = response.data?.metas?.[0];
    if (response.code !== 0) throw sourceReadErrorFromResponseCode(response.code);
    if (!metadata) throw new SourceReadError("unknown");
    return toDriveObject(metadata);
  }
}
function locatorToken(locator: FeishuWikiDriveLocator): string { return locator.kind === "wiki-node" ? locator.nodeToken.trim() : locator.fileToken.trim(); }
function toWikiObject(node: FeishuWikiNode, fallbackToken: string): FeishuWikiDriveSourceSnapshot["object"] { return { token: node.obj_token ?? node.node_token ?? fallbackToken, type: node.obj_type ?? "wiki", ...(node.title ? { title: node.title } : {}), ...(node.obj_create_time ? { createTime: node.obj_create_time } : {}), ...(node.obj_edit_time ? { updateTime: node.obj_edit_time } : {}), ...(node.parent_node_token ? { parentToken: node.parent_node_token } : {}), ...(node.url ? { url: node.url } : {}), ...(node.owner ? { ownerId: node.owner } : {}), ...(node.creator ? { creatorId: node.creator } : {}) }; }
function toDriveObject(file: FeishuDriveFileMetadata): FeishuWikiDriveSourceSnapshot["object"] { return { token: file.doc_token, type: file.doc_type, title: file.title, ...(file.create_time ? { createTime: file.create_time } : {}), ...(file.latest_modify_time ? { updateTime: file.latest_modify_time } : {}), ...(file.url ? { url: file.url } : {}), ...(file.owner_id ? { ownerId: file.owner_id } : {}), ...(file.latest_modify_user ? { creatorId: file.latest_modify_user } : {}) }; }
