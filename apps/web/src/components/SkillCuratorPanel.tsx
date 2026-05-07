import type { SkillCuratorItem } from "@scc/shared";
import { CheckCircle2, GitMerge, PauseCircle, RefreshCcw, Sparkles } from "lucide-react";

export function SkillCuratorPanel({
  items,
  language,
  onActivateSkill,
  onMergeDuplicate,
  onRunReflection,
  onSuspendSkill
}: {
  items: SkillCuratorItem[];
  language?: string | null;
  onActivateSkill: (skillId: string) => Promise<void> | void;
  onMergeDuplicate: (skillIds: string[]) => Promise<void> | void;
  onRunReflection?: () => Promise<void> | void;
  onSuspendSkill: (skillId: string) => Promise<void> | void;
}) {
  const text = getCuratorCopy(language);
  const reviewItems = Array.isArray(items) ? items : [];

  return (
    <section className="curatorPanel">
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

      <div className="curatorRows">
        {reviewItems.length === 0 ? (
          <div className="libraryEmpty">
            <Sparkles size={22} aria-hidden="true" />
            <strong>{text.emptyTitle}</strong>
            <p>{text.emptyBody}</p>
          </div>
        ) : null}
        {reviewItems.map((item) => (
          <article className={`curatorRow ${item.kind}`} key={item.id}>
            <div className="curatorKind">
              {item.kind === "duplicate" ? <GitMerge size={16} /> : <Sparkles size={16} />}
              <span>{text.kind[item.kind]}</span>
            </div>
            <div className="curatorMain">
              <strong>{item.title}</strong>
              <p>{item.reason}</p>
              <small>{item.recommendation}</small>
            </div>
            <div className="rowIconActions">
              {item.kind === "candidate" && item.skillIds[0] ? (
                <button className="iconButton" title={text.activate} type="button" onClick={() => void onActivateSkill(item.skillIds[0]!)}>
                  <CheckCircle2 size={15} />
                </button>
              ) : null}
              {item.kind === "active" && item.skillIds[0] ? (
                <button className="iconButton" title={text.suspend} type="button" onClick={() => void onSuspendSkill(item.skillIds[0]!)}>
                  <PauseCircle size={15} />
                </button>
              ) : null}
              {item.kind === "duplicate" && item.skillIds.length > 1 ? (
                <button className="iconButton" title={text.merge} type="button" onClick={() => void onMergeDuplicate(item.skillIds)}>
                  <GitMerge size={15} />
                </button>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function getCuratorCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "Skill Curator" : "Skill Curator",
    subtitle: zh
      ? "解释哪些经验值得晋升、哪些应该留在记忆里，以及哪些 Skill 需要合并或暂停。"
      : "Explains what should become a skill, stay as memory, or be merged/suspended.",
    run: zh ? "运行反思" : "Run reflection",
    activate: zh ? "启用候选 Skill" : "Activate candidate skill",
    suspend: zh ? "暂停 Skill" : "Suspend skill",
    merge: zh ? "合并重复 Skill" : "Merge duplicate skills",
    emptyTitle: zh ? "暂无需要处理的建议" : "No curator actions",
    emptyBody: zh ? "SCC 会在多个成功任务形成稳定模式后再建议晋升。" : "SCC suggests promotions only after stable repeated successful patterns.",
    kind: {
      candidate: zh ? "候选" : "Candidate",
      active: zh ? "已启用" : "Active",
      duplicate: zh ? "重复" : "Duplicate",
      conflict: zh ? "冲突" : "Conflict",
      low_value_memory: zh ? "未晋升" : "Not promoted"
    }
  };
}
