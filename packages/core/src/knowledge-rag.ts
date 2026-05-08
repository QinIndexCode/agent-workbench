import type {
  KnowledgeChunk,
  KnowledgeEmbedding,
  KnowledgeItem,
  KnowledgeReindexResult,
  KnowledgeSearchRequest,
  KnowledgeSearchResult,
  ToolCall,
  ToolResult
} from "@scc/shared";
import { createId, nowIso } from "./ids.js";
import { sanitizeSensitiveText } from "./secrets.js";
import type { WorkbenchStore } from "./store.js";
import type { ToolExecutionOptions, ToolExecutorDelegate } from "./tools.js";

const localEmbeddingModel = "local-hash-v1";
const dimensions = 128;

export class KnowledgeSearchToolExecutor implements ToolExecutorDelegate {
  constructor(private readonly store: WorkbenchStore) {}

  canExecute(toolName: string): boolean {
    return toolName === "knowledge_search";
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const query = String(call.args["query"] ?? "").trim();
    if (!query) return result(call, false, "Missing knowledge search query.");
    if (options.signal?.aborted) return result(call, false, "Knowledge search cancelled before it started.");
    const projectId = String(call.args["projectId"] ?? "default");
    const limit = clamp(Number(call.args["limit"] ?? 5), 1, 12);
    try {
      const matches = await searchKnowledge(this.store, { query, projectId, limit });
      if (options.signal?.aborted) return result(call, false, "Knowledge search cancelled by user.");
      return result(
        call,
        true,
        JSON.stringify(
          {
            query,
            projectId,
            results: matches.map((match) => ({
              score: Number(match.score.toFixed(4)),
              knowledgeId: match.item.id,
              title: match.item.title,
              chunkId: match.chunk.id,
              excerpt: match.chunk.content.slice(0, 1200),
              citation: match.citation,
              tags: match.chunk.tags,
              sourceUri: match.chunk.sourceUri
            }))
          },
          null,
          2
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return result(call, false, `Knowledge search failed: ${sanitizeSensitiveText(message)}`);
    }
  }
}

export async function indexKnowledgeItem(store: WorkbenchStore, item: KnowledgeItem): Promise<KnowledgeReindexResult> {
  await store.deleteKnowledgeChunks(item.id);
  if (!isIndexableKnowledge(item)) {
    const updated: KnowledgeItem = {
      ...item,
      indexStatus: "metadata_only",
      chunkCount: 0,
      lastIndexedAt: nowIso(),
      indexError: undefined,
      updatedAt: nowIso()
    };
    await store.saveKnowledgeItem(updated);
    return { knowledgeId: item.id, status: "metadata_only", chunks: 0 };
  }

  try {
    const chunks = chunkKnowledgeItem(item);
    for (const chunk of chunks) {
      await store.saveKnowledgeChunk(chunk);
      await store.saveKnowledgeEmbedding({
        id: createId("knowledge_embedding"),
        chunkId: chunk.id,
        providerId: "local_hash",
        model: localEmbeddingModel,
        dimensions,
        vector: embedText([chunk.title, chunk.content, chunk.tags.join(" ")].join("\n")),
        createdAt: nowIso()
      });
    }
    await store.saveKnowledgeItem({
      ...item,
      indexStatus: "indexed",
      chunkCount: chunks.length,
      lastIndexedAt: nowIso(),
      indexError: undefined,
      updatedAt: nowIso()
    });
    return { knowledgeId: item.id, status: "indexed", chunks: chunks.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await store.saveKnowledgeItem({
      ...item,
      indexStatus: "failed",
      chunkCount: 0,
      lastIndexedAt: nowIso(),
      indexError: message,
      updatedAt: nowIso()
    });
    return { knowledgeId: item.id, status: "failed", chunks: 0, error: message };
  }
}

export async function searchKnowledge(store: WorkbenchStore, request: KnowledgeSearchRequest): Promise<KnowledgeSearchResult[]> {
  const queryVector = embedText(request.query);
  const chunks = (await store.listKnowledgeChunks()).filter((chunk) => chunk.projectId === request.projectId);
  if (chunks.length === 0) return [];
  const embeddings = new Map((await store.listKnowledgeEmbeddings(chunks.map((chunk) => chunk.id))).map((embedding) => [embedding.chunkId, embedding]));
  const items = new Map((await store.listKnowledgeItems(request.projectId)).map((item) => [item.id, item]));
  return chunks
    .flatMap((chunk) => {
      const embedding = embeddings.get(chunk.id);
      const item = items.get(chunk.knowledgeId);
      if (!embedding || !item) return [];
      const score = cosine(queryVector, embedding.vector);
      return [{
        item,
        chunk,
        score,
        citation: {
          knowledgeId: item.id,
          chunkId: chunk.id,
          title: item.title,
          ...(chunk.sourceUri ? { sourceUri: chunk.sourceUri } : {}),
          ...(chunk.heading ? { heading: chunk.heading } : {}),
          excerpt: chunk.content.slice(0, 360),
          score
        }
      }];
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, request.limit);
}

export function chunkKnowledgeItem(item: KnowledgeItem): KnowledgeChunk[] {
  const text = item.content.trim();
  if (!text) return [];
  const segments = segmentKnowledgeText(item);
  const target = 1400;
  const overlap = 180;
  const chunks: KnowledgeChunk[] = [];
  for (const segment of segments) {
    let offset = 0;
    while (offset < segment.content.length) {
      const end = Math.min(segment.content.length, offset + target);
      const content = segment.content.slice(offset, end).trim();
      if (content) {
        chunks.push({
          id: createId("knowledge_chunk"),
          knowledgeId: item.id,
          projectId: item.projectId,
          ordinal: chunks.length,
          title: item.title,
          content,
          tokenEstimate: estimateTokens(content),
          tags: item.tags,
          ...(segment.heading ? { heading: segment.heading } : {}),
          startOffset: segment.startOffset + offset,
          endOffset: segment.startOffset + end,
          ...(item.sourceUri ? { sourceUri: item.sourceUri } : {}),
          createdAt: nowIso(),
          updatedAt: nowIso()
        });
      }
      if (end === segment.content.length) break;
      offset = Math.max(end - overlap, offset + 1);
    }
  }
  return chunks;
}

function segmentKnowledgeText(item: KnowledgeItem): Array<{ heading?: string; content: string; startOffset: number }> {
  const text = item.content.trim();
  const name = item.fileName ?? item.title;
  if (/\.csv$/i.test(name) || item.mimeType?.includes("csv")) return segmentCsv(text);
  if (/\.md$/i.test(name) || item.mimeType?.includes("markdown")) return segmentMarkdown(text);
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cs|cpp|c|h)$/i.test(name)) return segmentCode(text);
  return [{ content: text, startOffset: 0 }];
}

function segmentMarkdown(text: string): Array<{ heading?: string; content: string; startOffset: number }> {
  const matches = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)];
  if (matches.length === 0) return [{ content: text, startOffset: 0 }];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const heading = match[1]?.trim();
    return { ...(heading ? { heading } : {}), content: text.slice(start, end).trim(), startOffset: start };
  }).filter((segment) => segment.content.length > 0);
}

