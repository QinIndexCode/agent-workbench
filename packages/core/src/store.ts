import type {
  ConversationSummary,
  ExperienceRecord,
  GlobalPermissionGrant,
  KnowledgeItem,
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
  TaskDetail,
  TaskFolderRecord,
  TaskMemory,
  ToolApproval,
  UserPreferences,
  WebSearchProviderConfig
} from "@scc/shared";
import { normalizeSkillRecord } from "./experience.js";
import { findWorkspaceRoot } from "./workspace-root.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface WorkbenchStore {
  saveTask(task: TaskDetail): Promise<void>;
  getTask(taskId: string): Promise<TaskDetail | undefined>;
  listTasks(): Promise<TaskDetail[]>;
  deleteTask(taskId: string): Promise<void>;
  saveTaskAttachment(record: TaskAttachment): Promise<void>;
  getTaskAttachment(attachmentId: string): Promise<TaskAttachment | undefined>;
  listTaskAttachments(taskId?: string): Promise<TaskAttachment[]>;
  deleteTaskAttachment(attachmentId: string): Promise<void>;
  saveConversationSummary(record: ConversationSummary): Promise<void>;
  listConversationSummaries(taskId?: string): Promise<ConversationSummary[]>;
  deleteConversationSummary(summaryId: string): Promise<void>;
  saveTaskFolder(record: TaskFolderRecord): Promise<void>;
  getTaskFolder(folderId: string): Promise<TaskFolderRecord | undefined>;
  listTaskFolders(): Promise<TaskFolderRecord[]>;
  deleteTaskFolder(folderId: string): Promise<void>;
  saveExperience(record: ExperienceRecord): Promise<void>;
  listExperiences(): Promise<ExperienceRecord[]>;
  deleteExperience(experienceId: string): Promise<void>;
  saveTaskMemory(record: TaskMemory): Promise<void>;
  listTaskMemories(): Promise<TaskMemory[]>;
  deleteTaskMemory(memoryId: string): Promise<void>;
  savePattern(record: PatternRecord): Promise<void>;
  listPatterns(): Promise<PatternRecord[]>;
  saveSkill(record: SkillRecord): Promise<void>;
  listSkills(): Promise<SkillRecord[]>;
  getSkill(skillId: string): Promise<SkillRecord | undefined>;
  deleteSkill(skillId: string): Promise<void>;
  saveSkillConflict(record: SkillConflict): Promise<void>;
  listSkillConflicts(): Promise<SkillConflict[]>;
  saveMcpServer(record: McpServerConfig): Promise<void>;
  getMcpServer(serverId: string): Promise<McpServerConfig | undefined>;
  listMcpServers(): Promise<McpServerConfig[]>;
  deleteMcpServer(serverId: string): Promise<void>;
  saveGlobalPermission(record: GlobalPermissionGrant): Promise<void>;
  listGlobalPermissions(): Promise<GlobalPermissionGrant[]>;
  deleteGlobalPermission(riskCategory: RiskCategory): Promise<void>;
  getPreferences(): Promise<UserPreferences>;
  savePreferences(preferences: UserPreferences): Promise<void>;
  saveModelProvider(record: ModelProviderRecord): Promise<void>;
  getModelProvider(providerId: string): Promise<ModelProviderRecord | undefined>;
  listModelProviders(): Promise<ModelProviderRecord[]>;
  deleteModelProvider(providerId: string): Promise<void>;
  saveModelProviderSecret(providerId: string, secret: EncryptedSecretValue): Promise<void>;
  getModelProviderSecret(providerId: string): Promise<EncryptedSecretValue | undefined>;
  deleteModelProviderSecret(providerId: string): Promise<void>;
  saveScheduledTask(record: ScheduledTask): Promise<void>;
  getScheduledTask(taskId: string): Promise<ScheduledTask | undefined>;
  listScheduledTasks(): Promise<ScheduledTask[]>;
  deleteScheduledTask(taskId: string): Promise<void>;
  saveWebSearchProvider(record: WebSearchProviderConfig): Promise<void>;
  getWebSearchProvider(providerId: string): Promise<WebSearchProviderConfig | undefined>;
  listWebSearchProviders(): Promise<WebSearchProviderConfig[]>;
  deleteWebSearchProvider(providerId: string): Promise<void>;
  saveWebSearchProviderSecret(providerId: string, secret: EncryptedSecretValue): Promise<void>;
  getWebSearchProviderSecret(providerId: string): Promise<EncryptedSecretValue | undefined>;
  deleteWebSearchProviderSecret(providerId: string): Promise<void>;
  saveReflectionSession(session: ReflectionSession): Promise<void>;
  listReflectionSessions(): Promise<ReflectionSession[]>;
  saveProjectMemory(record: ProjectMemory): Promise<void>;
  listProjectMemories(projectId?: string): Promise<ProjectMemory[]>;
  deleteProjectMemory(id: string): Promise<void>;
  saveKnowledgeItem(record: KnowledgeItem): Promise<void>;
  getKnowledgeItem(id: string): Promise<KnowledgeItem | undefined>;
  listKnowledgeItems(projectId?: string): Promise<KnowledgeItem[]>;
  deleteKnowledgeItem(id: string): Promise<void>;
}

