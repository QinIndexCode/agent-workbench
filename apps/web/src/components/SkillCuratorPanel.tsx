import type { ReflectionSession, SkillCuratorItem } from "@scc/shared";
import { CheckCircle2, GitMerge, PauseCircle, RefreshCcw, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { SettingsPrimer } from "./SettingsAssist.js";
import { describeReflectionNextStep, describeReflectionPhase, describeReflectionStatus, describeSkillStatus, summarizeCuratorEvidence } from "./skillUx.js";

export function SkillCuratorPanel({
  items,
  language,
  onOpenDocs,
  onActivateSkill,
  onDeleteReflection,
  onMergeDuplicate,
  onRunReflection,
  onSuspendSkill,
  reflections = []
}: {
  items: SkillCuratorItem[];
  language?: string | null;
  onOpenDocs?: (() => void) | undefined;
  onActivateSkill: (skillId: string) => Promise<void> | void;
  onDeleteReflection?: (id: string) => Promise<void> | void;
  onMergeDuplicate: (skillIds: string[]) => Promise<void> | void;
  onRunReflection?: () => Promise<void> | void;
  onSuspendSkill: (skillId: string) => Promise<void> | void;
  reflections?: ReflectionSession[];
}) {
  const text = getCuratorCopy(language);
  const reviewItems = Array.isArray(items) ? items : [];
  const latestReflections = Array.isArray(reflections) ? reflections.slice(0, 3) : [];
  const [deleteReflection, setDeleteReflection] = useState<ReflectionSession | null>(null);

  return (
    <section className="curatorPanel">
      <header className="libraryPanelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button className="subtleButton iconText" type="button" onClick={() => void onRunReflection?.()}>
          <RefreshCcw size={15} />
          {text.run}
        </button>
      </header>
      <SettingsPrimer
        language={language}
        summary={text.primer.summary}
        focus={text.primer.focus}
        impact={text.primer.impact}
        nextStep={text.primer.nextStep}
        onOpenDocs={onOpenDocs}
      />

      {latestReflections.length > 0 ? (
        <div className="reflectionList compactReflectionList">
          {latestReflections.map((reflection) => (
            <article className="reflectionRow" key={reflection.id}>
              <div>
                <strong>{describeReflectionPhase(reflection.progress.phase, language)}</strong>
                <p>{reflection.progress.nextStep ? describeReflectionNextStep(reflection.progress.nextStep, language) : text.noNextStep}</p>
              </div>
              <span>{describeReflectionStatus(reflection.status, language)}</span>
              {onDeleteReflection ? (
                <button aria-label={`${text.deleteReflection} ${describeReflectionPhase(reflection.progress.phase, language)}`} className="iconButton dangerIcon" type="button" onClick={() => setDeleteReflection(reflection)}>
                  <Trash2 size={14} />
                </button>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

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
              {item.status ? <small>{text.statusLabel}: {describeSkillStatus(item.status, language)}</small> : null}
              {summarizeCuratorEvidence(item, language).length > 0 ? (
                <details>
                  <summary>{text.evidence}</summary>
                  <ul className="compactBulletList">
                    {summarizeCuratorEvidence(item, language).map((line, index) => <li key={`${item.id}-evidence-${index}`}>{line}</li>)}
                  </ul>
                </details>
              ) : null}
              {item.blockedReasons.length > 0 ? (
                <details>
                  <summary>{text.blockedReasons}</summary>
                  <ul className="compactBulletList">
                    {item.blockedReasons.map((line, index) => <li key={`${item.id}-blocked-${index}`}>{line}</li>)}
                  </ul>
                </details>
              ) : null}
              {item.dedupBasis.length > 0 ? (
                <details>
                  <summary>{text.dedupBasis}</summary>
                  <ul className="compactBulletList">
                    {item.dedupBasis.map((line, index) => <li key={`${item.id}-dedup-${index}`}>{line}</li>)}
                  </ul>
                </details>
              ) : null}
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
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.deleteReflection}
        open={Boolean(deleteReflection)}
        title={text.deleteReflectionTitle}
        tone="danger"
        onCancel={() => setDeleteReflection(null)}
        onConfirm={async () => {
          if (!deleteReflection) return;
          await onDeleteReflection?.(deleteReflection.id);
          setDeleteReflection(null);
        }}
      >
        <p>{deleteReflection ? text.deleteReflectionBody(describeReflectionPhase(deleteReflection.progress.phase, language)) : ""}</p>
      </ConfirmDialog>
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
    deleteReflection: zh ? "删除反思" : "Delete reflection",
    cancel: zh ? "取消" : "Cancel",
    deleteReflectionTitle: zh ? "删除反思记录？" : "Delete reflection?",
    deleteReflectionBody: (phase: string) => zh ? `将删除“${phase}”这条反思记录。` : `The "${phase}" reflection record will be deleted.`,
    noNextStep: zh ? "暂无下一步。" : "No next step.",
    activate: zh ? "启用候选 Skill" : "Activate candidate skill",
    suspend: zh ? "暂停 Skill" : "Suspend skill",
    merge: zh ? "合并重复 Skill" : "Merge duplicate skills",
    statusLabel: zh ? "当前状态" : "Current status",
    evidence: zh ? "为什么会出现这条建议" : "Why this recommendation exists",
    blockedReasons: zh ? "为什么被拦截" : "Why it was blocked",
    dedupBasis: zh ? "为什么判定为重复" : "Why it was grouped as duplicate",
    emptyTitle: zh ? "暂无需要处理的建议" : "No curator actions",
    emptyBody: zh ? "SCC 会在多个成功任务形成稳定模式后再建议晋升。" : "SCC suggests promotions only after stable repeated successful patterns.",
    kind: {
      candidate: zh ? "候选" : "Candidate",
      active: zh ? "已启用" : "Active",
      duplicate: zh ? "重复" : "Duplicate",
      conflict: zh ? "冲突" : "Conflict",
      low_value_memory: zh ? "未晋升" : "Not promoted"
    },
    primer: {
      summary: zh ? "Curator 用来解释为什么某条经验被推荐为候选、为什么被拦截，以及为什么被判成重复。" : "Curator explains why an experience became a candidate, why it was blocked, and why it was grouped as a duplicate.",
      focus: zh ? "优先核对证据、阻断原因和重复依据，再决定是否激活、暂停或合并。" : "Check the evidence, blocked reasons, and duplicate basis before activating, suspending, or merging anything.",
      impact: zh ? "会影响哪些 Skill 最终进入运行时可加载集合，以及资料库是否会因为重复候选而变脏。" : "Changes affect which skills become runtime-loadable and whether the library stays clean instead of filling with duplicate candidates.",
      nextStep: zh ? "如果一条建议看起来很弱，先保留在 candidate 或 not promoted，而不是急着启用。" : "If a suggestion looks weak, leave it as candidate or not promoted instead of activating it too early."
    }
  };
}