function segmentCode(text: string): Array<{ heading?: string; content: string; startOffset: number }> {
  const matches = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type)\s+([A-Za-z0-9_$]+)/gm)];
  if (matches.length === 0) return [{ content: text, startOffset: 0 }];
  return matches.map((match, index) => {
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const heading = match[1]?.trim();
    return { ...(heading ? { heading } : {}), content: text.slice(start, end).trim(), startOffset: start };
  }).filter((segment) => segment.content.length > 0);
}

function segmentCsv(text: string): Array<{ heading?: string; content: string; startOffset: number }> {
  const lines = text.split(/\r?\n/);
  const header = lines[0] ?? "";
  const sample = lines.slice(1, 80).join("\n");
  return [{ heading: "CSV sample", content: [`Columns: ${header}`, sample].filter(Boolean).join("\n"), startOffset: 0 }];
}

export function embedText(text: string): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of tokenize(text)) {
    const hash = hashToken(token);
    const index = Math.abs(hash) % dimensions;
    vector[index] = (vector[index] ?? 0) + (hash < 0 ? -1 : 1);
  }
  const length = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / length).toFixed(6)));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[\p{Script=Han}]{1,2}|[a-z0-9_]{2,}/gu) ?? [];
}

function hashToken(token: string): number {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

function cosine(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  for (let index = 0; index < length; index += 1) dot += (left[index] ?? 0) * (right[index] ?? 0);
  return Math.max(0, Math.min(1, dot));
}

function isIndexableKnowledge(item: KnowledgeItem): boolean {
  if (!item.content.trim()) return false;
  if (item.size && item.size > 1_500_000) return false;
  if (item.mimeType && !isTextLike(item.mimeType, item.fileName ?? "")) return false;
  return true;
}

function isTextLike(mimeType: string, fileName: string): boolean {
  return mimeType.startsWith("text/") || /(\.md|\.txt|\.json|\.csv|\.ts|\.tsx|\.js|\.jsx|\.css|\.html|\.xml|\.yaml|\.yml)$/i.test(fileName);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function result(call: ToolCall, ok: boolean, output: string): ToolResult {
  return {
    id: createId("tool_result"),
    toolCallId: call.id,
    ok,
    output,
    createdAt: nowIso()
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}
