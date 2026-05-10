import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ConversationSummary,
  ExperienceRecord,
  GlobalPermissionGrant,
  IntegrationMessage,
  IntegrationProviderConfig,
  IntegrationTaskLink,
  KnowledgeChunk,
  KnowledgeEmbedding,
  KnowledgeItem,
  KnowledgeSearchIndexEntry,
  McpServerConfig,
  ModelProviderRecord,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  RiskCategory,
  ScheduledTask,
  SkillConflict,
  SkillRecord,
  TaskAttachment,
  TaskCheckpoint,
  TaskDetail,
  TaskFolderRecord,
  TaskTurn,
  TaskMemory,
  UserPreferences,
  PromptCacheStats,
  WebSearchProviderConfig
} from "@scc/shared";
import { LocalSecretBox, defaultPreferences, normalizeKnowledgeItem, normalizeSkillRecord, normalizeTaskDetail, normalizeTaskFolderRecord, type EncryptedSecretValue, type WorkbenchStore } from "@scc/core";

type Namespace =
  | "tasks"
  | "task_turns"
  | "task_attachments"
  | "task_checkpoints"
  | "conversation_summaries"
  | "task_folders"
  | "experiences"
  | "task_memories"
  | "patterns"
  | "skills"
  | "skill_conflicts"
  | "mcp_servers"
  | "global_permissions"
  | "model_providers"
  | "model_provider_secrets"
  | "scheduled_tasks"
  | "web_search_providers"
  | "web_search_provider_secrets"
  | "preferences"
  | "reflection_sessions"
  | "project_memories"
  | "knowledge_items"
  | "knowledge_chunks"
  | "knowledge_embeddings"
  | "knowledge_search_index"
  | "prompt_cache_stats"
  | "integration_providers"
  | "integration_secrets"
  | "integration_messages"
  | "integration_task_links";
type Row = { key: string; value: string };
type NamespacedRow = Row & { namespace: Namespace };
type EncryptedRecordEnvelope = {
  __sccEncrypted: true;
  algorithm: "local-secret-box-v1";
  payload: EncryptedSecretValue;
};

