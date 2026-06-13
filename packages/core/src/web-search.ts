import type { ToolCall, ToolResult, WebSearchProviderConfig, WebSearchResult } from "@agent-workbench/shared";
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
    await options.onProgress?.({ status: "running", operation: "web_search", message: `Searching web for "${query}".`, progress: { processed: 0, total: limit, unit: "items" } });
    const provider = (await this.store.listWebSearchProviders()).find((item) => item.enabled);
    if (!provider) {
      try {
        const results = await searchWithBuiltinDuckDuckGo(query, limit, options.signal);
        await options.onProgress?.({ status: "running", operation: "web_search", message: `Received ${results.length} result(s).`, progress: { processed: results.length, total: limit, unit: "items" } });
        return result(
          call,
          true,
          JSON.stringify(
            {
              query,
              providerId: "builtin_duckduckgo",
              provider: "Built-in DuckDuckGo",
              note: "No configured search provider was found; Agent Workbench used its built-in no-key fallback.",
              results
            },
            null,
            2
          )
        );
      } catch (error) {
        return result(call, false, `Built-in web search failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const secret = provider.apiKeyRef ? await this.store.getWebSearchProviderSecret(provider.id) : undefined;
    const apiKey = secret ? this.secretBox.decrypt(secret) : "";
    try {
      const results = await searchWithProvider(provider, query, limit, apiKey, options.signal);
      await options.onProgress?.({ status: "running", operation: "web_search", message: `Received ${results.length} result(s).`, progress: { processed: results.length, total: limit, unit: "items" } });
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

async function searchWithBuiltinDuckDuckGo(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const provider: WebSearchProviderConfig = {
    id: "builtin_duckduckgo",
    label: "Built-in DuckDuckGo",
    kind: "duckduckgo",
    enabled: true,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  return searchWithProvider(provider, query, limit, "", signal);
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
    if (related.length > 0) return related.slice(0, limit).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.snippet,
      source: "duckduckgo"
    }));
    return searchDuckDuckGoHtml(query, limit, signal);
  }

  const endpoint = provider.endpoint?.trim();
  if (!endpoint) throw new Error("Custom web search provider requires an endpoint.");
  if (endpoint.includes("{apiKey}") && !apiKey) throw new Error("Custom web search endpoint requires an API key.");
  const url = endpoint.includes("{query}")
    ? endpoint
        .replaceAll("{query}", encodeURIComponent(query))
        .replaceAll("{limit}", String(limit))
        .replaceAll("{apiKey}", encodeURIComponent(apiKey))
    : appendSearchParams(endpoint, query, limit);
  const payload = await fetchJson(url, requestInit(signal, apiKey ? { authorization: `Bearer ${apiKey}` } : undefined));
  const items = (Array.isArray(payload) ? payload.filter(isRecord) : readArray(payload, ["results"]));
  return items.slice(0, limit).map((item) => ({
    title: stringOf(item["title"] ?? item["name"]),
    url: stringOf(item["url"] ?? item["link"]),
    snippet: stringOf(item["snippet"] ?? item["description"] ?? item["summary"]),
    source: "custom"
  }));
}

function appendSearchParams(endpoint: string, query: string, limit: number): string {
  const url = new URL(endpoint);
  if (!url.searchParams.has("q") && !url.searchParams.has("query")) url.searchParams.set("q", query);
  if (!url.searchParams.has("limit") && !url.searchParams.has("count") && !url.searchParams.has("num")) url.searchParams.set("limit", String(limit));
  return url.toString();
}

async function searchDuckDuckGoHtml(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(url, requestInit(signal, { accept: "text/html" }));
  if (!response.ok) throw new Error(`DuckDuckGo HTML search failed: ${response.status} ${await response.text()}`);
  const html = await response.text();
  const results: WebSearchResult[] = [];
  const resultRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(resultRegex)) {
    const rawUrl = decodeHtml(match[1] ?? "");
    const title = decodeHtml(stripHtml(match[2] ?? ""));
    const snippet = decodeHtml(stripHtml(match[3] ?? ""));
    const cleanedUrl = cleanDuckDuckGoRedirect(rawUrl);
    if (!title || !cleanedUrl) continue;
    results.push({ title, url: cleanedUrl, snippet, source: "duckduckgo" });
    if (results.length >= limit) break;
  }
  return results;
}

function cleanDuckDuckGoRedirect(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return url.href;
  } catch {
    return value;
  }
}

function stripHtml(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
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
