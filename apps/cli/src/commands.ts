import { startServer as defaultStartServer } from "@agent-workbench/server";
import type { TaskDetail, TaskTranscriptItem } from "@agent-workbench/shared";
import {
  CliUsageError,
  hasOption,
  isRecord,
  optionBoolean,
  optionList,
  optionNumber,
  optionString,
  parseArgs,
  parseJsonOption,
  parseKeyValueList,
  parseSetOptions,
  requirePosition,
  type ParsedArgs
} from "./args.js";
import { readAttachmentPayload, readKnowledgePayload } from "./files.js";
import { ApiClient, ApiError } from "./http.js";
import { renderTranscript, renderValue, renderWatchEvent } from "./render.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface RunCliOptions {
  fetchImpl?: typeof fetch;
  io?: CliIO;
  sleep?: (ms: number) => Promise<void>;
  startServer?: typeof defaultStartServer;
  env?: Record<string, string | undefined>;
}

const DEFAULT_API_BASE = "http://127.0.0.1:5177";
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "paused", "waiting_approval", "waiting_for_user"]);
const COMMAND_ACTIONS: Record<string, string[]> = {
  serve: [],
  health: [],
  task: ["list", "show", "create", "send", "watch", "control", "approve", "transcript", "attachments", "checkpoints", "rollback", "turns"],
  folder: ["list", "create", "rename", "delete", "clear"],
  prefs: ["get", "set"],
  profile: ["get", "set"],
  permission: ["list", "grant", "revoke"],
  provider: ["list", "add", "update", "delete", "activate", "test", "cache"],
  mcp: ["server", "tools"],
  knowledge: ["list", "add", "upload", "search", "reindex", "update", "delete", "models", "download-model"],
  skill: ["list", "show", "create", "update", "delete", "export", "merge", "duplicates", "cleanup-duplicates", "conflicts", "curator"],
  memory: ["task-list", "task-delete", "project-list", "project-create", "project-update", "project-delete", "compact"],
  curator: ["runs", "run", "delete", "clear"],
  reflection: ["runs", "run", "delete", "clear"],
  schedule: ["list", "create", "update", "delete"],
  "search-provider": ["list", "add", "update", "delete"],
  integration: ["list", "add", "update", "delete", "connect", "disconnect"]
};

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const io = options.io ?? {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  };
  let parsed: ParsedArgs | undefined;
  try {
    parsed = parseArgs(argv);
    if (parsed.command.length === 0) {
      io.stdout(helpText());
      return 0;
    }
    if (optionBoolean(parsed, "help")) {
      io.stdout(helpForCommand(parsed.command));
      return 0;
    }
    const apiBase = optionString(parsed, "api") ?? options.env?.["AGENT_WORKBENCH_API_BASE"] ?? process.env["AGENT_WORKBENCH_API_BASE"] ?? DEFAULT_API_BASE;
    const client = new ApiClient(options.fetchImpl ? { baseUrl: apiBase, fetchImpl: options.fetchImpl } : { baseUrl: apiBase });
    const result = await dispatch(parsed, client, options);
    if (!optionBoolean(parsed, "quiet") && result !== undefined) io.stdout(renderCliResult(result, optionBoolean(parsed, "json")));
    return 0;
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(formatUsageError(error, parsed));
      return 2;
    }
    if (error instanceof ApiError) {
      const json = parsed ? optionBoolean(parsed, "json") : argv.includes("--json");
      io.stderr(formatApiError(error, json));
      return error.status === 0 ? 1 : Math.min(Math.max(error.status, 1), 255);
    }
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function dispatch(args: ParsedArgs, client: ApiClient, options: RunCliOptions): Promise<unknown> {
  const [group, action] = args.command;
  if (group === "serve") return serve(args, options);
  if (group === "health") return client.health();
  if (group === "task") return task(args, client, options);
  if (group === "folder") return folder(args, client);
  if (group === "prefs") return preferences(args, client);
  if (group === "profile") return profile(args, client);
  if (group === "permission") return permission(args, client);
  if (group === "provider") return provider(args, client);
  if (group === "mcp") return mcp(args, client);
  if (group === "knowledge") return knowledge(args, client);
  if (group === "skill") return skill(args, client);
  if (group === "memory") return memory(args, client);
  if (group === "curator") return runCollection(args, client, "/api/curator/runs");
  if (group === "reflection") return runCollection(args, client, "/api/reflections");
  if (group === "schedule") return schedule(args, client);
  if (group === "search-provider") return searchProvider(args, client);
  if (group === "integration") return integration(args, client);
  throw new CliUsageError(unknownCommandMessage([group, action].filter(Boolean).join(" ")));
}

async function serve(args: ParsedArgs, options: RunCliOptions): Promise<undefined> {
  const host = optionString(args, "host") ?? "127.0.0.1";
  const port = optionNumber(args, "port", 5177) ?? 5177;
  if (!isLoopbackHost(host) && !optionBoolean(args, "yes")) {
    throw new CliUsageError(`Refusing to bind Agent Workbench to non-loopback host "${host}" without --yes. Local session bootstrap is intended for trusted local access.`);
  }
  await (options.startServer ?? defaultStartServer)({ host, port });
  return undefined;
}

