import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type {
  ExperienceRecord,
  GlobalPermissionGrant,
  KnowledgeItem,
  McpServerConfig,
  ModelProviderRecord,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  RiskCategory,
  SkillConflict,
  SkillRecord,
  TaskDetail,
  TaskFolderRecord,
  TaskMemory,
  UserPreferences
} from "@scc/shared";
import { defaultPreferences, normalizeSkillRecord, normalizeTaskDetail, type EncryptedSecretValue, type WorkbenchStore } from "@scc/core";

type Namespace =
  | "tasks"
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
  | "preferences"
  | "reflection_sessions"
  | "project_memories"
  | "knowledge_items";
type Row = { key: string; value: string };

export class SqliteWorkbenchStore implements WorkbenchStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db.pragma("journal_mode = WAL");
    this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))"
      )
      .run();
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

  async saveTaskFolder(record: TaskFolderRecord): Promise<void> {
    this.upsert("task_folders", record.id, record);
  }

  async getTaskFolder(folderId: string): Promise<TaskFolderRecord | undefined> {
    return this.get<TaskFolderRecord>("task_folders", folderId);
  }

  async listTaskFolders(): Promise<TaskFolderRecord[]> {
    return this.list<TaskFolderRecord>("task_folders").sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
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
    if (stored) return { ...defaultPreferences(), ...stored };
    const created = defaultPreferences();
    await this.savePreferences(created);
    return created;
  }

  async savePreferences(preferences: UserPreferences): Promise<void> {
    this.upsert("preferences", "default", preferences);
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

  async saveReflectionSession(session: ReflectionSession): Promise<void> {
    this.upsert("reflection_sessions", session.id, session);
  }

  async listReflectionSessions(): Promise<ReflectionSession[]> {
    return this.list<ReflectionSession>("reflection_sessions").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
    this.upsert("knowledge_items", record.id, record);
  }

  async getKnowledgeItem(id: string): Promise<KnowledgeItem | undefined> {
    return this.get<KnowledgeItem>("knowledge_items", id);
  }

  async listKnowledgeItems(projectId?: string): Promise<KnowledgeItem[]> {
    return this.list<KnowledgeItem>("knowledge_items")
      .filter((record) => !projectId || record.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteKnowledgeItem(id: string): Promise<void> {
    this.delete("knowledge_items", id);
  }

  close(): void {
    this.db.close();
  }

  private upsert(namespace: Namespace, key: string, value: unknown): void {
    this.db
      .prepare("INSERT INTO records(namespace, key, value) VALUES (?, ?, ?) ON CONFLICT(namespace, key) DO UPDATE SET value=excluded.value")
      .run(namespace, key, JSON.stringify(value));
  }

  private get<T>(namespace: Namespace, key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE namespace = ? AND key = ?").get(namespace, key) as
      | Row
      | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  private list<T>(namespace: Namespace): T[] {
    const rows = this.db.prepare("SELECT value FROM records WHERE namespace = ?").all(namespace) as Row[];
    return rows.map((row) => JSON.parse(row.value) as T);
  }

  private delete(namespace: Namespace, key: string): void {
    this.db.prepare("DELETE FROM records WHERE namespace = ? AND key = ?").run(namespace, key);
  }
}
