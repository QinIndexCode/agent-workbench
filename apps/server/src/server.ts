import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  AgentWorkbench,
  CompositeToolExecutor,
  ContextAssembler,
  McpRegistry,
  ShellToolExecutor,
  createModelClientFromEnvironment
} from "@scc/core";
import {
  ApprovalRequestSchema,
  ControlRequestSchema,
  CreateTaskRequestSchema,
  GlobalPermissionRequestSchema,
  MessageRequestSchema,
  McpServerCreateRequestSchema,
  McpServerPatchRequestSchema,
  PreferencesPatchSchema,
  ProjectMemoryCreateRequestSchema,
  SkillCorrectionRequestSchema,
  SkillStatusPatchSchema,
  type TaskEvent
} from "@scc/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { createSccMcpServer } from "./scc-mcp-server.js";
import { SqliteWorkbenchStore } from "./sqlite-store.js";

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface AppOptions {
  workbench?: AgentWorkbench;
  mcpRegistry?: McpRegistry;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Invalid request", issues: error.issues });
    }
    const requestId = generateRequestId();
    request.log.error({ err: error, requestId }, "Unhandled server error");
    return reply.code(500).send({
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
      requestId
    });
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const events = new TaskEventBroadcaster();
  const runtime = options.workbench
    ? { workbench: options.workbench, mcpRegistry: options.mcpRegistry }
    : createDefaultRuntime((event) => events.publish(event));
  const workbench = runtime.workbench;
  const mcpRegistry = runtime.mcpRegistry;
  await workbench.recoverInterruptedTasks();

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/tasks", async () => workbench.listTasks());

  app.post("/api/tasks", async (request, reply) => {
    const input = CreateTaskRequestSchema.parse(request.body);
    const task = await workbench.createTask(input.goal, input.title);
    return reply.code(201).send(task);
  });

  app.get("/api/tasks/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? task : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/events", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    return task ? task.events : reply.code(404).send({ error: "Task not found" });
  });

  app.get("/api/tasks/:id/events/ws", { websocket: true }, async (socket, request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const task = await workbench.getTask(id);
    socket.send(JSON.stringify({ type: "snapshot", events: task?.events ?? [] }));
    const unsubscribe = events.subscribe(id, (event) => socket.send(JSON.stringify({ type: "event", event })));
    socket.on("close", unsubscribe);
  });

  app.post("/api/tasks/:id/messages", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = MessageRequestSchema.parse(request.body);
    try {
      return await workbench.appendMessage(id, input.content);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks/:id/control", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = ControlRequestSchema.parse(request.body);
    try {
      return await workbench.control(id, input.action);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/tasks/:id/approvals/:approvalId", async (request, reply) => {
    const { id, approvalId } = z.object({ id: z.string(), approvalId: z.string() }).parse(request.params);
    const input = ApprovalRequestSchema.parse(request.body);
    try {
      return await workbench.decideApproval(id, approvalId, input.decision);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/experiences", async () => workbench.listExperiences());
  app.get("/api/task-memories", async () => workbench.listTaskMemories());
  app.get("/api/patterns", async () => workbench.listPatterns());

  app.post("/api/experiences/:id/promote", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return reply.code(201).send(await workbench.promoteExperience(id));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/skills", async () => workbench.listSkills());
  app.get("/api/skill-conflicts", async () => workbench.listSkillConflicts());

  app.get("/api/skills/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const skill = await workbench.getSkill(id);
    return skill ? skill : reply.code(404).send({ error: "Skill not found" });
  });

  app.patch("/api/skills/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = SkillStatusPatchSchema.parse(request.body);
    try {
      return await workbench.updateSkillStatus(id, input.status);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/skills/:id/corrections", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = SkillCorrectionRequestSchema.parse(request.body);
    try {
      return await workbench.correctSkill(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/skills/:id/export", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return await workbench.exportSkill(id);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/mcp/servers", async () => requireMcp(mcpRegistry).listServers());

  app.post("/api/mcp/servers", async (request, reply) => {
    const input = McpServerCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await requireMcp(mcpRegistry).createServer(input));
  });

  app.patch("/api/mcp/servers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const input = McpServerPatchRequestSchema.parse(request.body);
    try {
      return await requireMcp(mcpRegistry).patchServer(id, input);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/mcp/servers/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await requireMcp(mcpRegistry).deleteServer(id);
    return reply.code(204).send();
  });

  app.post("/api/mcp/servers/:id/connect", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return reply.code(202).send(await requireMcp(mcpRegistry).connectServer(id));
  });

  app.post("/api/mcp/servers/:id/disconnect", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return requireMcp(mcpRegistry).disconnectServer(id);
  });

  app.get("/api/mcp/tools", async () => requireMcp(mcpRegistry).listTools());

  app.post("/api/mcp/server", async (request, reply) => {
    const server = createSccMcpServer(workbench);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined } as never);
    await server.connect(transport as never);
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply.hijack();
  });

  app.get("/api/mcp/server", async (request, reply) =>
    reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );

  app.delete("/api/mcp/server", async (request, reply) =>
    reply.code(405).send({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null })
  );

  app.get("/api/permissions/global", async () => workbench.listGlobalPermissions());

  app.post("/api/permissions/global", async (request, reply) => {
    const input = GlobalPermissionRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.grantGlobalPermission(input.riskCategory, input.reason));
  });

  app.delete("/api/permissions/global/:riskCategory", async (request, reply) => {
    const { riskCategory } = z.object({ riskCategory: z.string() }).parse(request.params);
    const parsed = GlobalPermissionRequestSchema.shape.riskCategory.parse(riskCategory);
    await workbench.revokeGlobalPermission(parsed);
    return reply.code(204).send();
  });

  app.get("/api/preferences", async () => workbench.getPreferences());

  app.patch("/api/preferences", async (request) => {
    const input = PreferencesPatchSchema.parse(request.body);
    return workbench.updatePreferences(input);
  });

  app.get("/api/reflections", async () => workbench.listReflectionSessions());

  app.post("/api/reflections", async (request, reply) => reply.code(201).send(await workbench.runReflection()));

  app.get("/api/project-memories", async (request) => {
    const query = z.object({ projectId: z.string().optional() }).parse(request.query);
    return workbench.listProjectMemories(query.projectId);
  });

  app.post("/api/project-memories", async (request, reply) => {
    const input = ProjectMemoryCreateRequestSchema.parse(request.body);
    return reply.code(201).send(await workbench.createProjectMemory(input));
  });

  app.delete("/api/project-memories/:id", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    await workbench.deleteProjectMemory(id);
    return reply.code(204).send();
  });

  return app;
}

