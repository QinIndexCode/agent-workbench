import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { nowIso } from "./ids.js";
import type { EncryptedSecretValue } from "./store.js";

export class LocalSecretBox {
  private readonly key: Buffer;

  constructor(keyFilePath = process.env["SCC_LOCAL_SECRET_FILE"] ?? "data/local-secret.key") {
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
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(secret.iv, "base64"));
    decipher.setAuthTag(Buffer.from(secret.authTag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(secret.value, "base64")), decipher.final()]).toString("utf8");
  }
}

function loadOrCreateKey(filePath: string): Buffer {
  const resolved = resolve(filePath);
  if (existsSync(resolved)) {
    const stored = readFileSync(resolved, "utf8").trim();
    const key = Buffer.from(stored, "base64");
    if (key.length === 32) return key;
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
