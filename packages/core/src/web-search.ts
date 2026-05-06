import type { ToolCall, ToolResult, WebSearchProviderConfig, WebSearchResult } from "@scc/shared";
import { createId, nowIso } from "./ids.js";
import type { EncryptedSecretValue, WorkbenchStore } from "./store.js";
import { LocalSecretBox } from "./secrets.js";
import type { ToolExecutionOptions, ToolExecutorDelegate } from "./tools.js";

export class WebSearchToolExecutor implements ToolExecutorDelegate {
  private readonly secretBox = new LocalSecretBox();

  constructor(private readonly store: WorkbenchStore) {}

  canExecute(toolName: string): boolean {
    return toolName === "web_search";
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    if (options.signal?.aborted) return result(call, false, "Web search cancelled before it started.");
    const query = String(call.args["query"] ?? "").trim();
    if (!query) return result(call, false, "Missing web search query.");
    const limit = clamp(Number(call.args["limit"] ?? 5), 1, 10);
    const provider = (await this.store.listWebSearchProviders()).find((item) => item.enabled);
    if (!provider) {
      return result(call, false, "No web search provider is configured. Add a provider in Settings before using web_search.");
    }
    const secret = provider.apiKeyRef ? await this.store.getWebSearchProviderSecret(provider.id) : undefined;
    const apiKey = secret ? this.secretBox.decrypt(secret) : "";
    try {
      const results = await searchWithProvider(provider, query, limit, apiKey, options.signal);
      return result(
        call,
        true,
        JSON.stringify(
          {
            query,
            providerId: provider.id,
            provider: provider.label,
            results
          },
          null,
          2
        )
      );
    } catch (error) {
      return result(call, false, error instanceof Error ? error.message : String(error));
    }
  }
}

export function createWebSearchApiKeyRef(providerId: string, apiKey: string, encrypted: EncryptedSecretValue) {
  return {
    secretId: providerId,
    last4: apiKey.slice(-4),
    updatedAt: encrypted.updatedAt
  };
}

async function searchWithProvider(
  provider: WebSearchProviderConfig,
  query: string,
  limit: number,
  apiKey: string,
  signal?: AbortSignal
): Promise<WebSearchResult[]> {
  if (provider.kind === "brave") {
    if (!apiKey) throw new Error("Brave search requires an API key.");
    const url = `${provider.endpoint || "https://api.search.brave.com/res/v1/web/search"}?q=${encodeURIComponent(query)}&count=${limit}`;
    const payload = await fetchJson(url, requestInit(signal, { "x-subscription-token": apiKey, accept: "application/json" }));
    const items = readArray(payload, ["web", "results"]);
    return items.slice(0, limit).map((item) => ({
      title: stringOf(item["title"]),
      url: stringOf(item["url"]),
      snippet: stringOf(item["description"]),
      source: "brave"
    }));
  }

  if (provider.kind === "serpapi") {
    if (!apiKey) throw new Error("SerpAPI search requires an API key.");
    const url = `${provider.endpoint || "https://serpapi.com/search.json"}?engine=google&q=${encodeURIComponent(query)}&api_key=${encodeURIComponent(apiKey)}&num=${limit}`;
    const payload = await fetchJson(url, requestInit(signal));
    const items = readArray(payload, ["organic_results"]);
    return items.slice(0, limit).map((item) => ({
      title: stringOf(item["title"]),
      url: stringOf(item["link"]),
      snippet: stringOf(item["snippet"]),
      source: "serpapi"
    }));
  }

  if (provider.kind === "duckduckgo") {
    const endpoint = provider.endpoint || "https://api.duckduckgo.com/";
    const url = `${endpoint}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`;
    const payload = await fetchJson(url, requestInit(signal));
    const related = readArray(payload, ["RelatedTopics"]).flatMap(flattenDuckDuckGoTopic);
    return related.slice(0, limit).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      source: "duckduckgo"
    }));
  }

  const endpoint = provider.endpoint?.trim();
  if (!endpoint) throw new Error("Custom web search provider requires an endpoint.");
  const url = endpoint.replaceAll("{query}", encodeURIComponent(query)).replaceAll("{limit}", String(limit));
  const payload = await fetchJson(url, requestInit(signal, apiKey ? { authorization: `Bearer ${apiKey}` } : undefined));
  const items = (Array.isArray(payload) ? payload.filter(isRecord) : readArray(payload, ["results"]));
  return items.slice(0, limit).map((item) => ({
    title: stringOf(item["title"] ?? item["name"]),
    url: stringOf(item["url"] ?? item["link"]),
    snippet: stringOf(item["snippet"] ?? item["description"] ?? item["summary"]),
    source: "custom"
  }));
}

function requestInit(signal?: AbortSignal, headers?: HeadersInit): RequestInit {
  return {
    ...(signal ? { signal } : {}),
    ...(headers ? { headers } : {})
  };
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown> | unknown[]> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`Search provider failed: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown> | unknown[];
}

function readArray(payload: unknown, path: string[]): Record<string, unknown>[] {
  let value: unknown = payload;
  for (const key of path) value = isRecord(value) ? value[key] : undefined;
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function flattenDuckDuckGoTopic(item: Record<string, unknown>): Array<{ title: string; url: string; snippet: string }> {
  if (Array.isArray(item["Topics"])) return item["Topics"].filter(isRecord).flatMap(flattenDuckDuckGoTopic);
  const text = stringOf(item["Text"]);
  const url = stringOf(item["FirstURL"]);
  if (!text || !url) return [];
  const [title, ...rest] = text.split(" - ");
  return [{ title: title || text.slice(0, 80), url, snippet: rest.join(" - ") || text }];
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
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
