import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  McpServerConfig,
  McpServerCreateRequest,
  McpServerPatchRequest,
  McpServerStatus,
  McpToolSummary,
  RiskCategory,
  ToolCall,
  ToolResult
} from "@scc/shared";
import type { ModelToolDefinition, ModelToolProvider } from "./openai-model.js";
import { createId, nowIso } from "./ids.js";
import type { RiskAssessment } from "./permission-engine.js";
import type { WorkbenchStore } from "./store.js";
import type { ToolExecutionOptions, ToolExecutorDelegate } from "./tools.js";

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface McpConnection {
  client: McpClient;
  transport: McpTransport;
  config: McpServerConfig;
  tools: McpToolSummary[];
}

export class McpRegistry implements ModelToolProvider, ToolExecutorDelegate {
  private readonly connections = new Map<string, McpConnection>();
  private readonly statuses = new Map<string, McpServerStatus>();

  constructor(private readonly store: WorkbenchStore) {}

  async listServers(): Promise<Array<McpServerConfig & { status: McpServerStatus }>> {
    const servers = await this.store.listMcpServers();
    return servers.map((server) => ({ ...server, status: this.statusFor(server.id) }));
  }

  async createServer(input: McpServerCreateRequest): Promise<McpServerConfig> {
    const now = nowIso();
    const server: McpServerConfig = {
      id: input.id ? sanitizeIdentifier(input.id) : createId("mcp_server"),
      label: input.label ?? input.command ?? input.url ?? "MCP server",
      transport: input.transport,
      args: input.args,
      env: input.env,
      enabled: input.enabled,
      toolRiskOverrides: input.toolRiskOverrides,
      createdAt: now,
      updatedAt: now,
      ...(input.command ? { command: input.command } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.url ? { url: input.url } : {})
    };
    await this.store.saveMcpServer(server);
    this.setStatus(server.id, { serverId: server.id, connected: false, state: "disconnected", toolCount: 0 });
    return server;
  }

  async patchServer(serverId: string, patch: McpServerPatchRequest): Promise<McpServerConfig> {
    const current = await this.requiredServer(serverId);
    const command = patch.command ?? current.command;
    const cwd = patch.cwd ?? current.cwd;
    const url = patch.url ?? current.url;
    const next: McpServerConfig = {
      id: current.id,
      label: patch.label ?? current.label,
      transport: patch.transport ?? current.transport,
      args: patch.args ?? current.args,
      env: patch.env ?? current.env,
      enabled: patch.enabled ?? current.enabled,
      toolRiskOverrides: patch.toolRiskOverrides ?? current.toolRiskOverrides,
      createdAt: current.createdAt,
      updatedAt: nowIso(),
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(url ? { url } : {})
    };
    if (current.transport !== next.transport || current.command !== next.command || current.url !== next.url) {
      await this.disconnectServer(serverId);
    }
    await this.store.saveMcpServer(next);
    return next;
  }

  async deleteServer(serverId: string): Promise<void> {
    await this.disconnectServer(serverId);
    await this.store.deleteMcpServer(serverId);
    this.statuses.delete(serverId);
  }

  async connectServer(serverId: string): Promise<McpServerStatus> {
    const config = await this.requiredServer(serverId);
    if (!config.enabled) throw new Error(`MCP server is disabled: ${serverId}`);
    await this.disconnectServer(serverId);
    this.setStatus(serverId, { serverId, connected: false, state: "connecting", toolCount: 0 });

    try {
      const client = new Client({ name: "scc-agent-workbench", version: "0.1.0" }, { capabilities: {} });
      const transport = this.createTransport(config);
      transport.onerror = (error) => {
        this.setStatus(serverId, {
          serverId,
          connected: false,
          state: "error",
          lastError: sanitizeError(error),
          toolCount: this.connections.get(serverId)?.tools.length ?? 0
        });
      };
      transport.onclose = () => {
        this.connections.delete(serverId);
        this.setStatus(serverId, { serverId, connected: false, state: "disconnected", toolCount: 0 });
      };

      await client.connect(transport as never);
      const tools = await this.discoverTools(config, client);
      this.connections.set(serverId, { client, transport, config, tools });
      const status: McpServerStatus = {
        serverId,
        connected: true,
        state: "connected",
        connectedAt: nowIso(),
        toolCount: tools.length
      };
      this.setStatus(serverId, status);
      return status;
    } catch (error) {
      const status: McpServerStatus = {
        serverId,
        connected: false,
        state: "error",
        lastError: sanitizeError(error),
        toolCount: 0
      };
      this.setStatus(serverId, status);
      return status;
    }
  }