async function task(args: ParsedArgs, client: ApiClient, options: RunCliOptions): Promise<unknown> {
  const action = requirePosition(args, 1, "task action");
  if (action === "attachments") return taskAttachments(args, client);
  if (action === "rollback") return taskRollback(args, client);
  if (action === "turns") return taskTurns(args, client);
  if (action === "list") return client.request(`/api/tasks${optionBoolean(args, "include-children") ? "?includeChildren=true" : ""}`);
  if (action === "show") return client.request(`/api/tasks/${encodeURIComponent(requirePosition(args, 2, "task id"))}${query({ eventLimit: optionString(args, "events") })}`);
  if (action === "create") {
    assertJsonWatchCompatible(args);
    const attachmentIds = await uploadAttachments(client, optionList(args, "attach"));
    const body = bodyFrom(args, {
      goal: requirePosition(args, 2, "goal"),
      title: optionString(args, "title"),
      folderId: optionString(args, "folder"),
      runMode: optionBoolean(args, "target") ? "target" : undefined,
      targetLimits: targetLimitsFromOptions(args),
      attachmentIds
    });
    const created = await client.request<TaskDetail>("/api/tasks", jsonRequest("POST", body));
    if (optionBoolean(args, "watch")) await watchTask(args, client, options, created.id);
    return created;
  }
  if (action === "send") {
    assertJsonWatchCompatible(args);
    const taskId = requirePosition(args, 2, "task id");
    const attachmentIds = await uploadAttachments(client, optionList(args, "attach"));
    const body = bodyFrom(args, { content: requirePosition(args, 3, "message"), attachmentIds });
    const updated = await client.request<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}/messages`, jsonRequest("POST", body));
    if (optionBoolean(args, "watch")) await watchTask(args, client, options, taskId);
    return updated;
  }
  if (action === "watch") {
    await watchTask(args, client, options, requirePosition(args, 2, "task id"));
    return undefined;
  }
  if (action === "control") {
    return client.request(`/api/tasks/${encodeURIComponent(requirePosition(args, 2, "task id"))}/control`, jsonRequest("POST", { action: requirePosition(args, 3, "control action") }));
  }
  if (action === "approve") {
    const decision = normalizeApprovalDecision(requirePosition(args, 4, "approval decision"));
    return client.request(`/api/tasks/${encodeURIComponent(requirePosition(args, 2, "task id"))}/approvals/${encodeURIComponent(requirePosition(args, 3, "approval id"))}`, jsonRequest("POST", bodyFrom(args, { decision, reason: optionString(args, "reason") })));
  }
  if (action === "transcript") {
    const items = await client.request<TaskTranscriptItem[]>(`/api/tasks/${encodeURIComponent(requirePosition(args, 2, "task id"))}/transcript`);
    return new RawOutput(renderTranscript(items, optionBoolean(args, "json")));
  }
  if (action === "checkpoints") return client.request(`/api/tasks/${encodeURIComponent(requirePosition(args, 2, "task id"))}/checkpoints`);
  throw new CliUsageError(`Unknown task action: ${action}`);
}

async function taskAttachments(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 2, "attachment action");
  if (action === "list") return client.request(`/api/tasks/${encodeURIComponent(requirePosition(args, 3, "task id"))}/attachments`);
  if (action === "upload") return client.request("/api/task-attachments", jsonRequest("POST", readAttachmentPayload(requirePosition(args, 3, "file path"))));
  if (action === "delete") return client.request(`/api/task-attachments/${encodeURIComponent(requirePosition(args, 3, "attachment id"))}`, { method: "DELETE" });
  throw new CliUsageError(`Unknown task attachments action: ${action}`);
}

async function taskRollback(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 2, "rollback action");
  const taskId = requirePosition(args, 3, "task id");
  const body = bodyFrom(args, { checkpointId: optionString(args, "checkpoint"), filePaths: optionList(args, "file") });
  if (action === "preview") return client.request(`/api/tasks/${encodeURIComponent(taskId)}/rollback/preview`, jsonRequest("POST", body));
  if (action === "apply") return client.request(`/api/tasks/${encodeURIComponent(taskId)}/rollback`, jsonRequest("POST", body));
  throw new CliUsageError(`Unknown rollback action: ${action}`);
}

async function taskTurns(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 2, "turn action");
  const taskId = requirePosition(args, 3, "task id");
  if (action === "list") return client.request(`/api/tasks/${encodeURIComponent(taskId)}/turns`);
  if (action === "revert") return client.request(`/api/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(requirePosition(args, 4, "turn id"))}/revert`, { method: "POST" });
  if (action === "edit") {
    return client.request(
      `/api/tasks/${encodeURIComponent(taskId)}/turns/${encodeURIComponent(requirePosition(args, 4, "turn id"))}/edit`,
      jsonRequest("POST", bodyFrom(args, { content: optionString(args, "content") ?? requirePosition(args, 5, "content") }))
    );
  }
  throw new CliUsageError(`Unknown turn action: ${action}`);
}

async function folder(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "folder action");
  if (action === "list") return client.request("/api/task-folders");
  if (action === "create") return client.request("/api/task-folders", jsonRequest("POST", bodyFrom(args, { name: optionString(args, "name") ?? requirePosition(args, 2, "folder name"), rootPath: optionString(args, "root") })));
  if (action === "rename") return client.request(`/api/task-folders/${encodeURIComponent(requirePosition(args, 2, "folder id"))}`, jsonRequest("PATCH", { name: optionString(args, "name") ?? requirePosition(args, 3, "folder name") }));
  if (action === "delete") return client.request(`/api/task-folders/${encodeURIComponent(requirePosition(args, 2, "folder id"))}`, jsonRequest("DELETE", deletionFlags(args)));
  if (action === "clear") return client.request(`/api/task-folders/${encodeURIComponent(requirePosition(args, 2, "folder id"))}/clear`, jsonRequest("POST", deletionFlags(args)));
  throw new CliUsageError(`Unknown folder action: ${action}`);
}

async function preferences(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "prefs action");
  if (action === "get") return client.request("/api/preferences");
  if (action === "set") return client.request("/api/preferences", jsonRequest("PATCH", bodyFrom(args, parseSetOptions(args))));
  throw new CliUsageError(`Unknown prefs action: ${action}`);
}

async function profile(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "profile action");
  if (action === "get") return client.request("/api/user-profile");
  if (action === "set") return client.request("/api/user-profile", jsonRequest("PATCH", { content: optionString(args, "content") ?? requirePosition(args, 2, "content") }));
  throw new CliUsageError(`Unknown profile action: ${action}`);
}

async function permission(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "permission action");
  if (action === "list") return client.request("/api/permissions/global");
  if (action === "grant") return client.request("/api/permissions/global", jsonRequest("POST", { riskCategory: requirePosition(args, 2, "risk category"), reason: optionString(args, "reason") }));
  if (action === "revoke") return client.request(`/api/permissions/global/${encodeURIComponent(requirePosition(args, 2, "risk category"))}`, { method: "DELETE" });
  throw new CliUsageError(`Unknown permission action: ${action}`);
}

async function provider(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "provider action");
  if (action === "list") return client.request("/api/model-providers");
  if (action === "add") return client.request("/api/model-providers", jsonRequest("POST", providerBody(args)));
  if (action === "update") return client.request(`/api/model-providers/${encodeURIComponent(requirePosition(args, 2, "provider id"))}`, jsonRequest("PATCH", bodyFrom(args, providerBody(args, true))));
  if (action === "delete") return client.request(`/api/model-providers/${encodeURIComponent(requirePosition(args, 2, "provider id"))}`, { method: "DELETE" });
  if (action === "activate") return client.request(`/api/model-providers/${encodeURIComponent(requirePosition(args, 2, "provider id"))}`, jsonRequest("PATCH", { enabled: true, makeActive: true }));
  if (action === "test") return client.request(`/api/model-providers/${encodeURIComponent(requirePosition(args, 2, "provider id"))}/test`, { method: "POST" });
  if (action === "cache") return client.request(`/api/prompt-cache-stats${query({ taskId: optionString(args, "task") })}`);
  throw new CliUsageError(`Unknown provider action: ${action}`);
}

async function mcp(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const area = requirePosition(args, 1, "mcp area");
  if (area === "tools") return client.request("/api/mcp/tools");
  if (area !== "server") throw new CliUsageError(`Unknown mcp area: ${area}`);
  const action = requirePosition(args, 2, "mcp server action");
  if (action === "list") return client.request("/api/mcp/servers");
  if (action === "add") return client.request("/api/mcp/servers", jsonRequest("POST", mcpServerBody(args)));
  if (action === "update") return client.request(`/api/mcp/servers/${encodeURIComponent(requirePosition(args, 3, "server id"))}`, jsonRequest("PATCH", bodyFrom(args, mcpServerBody(args, true))));
  if (action === "delete") return client.request(`/api/mcp/servers/${encodeURIComponent(requirePosition(args, 3, "server id"))}`, { method: "DELETE" });
  if (action === "connect") return client.request(`/api/mcp/servers/${encodeURIComponent(requirePosition(args, 3, "server id"))}/connect`, { method: "POST" });
  if (action === "disconnect") return client.request(`/api/mcp/servers/${encodeURIComponent(requirePosition(args, 3, "server id"))}/disconnect`, { method: "POST" });
  throw new CliUsageError(`Unknown mcp server action: ${action}`);
}

async function knowledge(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "knowledge action");
  if (action === "list") return client.request(`/api/knowledge${query({ projectId: optionString(args, "project") })}`);
  if (action === "add") return client.request("/api/knowledge", jsonRequest("POST", bodyFrom(args, {
    projectId: optionString(args, "project"),
    kind: optionString(args, "kind"),
    title: optionString(args, "title") ?? requirePosition(args, 2, "title"),
    content: optionString(args, "content") ?? requirePosition(args, 3, "content"),
    tags: optionList(args, "tag"),
    sourceUri: optionString(args, "source-uri")
  })));
  if (action === "upload") {
    return client.request("/api/knowledge/upload", jsonRequest("POST", bodyFrom(args, {
      projectId: optionString(args, "project"),
      title: optionString(args, "title"),
      tags: optionList(args, "tag"),
      ...readKnowledgePayload(requirePosition(args, 2, "file path"))
    })));
  }
  if (action === "search") return client.request("/api/knowledge/search", jsonRequest("POST", bodyFrom(args, {
    query: requirePosition(args, 2, "query"),
    projectId: optionString(args, "project"),
    limit: optionNumber(args, "limit"),
    mode: optionString(args, "mode"),
    includeDiagnostics: hasOption(args, "diagnostics") ? optionBoolean(args, "diagnostics") : undefined
  })));
  if (action === "reindex") return client.request(`/api/knowledge/${encodeURIComponent(requirePosition(args, 2, "knowledge id"))}/reindex`, { method: "POST" });
  if (action === "update") return client.request(`/api/knowledge/${encodeURIComponent(requirePosition(args, 2, "knowledge id"))}`, jsonRequest("PATCH", bodyFrom(args, { title: optionString(args, "title"), content: optionString(args, "content"), tags: optionList(args, "tag"), sourceUri: optionString(args, "source-uri") })));
  if (action === "delete") return client.request(`/api/knowledge/${encodeURIComponent(requirePosition(args, 2, "knowledge id"))}`, { method: "DELETE" });
  if (action === "models") return client.request("/api/knowledge/models");
  if (action === "download-model") return client.request("/api/knowledge/models/download", jsonRequest("POST", bodyFrom(args, { kind: optionString(args, "kind") ?? requirePosition(args, 2, "model asset kind"), url: optionString(args, "url") ?? requirePosition(args, 3, "url"), fileName: optionString(args, "file-name") })));
  throw new CliUsageError(`Unknown knowledge action: ${action}`);
}

async function skill(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "skill action");
  if (action === "list") return client.request("/api/skills");
  if (action === "show") return client.request(`/api/skills/${encodeURIComponent(requirePosition(args, 2, "skill id"))}`);
  if (action === "create") return client.request("/api/skills", jsonRequest("POST", bodyFrom(args, { title: optionString(args, "title") ?? requirePosition(args, 2, "title"), body: optionString(args, "body") ?? requirePosition(args, 3, "body"), status: optionString(args, "status"), sourceMemoryIds: optionList(args, "source-memory"), relatedPatterns: optionList(args, "pattern") })));
  if (action === "update") return client.request(`/api/skills/${encodeURIComponent(requirePosition(args, 2, "skill id"))}`, jsonRequest("PATCH", bodyFrom(args, { title: optionString(args, "title"), body: optionString(args, "body"), status: optionString(args, "status"), sourceMemoryIds: optionList(args, "source-memory"), relatedPatterns: optionList(args, "pattern") })));
  if (action === "delete") return client.request(`/api/skills/${encodeURIComponent(requirePosition(args, 2, "skill id"))}`, { method: "DELETE" });
  if (action === "export") return client.request(`/api/skills/${encodeURIComponent(requirePosition(args, 2, "skill id"))}/export`);
  if (action === "merge") return client.request(`/api/skills/${encodeURIComponent(requirePosition(args, 2, "skill id"))}/merge`, jsonRequest("POST", bodyFrom(args, { sourceSkillIds: optionList(args, "source"), targetSkillId: optionString(args, "target"), deleteSources: !hasOption(args, "keep-sources") })));
  if (action === "duplicates") return client.request("/api/skills/duplicates");
  if (action === "cleanup-duplicates") return client.request("/api/skills/cleanup-duplicates", { method: "POST" });
  if (action === "conflicts") return client.request("/api/skill-conflicts");
  if (action === "curator") return client.request("/api/skill-curator");
  throw new CliUsageError(`Unknown skill action: ${action}`);
}

async function memory(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "memory action");
  if (action === "task-list") return client.request("/api/task-memories");
  if (action === "task-delete") return client.request(`/api/task-memories/${encodeURIComponent(requirePosition(args, 2, "memory id"))}`, { method: "DELETE" });
  if (action === "project-list") return client.request("/api/project-memories");
  if (action === "project-create") return client.request("/api/project-memories", jsonRequest("POST", bodyFrom(args, { title: optionString(args, "title") ?? requirePosition(args, 2, "title"), content: optionString(args, "content") ?? requirePosition(args, 3, "content"), category: optionString(args, "category") ?? "convention", tags: optionList(args, "tag"), projectId: optionString(args, "project") })));
  if (action === "project-update") return client.request(`/api/project-memories/${encodeURIComponent(requirePosition(args, 2, "project memory id"))}`, jsonRequest("PATCH", bodyFrom(args, { title: optionString(args, "title"), content: optionString(args, "content"), category: optionString(args, "category"), tags: optionList(args, "tag") })));
  if (action === "project-delete") return client.request(`/api/project-memories/${encodeURIComponent(requirePosition(args, 2, "project memory id"))}`, { method: "DELETE" });
  if (action === "compact") return client.request(`/api/project-memory/compact${query({ folderId: optionString(args, "folder") })}`, { method: "POST" });
  throw new CliUsageError(`Unknown memory action: ${action}`);
}

async function runCollection(args: ParsedArgs, client: ApiClient, path: string): Promise<unknown> {
  const action = requirePosition(args, 1, "run action");
  if (action === "runs") return client.request(path);
  if (action === "run") return client.request(path, { method: "POST" });
  if (action === "delete") return client.request(`${path}/${encodeURIComponent(requirePosition(args, 2, "run id"))}`, { method: "DELETE" });
  if (action === "clear") return client.request(path, { method: "DELETE" });
  throw new CliUsageError(`Unknown run action: ${action}`);
}

async function schedule(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "schedule action");
  if (action === "list") return client.request("/api/scheduled-tasks");
  if (action === "create") return client.request("/api/scheduled-tasks", jsonRequest("POST", bodyFrom(args, { title: optionString(args, "title") ?? requirePosition(args, 2, "title"), prompt: optionString(args, "prompt") ?? requirePosition(args, 3, "prompt"), folderId: optionString(args, "folder"), scheduleKind: optionString(args, "schedule-kind"), frequency: optionString(args, "frequency"), timeOfDay: optionString(args, "time"), intervalHours: optionNumber(args, "interval-hours"), intervalMinutes: optionNumber(args, "interval-minutes") })));
  if (action === "update") return client.request(`/api/scheduled-tasks/${encodeURIComponent(requirePosition(args, 2, "scheduled task id"))}`, jsonRequest("PATCH", bodyFrom(args, { title: optionString(args, "title"), prompt: optionString(args, "prompt"), folderId: optionString(args, "folder"), scheduleKind: optionString(args, "schedule-kind"), frequency: optionString(args, "frequency"), timeOfDay: optionString(args, "time"), intervalHours: optionNumber(args, "interval-hours"), intervalMinutes: optionNumber(args, "interval-minutes"), status: optionString(args, "status") })));
  if (action === "delete") return client.request(`/api/scheduled-tasks/${encodeURIComponent(requirePosition(args, 2, "scheduled task id"))}`, { method: "DELETE" });
  throw new CliUsageError(`Unknown schedule action: ${action}`);
}

async function searchProvider(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "search-provider action");
  if (action === "list") return client.request("/api/web-search/providers");
  if (action === "add") return client.request("/api/web-search/providers", jsonRequest("POST", bodyFrom(args, { label: optionString(args, "label") ?? requirePosition(args, 2, "label"), kind: optionString(args, "kind") ?? requirePosition(args, 3, "kind"), endpoint: optionString(args, "endpoint"), apiKey: optionString(args, "api-key"), enabled: !optionBoolean(args, "disabled") })));
  if (action === "update") return client.request(`/api/web-search/providers/${encodeURIComponent(requirePosition(args, 2, "provider id"))}`, jsonRequest("PATCH", bodyFrom(args, { label: optionString(args, "label"), kind: optionString(args, "kind"), endpoint: optionString(args, "endpoint"), apiKey: optionString(args, "api-key"), clearApiKey: optionBoolean(args, "clear-api-key"), enabled: hasOption(args, "enabled") ? optionBoolean(args, "enabled") : undefined })));
  if (action === "delete") return client.request(`/api/web-search/providers/${encodeURIComponent(requirePosition(args, 2, "provider id"))}`, { method: "DELETE" });
  throw new CliUsageError(`Unknown search-provider action: ${action}`);
}

async function integration(args: ParsedArgs, client: ApiClient): Promise<unknown> {
  const action = requirePosition(args, 1, "integration action");
  if (action === "list") return client.request("/api/integrations");
  if (action === "add") return client.request("/api/integrations", jsonRequest("POST", integrationBody(args)));
  if (action === "update") return client.request(`/api/integrations/${encodeURIComponent(requirePosition(args, 2, "integration id"))}`, jsonRequest("PATCH", bodyFrom(args, integrationBody(args, true))));
  if (action === "delete") return client.request(`/api/integrations/${encodeURIComponent(requirePosition(args, 2, "integration id"))}`, { method: "DELETE" });
  if (action === "connect") return client.request(`/api/integrations/${encodeURIComponent(requirePosition(args, 2, "integration id"))}/connect`, { method: "POST" });
  if (action === "disconnect") return client.request(`/api/integrations/${encodeURIComponent(requirePosition(args, 2, "integration id"))}/disconnect`, { method: "POST" });
  throw new CliUsageError(`Unknown integration action: ${action}`);
}

async function uploadAttachments(client: ApiClient, paths: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const path of paths) {
    const uploaded = await client.request<{ id: string }>("/api/task-attachments", jsonRequest("POST", readAttachmentPayload(path)));
    ids.push(uploaded.id);
  }
  return ids;
}

async function watchTask(args: ParsedArgs, client: ApiClient, options: RunCliOptions, taskId: string): Promise<void> {
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const interval = optionNumber(args, "interval", 1000) ?? 1000;
  const seen = new Set<string>();
  const io = options.io ?? {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text)
  };
  for (;;) {
    const taskDetail = await client.request<TaskDetail>(`/api/tasks/${encodeURIComponent(taskId)}`);
    for (const event of taskDetail.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      io.stdout(`${renderWatchEvent(event)}\n`);
    }
    if (TERMINAL_STATUSES.has(taskDetail.status)) return;
    await sleep(interval);
  }
}

function providerBody(args: ParsedArgs, partial = false): Record<string, unknown> {
  const modelIds = optionList(args, "model");
  const models = modelIds.length > 0 ? modelIds.map((item) => {
    const separator = item.indexOf("=");
    const id = separator >= 0 ? item.slice(0, separator) : item;
    const label = separator >= 0 ? item.slice(separator + 1) : item;
    return { id, label };
  }) : undefined;
  return bodyFrom(args, {
    vendor: optionString(args, "vendor") ?? (partial ? undefined : "custom"),
    label: optionString(args, "label"),
    protocol: optionString(args, "protocol") ?? (partial ? undefined : "openai_compatible"),
    baseUrl: optionString(args, "base-url"),
    apiKey: optionString(args, "api-key"),
    models,
    defaultModelId: optionString(args, "default-model") ?? modelIds.at(0),
    enabled: hasOption(args, "disabled") ? !optionBoolean(args, "disabled") : undefined,
    makeActive: hasOption(args, "make-active") ? optionBoolean(args, "make-active") : undefined,
    clearApiKey: hasOption(args, "clear-api-key") ? optionBoolean(args, "clear-api-key") : undefined
  });
}

function mcpServerBody(args: ParsedArgs, partial = false): Record<string, unknown> {
  const explicitTransport = optionString(args, "transport");
  return bodyFrom(args, {
    id: optionString(args, "id"),
    label: optionString(args, "label") ?? (partial ? undefined : requirePosition(args, 3, "server label")),
    transport: explicitTransport ?? (partial ? undefined : optionString(args, "url") ? "streamable_http" : "stdio"),
    command: optionString(args, "command"),
    args: optionList(args, "arg"),
    env: parseKeyValueList(optionList(args, "env"), "env"),
    cwd: optionString(args, "cwd"),
    url: optionString(args, "url"),
    enabled: hasOption(args, "disabled") ? !optionBoolean(args, "disabled") : undefined,
    toolRiskOverrides: parseKeyValueList(optionList(args, "risk"), "risk")
  });
}

function assertJsonWatchCompatible(args: ParsedArgs): void {
  if (optionBoolean(args, "json") && optionBoolean(args, "watch")) {
    throw new CliUsageError("--json cannot be combined with --watch because watch emits an event stream. Run the command without --watch, or omit --json for human-readable watch output.");
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function integrationBody(args: ParsedArgs, partial = false): Record<string, unknown> {
  return bodyFrom(args, {
    kind: optionString(args, "kind") ?? (partial ? undefined : requirePosition(args, 2, "integration kind")),
    label: optionString(args, "label") ?? (partial ? undefined : requirePosition(args, 3, "integration label")),
    botToken: optionString(args, "bot-token"),
    appId: optionString(args, "app-id"),
    appSecret: optionString(args, "app-secret"),
    publicKey: optionString(args, "public-key"),
    verificationToken: optionString(args, "verification-token"),
    encryptKey: optionString(args, "encrypt-key"),
    signingSecret: optionString(args, "signing-secret"),
    secretToken: optionString(args, "secret-token"),
    wecomToken: optionString(args, "wecom-token"),
    wecomEncodingAesKey: optionString(args, "wecom-encoding-aes-key"),
    callbackUrl: optionString(args, "callback-url"),
    defaultFolderId: optionString(args, "folder"),
    defaultPermissionPreset: optionString(args, "permission-preset"),
    enabled: hasOption(args, "enabled") ? optionBoolean(args, "enabled") : undefined,
    clearBotToken: hasOption(args, "clear-bot-token") ? optionBoolean(args, "clear-bot-token") : undefined,
    clearAppSecret: hasOption(args, "clear-app-secret") ? optionBoolean(args, "clear-app-secret") : undefined,
    clearVerificationToken: hasOption(args, "clear-verification-token") ? optionBoolean(args, "clear-verification-token") : undefined,
    clearEncryptKey: hasOption(args, "clear-encrypt-key") ? optionBoolean(args, "clear-encrypt-key") : undefined,
    clearSigningSecret: hasOption(args, "clear-signing-secret") ? optionBoolean(args, "clear-signing-secret") : undefined,
    clearSecretToken: hasOption(args, "clear-secret-token") ? optionBoolean(args, "clear-secret-token") : undefined,
    clearWecomToken: hasOption(args, "clear-wecom-token") ? optionBoolean(args, "clear-wecom-token") : undefined,
    clearWecomEncodingAesKey: hasOption(args, "clear-wecom-encoding-aes-key") ? optionBoolean(args, "clear-wecom-encoding-aes-key") : undefined
  });
}

function bodyFrom(args: ParsedArgs, defaults: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (isRecord(value) && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return { ...out, ...parseJsonOption(args), ...parseSetOptions(args) };
}

function deletionFlags(args: ParsedArgs): Record<string, boolean> {
  return {
    deleteLearningData: optionBoolean(args, "delete-learning-data"),
    deleteDerivedSkills: optionBoolean(args, "delete-derived-skills")
  };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) };
}

function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

function normalizeApprovalDecision(value: string): string {
  const normalized = value.replace(/-/g, "_");
  if (normalized === "allow_once" || normalized === "allow_for_task" || normalized === "allow_globally" || normalized === "deny") return normalized;
  if (normalized === "allow_task") return "allow_for_task";
  if (normalized === "allow_global") return "allow_globally";
  throw new CliUsageError("Approval decision must be allow-once, allow-task, allow-global, or deny.");
}

function helpText(): string {
  return `${shortUsage()}

