import type { PatternRecord, ReflectionSession, SkillRecord, TaskMemory } from "@scc/shared";

export function LearningPanel({
  memories,
  patterns,
  skills,
  reflections,
  onRunReflection,
  onSkillStatus
}: {
  memories: TaskMemory[];
  patterns: PatternRecord[];
  skills: SkillRecord[];
  reflections: ReflectionSession[];
  onRunReflection: () => void;
  onSkillStatus: (skillId: string, status: SkillRecord["status"]) => void;
}) {
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
      <section className="compactList">
        <h3>Skills</h3>
        {skills.length === 0 ? <p className="muted">None yet</p> : null}
        {skills.map((skill) => (
          <div className="compactRow" key={skill.id}>
            <span>{skill.title}</span>
            <small>{skill.status}</small>
            <select value={skill.status} onChange={(event) => onSkillStatus(skill.id, event.target.value as SkillRecord["status"])}>
              <option value="candidate">candidate</option>
              <option value="active">active</option>
              <option value="suspended">suspended</option>
              <option value="retired">retired</option>
            </select>
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