export interface EncryptedSecretValue {
  algorithm: "aes-256-gcm";
  iv: string;
  authTag: string;
  value: string;
  updatedAt: string;
}

export class InMemoryWorkbenchStore implements WorkbenchStore {
  private readonly tasks = new Map<string, TaskDetail>();
  private readonly taskAttachments = new Map<string, TaskAttachment>();
  private readonly conversationSummaries = new Map<string, ConversationSummary>();
  private readonly taskFolders = new Map<string, TaskFolderRecord>();
  private readonly experiences = new Map<string, ExperienceRecord>();
  private readonly taskMemories = new Map<string, TaskMemory>();
  private readonly patterns = new Map<string, PatternRecord>();
  private readonly skills = new Map<string, SkillRecord>();
  private readonly skillConflicts = new Map<string, SkillConflict>();
  private readonly mcpServers = new Map<string, McpServerConfig>();
  private readonly globalPermissions = new Map<RiskCategory, GlobalPermissionGrant>();
  private readonly modelProviders = new Map<string, ModelProviderRecord>();
  private readonly modelProviderSecrets = new Map<string, EncryptedSecretValue>();
  private readonly scheduledTasks = new Map<string, ScheduledTask>();
  private readonly webSearchProviders = new Map<string, WebSearchProviderConfig>();
  private readonly webSearchProviderSecrets = new Map<string, EncryptedSecretValue>();
  private readonly reflectionSessions = new Map<string, ReflectionSession>();
  private readonly projectMemories = new Map<string, ProjectMemory>();
  private readonly knowledgeItems = new Map<string, KnowledgeItem>();
  private preferences: UserPreferences | null = null;

  async saveTask(task: TaskDetail): Promise<void> {
    this.tasks.set(task.id, normalizeTaskDetail(clone(task)));
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    const task = this.tasks.get(taskId);
    return task ? normalizeTaskDetail(clone(task)) : undefined;
  }

