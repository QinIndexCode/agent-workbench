import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export interface FilePayload {
  fileName: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export interface KnowledgeFilePayload {
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
}

export function readAttachmentPayload(path: string): FilePayload {
  const bytes = readFileSync(path);
  const stat = statSync(path);
  return {
    fileName: basename(path),
    mimeType: inferMimeType(path),
    size: stat.size,
    dataBase64: bytes.toString("base64")
  };
}

export function readKnowledgePayload(path: string): KnowledgeFilePayload {
  const bytes = readFileSync(path);
  const stat = statSync(path);
  return {
    fileName: basename(path),
    mimeType: inferMimeType(path),
    size: stat.size,
    content: bytes.toString("utf8")
  };
}

function inferMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".html":
      return "text/html";
    case ".txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}
