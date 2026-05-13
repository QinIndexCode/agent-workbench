import type {
  DiscordInteractionRequest,
  FeishuEventRequest,
  IntegrationKind,
  IntegrationProviderConfig,
  SlackEventRequest,
  TelegramUpdateRequest,
  WecomCallbackRequest
} from "@scc/shared";
import { createDecipheriv, createHash, createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";

export type IntegrationSetupSnapshot = {
  kind: IntegrationKind;
  callbackUrl?: string | undefined;
  publicKey?: string | undefined;
  verificationTokenConfigured?: boolean | undefined;
  signingSecretConfigured?: boolean | undefined;
  secretTokenConfigured?: boolean | undefined;
  wecomTokenConfigured?: boolean | undefined;
  wecomEncodingAesKeyConfigured?: boolean | undefined;
  botTokenConfigured?: boolean | undefined;
};

export type IntegrationSecretName =
  | "botToken"
  | "appSecret"
  | "verificationToken"
  | "encryptKey"
  | "signingSecret"
  | "secretToken"
  | "wecomToken"
  | "wecomEncodingAesKey";

type IntegrationProviderDefinition = {
  kind: IntegrationKind;
  label: string;
  requiredSecrets: IntegrationSecretName[];
  requiredFields: Array<keyof IntegrationSetupSnapshot>;
  docSection: string;
};

export const integrationProviderRegistry: Record<IntegrationKind, IntegrationProviderDefinition> = {
  discord: {
    kind: "discord",
    label: "Discord",
    requiredSecrets: [],
    requiredFields: ["callbackUrl", "publicKey"],
    docSection: "integrations"
  },
  feishu: {
    kind: "feishu",
    label: "Feishu / Lark",
    requiredSecrets: ["verificationToken"],
    requiredFields: ["callbackUrl", "verificationTokenConfigured"],
    docSection: "integrations"
  },
  slack: {
    kind: "slack",
    label: "Slack",
    requiredSecrets: ["signingSecret"],
    requiredFields: ["callbackUrl", "signingSecretConfigured"],
    docSection: "integrations"
  },
  telegram: {
    kind: "telegram",
    label: "Telegram",
    requiredSecrets: ["botToken", "secretToken"],
    requiredFields: ["callbackUrl", "botTokenConfigured", "secretTokenConfigured"],
    docSection: "integrations"
  },
  wecom: {
    kind: "wecom",
    label: "WeCom",
    requiredSecrets: ["wecomToken", "wecomEncodingAesKey"],
    requiredFields: ["callbackUrl", "wecomTokenConfigured", "wecomEncodingAesKeyConfigured"],
    docSection: "integrations"
  }
};

export function initialIntegrationStatus(input: IntegrationSetupSnapshot): IntegrationProviderConfig["status"] {
  const definition = integrationProviderRegistry[input.kind];
  if (!definition) return "setup_pending";
  for (const field of definition.requiredFields) {
    const value = input[field];
    if (typeof value === "string") {
      if (!value.trim()) return "setup_pending";
      continue;
    }
    if (!value) return "setup_pending";
  }
  return "connected";
}

export function parseDiscordInteractionText(input: DiscordInteractionRequest): string {
  const values = flattenDiscordInteractionOptionValues(input.data?.options ?? []);
  if (values.length > 0) return values.join("\n").trim();
  const command = String(input.data?.name ?? "").trim();
  return command ? `/${command}` : "";
}

export function extractDiscordUserId(input: DiscordInteractionRequest): string | undefined {
  const member = recordFromUnknown(input.member);
  const memberUser = recordFromUnknown(member["user"]);
  return String(memberUser["id"] ?? input.user?.id ?? "").trim() || undefined;
}

export function verifyDiscordRequestSignature(publicKey: string | undefined, signature: string, timestamp: string, rawBody: string): void {
  const normalizedKey = publicKey?.trim();
  if (!normalizedKey) throw new Error("Discord integration is missing a public key.");
  if (!signature || !timestamp) throw new Error("Missing Discord signature headers.");
  if (!/^[0-9a-f]{64}$/i.test(normalizedKey)) throw new Error("Discord integration public key must be a 32-byte hex string.");
  if (!/^[0-9a-f]+$/i.test(signature) || signature.length % 2 !== 0) throw new Error("Invalid Discord request signature.");
  try {
    const publicKeyBytes = Buffer.from(normalizedKey, "hex");
    const signatureBytes = Buffer.from(signature, "hex");
    const keyObject = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKeyBytes]),
      format: "der",
      type: "spki"
    });
    const verified = verify(null, Buffer.from(`${timestamp}${rawBody}`, "utf8"), keyObject, signatureBytes);
    if (!verified) throw new Error("Invalid Discord request signature.");
  } catch (error) {
    if (error instanceof Error && /invalid discord request signature/i.test(error.message)) throw error;
    throw new Error("Invalid Discord request signature.");
  }
}

