import type { FeishuApiClient, FeishuApiResponse, FeishuDocumentBlock, FeishuPage } from "./types.js";
import {
  classifySourceReadError, createSourceReadFailure, createSourceReadSuccess, createSourceReadUnavailable,
  isSourceReadable, SourceReadError, sourceReadErrorFromResponseCode, type ProjectSourceReader, type ProjectSourceReadContext, type ProjectSourceReadResult,
} from "./source-contract.js";

export interface FeishuDocsLocator { documentToken: string; }
export interface FeishuDocumentBlockRecord { blockId: string; blockType?: number; parentId?: string; children?: string[]; text?: string; }
export interface FeishuDocsSourceSnapshot {
  locator: FeishuDocsLocator;
  document: { documentToken: string; title?: string; revisionId?: number };
  blocks: FeishuDocumentBlockRecord[];
}
export interface FeishuDocsSourceReadInput { context: ProjectSourceReadContext; locator: FeishuDocsLocator; }
export interface FeishuDocsReaderOptions { pageSize?: number; now?: () => Date; }

/** Reads one explicit Docx document and its paginated block hierarchy. */
export class FeishuDocsReader implements ProjectSourceReader<FeishuDocsSourceReadInput, FeishuDocsSourceSnapshot> {
  private readonly pageSize: number;
  private readonly now: () => Date;
  constructor(private readonly client: Pick<FeishuApiClient, "docx">, options: FeishuDocsReaderOptions = {}) {
    this.pageSize = options.pageSize ?? 100;
    this.now = options.now ?? (() => new Date());
  }

  async read(input: FeishuDocsSourceReadInput): Promise<ProjectSourceReadResult<FeishuDocsSourceSnapshot>> {
    const freshness = { fetchedAt: this.now().toISOString() };
    if (!isSourceReadable(input.context)) return createSourceReadUnavailable({ context: input.context, freshness });
    if (input.context.sourceKind !== "feishu-docs" || !input.locator.documentToken.trim()) {
      return createSourceReadFailure({ context: input.context, category: "unknown", freshness });
    }
    const api = this.client.docx?.v1;
    if (!api) return createSourceReadFailure({ context: input.context, category: "source-unavailable", freshness });
    try {
      const token = input.locator.documentToken;
      const metadata = await api.document.get({ path: { document_id: token } });
      if (metadata.code !== 0) throw sourceReadErrorFromResponseCode(metadata.code);
      if (!metadata.data?.document) throw new SourceReadError("unknown");
      const document = metadata.data.document;
      const blocks = await collectBlocks((pageToken) => api.documentBlock.list({
        path: { document_id: token }, params: { page_size: this.pageSize, ...(pageToken ? { page_token: pageToken } : {}), ...(document.revision_id !== undefined ? { document_revision_id: document.revision_id } : {}) },
      }));
      return createSourceReadSuccess({
        context: input.context,
        data: { locator: { ...input.locator }, document: { documentToken: token, ...(document.title ? { title: document.title } : {}), ...(document.revision_id !== undefined ? { revisionId: document.revision_id } : {}) }, blocks: blocks.map(toBlockRecord) },
        resources: [{ sourceRef: input.context.sourceRef, resourceType: "feishu-docx", resourceId: token }], freshness,
      });
    } catch (error) {
      return createSourceReadFailure({ context: input.context, category: classifySourceReadError(error), freshness });
    }
  }
}

async function collectBlocks(fetchPage: (pageToken?: string) => Promise<FeishuApiResponse<FeishuPage<FeishuDocumentBlock>>>): Promise<FeishuDocumentBlock[]> {
  const blocks: FeishuDocumentBlock[] = [];
  let pageToken: string | undefined;
  do {
    const response = await fetchPage(pageToken);
    if (response.code !== 0) throw sourceReadErrorFromResponseCode(response.code);
    if (!response.data) throw new SourceReadError("unknown");
    blocks.push(...(response.data.items ?? []));
    if (response.data.has_more && !response.data.page_token) throw new SourceReadError("transient");
    pageToken = response.data.has_more ? response.data.page_token : undefined;
  } while (pageToken);
  return blocks;
}

function toBlockRecord(block: FeishuDocumentBlock): FeishuDocumentBlockRecord {
  if (!block.block_id?.trim()) throw new SourceReadError("unknown");
  const text = block.text?.elements?.flatMap((element) => element.text_run?.content ? [element.text_run.content] : []).join("");
  return { blockId: block.block_id, ...(block.block_type !== undefined ? { blockType: block.block_type } : {}), ...(block.parent_id ? { parentId: block.parent_id } : {}), ...(block.children ? { children: [...block.children] } : {}), ...(text ? { text } : {}) };
}
