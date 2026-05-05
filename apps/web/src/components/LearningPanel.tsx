import { useState } from "react";
import type { PatternRecord, ReflectionSession, SkillConflict, SkillRecord, TaskMemory } from "@scc/shared";

export function LearningPanel({
  memories,
  patterns,
  skills,
  conflicts,
  reflections,
  onRunReflection,
  onSkillStatus,
  onExportSkill
}: {
  memories: TaskMemory[];
  patterns: PatternRecord[];
  skills: SkillRecord[];
  conflicts: SkillConflict[];
  reflections: ReflectionSession[];
  onRunReflection: () => void;
  onSkillStatus: (skillId: string, status: SkillRecord["status"]) => void;
  onExportSkill: (skillId: string) => void;
}) {
  const [statusFilter, setStatusFilter] = useState<SkillRecord["status"] | "all">("all");
  const visibleSkills = statusFilter === "all" ? skills : skills.filter((skill) => skill.status === statusFilter);

  return (
    <section>
      <div className="panelHeader">
        <h2>Learning</h2>
        <button className="subtleButton" onClick={onRunReflection}>
          Reflect
        </button>
      </div>
      <CompactList title="Task Memory" rows={memories.map((item) => ({ id: item.id, label: item.title, meta: item.reflectionStatus }))} />
      <CompactList title="Patterns" rows={patterns.map((item) => ({ id: item.id, label: item.title, meta: item.status }))} />
      <CompactList title="Conflicts" rows={conflicts.map((item) => ({ id: item.id, label: item.reason, meta: item.severity }))} />
      <section className="compactList">
        <div className="panelHeader">
          <h3>Skills</h3>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SkillRecord["status"] | "all")}>
            <option value="all">all</option>
            <option value="candidate">candidate</option>
            <option value="active">active</option>
            <option value="suspended">suspended</option>
            <option value="retired">retired</option>
          </select>
        </div>
        {visibleSkills.length === 0 ? <p className="muted">None yet</p> : null}
        {visibleSkills.map((skill) => (
          <div className="compactRow" key={skill.id}>
            <span>{skill.title}</span>
            <small>
              {skill.status} · {Math.round(skill.stats.successRate * 100)}% · {skill.stats.totalUses} uses
            </small>
            <select value={skill.status} onChange={(event) => onSkillStatus(skill.id, event.target.value as SkillRecord["status"])}>
              <option value="candidate">candidate</option>
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="retired">retired</option>
            </select>
            <button className="textButton" type="button" onClick={() => onExportSkill(skill.id)}>
              Export
            </button>
          </div>
        ))}
      </section>
      <CompactList
        title="Reflections"
        rows={reflections.slice(0, 4).map((item) => ({ id: item.id, label: item.progress.phase, meta: item.status }))}
      />
    </section>
  );
}

export function CompactList({ title, rows }: { title: string; rows: Array<{ id: string; label: string; meta: string }> }) {
  return (
    <section className="compactList">
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="muted">None yet</p> : null}
      {rows.slice(0, 6).map((row) => (
        <div className="compactRow" key={row.id}>
          <span>{row.label}</span>
          <small>{row.meta}</small>
        </div>
      ))}
    </section>
  );
}