  async disconnectServer(serverId: string): Promise<McpServerStatus> {
    const connection = this.connections.get(serverId);
    if (connection) {
      this.connections.delete(serverId);
      await connection.transport.close().catch(() => undefined);
      await connection.client.close().catch(() => undefined);
    }
    const status: McpServerStatus = { serverId, connected: false, state: "disconnected", toolCount: 0 };
    this.setStatus(serverId, status);
    return status;
  }

  async listTools(): Promise<McpToolSummary[]> {
    return [...this.connections.values()].flatMap((connection) => connection.tools);
  }

  async listModelTools(): Promise<ModelToolDefinition[]> {
    const tools = await this.listTools();
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.id,
        description: [tool.description ?? `MCP tool ${tool.name}`, `Server: ${tool.serverId}`, `Risk: ${tool.riskCategory}`].join("\n"),
        parameters: toOpenAiParameters(tool.inputSchema)
      }
    }));
  }

  canExecute(toolName: string): boolean {
    return toolName.startsWith("mcp__");
  }

  async assessTool(call: ToolCall): Promise<RiskAssessment | undefined> {
    const tool = await this.resolveTool(call.toolName);
    if (!tool) return undefined;
    return { category: tool.riskCategory, reason: `MCP tool ${tool.serverId}/${tool.name} is classified as ${tool.riskCategory}.` };
  }

  async describeToolCall(call: ToolCall): Promise<Record<string, unknown> | undefined> {
    const tool = await this.resolveTool(call.toolName);
    if (!tool) return undefined;
    return {
      serverId: tool.serverId,
      toolName: tool.name,
      displayName: tool.displayName,
      riskCategory: tool.riskCategory,
      argsPreview: previewArgs(call.args)
    };
  }

  async execute(call: ToolCall, options: ToolExecutionOptions = {}): Promise<ToolResult> {
    const resolved = await this.resolveToolWithConnection(call.toolName);
    if (!resolved) {
      return this.result(call, false, `Unknown MCP tool: ${call.toolName}`);
    }
    if (options.signal?.aborted) {
      return this.result(call, false, "MCP tool call cancelled before it started.");
    }
    try {
      await options.onProgress?.({
        status: "running",
        operation: "mcp_tool",
        message: `Calling MCP tool ${resolved.tool.displayName}.`,
        progress: { processed: 0, unit: "items" }
      });
      const response = await abortable(
        resolved.connection.client.callTool({ name: resolved.tool.name, arguments: call.args }),
        options.signal
      );
      const output = serializeMcpToolResponse(response);
      await options.onProgress?.({
        status: "running",
        operation: "mcp_tool",
        message: `MCP tool ${resolved.tool.displayName} returned.`,
        progress: { processed: 1, total: 1, unit: "items" }
      });
      return this.result(call, !isMcpError(response), output);
    } catch (error) {
      return this.result(call, false, `MCP tool error: ${sanitizeError(error)}`);
    }
  }

  private createTransport(config: McpServerConfig): McpTransport {
    if (config.transport === "streamable_http") {
      if (!config.url) throw new Error("streamable_http MCP server requires url.");
      return new StreamableHTTPClientTransport(new URL(config.url));
    }
    if (!config.command) throw new Error("stdio MCP server requires command.");
    const params: StdioServerParameters = {
      command: config.command,
      args: config.args,
      stderr: "pipe",
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(Object.keys(config.env).length > 0 ? { env: config.env } : {})
    };
    return new StdioClientTransport(params);
  }

  private async discoverTools(config: McpServerConfig, client: McpClient): Promise<McpToolSummary[]> {
    const response = await client.listTools();
    return response.tools.map((tool) => {
      const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : {};
      const riskCategory = config.toolRiskOverrides[tool.name] ?? inferMcpRisk(tool);
      return {
        id: createMcpToolId(config.id, tool.name),
        serverId: config.id,
        name: tool.name,
        displayName: tool.title ?? tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema,
        riskCategory
      };
    });
  }

  private async resolveToolWithConnection(toolId: string): Promise<{ connection: McpConnection; tool: McpToolSummary } | undefined> {
    for (const connection of this.connections.values()) {
      const tool = connection.tools.find((item) => item.id === toolId);
      if (tool) return { connection, tool };
    }
    const serverId = parseServerId(toolId);
    if (!serverId) return undefined;
    await this.connectServer(serverId);
    for (const connection of this.connections.values()) {
      const tool = connection.tools.find((item) => item.id === toolId);
      if (tool) return { connection, tool };
    }
    return undefined;
  }

  private async resolveTool(toolId: string): Promise<McpToolSummary | undefined> {
    const existing = (await this.listTools()).find((tool) => tool.id === toolId);
    if (existing) return existing;
    const serverId = parseServerId(toolId);
    if (!serverId) return undefined;
    await this.connectServer(serverId);
    return (await this.listTools()).find((tool) => tool.id === toolId);
  }

  private statusFor(serverId: string): McpServerStatus {
    return this.statuses.get(serverId) ?? { serverId, connected: false, state: "disconnected", toolCount: 0 };
  }

  private setStatus(serverId: string, status: McpServerStatus): void {
    this.statuses.set(serverId, status);
  }

  private async requiredServer(serverId: string): Promise<McpServerConfig> {
    const server = await this.store.getMcpServer(serverId);
    if (!server) throw new Error(`MCP server not found: ${serverId}`);
    return server;
  }

  private async result(call: ToolCall, ok: boolean, output: string): Promise<ToolResult> {
    const id = createId("tool_result");
    return {
      id,
      toolCallId: call.id,
      ok,
      output: await materializeMcpOutput(id, output),
      createdAt: nowIso()
    };
  }
}