Run "aw <command> --help" for command-specific examples.

Common commands:
  aw serve [--host 127.0.0.1] [--port 5177]
  aw health
  aw task list|show|create|send|watch|control|approve|transcript|attachments
  aw folder list|create|rename|delete|clear
  aw permission list|grant|revoke
  aw prefs get|set
  aw profile get|set
  aw provider list|add|update|delete|activate|test
  aw mcp server list|add|update|delete|connect|disconnect
  aw knowledge list|add|upload|search|reindex|update|delete|models|download-model
  aw skill list|show|create|update|delete|export|merge|duplicates|cleanup-duplicates|conflicts|curator
  aw memory task-list|task-delete|project-list|project-create|project-update|project-delete|compact
  aw curator runs|run|delete|clear
  aw reflection runs|run|delete|clear
  aw schedule list|create|update|delete
  aw search-provider list|add|update|delete
  aw integration list|add|update|delete|connect|disconnect

Global options:
  --api <url>      Agent Workbench API base URL. Defaults to http://127.0.0.1:5177
  --json           Print raw JSON responses.
  --quiet          Suppress normal output.
  --yes            Confirm explicitly risky local-server actions.
  --data <json>    Merge a JSON object into the request body.
  --set k=v        Merge scalar request fields. Can be repeated.
