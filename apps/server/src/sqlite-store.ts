import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { ExperienceRecord, SkillRecord, TaskDetail } from "@scc/shared";
import type { WorkbenchStore } from "@scc/core";

type Namespace = "tasks" | "experiences" | "skills";
type Row = { key: string; value: string };

export class SqliteWorkbenchStore implements WorkbenchStore {
  private readonly db: Database.Database;

  constructor(filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.db = new Database(filePath);
    this.db
      .prepare(
        "CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace, key))"
      )
      .run();
  }

  async saveTask(task: TaskDetail): Promise<void> {
    this.upsert("tasks", task.id, task);
  }

  async getTask(taskId: string): Promise<TaskDetail | undefined> {
    return this.get<TaskDetail>("tasks", taskId);
  }

  async listTasks(): Promise<TaskDetail[]> {
    return this.list<TaskDetail>("tasks").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async saveExperience(record: ExperienceRecord): Promise<void> {
    this.upsert("experiences", record.id, record);
  }

  async listExperiences(): Promise<ExperienceRecord[]> {
    return this.list<ExperienceRecord>("experiences");
  }

  async saveSkill(record: SkillRecord): Promise<void> {
    this.upsert("skills", record.id, record);
  }

  async listSkills(): Promise<SkillRecord[]> {
    return this.list<SkillRecord>("skills");
  }

  async getSkill(skillId: string): Promise<SkillRecord | undefined> {
    return this.get<SkillRecord>("skills", skillId);
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
}
