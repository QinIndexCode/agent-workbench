import type {
  KnowledgeChunk,
  KnowledgeItem,
  KnowledgeReindexResult,
  KnowledgeSearchRequest,
  KnowledgeSearchField,
  KnowledgeSearchIndexEntry,
  KnowledgeSearchResult,
  ToolCall,
  ToolResult
} from "@scc/shared";
import { createId, nowIso } from "./ids.js";
import { sanitizeSensitiveText } from "./secrets.js";
import type { WorkbenchStore } from "./store.js";
import type { ToolExecutionOptions, ToolExecutorDelegate } from "./tools.js";

const dimensions = 128;
const fieldWeights: Record<KnowledgeSearchField, number> = {
  title: 5,
  tags: 4,
  heading: 3,
  fileName: 2.5,
  content: 1,
  sourceUri: 0.5
};
const fieldOrder: KnowledgeSearchField[] = ["title", "tags", "heading", "fileName", "content", "sourceUri"];
const maxLocalRecall = 30;

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
              rankReason: match.rankReason,
              highlights: match.highlights,
              matchedFields: match.matchedFields,
              rerankScore: match.rerankScore,
              rerankStatus: match.rerankStatus,
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
      for (const entry of createSearchIndexEntries(item, chunk)) {
        await store.saveKnowledgeSearchIndexEntry(entry);
      }
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
  const chunks = (await store.listKnowledgeChunks()).filter((chunk) => chunk.projectId === request.projectId);
  if (chunks.length === 0) return [];
  const items = new Map((await store.listKnowledgeItems(request.projectId)).map((item) => [item.id, item]));
  const queryTerms = unique(tokenize(request.query));
  if (queryTerms.length === 0) return [];
  const chunkIds = chunks.map((chunk) => chunk.id);
  const persistedEntries = await store.listKnowledgeSearchIndexEntries(chunkIds);
  const indexedChunkIds = new Set(persistedEntries.map((entry) => entry.chunkId));
  const transientEntries = chunks.flatMap((chunk) => {
    if (indexedChunkIds.has(chunk.id)) return [];
    const item = items.get(chunk.knowledgeId);
    return item ? createSearchIndexEntries(item, chunk) : [];
  });
  const indexEntries = [...persistedEntries, ...transientEntries];
  if (indexEntries.length === 0) return [];

  const querySet = new Set(queryTerms);
  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const documentFrequency = buildDocumentFrequency(indexEntries, querySet);
  const averageLength = chunks.reduce((sum, chunk) => sum + Math.max(1, chunk.tokenEstimate), 0) / chunks.length;
  const rawScores = new Map<string, number>();
  const matchedFields = new Map<string, Set<KnowledgeSearchField>>();
  const coveredTerms = new Map<string, Set<string>>();
  const k1 = 1.2;

  for (const entry of indexEntries) {
    if (!querySet.has(entry.term)) continue;
    const chunk = chunkById.get(entry.chunkId);
    if (!chunk) continue;
    const df = documentFrequency.get(entry.term)?.size ?? 0;
    const idf = Math.max(0.01, Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5)));
    const lengthNorm = 0.25 + 0.75 * (Math.max(1, chunk.tokenEstimate) / Math.max(1, averageLength));
    const tf = (entry.frequency * (k1 + 1)) / (entry.frequency + k1 * lengthNorm);
    rawScores.set(entry.chunkId, (rawScores.get(entry.chunkId) ?? 0) + idf * tf * fieldWeights[entry.field]);
    getOrCreateSet(matchedFields, entry.chunkId).add(entry.field);
    getOrCreateSet(coveredTerms, entry.chunkId).add(entry.term);
  }

  const maxRawScore = Math.max(...rawScores.values(), 0);
  const candidates: RankedKnowledgeResult[] = [];
  for (const [chunkId, rawScore] of rawScores) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    const item = items.get(chunk.knowledgeId);
    if (!item) continue;
    const fields = sortFields(matchedFields.get(chunkId) ?? new Set());
    const highlights = buildHighlights(item, chunk, fields, request.query, queryTerms);
    const score = normalizeLexicalScore(rawScore, maxRawScore);
    const coverageRatio = (coveredTerms.get(chunkId)?.size ?? 0) / querySet.size;
    const phraseMatch = hasPhraseMatch(item, chunk, request.query);
    const titleTagMatch = fields.includes("title") || fields.includes("tags");
    candidates.push({
      item,
      chunk,
      score,
      rankReason: formatRankReason(fields, score, coverageRatio),
      highlights,
      matchedFields: fields,
      rerankStatus: "skipped",
      coverageRatio,
      phraseMatch,
      titleTagMatch,
      citation: {
        knowledgeId: item.id,
        chunkId: chunk.id,
        title: item.title,
        ...(chunk.sourceUri ? { sourceUri: chunk.sourceUri } : {}),
        ...(chunk.heading ? { heading: chunk.heading } : {}),
        excerpt: (highlights.find((highlight) => highlight.field === "content")?.text ?? highlights[0]?.text ?? chunk.content).slice(0, 360),
        score
      }
    });
  }

  const recalled = candidates
    .sort(compareLocalCandidates)
    .slice(0, Math.max(request.limit, maxLocalRecall));
  return applyLocalRerank(recalled)
    .slice(0, request.limit)
    .map(({ coverageRatio: _coverageRatio, phraseMatch: _phraseMatch, titleTagMatch: _titleTagMatch, ...result }) => result);
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
  const tokens: string[] = [];
  for (const match of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[a-z0-9_]{2,}/gu)) {
    const token = match[0];
    if (!token) continue;
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (const char of token) tokens.push(char);
      for (let index = 0; index < token.length - 1; index += 1) tokens.push(token.slice(index, index + 2));
      continue;
    }
    tokens.push(token);
  }
  return tokens;
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