`;
}

function shortUsage(): string {
  return "Usage: aw [--api <url>] [--json] [--quiet] <command> [args]";
}

function helpForCommand(command: string[]): string {
  const group = command[0];
  if (!group) return helpText();
  if (group === "serve") {
    return `${shortUsage()}

Serve:
  aw serve [--host 127.0.0.1] [--port 5177]

Notes:
  Starts the local Agent Workbench server explicitly. Other commands do not auto-start it.
  Binding to a non-loopback host requires --yes.
`;
  }
  if (group === "health") {
    return `${shortUsage()}

Health:
  aw health
  aw --api http://127.0.0.1:5177 health --json
`;
  }
  if (group === "task") {
    return `${shortUsage()}

Tasks:
  aw task list [--include-children]
  aw task show <taskId> [--events <n>]
  aw task create "<goal>" [--title <title>] [--folder <id>] [--target]
                 [--max-model-turns <n>] [--max-tool-calls <n>] [--max-wall-time-minutes <n>]
                 [--attach <path>]... [--watch]
  aw task send <taskId> "<message>" [--attach <path>]... [--watch]
  aw task watch <taskId> [--interval 1000]
  aw task control <taskId> pause|resume|cancel
  aw task approve <taskId> <approvalId> allow-once|allow-task|allow-global|deny [--reason <text>]
  aw task transcript <taskId>
  aw task attachments list <taskId>
  aw task attachments upload <path>
  aw task attachments delete <attachmentId>
  aw task rollback preview|apply <taskId> [--checkpoint <id>] [--file <path>]...
  aw task turns list|revert|edit <taskId> ...