export class SqliteWorkbenchStore implements WorkbenchStore {
  private readonly db: Database.Database;
  private secretBox: LocalSecretBox | undefined;
  private checkpointInterval: ReturnType<typeof setInterval> | undefined;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))"
      )
      .run();
    this.checkpointInterval = setInterval(() => {
      try {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
      } catch {
        // checkpoint is best-effort
      }
    }, 60_000);
    if (this.checkpointInterval.unref) this.checkpointInterval.unref();
  }

  async saveTask(task: TaskDetail): Promise<void> {
    this.upsert("tasks", task.id, normalizeTaskDetail(task));
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    const task = this.get<TaskDetail>("tasks", taskId);
    return task ? normalizeTaskDetail(task) : undefined;
  }

  async listTasks(): Promise<TaskDetail[]> {
    return this.list<TaskDetail>("tasks").map((task) => normalizeTaskDetail(task)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteTask(taskId: string): Promise<void> {
    this.delete("tasks", taskId);
  }

  async saveTaskTurn(record: TaskTurn): Promise<void> {
    this.upsert("task_turns", record.id, record);
  }

  async getTaskTurn(turnId: string): Promise<TaskTurn | undefined> {
    return this.get<TaskTurn>("task_turns", turnId);
  }

  async listTaskTurns(taskId?: string): Promise<TaskTurn[]> {
    return this.list<TaskTurn>("task_turns")
      .filter((record) => !taskId || record.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteTaskTurn(turnId: string): Promise<void> {
    this.delete("task_turns", turnId);
  }

  async saveTaskAttachment(record: TaskAttachment): Promise<void> {
    this.upsert("task_attachments", record.id, record);
  }

  async getTaskAttachment(attachmentId: string): Promise<TaskAttachment | undefined> {
    return this.get<TaskAttachment>("task_attachments", attachmentId);
  }

  async listTaskAttachments(taskId?: string): Promise<TaskAttachment[]> {
    return this.list<TaskAttachment>("task_attachments")
      .filter((record) => !taskId || record.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteTaskAttachment(attachmentId: string): Promise<void> {
    this.delete("task_attachments", attachmentId);
  }

  async saveTaskCheckpoint(record: TaskCheckpoint): Promise<void> {
    this.upsert("task_checkpoints", record.id, record);
  }

  async getTaskCheckpoint(checkpointId: string): Promise<TaskCheckpoint | undefined> {
    return this.get<TaskCheckpoint>("task_checkpoints", checkpointId);
  }

  async listTaskCheckpoints(taskId?: string): Promise<TaskCheckpoint[]> {
    return this.list<TaskCheckpoint>("task_checkpoints")
      .filter((record) => !taskId || record.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteTaskCheckpoint(checkpointId: string): Promise<void> {
    this.delete("task_checkpoints", checkpointId);
  }

  async saveConversationSummary(record: ConversationSummary): Promise<void> {
    this.upsert("conversation_summaries", record.id, record);
  }

  async listConversationSummaries(taskId?: string): Promise<ConversationSummary[]> {
    return this.list<ConversationSummary>("conversation_summaries")
      .filter((record) => !taskId || record.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteConversationSummary(summaryId: string): Promise<void> {
    this.delete("conversation_summaries", summaryId);
  }

  async saveTaskFolder(record: TaskFolderRecord): Promise<void> {
    this.upsert("task_folders", record.id, normalizeTaskFolderRecord(record));
  }

  async getTaskFolder(folderId: string): Promise<TaskFolderRecord | undefined> {
    const folder = this.get<TaskFolderRecord>("task_folders", folderId);
    return folder ? normalizeTaskFolderRecord(folder) : undefined;
  }

  async listTaskFolders(): Promise<TaskFolderRecord[]> {
    return this.list<TaskFolderRecord>("task_folders")
      .map((folder) => normalizeTaskFolderRecord(folder))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  async deleteTaskFolder(folderId: string): Promise<void> {
    this.delete("task_folders", folderId);
  }

  async saveExperience(record: ExperienceRecord): Promise<void> {
    this.upsert("experiences", record.id, record);
  }

  async listExperiences(): Promise<ExperienceRecord[]> {
    return this.list<ExperienceRecord>("experiences");
  }

  async deleteExperience(experienceId: string): Promise<void> {
    this.delete("experiences", experienceId);
  }

  async saveTaskMemory(record: TaskMemory): Promise<void> {
    this.upsert("task_memories", record.id, record);
  }

  async listTaskMemories(): Promise<TaskMemory[]> {
    return this.list<TaskMemory>("task_memories");
  }

  async deleteTaskMemory(memoryId: string): Promise<void> {
    this.delete("task_memories", memoryId);
  }

  async savePattern(record: PatternRecord): Promise<void> {
    this.upsert("patterns", record.id, record);
  }

  async listPatterns(): Promise<PatternRecord[]> {
    return this.list<PatternRecord>("patterns");
  }

  async saveSkill(record: SkillRecord): Promise<void> {
    const normalized = normalizeSkillRecord(record);
    this.upsert("skills", normalized.id, normalized);
  }

  async listSkills(): Promise<SkillRecord[]> {
    return this.list<SkillRecord>("skills").map((record) => normalizeSkillRecord(record));
  }

  async getSkill(skillId: string): Promise<SkillRecord | undefined> {
    const skill = this.get<SkillRecord>("skills", skillId);
    return skill ? normalizeSkillRecord(skill) : undefined;
  }

  async deleteSkill(skillId: string): Promise<void> {
    this.delete("skills", skillId);
  }

  async saveSkillConflict(record: SkillConflict): Promise<void> {
    this.upsert("skill_conflicts", record.id, record);
  }

  async listSkillConflicts(): Promise<SkillConflict[]> {
    return this.list<SkillConflict>("skill_conflicts").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveMcpServer(record: McpServerConfig): Promise<void> {
    this.upsert("mcp_servers", record.id, record);
  }

  async getMcpServer(serverId: string): Promise<McpServerConfig | undefined> {
    return this.get<McpServerConfig>("mcp_servers", serverId);
  }

  async listMcpServers(): Promise<McpServerConfig[]> {
    return this.list<McpServerConfig>("mcp_servers").sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteMcpServer(serverId: string): Promise<void> {
    this.delete("mcp_servers", serverId);
  }

  async saveGlobalPermission(record: GlobalPermissionGrant): Promise<void> {
    this.upsert("global_permissions", record.riskCategory, record);
  }

  async listGlobalPermissions(): Promise<GlobalPermissionGrant[]> {
    return this.list<GlobalPermissionGrant>("global_permissions");
  }

  async deleteGlobalPermission(riskCategory: RiskCategory): Promise<void> {
    this.delete("global_permissions", riskCategory);
  }

  async getPreferences(): Promise<UserPreferences> {
    const stored = this.get<UserPreferences>("preferences", "default");
    if (stored) {
      const { reflectionEnabled: _reflectionEnabled, reflectionSchedule: _reflectionSchedule, emojiStyle: _emojiStyle, ...rest } = stored as UserPreferences & {
        reflectionEnabled?: boolean;
        reflectionSchedule?: string;
        emojiStyle?: string;
      };
      return { ...defaultPreferences(), ...rest };
    }
    const created = defaultPreferences();
    await this.savePreferences(created);
    return created;
  }

  async savePreferences(preferences: UserPreferences): Promise<void> {
    const previous = this.get<UserPreferences>("preferences", "default");
    this.upsert("preferences", "default", preferences);
    if (previous?.encryptStorage !== preferences.encryptStorage) {
      this.rewriteEncryptedRecords(preferences.encryptStorage);
    }
  }

  async saveModelProvider(record: ModelProviderRecord): Promise<void> {
    this.upsert("model_providers", record.id, record);
  }

  async getModelProvider(providerId: string): Promise<ModelProviderRecord | undefined> {
    return this.get<ModelProviderRecord>("model_providers", providerId);
  }

  async listModelProviders(): Promise<ModelProviderRecord[]> {
    return this.list<ModelProviderRecord>("model_providers").sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteModelProvider(providerId: string): Promise<void> {
    this.delete("model_providers", providerId);
  }

  async saveModelProviderSecret(providerId: string, secret: EncryptedSecretValue): Promise<void> {
    this.upsert("model_provider_secrets", providerId, secret);
  }

  async getModelProviderSecret(providerId: string): Promise<EncryptedSecretValue | undefined> {
    return this.get<EncryptedSecretValue>("model_provider_secrets", providerId);
  }

  async deleteModelProviderSecret(providerId: string): Promise<void> {
    this.delete("model_provider_secrets", providerId);
  }

  async saveScheduledTask(record: ScheduledTask): Promise<void> {
    this.upsert("scheduled_tasks", record.id, record);
  }

  async getScheduledTask(taskId: string): Promise<ScheduledTask | undefined> {
    return this.get<ScheduledTask>("scheduled_tasks", taskId);
  }

  async listScheduledTasks(): Promise<ScheduledTask[]> {
    return this.list<ScheduledTask>("scheduled_tasks").sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async deleteScheduledTask(taskId: string): Promise<void> {
    this.delete("scheduled_tasks", taskId);
  }

  async saveWebSearchProvider(record: WebSearchProviderConfig): Promise<void> {
    this.upsert("web_search_providers", record.id, record);
  }

  async getWebSearchProvider(providerId: string): Promise<WebSearchProviderConfig | undefined> {
    return this.get<WebSearchProviderConfig>("web_search_providers", providerId);
  }

  async listWebSearchProviders(): Promise<WebSearchProviderConfig[]> {
    return this.list<WebSearchProviderConfig>("web_search_providers").sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteWebSearchProvider(providerId: string): Promise<void> {
    this.delete("web_search_providers", providerId);
  }

  async saveWebSearchProviderSecret(providerId: string, secret: EncryptedSecretValue): Promise<void> {
    this.upsert("web_search_provider_secrets", providerId, secret);
  }

  async getWebSearchProviderSecret(providerId: string): Promise<EncryptedSecretValue | undefined> {
    return this.get<EncryptedSecretValue>("web_search_provider_secrets", providerId);
  }

  async deleteWebSearchProviderSecret(providerId: string): Promise<void> {
    this.delete("web_search_provider_secrets", providerId);
  }

  async saveReflectionSession(session: ReflectionSession): Promise<void> {
    this.upsert("reflection_sessions", session.id, session);
  }

  async listReflectionSessions(): Promise<ReflectionSession[]> {
    return this.list<ReflectionSession>("reflection_sessions").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async deleteReflectionSession(sessionId: string): Promise<void> {
    this.delete("reflection_sessions", sessionId);
  }

  async clearReflectionSessions(): Promise<void> {
    for (const session of await this.listReflectionSessions()) {
      this.delete("reflection_sessions", session.id);
    }
  }

  async saveProjectMemory(record: ProjectMemory): Promise<void> {
    this.upsert("project_memories", record.id, record);
  }

  async listProjectMemories(projectId?: string): Promise<ProjectMemory[]> {
    return this.list<ProjectMemory>("project_memories").filter((record) => !projectId || record.projectId === projectId);
  }

  async deleteProjectMemory(id: string): Promise<void> {
    this.delete("project_memories", id);
  }

  async saveKnowledgeItem(record: KnowledgeItem): Promise<void> {
    this.upsert("knowledge_items", record.id, normalizeKnowledgeItem(record));
  }

  async getKnowledgeItem(id: string): Promise<KnowledgeItem | undefined> {
    const item = this.get<KnowledgeItem>("knowledge_items", id);
    return item ? normalizeKnowledgeItem(item) : undefined;
  }

  async listKnowledgeItems(projectId?: string): Promise<KnowledgeItem[]> {
    return this.list<KnowledgeItem>("knowledge_items")
      .filter((record) => !projectId || record.projectId === projectId)
      .map((record) => normalizeKnowledgeItem(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteKnowledgeItem(id: string): Promise<void> {
    this.delete("knowledge_items", id);
    await this.deleteKnowledgeChunks(id);
  }

  async saveKnowledgeChunk(record: KnowledgeChunk): Promise<void> {
    this.upsert("knowledge_chunks", record.id, record);
  }

  async listKnowledgeChunks(knowledgeId?: string): Promise<KnowledgeChunk[]> {
    return this.list<KnowledgeChunk>("knowledge_chunks")
      .filter((record) => !knowledgeId || record.knowledgeId === knowledgeId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async deleteKnowledgeChunks(knowledgeId: string): Promise<void> {
    const chunkIds = this.list<KnowledgeChunk>("knowledge_chunks")
      .filter((record) => record.knowledgeId === knowledgeId)
      .map((record) => record.id);
    for (const chunkId of chunkIds) this.delete("knowledge_chunks", chunkId);
    await this.deleteKnowledgeSearchIndexEntries(chunkIds);
    await this.deleteKnowledgeEmbeddings(chunkIds);
  }

  async saveKnowledgeEmbedding(record: KnowledgeEmbedding): Promise<void> {
    this.upsert("knowledge_embeddings", record.id, record);
  }

  async listKnowledgeEmbeddings(chunkIds?: string[]): Promise<KnowledgeEmbedding[]> {
    const ids = chunkIds ? new Set(chunkIds) : null;
    return this.list<KnowledgeEmbedding>("knowledge_embeddings").filter((record) => !ids || ids.has(record.chunkId));
  }

  async deleteKnowledgeEmbeddings(chunkIds: string[]): Promise<void> {
    const ids = new Set(chunkIds);
    for (const record of this.list<KnowledgeEmbedding>("knowledge_embeddings")) {
      if (ids.has(record.chunkId)) this.delete("knowledge_embeddings", record.id);
    }
  }

  async saveKnowledgeSearchIndexEntry(record: KnowledgeSearchIndexEntry): Promise<void> {
    this.upsert("knowledge_search_index", record.id, record);
  }

  async listKnowledgeSearchIndexEntries(chunkIds?: string[]): Promise<KnowledgeSearchIndexEntry[]> {
    const ids = chunkIds ? new Set(chunkIds) : null;
    return this.list<KnowledgeSearchIndexEntry>("knowledge_search_index").filter((record) => !ids || ids.has(record.chunkId));
  }

  async deleteKnowledgeSearchIndexEntries(chunkIds: string[]): Promise<void> {
    const ids = new Set(chunkIds);
    for (const record of this.list<KnowledgeSearchIndexEntry>("knowledge_search_index")) {
      if (ids.has(record.chunkId)) this.delete("knowledge_search_index", record.id);
    }
  }

  async savePromptCacheStats(record: PromptCacheStats): Promise<void> {
    this.upsert("prompt_cache_stats", record.id, record);
  }

  async listPromptCacheStats(taskId?: string): Promise<PromptCacheStats[]> {
    return this.list<PromptCacheStats>("prompt_cache_stats")
      .filter((record) => !taskId || record.taskId === taskId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveIntegrationProvider(record: IntegrationProviderConfig): Promise<void> {
    this.upsert("integration_providers", record.id, record);
  }

  async getIntegrationProvider(integrationId: string): Promise<IntegrationProviderConfig | undefined> {
    return this.get<IntegrationProviderConfig>("integration_providers", integrationId);
  }

  async listIntegrationProviders(): Promise<IntegrationProviderConfig[]> {
    return this.list<IntegrationProviderConfig>("integration_providers").sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteIntegrationProvider(integrationId: string): Promise<void> {
    this.delete("integration_providers", integrationId);
    for (const row of this.db.prepare("SELECT key FROM records WHERE namespace = ? AND key LIKE ?").all("integration_secrets", `${integrationId}:%`) as Array<{ key: string }>) {
      this.delete("integration_secrets", row.key);
    }
  }

  async saveIntegrationSecret(integrationId: string, name: string, secret: EncryptedSecretValue): Promise<void> {
    this.upsert("integration_secrets", `${integrationId}:${name}`, secret);
  }

  async getIntegrationSecret(integrationId: string, name: string): Promise<EncryptedSecretValue | undefined> {
    return this.get<EncryptedSecretValue>("integration_secrets", `${integrationId}:${name}`);
  }

  async deleteIntegrationSecret(integrationId: string, name: string): Promise<void> {
    this.delete("integration_secrets", `${integrationId}:${name}`);
  }

  async saveIntegrationMessage(record: IntegrationMessage): Promise<void> {
    this.upsert("integration_messages", record.id, record);
  }

  async listIntegrationMessages(integrationId?: string): Promise<IntegrationMessage[]> {
    return this.list<IntegrationMessage>("integration_messages")
      .filter((record) => !integrationId || record.integrationId === integrationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveIntegrationTaskLink(record: IntegrationTaskLink): Promise<void> {
    this.upsert("integration_task_links", record.id, record);
  }

  async listIntegrationTaskLinks(taskId?: string): Promise<IntegrationTaskLink[]> {
    return this.list<IntegrationTaskLink>("integration_task_links").filter((record) => !taskId || record.taskId === taskId);
  }

  close(): void {
    if (this.checkpointInterval) {
      clearInterval(this.checkpointInterval);
      this.checkpointInterval = undefined;
    }
    try { this.db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
    this.db.close();
  }

  private upsert(namespace: Namespace, key: string, value: unknown): void {
    const stored = namespace !== "preferences" && this.isStorageEncryptionEnabled() ? this.encryptRecordValue(value) : value;
    this.retryWrite(() => {
      this.db
        .prepare("INSERT INTO records(namespace, key, value) VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value")
        .run(namespace, key, JSON.stringify(stored));
    });
  }

  private retryWrite(op: () => void, maxRetries = 3): void {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        op();
        return;
      } catch (error) {
        if (attempt === maxRetries) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("BUSY") && !message.includes("LOCK")) throw error;
      }
    }
  }

  private get<T>(namespace: Namespace, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get(namespace, key) as
      | Row
      | undefined;
    return row ? this.decodeRecordValue<T>(JSON.parse(row.value)) : undefined;
  }

  private list<T>(namespace: Namespace): T[] {
    const rows = this.db.prepare("SELECT value FROM records WHERE namespace = ?").all(namespace) as Row[];
    return rows.map((row) => this.decodeRecordValue<T>(JSON.parse(row.value)));
  }

  private delete(namespace: Namespace, key: string): void {
    this.db.prepare("DELETE FROM records WHERE namespace = ? AND key = ?").run(namespace, key);
  }

  private rewriteEncryptedRecords(enabled: boolean): void {
    const rows = this.db.prepare("SELECT namespace, key, value FROM records WHERE namespace <> ?").all("preferences") as NamespacedRow[];
    const update = this.db.prepare("UPDATE records SET value = ? WHERE namespace = ? AND key = ?");
    const rewrite = this.db.transaction((records: NamespacedRow[]) => {
      for (const row of records) {
        const decoded = this.decodeRecordValue<unknown>(JSON.parse(row.value));
        const stored = enabled ? this.encryptRecordValue(decoded) : decoded;
        update.run(JSON.stringify(stored), row.namespace, row.key);
      }
    });
    rewrite(rows);
  }

  private isStorageEncryptionEnabled(): boolean {
    const row = this.db.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get("preferences", "default") as Row | undefined;
    if (!row) return false;
    try {
      const preferences = this.decodeRecordValue<{ encryptStorage?: unknown }>(JSON.parse(row.value));
      return preferences.encryptStorage === true;
    } catch {
      return false;
    }
  }

  private encryptRecordValue(value: unknown): EncryptedRecordEnvelope {
    return {
      __sccEncrypted: true,
      algorithm: "local-secret-box-v1",
      payload: this.storageSecretBox().encrypt(JSON.stringify(value))
    };
  }

  private decodeRecordValue<T>(value: unknown): T {
    if (!isEncryptedRecordEnvelope(value)) return value as T;
    return JSON.parse(this.storageSecretBox().decrypt(value.payload)) as T;
  }

  private storageSecretBox(): LocalSecretBox {
    this.secretBox ??= new LocalSecretBox();
    return this.secretBox;
  }
}

function isEncryptedRecordEnvelope(value: unknown): value is EncryptedRecordEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EncryptedRecordEnvelope>;
  return record.__sccEncrypted === true && record.algorithm === "local-secret-box-v1" && Boolean(record.payload);
}