function createMcpToolId(serverId: string, toolName: string): string {
  const safeServer = sanitizeIdentifier(serverId);
  const safeTool = sanitizeIdentifier(toolName);
  const base = `mcp__${safeServer}__${safeTool}`;
  if (base.length <= 64) return base;
  return `mcp__${safeServer.slice(0, 20)}__${safeTool.slice(0, 28)}_${hash(base).slice(0, 8)}`;
}

function parseServerId(toolId: string): string | undefined {
  const match = toolId.match(/^mcp__(?<server>[^_][a-zA-Z0-9_]*?)__/);
  return match?.groups?.["server"];
}

function sanitizeIdentifier(input: string): string {
  const sanitized = input.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  return sanitized || "mcp_server";
}

function inferMcpRisk(tool: { annotations?: Record<string, unknown> | undefined }): RiskCategory {
  if (tool.annotations?.["destructiveHint"] === true) return "destructive";
  if (tool.annotations?.["openWorldHint"] === true) return "network";
  if (tool.annotations?.["readOnlyHint"] === true) return "workspace_read";
  return "shell";
}

function toOpenAiParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (inputSchema["type"] === "object") return inputSchema;
  return { type: "object", additionalProperties: true, properties: {} };
}

function serializeMcpToolResponse(response: unknown): string {
  if (!isRecord(response)) return JSON.stringify(response, null, 2);
  const content = Array.isArray(response["content"]) ? response["content"] : [];
  const chunks = content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (part["type"] === "text") return String(part["text"] ?? "");
      if (part["type"] === "resource" && isRecord(part["resource"])) {
        return String(part["resource"]["text"] ?? JSON.stringify(part["resource"], null, 2));
      }
      return JSON.stringify(part, null, 2);
    })
    .filter(Boolean);
  if (chunks.length > 0) return chunks.join("\n\n");
  return JSON.stringify(response, null, 2);
}

function isMcpError(response: unknown): boolean {
  return isRecord(response) && response["isError"] === true;
}

function sanitizeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\b(sk|ak)-[a-zA-Z0-9_-]{10,}\b/g, "[redacted-key]");
}

function previewArgs(args: Record<string, unknown>): string {
  const raw = JSON.stringify(args, null, 2);
  if (raw.length <= 1600) return raw;
  return `${raw.slice(0, 1600)}\n... args truncated ...`;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("MCP tool call cancelled.");
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("MCP tool call cancelled.")), { once: true });
    })
  ]);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function materializeMcpOutput(resultId: string, output: string): Promise<string> {
  if (output.length <= 12000) return output;
  const rawOutputRef = resolve(process.cwd(), "data", "tool-output", `${resultId}.mcp.txt`);
  await mkdir(dirname(rawOutputRef), { recursive: true });
  await writeFile(rawOutputRef, output, "utf8");
  return JSON.stringify(
    {
      truncated: true,
      totalChars: output.length,
      rawOutputRef,
      summary: `${output.slice(0, 4000)}\n\n... MCP output truncated; raw output is stored on disk ...\n\n${output.slice(-3000)}`
    },
    null,
    2
  );
}