type RankedKnowledgeResult = KnowledgeSearchResult & {
  coverageRatio: number;
  phraseMatch: boolean;
  titleTagMatch: boolean;
};

function createSearchIndexEntries(item: KnowledgeItem, chunk: KnowledgeChunk): KnowledgeSearchIndexEntry[] {
  const now = nowIso();
  const fields: Array<{ field: KnowledgeSearchField; text: string }> = [
    { field: "title", text: item.title || chunk.title },
    { field: "heading", text: chunk.heading ?? "" },
    { field: "content", text: chunk.content },
    { field: "tags", text: item.tags.join(" ") || chunk.tags.join(" ") },
    { field: "fileName", text: item.fileName ?? "" },
    { field: "sourceUri", text: item.sourceUri ?? chunk.sourceUri ?? "" }
  ];
  return fields.flatMap(({ field, text }) => {
    const positions = tokenPositions(text);
    return [...positions.entries()].map(([term, termPositions]) => ({
      id: createId("knowledge_index"),
      knowledgeId: item.id,
      chunkId: chunk.id,
      projectId: item.projectId,
      term,
      field,
      frequency: termPositions.length,
      positions: termPositions.slice(0, 32),
      createdAt: now
    }));
  });
}

function tokenPositions(text: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  tokenize(text).forEach((term, position) => {
    const positions = map.get(term) ?? [];
    positions.push(position);
    map.set(term, positions);
  });
  return map;
}

function buildDocumentFrequency(entries: KnowledgeSearchIndexEntry[], querySet: Set<string>): Map<string, Set<string>> {
  const frequency = new Map<string, Set<string>>();
  for (const entry of entries) {
    if (!querySet.has(entry.term)) continue;
    getOrCreateSet(frequency, entry.term).add(entry.chunkId);
  }
  return frequency;
}

function getOrCreateSet<T>(map: Map<string, Set<T>>, key: string): Set<T> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Set<T>();
  map.set(key, created);
  return created;
}

