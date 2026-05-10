import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { UserPreferencesSchema } from "@scc/shared";
import type {
  KnowledgeModelAssetKind,
  KnowledgeModelAssetStatus,
  KnowledgeModelDownloadRequest,
  KnowledgeModelDownloadResult,
  KnowledgeModelPreset,
  KnowledgeModelStatus,
  PreferencesPatch,
  UserPreferences
} from "@scc/shared";
import { nowIso } from "./ids.js";
import type { WorkbenchStore } from "./store.js";
import { findWorkspaceRoot } from "./workspace-root.js";

const maxModelAssetBytes = 120 * 1024 * 1024;

export const knowledgeModelPresets: KnowledgeModelPreset[] = [
  {
    id: "custom_fasttext_vectors",
    kind: "fasttext_vectors",
    label: "Custom fastText .vec/.txt vectors",
    description: "Download a compact fastText text-vector file. The file is loaded locally and used as a semantic recall signal.",
    fileName: "fasttext-vectors.vec",
    sizeHint: "5MB+ depending on the selected vector pack"
  },
  {
    id: "custom_tiny_reranker_model",
    kind: "tiny_reranker_model",
    label: "Custom TinyBERT/MobileBERT ONNX model",
    description: "Download an INT4/quantized cross-encoder ONNX reranker model. Requires a matching WordPiece vocab file.",
    fileName: "tiny-reranker.onnx",
    sizeHint: "20MB+ depending on quantization"
  },
  {
    id: "custom_tiny_reranker_vocab",
    kind: "tiny_reranker_vocab",
    label: "Custom TinyBERT/MobileBERT vocab.txt",
    description: "Download the WordPiece vocab.txt that matches the configured reranker model.",
    fileName: "tiny-reranker-vocab.txt",
    sizeHint: "Small text file"
  }
];

export async function getKnowledgeModelStatus(store: WorkbenchStore): Promise<KnowledgeModelStatus> {
  const preferences = await store.getPreferences();
  return {
    assets: buildKnowledgeModelAssetStatuses(preferences),
    presets: knowledgeModelPresets,
    tinyRerankerEnabled: preferences.knowledgeTinyRerankerEnabled
  };
}

export async function downloadKnowledgeModelAsset(
  store: WorkbenchStore,
  request: KnowledgeModelDownloadRequest
): Promise<KnowledgeModelDownloadResult> {
  const target = modelAssetPath(request.kind, request.fileName || defaultFileName(request.kind, request.url));
  await downloadToFile(request.url, target);
  const preferences = await store.getPreferences();
  const patch = preferencePatchForAsset(request.kind, target, preferences);
  const next = UserPreferencesSchema.parse({ ...preferences, ...patch, updatedAt: nowIso() });
  await store.savePreferences(next);
  const asset = buildKnowledgeModelAssetStatuses(next).find((item) => item.kind === request.kind)!;
  return { asset, preferences: next };
}

export function buildKnowledgeModelAssetStatuses(preferences: UserPreferences): KnowledgeModelAssetStatus[] {
  return [
    assetStatus("fasttext_vectors", "fastText vectors", preferences.knowledgeFastTextVectorPath),
    assetStatus("tiny_reranker_model", "Tiny reranker ONNX", preferences.knowledgeTinyRerankerModelPath),
    assetStatus("tiny_reranker_vocab", "Tiny reranker vocab", preferences.knowledgeTinyRerankerVocabPath)
  ];
}

function preferencePatchForAsset(kind: KnowledgeModelAssetKind, path: string, preferences: UserPreferences): PreferencesPatch {
  if (kind === "fasttext_vectors") return { knowledgeFastTextVectorPath: path };
  if (kind === "tiny_reranker_model") {
    return {
      knowledgeTinyRerankerModelPath: path,
      knowledgeTinyRerankerEnabled: Boolean(preferences.knowledgeTinyRerankerVocabPath)
    };
  }
  return {
    knowledgeTinyRerankerVocabPath: path,
    knowledgeTinyRerankerEnabled: Boolean(preferences.knowledgeTinyRerankerModelPath)
  };
}

function assetStatus(kind: KnowledgeModelAssetKind, label: string, path: string | undefined): KnowledgeModelAssetStatus {
  const exists = Boolean(path && existsSync(path));
  const stat = exists && path ? statSync(path) : undefined;
  return {
    kind,
    label,
    ...(path ? { path } : {}),
    exists,
    configured: Boolean(path),
    ...(stat ? { size: stat.size, updatedAt: stat.mtime.toISOString() } : {})
  };
}

function modelAssetPath(kind: KnowledgeModelAssetKind, fileName: string): string {
  const safeName = sanitizeFileName(fileName);
  const folder = resolve(findWorkspaceRoot(), "data", "models", "knowledge", kind);
  mkdirSync(folder, { recursive: true });
  return join(folder, safeName);
}

function defaultFileName(kind: KnowledgeModelAssetKind, url: string): string {
  const parsed = new URL(url);
  const fromUrl = parsed.pathname.split("/").filter(Boolean).at(-1);
  if (fromUrl) return fromUrl;
  if (kind === "fasttext_vectors") return "fasttext-vectors.vec";
  if (kind === "tiny_reranker_model") return "tiny-reranker.onnx";
  return "tiny-reranker-vocab.txt";
}

function sanitizeFileName(fileName: string): string {
  const extension = extname(fileName);
  const base = fileName.slice(0, fileName.length - extension.length).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  const safeBase = base || "model";
  return `${safeBase}${extension.replace(/[^a-zA-Z0-9.]/g, "")}`;
}

async function downloadToFile(url: string, target: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Only http and https model downloads are supported.");
  }
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed with HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > maxModelAssetBytes) {
    throw new Error(`Model asset exceeds the ${Math.round(maxModelAssetBytes / 1024 / 1024)}MB download limit.`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const stream = Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>);
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxModelAssetBytes) stream.destroy(new Error(`Model asset exceeds the ${Math.round(maxModelAssetBytes / 1024 / 1024)}MB download limit.`));
  });
  await pipeline(stream, createWriteStream(target));
}