export function ensureFeishuVerificationToken(input: FeishuEventRequest, expected: string | undefined): void {
  if (!expected) throw new Error("Feishu integration is missing a verification token.");
  const candidate = String(input.header?.token ?? input.token ?? "").trim();
  if (!candidate) throw new Error("Missing Feishu verification token.");
  ensureMatchingSecret(candidate, expected, "Invalid Feishu verification token.");
}

export function parseFeishuMessageText(content: string | undefined): string {
  if (!content) return "";
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const text = parsed["text"] ?? parsed["content"];
    return typeof text === "string" ? text.trim() : content.trim();
  } catch {
    return content.trim();
  }
}

export function extractFeishuSenderId(input: FeishuEventRequest): string | undefined {
  const sender = recordFromUnknown(input.event?.sender);
  const senderId = recordFromUnknown(sender["sender_id"]);
  return String(senderId["open_id"] ?? senderId["user_id"] ?? senderId["union_id"] ?? "").trim() || undefined;
}

export function verifySlackRequestSignature(signingSecret: string | undefined, signature: string, timestamp: string, rawBody: string): void {
  const secret = signingSecret?.trim();
  if (!secret) throw new Error("Slack integration is missing a signing secret.");
  if (!signature || !timestamp) throw new Error("Missing Slack signature headers.");
  const timestampMs = parseSlackTimestampMs(timestamp);
  if (!Number.isFinite(timestampMs)) throw new Error("Invalid Slack request timestamp.");
  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) {
    throw new Error("Slack request timestamp is outside the allowed replay window.");
  }
  const base = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${createHmacSha256(secret, base)}`;
  ensureMatchingSecret(signature, expected, "Invalid Slack request signature.");
}

export function parseSlackEventText(input: SlackEventRequest): string {
  const text = String(input.event?.text ?? "").trim();
  return text;
}

export function extractSlackUserId(input: SlackEventRequest): string | undefined {
  return String(input.event?.user ?? "").trim() || undefined;
}

export function verifyTelegramSecretToken(expected: string | undefined, provided: string): void {
  const secret = expected?.trim();
  if (!secret) throw new Error("Telegram integration is missing a secret token.");
  if (!provided.trim()) throw new Error("Missing Telegram secret token.");
  ensureMatchingSecret(provided.trim(), secret, "Invalid Telegram secret token.");
}

export function parseTelegramMessageText(input: TelegramUpdateRequest): string {
  const message = recordFromUnknown(input.message);
  return String(message["text"] ?? "").trim();
}

export function extractTelegramUserId(input: TelegramUpdateRequest): string | undefined {
  const from = recordFromUnknown(recordFromUnknown(input.message)["from"]);
  return String(from["id"] ?? "").trim() || undefined;
}

export function parseWecomCallbackXml(xml: string): WecomCallbackRequest {
  const normalized = xml.replace(/<!\[CDATA\[(.*?)]]>/gs, "$1");
  const get = (tag: string): string | undefined => {
    const match = normalized.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
    const value = match?.[1]?.trim();
    return value ? value : undefined;
  };
  return {
    toUserName: get("ToUserName"),
    fromUserName: get("FromUserName"),
    createTime: get("CreateTime"),
    msgType: get("MsgType"),
    content: get("Content"),
    msgId: get("MsgId"),
    agentID: get("AgentID"),
    encrypt: get("Encrypt")
  };
}

export function verifyWecomSignature(token: string | undefined, signature: string, timestamp: string, nonce: string, encryptedValue: string): void {
  const normalizedToken = token?.trim();
  if (!normalizedToken) throw new Error("WeCom integration is missing a callback token.");
  if (!signature || !timestamp || !nonce) throw new Error("Missing WeCom callback signature parameters.");
  const expected = createSha1Signature([normalizedToken, timestamp, nonce, encryptedValue]);
  ensureMatchingSecret(signature, expected, "Invalid WeCom callback signature.");
}

export function decryptWecomPayload(encodingAesKey: string | undefined, encryptedValue: string): string {
  const normalized = encodingAesKey?.trim();
  if (!normalized) throw new Error("WeCom integration is missing an EncodingAESKey.");
  const aesKey = Buffer.from(`${normalized}=`, "base64");
  if (aesKey.length !== 32) throw new Error("WeCom EncodingAESKey must decode to 32 bytes.");
  const decipher = createDecipheriv("aes-256-cbc", aesKey, aesKey.subarray(0, 16));
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64")), decipher.final()]);
  const content = pkcs7Unpad(decrypted);
  const xmlLength = content.readUInt32BE(16);
  return content.subarray(20, 20 + xmlLength).toString("utf8");
}

export function parseWecomMessageText(input: WecomCallbackRequest): string {
  return String(input.content ?? "").trim();
}

export function extractWecomSenderId(input: WecomCallbackRequest): string | undefined {
  return String(input.fromUserName ?? "").trim() || undefined;
}

export function describeIntegrationSource(skillOrPattern: { sourcePatternId?: string | undefined; sourceMemoryIds?: string[] | undefined }): string {
  if (skillOrPattern.sourcePatternId) return "reflection_pattern";
  if (Array.isArray(skillOrPattern.sourceMemoryIds) && skillOrPattern.sourceMemoryIds.length > 0) return "task_memory";
  return "manual";
}

export function looksReadOnlySkillBody(body: string, requiredTools: string[]): boolean {
  if (/read-only|keep it read-only|只读/i.test(body)) return true;
  return requiredTools.every((tool) => !/(write|edit|delete|remove|rollback|patch|shell)/i.test(tool));
}

function flattenDiscordInteractionOptionValues(options: Array<Record<string, unknown>>): string[] {
  const values: string[] = [];
  for (const option of options) {
    const value = option["value"];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    else if (typeof value === "number" || typeof value === "boolean") values.push(String(value));
    const nested = Array.isArray(option["options"])
      ? flattenDiscordInteractionOptionValues(option["options"].map((item) => recordFromUnknown(item)).filter((item) => Object.keys(item).length > 0))
      : [];
    values.push(...nested);
  }
  return values;
}

function ensureMatchingSecret(candidate: string, expected: string, errorMessage: string): void {
  const candidateBytes = Buffer.from(candidate, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (candidateBytes.length !== expectedBytes.length || !timingSafeEqual(candidateBytes, expectedBytes)) {
    throw new Error(errorMessage);
  }
}

function createHmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function parseSlackTimestampMs(value: string): number {
  const trimmed = value.trim();
  if (!/^\d{10,13}$/.test(trimmed)) return Number.NaN;
  const numeric = Number(trimmed);
  return trimmed.length >= 13 ? numeric : numeric * 1000;
}

function createSha1Signature(values: string[]): string {
  return createHash("sha1").update([...values].sort().join("")).digest("hex");
}

function pkcs7Unpad(buffer: Buffer): Buffer {
  if (buffer.length === 0) throw new Error("WeCom callback payload is empty.");
  const padding = buffer[buffer.length - 1] ?? 0;
  if (padding <= 0 || padding > 32) throw new Error("Invalid WeCom callback padding.");
  return buffer.subarray(0, buffer.length - padding);
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