function sortFields(fields: Set<KnowledgeSearchField>): KnowledgeSearchField[] {
  return fieldOrder.filter((field) => fields.has(field));
}

function buildHighlights(
  item: KnowledgeItem,
  chunk: KnowledgeChunk,
  fields: KnowledgeSearchField[],
  query: string,
  queryTerms: string[]
): NonNullable<KnowledgeSearchResult["highlights"]> {
  return fields
    .flatMap((field) => {
      const text = fieldText(item, chunk, field);
      const snippet = makeSnippet(text, query, queryTerms);
      return snippet ? [{ field, text: snippet }] : [];
    })
    .slice(0, 4);
}

function fieldText(item: KnowledgeItem, chunk: KnowledgeChunk, field: KnowledgeSearchField): string {
  switch (field) {
    case "title":
      return item.title || chunk.title;
    case "heading":
      return chunk.heading ?? "";
    case "content":
      return chunk.content;
    case "tags":
      return item.tags.join(", ") || chunk.tags.join(", ");
    case "fileName":
      return item.fileName ?? "";
    case "sourceUri":
      return item.sourceUri ?? chunk.sourceUri ?? "";
  }
}

function makeSnippet(text: string, query: string, queryTerms: string[]): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const lower = compact.toLowerCase();
  const queryLower = query.trim().toLowerCase();
  let index = queryLower.length > 1 ? lower.indexOf(queryLower) : -1;
  if (index < 0) {
    for (const term of queryTerms) {
      index = lower.indexOf(term);
      if (index >= 0) break;
    }
  }
  if (index < 0) return compact.slice(0, 220);
  const start = Math.max(0, index - 80);
  const end = Math.min(compact.length, index + 180);
  return `${start > 0 ? "... " : ""}${compact.slice(start, end)}${end < compact.length ? " ..." : ""}`;
}

function normalizeLexicalScore(rawScore: number, maxRawScore: number): number {
  if (maxRawScore <= 0) return 0;
  return clamp01(0.2 + 0.8 * (rawScore / maxRawScore));
}

function hasPhraseMatch(item: KnowledgeItem, chunk: KnowledgeChunk, query: string): boolean {
  const phrase = query.trim().toLowerCase();
  if (phrase.length < 2) return false;
  return [item.title, item.tags.join(" "), item.fileName ?? "", chunk.heading ?? "", chunk.content]
    .some((value) => value.toLowerCase().includes(phrase));
}

function formatRankReason(fields: KnowledgeSearchField[], score: number, coverageRatio: number): string {
  const fieldTextValue = fields.length > 0 ? fields.join(", ") : "content";
  return `Matched ${fieldTextValue}; lexical score ${score.toFixed(2)}; query coverage ${Math.round(coverageRatio * 100)}%.`;
}

function compareLocalCandidates(left: RankedKnowledgeResult, right: RankedKnowledgeResult): number {
  return right.score - left.score || Number(right.titleTagMatch) - Number(left.titleTagMatch) || right.item.updatedAt.localeCompare(left.item.updatedAt);
}

function applyLocalRerank(candidates: RankedKnowledgeResult[]): RankedKnowledgeResult[] {
  return candidates
    .map((candidate) => {
      const rerankScore = clamp01(
        candidate.score * 0.68 +
        candidate.coverageRatio * 0.14 +
        (candidate.titleTagMatch ? 0.1 : 0) +
        (candidate.phraseMatch ? 0.06 : 0) +
        recencyScore(candidate.item.updatedAt) * 0.02
      );
      return {
        ...candidate,
        rerankScore,
        rerankStatus: "applied" as const,
        rankReason: `${candidate.rankReason} Local structured rerank ${rerankScore.toFixed(2)}.`
      };
    })
    .sort((left, right) => (right.rerankScore ?? 0) - (left.rerankScore ?? 0) || compareLocalCandidates(left, right));
}

function recencyScore(updatedAt: string): number {
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return 0;
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86_400_000);
  return 1 / (1 + ageDays / 30);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(6))));
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
