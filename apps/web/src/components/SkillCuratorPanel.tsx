import type { CuratorRun, SkillConflict, SkillCuratorItem, SkillDuplicateGroup } from "@agent-workbench/shared";
import { AlertCircle, CheckCircle2, GitMerge, PauseCircle, RefreshCcw, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { describeCuratorRunNextStep, describeCuratorRunPhase, describeCuratorRunStatus, describeSkillStatus, summarizeCuratorEvidence } from "./skillUx.js";

export function SkillCuratorPanel({
  conflicts = [],
  duplicates = [],
  items,
  language,
  onOpenDocs,
  onActivateSkill,
  onClearCuratorRuns,
  onDeleteCuratorRun,
  onDeleteMemory,
  onMergeDuplicate,
  onRunCuratorExtraction,
  onSuspendSkill,
  curatorRuns = []
}: {
  conflicts?: SkillConflict[];
  duplicates?: SkillDuplicateGroup[];
  items: SkillCuratorItem[];
  language?: string | null;
  onOpenDocs?: (() => void) | undefined;
  onActivateSkill: (skillId: string) => Promise<void> | void;
  onClearCuratorRuns?: () => Promise<void> | void;
  onDeleteCuratorRun?: (id: string) => Promise<void> | void;
  onDeleteMemory?: (id: string) => Promise<void> | void;
  onMergeDuplicate: (skillIds: string[]) => Promise<void> | void;
  onRunCuratorExtraction?: () => Promise<void> | void;
  onSuspendSkill: (skillId: string) => Promise<void> | void;
  curatorRuns?: CuratorRun[];
}) {
  const text = getCuratorCopy(language);
  const reviewItems = Array.isArray(items) ? items : [];
  const actionItems = reviewItems.filter((item) => item.kind !== "low_value_memory");
  const lowValueItems = reviewItems.filter((item) => item.kind === "low_value_memory");
  const safeCuratorRuns = Array.isArray(curatorRuns) ? curatorRuns : [];
  const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
  const safeDuplicates = Array.isArray(duplicates) ? duplicates : [];
  const [deleteCuratorRun, setDeleteCuratorRun] = useState<CuratorRun | null>(null);
  const [deleteMemoryItem, setDeleteMemoryItem] = useState<SkillCuratorItem | null>(null);
  const [clearOpen, setClearOpen] = useState(false);

  return (
    <section className="curatorPanel">
      <header className="libraryPanelHero">
        <div>
          <h2>{text.title}</h2>
        </div>
        <div className="inlineActions">
          {safeCuratorRuns.length > 0 && onClearCuratorRuns ? (
            <button className="textButton dangerText iconText" type="button" onClick={() => setClearOpen(true)}>
              <Trash2 size={15} />
              {text.clear}
            </button>
          ) : null}
          {onOpenDocs ? (
            <button className="textButton" type="button" onClick={onOpenDocs}>
              {text.docs}
            </button>
          ) : null}
          <button className="subtleButton iconText" type="button" onClick={() => void onRunCuratorExtraction?.()}>
            <RefreshCcw size={15} />
            {text.run}
          </button>
        </div>
      </header>

      <div className="curatorSummaryGrid curatorOverview">
        <article>
          <Sparkles size={17} aria-hidden="true" />
          <strong>{actionItems.length}</strong>
          <span>{text.actions}</span>
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

      {safeCuratorRuns.length > 0 ? (
        <section className="curatorSection">
          <div className="curatorSectionHeader">
            <h3>{text.runHistory}</h3>
          </div>
          <div className="curatorRunList">
            {safeCuratorRuns.slice(0, 8).map((run) => (
              <CuratorRunRow
                key={run.id}
                language={language ?? null}
                run={run}
                text={text}
                onRequestDelete={onDeleteCuratorRun ? setDeleteCuratorRun : undefined}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="curatorSection">
        <div className="curatorSectionHeader">
          <h3>{text.reviewQueue}</h3>
          {lowValueItems.length > 0 ? <span>{text.hiddenLowValue(lowValueItems.length)}</span> : null}
        </div>
        <div className="curatorRows">
          {actionItems.length === 0 ? (
            <div className="libraryEmpty">
              <Sparkles size={22} aria-hidden="true" />
              <strong>{text.emptyTitle}</strong>
              <p>{text.emptyBody}</p>
            </div>
          ) : null}
          {actionItems.map((item) => (
            <CuratorActionRow
              item={item}
              key={item.id}
              language={language ?? null}
              text={text}
              onActivateSkill={onActivateSkill}
              onMergeDuplicate={onMergeDuplicate}
              onSuspendSkill={onSuspendSkill}
            />
          ))}
        </div>
      </section>

      {lowValueItems.length > 0 ? (
        <details className="curatorLowValueDetails">
          <summary>{text.lowValueSummary(lowValueItems.length)}</summary>
          <div className="curatorRows lowValueRows">
            {lowValueItems.slice(0, 12).map((item) => (
              <CuratorLowValueRow
                item={item}
                key={item.id}
                text={text}
                onRequestDelete={onDeleteMemory ? setDeleteMemoryItem : undefined}
              />
            ))}
          </div>
        </details>
      ) : null}
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.deleteCuratorRun}
        open={Boolean(deleteCuratorRun)}
        title={text.deleteCuratorRunTitle}
        tone="danger"
        onCancel={() => setDeleteCuratorRun(null)}
        onConfirm={async () => {
          if (!deleteCuratorRun) return;
          await onDeleteCuratorRun?.(deleteCuratorRun.id);
          setDeleteCuratorRun(null);
        }}
      >
        <p>{deleteCuratorRun ? text.deleteCuratorRunBody(describeCuratorRunPhase(deleteCuratorRun.progress.phase, language)) : ""}</p>
      </ConfirmDialog>
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.clear}
        open={clearOpen}
        title={text.clearTitle}
        tone="danger"
        onCancel={() => setClearOpen(false)}
        onConfirm={async () => {
          await onClearCuratorRuns?.();
          setClearOpen(false);
        }}
      >
        <p>{text.clearBody}</p>
      </ConfirmDialog>
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.deleteMemory}
        open={Boolean(deleteMemoryItem)}
        title={text.deleteMemoryTitle}
        tone="danger"
        onCancel={() => setDeleteMemoryItem(null)}
        onConfirm={async () => {
          const memoryId = deleteMemoryItem?.memoryIds[0];
          if (!memoryId) return;
          await onDeleteMemory?.(memoryId);
          setDeleteMemoryItem(null);
        }}
      >
        <p>{deleteMemoryItem ? text.deleteMemoryBody(deleteMemoryItem.title) : ""}</p>
      </ConfirmDialog>
    </section>
  );
}

type CuratorCopy = ReturnType<typeof getCuratorCopy>;

function CuratorRunRow({
  language,
  onRequestDelete,
  run,
  text
}: {
  language?: string | null;
  onRequestDelete?: ((run: CuratorRun) => void) | undefined;
  run: CuratorRun;
  text: CuratorCopy;
}) {
  const phase = describeCuratorRunPhase(run.progress.phase, language);
  const status = describeCuratorRunStatus(run.status, language);
  const statusClass = run.status.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  const nextStep = run.progress.nextStep ? describeCuratorRunNextStep(run.progress.nextStep, language) : text.noNextStep;

  return (
    <article className="curatorRunRow">
      <span className="curatorRunMarker" aria-hidden="true" />
      <div className="curatorRunMain">
        <strong>{phase}</strong>
        <p>{nextStep}</p>
      </div>
      <div className="curatorRunMeta">
        <span className={`curatorRunStatus ${statusClass}`}>{status}</span>
        <time dateTime={run.createdAt}>{formatCuratorRunTime(run.createdAt, language)}</time>
      </div>
      {onRequestDelete ? (
        <button aria-label={`${text.deleteCuratorRun} ${phase}`} className="iconButton dangerIcon" type="button" onClick={() => onRequestDelete(run)}>
          <Trash2 size={14} />
        </button>
      ) : null}
    </article>
  );
}

function CuratorActionRow({
  item,
  language,
  onActivateSkill,
  onMergeDuplicate,
  onSuspendSkill,
  text
}: {
  item: SkillCuratorItem;
  language?: string | null;
  onActivateSkill: (skillId: string) => Promise<void> | void;
  onMergeDuplicate: (skillIds: string[]) => Promise<void> | void;
  onSuspendSkill: (skillId: string) => Promise<void> | void;
  text: CuratorCopy;
}) {
  const evidenceLines = summarizeCuratorEvidence(item, language);

  return (
    <article className={`curatorRow ${item.kind}`}>
      <div className="curatorKind">
        {item.kind === "duplicate" ? <GitMerge size={16} /> : <Sparkles size={16} />}
        <span>{text.kind[item.kind]}</span>
      </div>
      <div className="curatorMain">
        <strong>{item.title}</strong>
        <p>{item.reason}</p>
        <small>{item.recommendation}</small>
        {item.status ? <small>{text.statusLabel}: {describeSkillStatus(item.status, language)}</small> : null}
        {evidenceLines.length > 0 ? (
          <details>
            <summary>{text.evidence}</summary>
            <ul className="compactBulletList">
              {evidenceLines.map((line, index) => <li key={`${item.id}-evidence-${index}`}>{line}</li>)}
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
  );
}

function CuratorLowValueRow({
  item,
  onRequestDelete,
  text
}: {
  item: SkillCuratorItem;
  onRequestDelete?: ((item: SkillCuratorItem) => void) | undefined;
  text: CuratorCopy;
}) {
  return (
    <article className={`curatorRow ${item.kind}`}>
      <div className="curatorKind">
        <Sparkles size={16} />
        <span>{text.kind[item.kind]}</span>
      </div>
      <div className="curatorMain">
        <strong>{item.title}</strong>
        <p>{item.reason}</p>
        {item.blockedReasons.length > 0 ? <small>{item.blockedReasons.join(" · ")}</small> : null}
      </div>
      {onRequestDelete && item.memoryIds[0] ? (
        <div className="rowIconActions">
          <button aria-label={`${text.deleteMemory} ${item.title}`} className="iconButton dangerIcon" type="button" onClick={() => onRequestDelete(item)}>
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}
    </article>
  );
}

function getCuratorCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: "Skill Curator",
    run: zh ? "提取建议" : "Extract suggestions",
    clear: zh ? "清空运行记录" : "Clear run history",
    docs: zh ? "文档" : "Docs",
    deleteCuratorRun: zh ? "删除记录" : "Delete record",
    deleteMemory: zh ? "删除任务记忆" : "Delete task memory",
    cancel: zh ? "取消" : "Cancel",
    deleteCuratorRunTitle: zh ? "删除运行记录？" : "Delete run record?",
    deleteCuratorRunBody: (phase: string) => zh ? `将删除“${phase}”这条运行记录。` : `The "${phase}" run record will be deleted.`,
    deleteMemoryTitle: zh ? "删除任务记忆？" : "Delete task memory?",
    deleteMemoryBody: (title: string) => zh ? `“${title}” 会从任务记忆中移除，不会删除原始任务。` : `"${title}" will be removed from task memory. The original task is not deleted.`,
    clearTitle: zh ? "清空运行记录？" : "Clear run history?",
    clearBody: zh ? "所有运行记录都会被删除，已晋升的 Skill 不会被回滚。" : "All run records will be deleted. Promoted skills will not be rolled back.",
    noNextStep: zh ? "暂无下一步。" : "No next step.",
    actions: zh ? "待处理建议" : "review actions",
    duplicates: zh ? "组重复" : "duplicate groups",
    conflicts: zh ? "个冲突" : "conflicts",
    runHistory: zh ? "运行记录" : "Run history",
    reviewQueue: zh ? "复核队列" : "Review queue",
    hiddenLowValue: (count: number) => zh ? `${count} 条低价值记忆已折叠` : `${count} low-value memories collapsed`,
    lowValueSummary: (count: number) => zh ? `查看 ${count} 条未晋升记忆` : `Show ${count} not-promoted memories`,
    activate: zh ? "启用候选 Skill" : "Activate candidate skill",
    suspend: zh ? "暂停 Skill" : "Suspend skill",
    merge: zh ? "合并重复 Skill" : "Merge duplicate skills",
    statusLabel: zh ? "当前状态" : "Current status",
    evidence: zh ? "为什么会出现这条建议" : "Why this recommendation exists",
    blockedReasons: zh ? "为什么被拦截" : "Why it was blocked",
    dedupBasis: zh ? "为什么判定为重复" : "Why it was grouped as duplicate",
    emptyTitle: zh ? "暂无需要处理的建议" : "No curator actions",
    emptyBody: zh ? "Agent Workbench 会在多个成功任务形成稳定模式后再建议晋升。" : "Agent Workbench suggests promotions only after stable repeated successful patterns.",
    kind: {
      candidate: zh ? "候选" : "Candidate",
      active: zh ? "已启用" : "Active",
      duplicate: zh ? "重复" : "Duplicate",
      conflict: zh ? "冲突" : "Conflict",
      low_value_memory: zh ? "未晋升" : "Not promoted"
    },
  };
}

function formatCuratorRunTime(value: string, language?: string | null): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(language === "zh-CN" ? "zh-CN" : "en", {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short"
  });
}
