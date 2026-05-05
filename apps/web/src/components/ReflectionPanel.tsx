import type { ReflectionSession, SkillConflict, SkillDuplicateGroup } from "@scc/shared";
import { AlertCircle, GitMerge, RefreshCcw, Sparkles } from "lucide-react";

export function ReflectionPanel({
  conflicts,
  duplicates,
  language,
  reflections,
  onRunReflection
}: {
  conflicts: SkillConflict[];
  duplicates: SkillDuplicateGroup[];
  language?: string | null;
  reflections: ReflectionSession[];
  onRunReflection?: () => Promise<void> | void;
}) {
  const text = getReflectionCopy(language);
  const safeReflections = Array.isArray(reflections) ? reflections : [];
  const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
  const safeDuplicates = Array.isArray(duplicates) ? duplicates : [];

  return (
    <section className="reflectionPanel">
      <header className="libraryPanelHero">
        <div>
          <h3>{text.title}</h3>
          <p>{text.subtitle}</p>
        </div>
        <button className="subtleButton iconText" type="button" onClick={() => void onRunReflection?.()}>
          <RefreshCcw size={15} />
          {text.run}
        </button>
      </header>

      <div className="reflectionSummaryGrid">
        <article>
          <Sparkles size={17} aria-hidden="true" />
          <strong>{safeReflections.length}</strong>
          <span>{text.sessions}</span>
        </article>
        <article>
          <GitMerge size={17} aria-hidden="true" />
          <strong>{safeDuplicates.length}</strong>
          <span>{text.duplicates}</span>
        </article>
        <article className={safeConflicts.length > 0 ? "warning" : ""}>
          <AlertCircle size={17} aria-hidden="true" />
          <strong>{safeConflicts.length}</strong>
          <span>{text.conflicts}</span>
        </article>
      </div>

      <div className="reflectionList">
        {safeReflections.length === 0 ? (
          <div className="libraryEmpty">
            <Sparkles size={22} aria-hidden="true" />
            <strong>{text.emptyTitle}</strong>
            <p>{text.emptyBody}</p>
          </div>
        ) : null}
        {safeReflections.slice(0, 12).map((reflection) => (
          <article className="reflectionRow" key={reflection.id}>
            <div>
              <strong>{reflection.progress.phase}</strong>
              <p>{reflection.progress.nextStep || text.noNextStep}</p>
            </div>
            <span>{reflection.status}</span>
            <small>{new Date(reflection.createdAt).toLocaleString()}</small>
          </article>
        ))}
      </div>
    </section>
  );
}

function getReflectionCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "Agent 反思" : "Agent reflections",
    subtitle: zh ? "这里展示学习建议和阻塞原因，不把内部记忆直接塞给用户。" : "Learning suggestions and blockers without exposing raw internal memory.",
    run: zh ? "运行反思" : "Run reflection",
    sessions: zh ? "次反思" : "sessions",
    duplicates: zh ? "组重复" : "duplicate groups",
    conflicts: zh ? "个冲突" : "conflicts",
    emptyTitle: zh ? "还没有反思记录" : "No reflections yet",
    emptyBody: zh ? "完成更多任务后，SCC 会把稳定模式整理为候选建议。" : "After more completed tasks, SCC will summarize stable patterns as suggestions.",
    noNextStep: zh ? "暂无下一步。" : "No next step."
  };
}