function createDefaultRuntime(onEvent: (event: TaskEvent) => void): { workbench: AgentWorkbench; mcpRegistry: McpRegistry } {
  const store = new SqliteWorkbenchStore(process.env["SCC_DB_PATH"] ?? "data/workbench.sqlite");
  const contextAssembler = new ContextAssembler(store);
  const mcpRegistry = new McpRegistry(store);
  const tools = new CompositeToolExecutor(new ShellToolExecutor(), [mcpRegistry]);
  const workbench = new AgentWorkbench({
    store,
    contextAssembler,
    model: createModelClientFromEnvironment({ contextAssembler, toolProvider: mcpRegistry }),
    tools,
    toolRiskProvider: mcpRegistry,
    onEvent
  });
  return { workbench, mcpRegistry };
}

function redactSensitiveText(input: string): string {
  return input
    .replace(/\bsk-[A-Za-z0-9_\-*]{8,}/g, "[redacted-api-key]")
    .replace(/(OPENAI_API_KEY\s*=\s*)\S+/gi, "$1[redacted]");
}

function requireMcp(registry: McpRegistry | undefined): McpRegistry {
  if (!registry) throw new Error("MCP registry is not configured.");
  return registry;
}

class TaskEventBroadcaster {
  private readonly subscribers = new Map<string, Set<(event: TaskEvent) => void>>();

  subscribe(taskId: string, listener: (event: TaskEvent) => void): () => void {
    const listeners = this.subscribers.get(taskId) ?? new Set<(event: TaskEvent) => void>();
    listeners.add(listener);
    this.subscribers.set(taskId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.subscribers.delete(taskId);
    };
  }

  publish(event: TaskEvent): void {
    for (const listener of this.subscribers.get(event.taskId) ?? []) {
      listener(event);
    }
  }
}