Tip:
  Use --watch for human event streams, or --json for raw structured output. They are intentionally separate.
  Goal mode accepts explicit long-task limits, for example:
  aw task create "repair and verify the repo" --target --max-tool-calls 1200 --max-wall-time-minutes 360
`;
  }
  if (group === "knowledge") {
    return `${shortUsage()}

Knowledge:
  aw knowledge list [--project <id>]
  aw knowledge add "<title>" "<content>" [--project <id>] [--tag <tag>]...
  aw knowledge upload <path> [--title <title>] [--project <id>] [--tag <tag>]...
  aw knowledge search "<query>" [--project <id>] [--limit <n>] [--mode auto|keyword|hybrid] [--diagnostics]
  aw knowledge reindex <knowledgeId>
  aw knowledge update <knowledgeId> [--title <title>] [--content <content>] [--tag <tag>]...
  aw knowledge delete <knowledgeId>
  aw knowledge models
  aw knowledge download-model <kind> <url> [--file-name <name>]

Notes:
  knowledge search reads saved Library content, not live workspace files.
  Use --project <id> when you need a specific task-folder scope.
  Use --diagnostics to show query rewrites, matched query variants, grades, and confidence in --json output.
`;
  }
  if (group === "permission") {
    return `${shortUsage()}

Permissions:
  aw permission list
  aw permission grant <riskCategory> [--reason <text>]
  aw permission revoke <riskCategory>

