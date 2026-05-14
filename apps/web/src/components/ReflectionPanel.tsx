import type { ReflectionSession, SkillConflict, SkillDuplicateGroup } from "@agent-workbench/shared";
import { AlertCircle, GitMerge, RefreshCcw, Sparkles, Trash2 } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useState } from "react";
import { SettingsPrimer } from "./SettingsAssist.js";
import { describeReflectionNextStep, describeReflectionPhase, describeReflectionStatus } from "./skillUx.js";

export function ReflectionPanel({
  conflicts,
  duplicates,
  language,
  onOpenDocs,
  reflections,
  onRunReflection,
  onDeleteReflection,
  onClearReflections
}: {
  conflicts: SkillConflict[];
  duplicates: SkillDuplicateGroup[];
  language?: string | null;
  onOpenDocs?: (() => void) | undefined;
  reflections: ReflectionSession[];
  onRunReflection?: () => Promise<void> | void;
  onDeleteReflection?: (id: string) => Promise<void> | void;
  onClearReflections?: () => Promise<void> | void;
}) {
  const text = getReflectionCopy(language);
  const safeReflections = Array.isArray(reflections) ? reflections : [];
  const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
  const safeDuplicates = Array.isArray(duplicates) ? duplicates : [];

  const [deleteTarget, setDeleteTarget] = useState<ReflectionSession | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  return (
    <section className="reflectionPanel">
      <header className="libraryPanelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <div className="inlineActions">
          {safeReflections.length > 0 && onClearReflections ? (
            <button aria-label={text.clear} className="textButton dangerText iconText" type="button" onClick={() => setClearOpen(true)}>
              <Trash2 size={15} />
              {text.clear}
            </button>
          ) : null}
          <button aria-label="Run reflection" className="subtleButton iconText" type="button" onClick={() => void onRunReflection?.()}>
            <RefreshCcw size={15} />
            {text.run}
          </button>
        </div>
      </header>
      <SettingsPrimer
        language={language}
        summary={text.primer.summary}
        focus={text.primer.focus}
        impact={text.primer.impact}
        nextStep={text.primer.nextStep}
        onOpenDocs={onOpenDocs}
      />

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
              <strong>{describeReflectionPhase(reflection.progress.phase, language)}</strong>
              <p>{reflection.progress.nextStep ? describeReflectionNextStep(reflection.progress.nextStep, language) : text.noNextStep}</p>
            </div>
            <span>{describeReflectionStatus(reflection.status, language)}</span>
            <small>{new Date(reflection.createdAt).toLocaleString()}</small>
            {onDeleteReflection ? (
              <button aria-label={`${text.delete} ${describeReflectionPhase(reflection.progress.phase, language)}`} className="iconButton dangerIcon" type="button" onClick={() => setDeleteTarget(reflection)}>
                <Trash2 size={14} />
              </button>
            ) : null}
          </article>
        ))}
      </div>
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        confirmLabel={text.delete}
        cancelLabel={text.cancel}
        tone="danger"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={async () => {
          if (!deleteTarget) return;
          await onDeleteReflection?.(deleteTarget.id);
          setDeleteTarget(null);
        }}
      >
        <p>{deleteTarget ? text.deleteBody(describeReflectionPhase(deleteTarget.progress.phase, language)) : ""}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={clearOpen}
        title={text.clearTitle}
        confirmLabel={text.clear}
        cancelLabel={text.cancel}
        tone="danger"
        onCancel={() => setClearOpen(false)}
        onConfirm={async () => {
          await onClearReflections?.();
          setClearOpen(false);
        }}
      >
        <p>{text.clearBody}</p>
      </ConfirmDialog>
    </section>
  );
}

function getReflectionCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "Agent 反思" : "Agent reflections",
    subtitle: zh ? "这里展示学习建议和阻塞原因，不把内部记忆直接塞给用户。" : "Learning suggestions and blockers without exposing raw internal memory.",
    run: zh ? "运行反思" : "Run reflection",
    clear: zh ? "清空历史" : "Clear history",
    delete: zh ? "删除" : "Delete",
    cancel: zh ? "取消" : "Cancel",
    deleteTitle: zh ? "删除反思记录？" : "Delete reflection?",
    deleteBody: (phase: string) => zh ? `将删除“${phase}”这条反思记录。` : `The "${phase}" reflection record will be deleted.`,
    clearTitle: zh ? "清空反思历史？" : "Clear reflection history?",
    clearBody: zh ? "所有反思记录都会被删除，已晋升的 Skill 不会被回滚。" : "All reflection records will be deleted. Promoted skills will not be rolled back.",
    sessions: zh ? "次反思" : "sessions",
    duplicates: zh ? "组重复" : "duplicate groups",
    conflicts: zh ? "个冲突" : "conflicts",
    emptyTitle: zh ? "还没有反思记录" : "No reflections yet",
    emptyBody: zh ? "完成更多任务后，Agent Workbench 会把稳定模式整理为候选建议。" : "After more completed tasks, Agent Workbench will summarize stable patterns as suggestions.",
    noNextStep: zh ? "暂无下一步。" : "No next step.",
    primer: {
      summary: zh ? "反思记录解释系统如何从已完成任务中提取模式、发现重复，以及为什么某些经验还不能晋升。" : "Reflection records explain how the system extracts patterns from completed tasks, finds duplicates, and decides why some experiences still cannot be promoted.",
      focus: zh ? "优先看阶段说明、下一步和重复/冲突数量，不需要直接阅读内部 memory 原文。" : "Look at the stage summary, next step, and duplicate or conflict counts first. You should not need raw internal memory text here.",
      impact: zh ? "会影响候选 Skill 何时出现、重复技能是否会被合并，以及 Curator 为什么给出当前建议。" : "Changes affect when candidate skills appear, whether duplicate skills should be merged, and why Curator presents its current recommendations.",
      nextStep: zh ? "如果某条反思长时间停在等待更多样本，说明当前任务还不足以形成稳定可复用流程。" : "If a reflection stays in a wait-for-more-evidence stage for a long time, the recent tasks still are not stable enough to form a reusable workflow."
    }
  };
}
