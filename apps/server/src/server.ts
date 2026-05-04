import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { AgentWorkbench, createModelClientFromEnvironment } from "@scc/core";
import {
  ApprovalRequestSchema,
  ControlRequestSchema,
  CreateTaskRequestSchema,
  MessageRequestSchema
} from "@scc/shared";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { SqliteWorkbenchStore } from "./sqlite-store.js";

function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

const SkillStatusPatchSchema = z.object({ status: z.enum(["enabled", "draft"]) }).strict();

export interface AppOptions {
  workbench?: AgentWorkbench;
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
      error: error instanceof Error ? error.message : String(error),
      requestId
    });
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  const workbench =
    options.workbench ??
    new AgentWorkbench({
      model: createModelClientFromEnvironment(),
      store: new SqliteWorkbenchStore(process.env["SCC_DB_PATH"] ?? "data/workbench.sqlite")
    });

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

  app.post("/api/experiences/:id/promote", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    try {
      return reply.code(201).send(await workbench.promoteExperience(id));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/skills", async () => workbench.listSkills());

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

  return app;
}