Risk categories:
  host_observation | workspace_read | workspace_write | shell | network | destructive
`;
  }
  if (group === "memory") {
    return `${shortUsage()}

Memory:
  aw memory task-list
  aw memory task-delete <memoryId>
  aw memory project-list
  aw memory project-create "<title>" "<content>" [--category <name>] [--tag <tag>]... [--project <id>]
  aw memory project-update <projectMemoryId> [--title <title>] [--content <content>] [--category <name>] [--tag <tag>]...
  aw memory project-delete <projectMemoryId>
  aw memory compact [--folder <id>]

Notes:
  Keep durable memory stable, reusable, and non-secret. Use project memory for confirmed project facts.
`;
  }
  if (group === "schedule") {
    return `${shortUsage()}

Scheduled tasks:
  aw schedule list
  aw schedule create "<title>" "<prompt>" [--folder <id>] [--schedule-kind interval|daily|weekly]
                     [--frequency <value>] [--time HH:mm] [--interval-hours <n>] [--interval-minutes <n>]
  aw schedule update <scheduledTaskId> [--title <title>] [--prompt <prompt>] [--status active|paused]
  aw schedule delete <scheduledTaskId>
`;
  }
  if (group === "curator" || group === "reflection") {
    return `${shortUsage()}

${group === "curator" ? "Curator" : "Reflection"} runs:
  aw ${group} runs
  aw ${group} run
  aw ${group} delete <runId>
  aw ${group} clear
