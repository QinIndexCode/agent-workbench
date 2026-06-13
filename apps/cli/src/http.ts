export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private sessionTokenPromise: Promise<string> | null = null;

  constructor(options: ApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(path: string, init: RequestInit = {}, options: { auth?: boolean } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (options.auth !== false) headers.set("x-agent-workbench-session", await this.getSessionToken());
    const response = await this.fetchWithTimeout(path, { ...init, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ApiError(response.status, friendlyErrorMessage(response.status, body));
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  async health(): Promise<{ ok: boolean }> {
    return this.request<{ ok: boolean }>("/health", {}, { auth: false });
  }

  private async getSessionToken(): Promise<string> {
    if (!this.sessionTokenPromise) {
      this.sessionTokenPromise = this.request<{ sessionToken?: string }>("/api/session/bootstrap", {}, { auth: false }).then((payload) => {
        if (!payload.sessionToken) throw new ApiError(401, "Server did not return a local session token.");
        return payload.sessionToken;
      });
    }
    return this.sessionTokenPromise;
  }

  private async fetchWithTimeout(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new ApiError(408, "Backend request timed out. Check the local server and retry.");
      }
      throw new ApiError(0, `Cannot connect to Agent Workbench server at ${this.baseUrl}. Start it with: aw serve`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function friendlyErrorMessage(status: number, bodyText: string): string {
  const backend = parseBackendError(bodyText);
  if (status === 401) return "Missing or invalid local session. Check that the server is running, then retry.";
  if (backend) return backend;
  if (status === 403) return "Request was rejected by the local server.";
  if (status === 404) return "Requested resource was not found.";
  if (status === 429) return "Request was rate limited. Retry later.";
  if (status >= 500) return `Server error (${status}).`;
  return `Request failed (${status}).`;
}

function parseBackendError(bodyText: string): string | null {
  if (!bodyText) return null;
  try {
    const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown; requestId?: unknown };
    const message = typeof parsed.error === "string" ? parsed.error : typeof parsed.message === "string" ? parsed.message : "";
    const requestId = typeof parsed.requestId === "string" ? ` requestId=${parsed.requestId}` : "";
    return message ? `${message}${requestId}` : null;
  } catch {
    return bodyText.length < 300 ? bodyText.trim() || null : null;
  }
}