  async listTasks(): Promise<TaskDetail[]> {
    return [...this.tasks.values()]
      .map((task) => normalizeTaskDetail(clone(task)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }

  async saveTaskAttachment(record: TaskAttachment): Promise<void> {
    this.taskAttachments.set(record.id, clone(record));
  }

  async getTaskAttachment(attachmentId: string): Promise<TaskAttachment | undefined> {
    const record = this.taskAttachments.get(attachmentId);
    return record ? clone(record) : undefined;
  }

  async listTaskAttachments(taskId?: string): Promise<TaskAttachment[]> {
    return [...this.taskAttachments.values()]
      .filter((record) => !taskId || record.taskId === taskId)
      .map((record) => clone(record))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteTaskAttachment(attachmentId: string): Promise<void> {
    this.taskAttachments.delete(attachmentId);
  }

  async saveConversationSummary(record: ConversationSummary): Promise<void> {
    this.conversationSummaries.set(record.id, clone(record));
  }

  async listConversationSummaries(taskId?: string): Promise<ConversationSummary[]> {
    return [...this.conversationSummaries.values()]
      .filter((record) => !taskId || record.taskId === taskId)
      .map((record) => clone(record))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async deleteConversationSummary(summaryId: string): Promise<void> {
    this.conversationSummaries.delete(summaryId);
  }

  async saveTaskFolder(record: TaskFolderRecord): Promise<void> {
    this.taskFolders.set(record.id, normalizeTaskFolderRecord(clone(record)));
  }

  async getTaskFolder(folderId: string): Promise<TaskFolderRecord | undefined> {
    const folder = this.taskFolders.get(folderId);
    return folder ? normalizeTaskFolderRecord(clone(folder)) : undefined;
  }

  async listTaskFolders(): Promise<TaskFolderRecord[]> {
    return [...this.taskFolders.values()].map((record) => normalizeTaskFolderRecord(clone(record))).sort(compareTaskFolders);
  }

  async deleteTaskFolder(folderId: string): Promise<void> {
    this.taskFolders.delete(folderId);
  }

  async saveExperience(record: ExperienceRecord): Promise<void> {
    this.experiences.set(record.id, clone(record));
  }

  async listExperiences(): Promise<ExperienceRecord[]> {
    return [...this.experiences.values()].map((record) => clone(record));
  }

  async deleteExperience(experienceId: string): Promise<void> {
    this.experiences.delete(experienceId);
  }

  async saveTaskMemory(record: TaskMemory): Promise<void> {
    this.taskMemories.set(record.id, clone(record));
  }

  async listTaskMemories(): Promise<TaskMemory[]> {
    return [...this.taskMemories.values()].map((record) => clone(record));
  }

  async deleteTaskMemory(memoryId: string): Promise<void> {
    this.taskMemories.delete(memoryId);
  }

  async savePattern(record: PatternRecord): Promise<void> {
    this.patterns.set(record.id, clone(record));
  }

  async listPatterns(): Promise<PatternRecord[]> {
    return [...this.patterns.values()].map((record) => clone(record));
  }

  async saveSkill(record: SkillRecord): Promise<void> {
    const normalized = normalizeSkillRecord(record);
    this.skills.set(normalized.id, clone(normalized));
  }

  async listSkills(): Promise<SkillRecord[]> {
    return [...this.skills.values()].map((record) => normalizeSkillRecord(clone(record)));
  }

  async getSkill(skillId: string): Promise<SkillRecord | undefined> {
    const skill = this.skills.get(skillId);
    return skill ? normalizeSkillRecord(clone(skill)) : undefined;
  }

  async deleteSkill(skillId: string): Promise<void> {
    this.skills.delete(skillId);
  }

  async saveSkillConflict(record: SkillConflict): Promise<void> {
    this.skillConflicts.set(record.id, clone(record));
  }

  async listSkillConflicts(): Promise<SkillConflict[]> {
    return [...this.skillConflicts.values()].map((record) => clone(record));
  }

  async saveMcpServer(record: McpServerConfig): Promise<void> {
    this.mcpServers.set(record.id, clone(record));
  }

  async getMcpServer(serverId: string): Promise<McpServerConfig | undefined> {
    const server = this.mcpServers.get(serverId);
    return server ? clone(server) : undefined;
  }

  async listMcpServers(): Promise<McpServerConfig[]> {
    return [...this.mcpServers.values()].map((record) => clone(record)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteMcpServer(serverId: string): Promise<void> {
    this.mcpServers.delete(serverId);
  }

  async saveGlobalPermission(record: GlobalPermissionGrant): Promise<void> {
    this.globalPermissions.set(record.riskCategory, clone(record));
  }

  async listGlobalPermissions(): Promise<GlobalPermissionGrant[]> {
    return [...this.globalPermissions.values()].map((record) => clone(record));
  }

  async deleteGlobalPermission(riskCategory: RiskCategory): Promise<void> {
    this.globalPermissions.delete(riskCategory);
  }

  async getPreferences(): Promise<UserPreferences> {
    if (!this.preferences) this.preferences = defaultPreferences();
    return clone(this.preferences);
  }

  async savePreferences(preferences: UserPreferences): Promise<void> {
    this.preferences = clone(preferences);
  }

  async saveModelProvider(record: ModelProviderRecord): Promise<void> {
    this.modelProviders.set(record.id, clone(record));
  }

  async getModelProvider(providerId: string): Promise<ModelProviderRecord | undefined> {
    const provider = this.modelProviders.get(providerId);
    return provider ? clone(provider) : undefined;
  }

  async listModelProviders(): Promise<ModelProviderRecord[]> {
    return [...this.modelProviders.values()].map((record) => clone(record)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteModelProvider(providerId: string): Promise<void> {
    this.modelProviders.delete(providerId);
  }

  async saveModelProviderSecret(providerId: string, secret: EncryptedSecretValue): Promise<void> {
    this.modelProviderSecrets.set(providerId, clone(secret));
  }

  async getModelProviderSecret(providerId: string): Promise<EncryptedSecretValue | undefined> {
    const secret = this.modelProviderSecrets.get(providerId);
    return secret ? clone(secret) : undefined;
  }

  async deleteModelProviderSecret(providerId: string): Promise<void> {
    this.modelProviderSecrets.delete(providerId);
  }

  async saveScheduledTask(record: ScheduledTask): Promise<void> {
    this.scheduledTasks.set(record.id, clone(record));
  }

  async getScheduledTask(taskId: string): Promise<ScheduledTask | undefined> {
    const record = this.scheduledTasks.get(taskId);
    return record ? clone(record) : undefined;
  }

  async listScheduledTasks(): Promise<ScheduledTask[]> {
    return [...this.scheduledTasks.values()].map((record) => clone(record)).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt));
  }

  async deleteScheduledTask(taskId: string): Promise<void> {
    this.scheduledTasks.delete(taskId);
  }

  async saveWebSearchProvider(record: WebSearchProviderConfig): Promise<void> {
    this.webSearchProviders.set(record.id, clone(record));
  }

  async getWebSearchProvider(providerId: string): Promise<WebSearchProviderConfig | undefined> {
    const record = this.webSearchProviders.get(providerId);
    return record ? clone(record) : undefined;
  }

  async listWebSearchProviders(): Promise<WebSearchProviderConfig[]> {
    return [...this.webSearchProviders.values()].map((record) => clone(record)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async deleteWebSearchProvider(providerId: string): Promise<void> {
    this.webSearchProviders.delete(providerId);
  }

  async saveWebSearchProviderSecret(providerId: string, secret: EncryptedSecretValue): Promise<void> {
    this.webSearchProviderSecrets.set(providerId, clone(secret));
  }

  async getWebSearchProviderSecret(providerId: string): Promise<EncryptedSecretValue | undefined> {
    const secret = this.webSearchProviderSecrets.get(providerId);
    return secret ? clone(secret) : undefined;
  }

  async deleteWebSearchProviderSecret(providerId: string): Promise<void> {
    this.webSearchProviderSecrets.delete(providerId);
  }

  async saveReflectionSession(session: ReflectionSession): Promise<void> {
    this.reflectionSessions.set(session.id, clone(session));
  }

  async listReflectionSessions(): Promise<ReflectionSession[]> {
    return [...this.reflectionSessions.values()].map((record) => clone(record));
  }

  async saveProjectMemory(record: ProjectMemory): Promise<void> {
    this.projectMemories.set(record.id, clone(record));
  }

  async listProjectMemories(projectId?: string): Promise<ProjectMemory[]> {
    return [...this.projectMemories.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .map((record) => clone(record));
  }

  async deleteProjectMemory(id: string): Promise<void> {
    this.projectMemories.delete(id);
  }

  async saveKnowledgeItem(record: KnowledgeItem): Promise<void> {
    this.knowledgeItems.set(record.id, clone(record));
  }

  async getKnowledgeItem(id: string): Promise<KnowledgeItem | undefined> {
    const item = this.knowledgeItems.get(id);
    return item ? clone(item) : undefined;
  }

  async listKnowledgeItems(projectId?: string): Promise<KnowledgeItem[]> {
    return [...this.knowledgeItems.values()]
      .filter((record) => !projectId || record.projectId === projectId)
      .map((record) => clone(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async deleteKnowledgeItem(id: string): Promise<void> {
    this.knowledgeItems.delete(id);
  }
}

export function pendingApprovals(task: TaskDetail): ToolApproval[] {
  return task.approvals.filter((approval) => approval.status === "pending");
}

export function normalizeTaskDetail(task: TaskDetail): TaskDetail {
  return {
    ...task,
    folderId: task.folderId || "default",
    workRoot: task.workRoot || findWorkspaceRoot()
  };
}

export function normalizeTaskFolderRecord(record: TaskFolderRecord): TaskFolderRecord {
  const rootPath = record.rootPath?.trim() || findWorkspaceRoot();
  return {
    ...record,
    rootPath,
    isDefault: record.id === "default" || Boolean(record.isDefault),
    exists: record.exists ?? true
  };
}

function compareTaskFolders(a: TaskFolderRecord, b: TaskFolderRecord): number {
  return a.sortOrder - b.sortOrder || a.name.localeCompare(b.name);
}

export function defaultPreferences(): UserPreferences {
  return {
    llmProvider: "mimo",
    activeModelProviderId: undefined,
    defaultModel: "mimo-v2.5",
    providerBaseUrl: "",
    contextMode: "auto",
    customModelContextWindow: 128000,
    maxTokensPerRequest: 128000,
    autoApprove: "none",
    showThinking: true,
    language: "zh-CN",
    agentTone: "balanced",
    emojiStyle: "auto",
    agentRole: "Pragmatic engineering assistant",
    responseDetail: "normal",
    reflectionEnabled: true,
    reflectionSchedule: "02:00",
    skillAutoInject: true,
    maxInjectedSkills: 3,
    mcpApprovalMode: "confirm_dangerous",
    sanitizeSensitiveData: true,
    encryptStorage: false,
    updatedAt: new Date().toISOString()
  };
}