`;
  }
  if (group === "search-provider") {
    return `${shortUsage()}

Search providers:
  aw search-provider list
  aw search-provider add "DuckDuckGo" duckduckgo
  aw search-provider add "Brave" brave --api-key <key>
  aw search-provider add "Custom" custom --endpoint "https://example.test/search?q={query}&limit={limit}"
  aw search-provider update <providerId> [--label <label>] [--enabled true|false] [--clear-api-key]
  aw search-provider delete <providerId>
`;
  }
  if (group === "provider") {
    return `${shortUsage()}

Model providers:
  aw provider list
  aw provider add --label "Local" --base-url http://127.0.0.1:8000/v1 --model local=Local --default-model local
  aw provider update <providerId> [--label <label>] [--api-key <key>] [--clear-api-key]
  aw provider activate <providerId>
  aw provider test <providerId>
  aw provider cache [--task <taskId>]
  aw provider delete <providerId>

Cache:
  Reads the server-side prompt-cache telemetry. The rolling target is 90% cachedTokens / inputTokens after warmup.
`;
  }
  if (group === "mcp") {
    return `${shortUsage()}

MCP:
  aw mcp server list
  aw mcp server add "Filesystem" --command node --arg server.js
  aw mcp server add "Remote" --url http://127.0.0.1:3333/mcp
  aw mcp server update <serverId> [--label <label>] [--env KEY=value]...
  aw mcp server connect|disconnect <serverId>
  aw mcp tools
