import type { ExperienceRecord, SkillRecord, TaskDetail, ToolApproval } from "@scc/shared";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface WorkbenchStore {
  saveTask(task: TaskDetail): Promise<void>;
  getTask(taskId: string): Promise<TaskDetail | undefined>;
  listTasks(): Promise<TaskDetail[]>;
  saveExperience(record: ExperienceRecord): Promise<void>;
  listExperiences(): Promise<ExperienceRecord[]>;
  saveSkill(record: SkillRecord): Promise<void>;
  listSkills(): Promise<SkillRecord[]>;
  getSkill(skillId: string): Promise<SkillRecord | undefined>;
}

export class InMemoryWorkbenchStore implements WorkbenchStore {
  private readonly tasks = new Map<string, TaskDetail>();
  private readonly experiences = new Map<string, ExperienceRecord>();
  private readonly skills = new Map<string, SkillRecord>();

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
}

export function pendingApprovals(task: TaskDetail): ToolApproval[] {
  return task.approvals.filter((approval) => approval.status === "pending");
}
