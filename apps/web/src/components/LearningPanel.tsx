import type { PatternRecord, ReflectionSession, SkillConflict, TaskMemory } from "@scc/shared";
import { describeReflectionPhase, describeReflectionStatus } from "./skillUx.js";

export function LearningPanel({
  memories,
  patterns,
  conflicts,
  reflections,
  onRunReflection
}: {
  memories: TaskMemory[];
  patterns: PatternRecord[];
  conflicts: SkillConflict[];
  reflections: ReflectionSession[];
  onRunReflection: () => void;
}) {
  const safeMemories = Array.isArray(memories) ? memories : [];
  const safePatterns = Array.isArray(patterns) ? patterns : [];
  const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
  const safeReflections = Array.isArray(reflections) ? reflections : [];

  return (
    <section>
      <div className="panelHeader">
        <h2>Learning</h2>
        <button className="subtleButton" onClick={onRunReflection}>
          Reflect
        </button>
      </div>
      <CompactList
        title="Task Memory"
        rows={safeMemories.map((item) => ({
          id: item.id,
          label: item.title,
          meta: item.reflectionStatus ?? "pending"
        }))}
      />
      <CompactList
        title="Patterns"
        rows={safePatterns.map((item) => ({
          id: item.id,
          label: item.title,
          meta: item.status ?? "forming"
        }))}
      />
      <section className="compactList">
        <h3>Conflicts</h3>
        {safeConflicts.length === 0 ? <p className="muted">None yet</p> : null}
        {safeConflicts.slice(0, 6).map((item) => (
          <div className={`compactRow conflict ${item.severity ?? "low"}`} key={item.id}>
            <span>{item.reason ?? "Potential skill conflict"}</span>
            <small>
              {item.severity ?? "low"} · {item.status ?? "open"} · {item.skillIds?.length ?? 0} skills
            </small>
          </div>
        ))}
      </section>
      <CompactList
        title="Reflections"
        rows={safeReflections.slice(0, 4).map((item) => ({
          id: item.id,
          label: describeReflectionPhase(item.progress?.phase ?? "reflection"),
          meta: describeReflectionStatus(item.status)
        }))}
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
          <span>{row.label || row.id}</span>
          <small>{row.meta || "unknown"}</small>
        </div>
      ))}
    </section>
  );
}