`;
  }
  const actions = COMMAND_ACTIONS[group];
  if (actions) {
    return `${shortUsage()}

${group} actions:
  ${actions.join(" | ")}

Examples:
  aw ${group} ${actions[0] ?? "list"}
  aw --json ${group} ${actions[0] ?? "list"}
`;
  }
  return `${unknownCommandMessage(group)}

${helpText()}`;
}

function formatUsageError(error: CliUsageError, parsed: ParsedArgs | undefined): string {
  const group = parsed?.command[0];
  const hint = group && COMMAND_ACTIONS[group] ? `\n\nRun "aw ${group} --help" for ${group} examples.` : "\n\nRun \"aw --help\" for available commands.";
  return `${error.message}${hint}\n\n${shortUsage()}`;
}

function targetLimitsFromOptions(args: ParsedArgs): Record<string, number> | undefined {
  const maxModelTurns = positiveIntegerOption(args, "max-model-turns");
  const maxToolCalls = positiveIntegerOption(args, "max-tool-calls");
  const maxWallTimeMinutes = positiveIntegerOption(args, "max-wall-time-minutes");
  if (maxModelTurns === undefined && maxToolCalls === undefined && maxWallTimeMinutes === undefined) return undefined;
  if (!optionBoolean(args, "target")) {
    throw new CliUsageError("Long-task limits require --target so the server can apply explicit goal-mode safeguards.");
  }
  return {
    ...(maxModelTurns !== undefined ? { maxModelTurns } : {}),
    ...(maxToolCalls !== undefined ? { maxToolCalls } : {}),
    ...(maxWallTimeMinutes !== undefined ? { maxWallTimeMs: maxWallTimeMinutes * 60_000 } : {})
  };
}

function positiveIntegerOption(args: ParsedArgs, name: string): number | undefined {
  if (!hasOption(args, name)) return undefined;
  const value = optionNumber(args, name);
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    throw new CliUsageError(`--${name} must be a positive integer.`);
  }
  return value;
}

function formatApiError(error: ApiError, json: boolean): string {
  if (!json) return `${error.message}\n`;
  return `${JSON.stringify({
    ok: false,
    error: {
      status: error.status,
      code: error.status === 0 ? "connection_failed" : "api_error",
      message: error.message,
      ...(error.status === 0 ? { hint: "Start the local server with: aw serve" } : {})
    }
  }, null, 2)}\n`;
}

function unknownCommandMessage(command: string): string {
  const first = command.split(/\s+/)[0] ?? "";
  const suggestion = closestCommand(first);
  return suggestion ? `Unknown command: ${command}\nDid you mean "aw ${suggestion}"?` : `Unknown command: ${command}`;
}

function closestCommand(input: string): string | null {
  if (!input) return null;
  let best: { command: string; distance: number } | null = null;
  for (const command of Object.keys(COMMAND_ACTIONS)) {
    const distance = levenshtein(input, command);
    if (!best || distance < best.distance) best = { command, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(input.length / 3)) ? best.command : null;
}

function levenshtein(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, index) => [index]);
  for (let column = 1; column <= right.length; column += 1) rows[0]![column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      rows[row]![column] = Math.min(
        rows[row - 1]![column]! + 1,
        rows[row]![column - 1]! + 1,
        rows[row - 1]![column - 1]! + cost
      );
    }
  }
  return rows[left.length]![right.length]!;
}

class RawOutput {
  constructor(readonly text: string) {}
}

const originalRenderValue = renderValue;
export function renderCliResult(value: unknown, json: boolean): string {
  return value instanceof RawOutput ? value.text : originalRenderValue(value, json);
}
