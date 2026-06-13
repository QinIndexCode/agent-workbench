import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { nowIso } from "./ids.js";
import type { EncryptedSecretValue } from "./store.js";

export class LocalSecretBox {
  private readonly key: Buffer;

  constructor(keyFilePath = process.env["AGENT_WORKBENCH_LOCAL_SECRET_FILE"] ?? process.env["SCC_LOCAL_SECRET_FILE"] ?? "data/local-secret.key") {
    this.key = loadOrCreateKey(keyFilePath);
  }

  encrypt(value: string): EncryptedSecretValue {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return {
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      value: encrypted.toString("base64"),
      updatedAt: nowIso()
    };
  }

  decrypt(secret: EncryptedSecretValue): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(secret.iv, "base64"));
      decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(secret.value, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Unable to decrypt local encrypted data. The local secret key file may be missing, changed, or corrupted.");
    }
  }
}

function loadOrCreateKey(filePath: string): Buffer {
  const resolved = resolve(filePath);
  if (existsSync(resolved)) {
    const stored = readFileSync(resolved, "utf8").trim();
    const key = Buffer.from(stored, "base64");
    if (key.length === 32) return key;
    throw new Error(`Invalid local secret key file at ${resolved}. Expected a base64-encoded 32-byte key.`);
  }
  mkdirSync(dirname(resolved), { recursive: true });
  const created = randomBytes(32);
  writeFileSync(resolved, created.toString("base64"), { encoding: "utf8", mode: 0o600 });
  return created;
}

export function maskSecret(value: string): { last4: string } {
  const trimmed = value.trim();
  return { last4: trimmed.slice(-4) };
}

export function sanitizeSensitiveText(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/\btp-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted-token]")
    .replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]\s*([^\s"'`,;]+)/gi, "$1=[redacted-secret]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)["']?\s*:\s*["'])([^"']{4,})(["'])/gi, "$1[redacted-secret]$3");
}

export function sanitizeSensitiveValue<T>(value: T): T {
  return sanitizeValue(value, 0) as T;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return sanitizeSensitiveText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return "[redacted-deep-value]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? "[redacted-secret]" : sanitizeValue(entry, depth + 1);
  }
  return output;
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization/i.test(key);
}
