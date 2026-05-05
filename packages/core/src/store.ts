import type {
  ExperienceRecord,
  GlobalPermissionGrant,
  McpServerConfig,
  PatternRecord,
  ProjectMemory,
  ReflectionSession,
  RiskCategory,
  SkillConflict,
  SkillRecord,
  TaskDetail,
  TaskMemory,
  ToolApproval,
  UserPreferences
} from "@scc/shared";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface WorkbenchStore {
  saveTask(task: TaskDetail): Promise<void>;
  getTask(taskId: string): Promise<TaskDetail | undefined>;
  listTasks(): Promise<TaskDetail[]>;
  saveExperience(record: ExperienceRecord): Promise<void>;
  listExperiences(): Promise<ExperienceRecord[]>;
  saveTaskMemory(record: TaskMemory): Promise<void>;
  listTaskMemories(): Promise<TaskMemory[]>;
  savePattern(record: PatternRecord): Promise<void>;
  listPatterns(): Promise<PatternRecord[]>;
  saveSkill(record: SkillRecord): Promise<void>;
  listSkills(): Promise<SkillRecord[]>;
  getSkill(skillId: string): Promise<SkillRecord | undefined>;
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
  saveReflectionSession(session: ReflectionSession): Promise<void>;
  listReflectionSessions(): Promise<ReflectionSession[]>;
  saveProjectMemory(record: ProjectMemory): Promise<void>;
  listProjectMemories(projectId?: string): Promise<ProjectMemory[]>;
  deleteProjectMemory(id: string): Promise<void>;
}

export class InMemoryWorkbenchStore implements WorkbenchStore {
  private readonly tasks = new Map<string, TaskDetail>();
  private readonly experiences = new Map<string, ExperienceRecord>();
  private readonly taskMemories = new Map<string, TaskMemory>();
  private readonly patterns = new Map<string, PatternRecord>();
  private readonly skills = new Map<string, SkillRecord>();
  private readonly skillConflicts = new Map<string, SkillConflict>();
  private readonly mcpServers = new Map<string, McpServerConfig>();
  private readonly globalPermissions = new Map<RiskCategory, GlobalPermissionGrant>();
  private readonly reflectionSessions = new Map<string, ReflectionSession>();
  private readonly projectMemories = new Map<string, ProjectMemory>();
  private preferences: UserPreferences | null = null;

  async saveTask(task: TaskDetail): Promise<void> {
    this.tasks.set(task.id, clone(task));
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    const task = this.tasks.get(taskId);
    return task ? clone(task) : undefined;
  }

  async listTasks(): Promise<TaskDetail[]> {
    return [...this.tasks.values()]
      .map((task) => clone(task))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveExperience(record: ExperienceRecord): Promise<void> {
    this.experiences.set(record.id, clone(record));
  }

  async listExperiences(): Promise<ExperienceRecord[]> {
    return [...this.experiences.values()].map((record) => clone(record));
  }

  async saveTaskMemory(record: TaskMemory): Promise<void> {
    this.taskMemories.set(record.id, clone(record));
  }

  async listTaskMemories(): Promise<TaskMemory[]> {
    return [...this.taskMemories.values()].map((record) => clone(record));
  }

  async savePattern(record: PatternRecord): Promise<void> {
    this.patterns.set(record.id, clone(record));
  }

  async listPatterns(): Promise<PatternRecord[]> {
    return [...this.patterns.values()].map((record) => clone(record));
  }

  async saveSkill(record: SkillRecord): Promise<void> {
    this.skills.set(record.id, clone(record));
  }

  async listSkills(): Promise<SkillRecord[]> {
    return [...this.skills.values()].map((record) => clone(record));
  }

  async getSkill(skillId: string): Promise<SkillRecord | undefined> {
    const skill = this.skills.get(skillId);
    return skill ? clone(skill) : undefined;
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
}

export function pendingApprovals(task: TaskDetail): ToolApproval[] {
  return task.approvals.filter((approval) => approval.status === "pending");
}

export function defaultPreferences(): UserPreferences {
  return {
    defaultModel: "gpt-5.4-mini",
    maxTokensPerRequest: 128000,
    autoApprove: "none",
    showThinking: true,
    language: "zh-CN",
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
