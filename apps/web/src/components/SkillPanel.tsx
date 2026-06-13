import { useEffect, useMemo, useState } from "react";
import type { SkillConflict, SkillCreateRequest, SkillDuplicateGroup, SkillRecord, SkillUpdateRequest } from "@agent-workbench/shared";
import { Copy, Download, Edit3, Merge, Plus, RefreshCcw, Save, Search, Trash2, X } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { MarkdownText } from "./MarkdownText.js";

const statuses: SkillRecord["status"][] = ["candidate", "active", "suspended", "retired"];
const pageSize = 8;

interface SkillDraft {
  title: string;
  body: string;
  status: SkillRecord["status"];
  description: string;
  keywords: string;
  requiredTools: string;
  requiredContext: string;
  exclusions: string;
  minConfidence: string;
}

const emptyDraft: SkillDraft = {
  title: "",
  body: "",
  status: "candidate",
  description: "",
  keywords: "",
  requiredTools: "",
  requiredContext: "",
  exclusions: "",
  minConfidence: "0.7"
};

export function SkillPanel({
  skills,
  duplicates,
  conflicts,
  language,
  query = "",
  onOpenDocs,
  onCreate,
  onUpdate,
  onDelete,
  onBulkDelete,
  onMergeDuplicate,
  onExport,
  onRunCuratorExtraction
}: {
  skills: SkillRecord[];
  duplicates: SkillDuplicateGroup[];
  conflicts: SkillConflict[];
  language?: string | null;
  query?: string;
  onOpenDocs?: (() => void) | undefined;
  onCreate: (input: SkillCreateRequest) => Promise<void> | void;
  onUpdate: (skillId: string, input: SkillUpdateRequest) => Promise<void> | void;
  onDelete: (skillId: string) => Promise<void> | void;
  onBulkDelete: (skillIds: string[]) => Promise<void> | void;
  onMergeDuplicate: (group: SkillDuplicateGroup) => Promise<void> | void;
  onExport: (skillId: string) => Promise<void> | void;
  onRunCuratorExtraction?: () => Promise<void> | void;
}) {
  const text = getSkillCopy(language);
  const safeSkills = useMemo(() => (Array.isArray(skills) ? skills : []), [skills]);
  const safeDuplicates = useMemo(() => (Array.isArray(duplicates) ? duplicates : []), [duplicates]);
  const safeConflicts = useMemo(() => (Array.isArray(conflicts) ? conflicts : []), [conflicts]);
  const [localQuery, setLocalQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SkillRecord["status"] | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(safeSkills[0]?.id ?? null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SkillRecord | null>(null);
  const selected = selectedId ? safeSkills.find((skill) => skill.id === selectedId) ?? null : null;
  const [draft, setDraft] = useState<SkillDraft>(selected ? draftFromSkill(selected) : emptyDraft);
  const searchText = `${query} ${localQuery}`.trim().toLowerCase();

  useEffect(() => {
    if (selectedId && !safeSkills.some((skill) => skill.id === selectedId)) {
      setSelectedId(safeSkills[0]?.id ?? null);
    }
  }, [safeSkills, selectedId]);

  useEffect(() => {
    if (modalMode === "edit" && selected) setDraft(draftFromSkill(selected));
  }, [modalMode, selected]);

  const filteredSkills = useMemo(() => {
    return safeSkills.filter((skill) => {
      if (statusFilter !== "all" && skill.status !== statusFilter) return false;
      if (!searchText) return true;
      return [skill.title, skill.body, skill.applicability.description, ...skill.applicability.keywords, ...skill.applicability.requiredTools]
        .join(" ")
        .toLowerCase()
        .includes(searchText);
    });
  }, [safeSkills, searchText, statusFilter]);

  useEffect(() => {
    setPage(0);
  }, [searchText, statusFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredSkills.length / pageSize));
  const visibleSkills = filteredSkills.slice(page * pageSize, page * pageSize + pageSize);
  const selectedDuplicate = safeDuplicates.find((group) => group.skills.some((skill) => skill.id === selected?.id));
  const selectedConflicts = safeConflicts.filter((conflict) => selected && conflict.skillIds.includes(selected.id));
  const checkedIds = [...checked].filter((id) => safeSkills.some((skill) => skill.id === id));

  return (
    <section className="skillWorkbench" aria-label="Skills">
      <header className="libraryPanelHero">
        <div>
          <h2>{text.title}</h2>
        </div>
        <div className="inlineActions">
          {onOpenDocs ? (
            <button className="textButton" type="button" onClick={onOpenDocs}>
              {text.docs}
            </button>
          ) : null}
          <button className="textButton iconText" type="button" onClick={() => void onRunCuratorExtraction?.()}>
            <RefreshCcw size={15} />
            {text.reflect}
          </button>
          <button
            className="subtleButton iconText"
            type="button"
            onClick={() => {
              setDraft(emptyDraft);
              setModalMode("create");
            }}
          >
            <Plus size={15} />
            {text.newSkill}
          </button>
        </div>
      </header>

      {safeDuplicates.length > 0 ? (
        <section className="duplicateBanner">
          <div>
            <strong>{safeDuplicates.length} {text.duplicateGroups}</strong>
            <span>{text.duplicateHelp}</span>
          </div>
          <button className="subtleButton iconText" type="button" onClick={() => safeDuplicates.forEach((group) => void onMergeDuplicate(group))}>
            <Merge size={15} />
            {text.mergeAll}
          </button>
        </section>
      ) : null}

      <div className="skillGrid libraryManagerGrid">
        <aside className="skillListPane">
          <div className="skillToolbar">
            <label className="skillSearch">
              <Search size={15} />
              <input aria-label={text.search} placeholder={text.search} value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} />
            </label>
            <AccordionSelect
              ariaLabel={text.statusFilter}
              size="compact"
              value={statusFilter}
              options={[{ value: "all", label: text.allStatuses }, ...statuses.map((status) => ({ value: status, label: status }))]}
              onChange={(value) => setStatusFilter(value as SkillRecord["status"] | "all")}
            />
          </div>

          <div className="bulkActions">
            <span>{checkedIds.length} {text.selected}</span>
            <button className="textButton" type="button" disabled={checkedIds.length === 0} onClick={() => void onBulkDelete(checkedIds)}>
              {text.deleteSelected}
            </button>
          </div>

          <div className="skillRows">
            {filteredSkills.length === 0 ? <LibraryEmpty text={text.empty} /> : null}
            {visibleSkills.map((skill) => {
              const duplicate = safeDuplicates.some((group) => group.skills.some((item) => item.id === skill.id));
              return (
                <article className={selectedId === skill.id ? "skillListRow selected" : "skillListRow"} key={skill.id}>
                  <input
                    aria-label={`Select ${skill.title}`}
                    checked={checked.has(skill.id)}
                    onChange={() => {
                      setChecked((current) => {
                        const next = new Set(current);
                        if (next.has(skill.id)) next.delete(skill.id);
                        else next.add(skill.id);
                        return next;
                      });
                    }}
                    type="checkbox"
                  />
                  <button className="skillListButton" type="button" onClick={() => setSelectedId(skill.id)}>
                    <span>{skill.title}</span>
                    <small>
                      {skill.status} · {formatSkillStats(skill, language)}
                      {duplicate ? ` · ${text.duplicate}` : ""}
                    </small>
                    <small>{skill.applicability.description || text.noApplicability}</small>
                  </button>
                  <div className="rowIconActions">
                    <button aria-label={`${text.edit} ${skill.title}`} className="iconButton" type="button" onClick={() => openEdit(skill)}>
                      <Edit3 size={14} />
                    </button>
                    <button aria-label={`${text.export} ${skill.title}`} className="iconButton" type="button" onClick={() => void onExport(skill.id)}>
                      <Download size={14} />
                    </button>
                    <button aria-label={`${text.delete} ${skill.title}`} className="iconButton dangerIcon" type="button" onClick={() => setDeleteTarget(skill)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <Pagination page={page} pageCount={pageCount} label={text.pageLabel(page + 1, pageCount)} onPage={setPage} />
        </aside>

        <section className="skillDetailPane libraryPreviewPane">
          {selected ? (
            <>
              <div className="libraryPreviewHeader">
                <div>
                  <h3>{selected.title}</h3>
                  <p>{selected.applicability.description || text.noApplicability}</p>
                </div>
                <div className="rowIconActions">
                  <button aria-label={`${text.edit} ${selected.title}`} className="iconButton" type="button" onClick={() => openEdit(selected)}>
                    <Edit3 size={15} />
                  </button>
                  <button aria-label={`${text.delete} ${selected.title}`} className="iconButton dangerIcon" type="button" onClick={() => setDeleteTarget(selected)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              {selectedDuplicate ? (
                <div className="inlineNotice">
                  <span>{text.duplicateDetected}</span>
                  <button className="textButton iconText" type="button" onClick={() => void onMergeDuplicate(selectedDuplicate)}>
                    <Merge size={14} />
                    {text.mergeGroup}
                  </button>
                </div>
              ) : null}
              {selectedConflicts.length > 0 ? (
                <div className="inlineNotice warning">
                  <span>{selectedConflicts.length} {text.conflicts}: {selectedConflicts[0]?.reason}</span>
                </div>
              ) : null}
              <dl className="libraryMetaGrid">
                <div><dt>{text.status}</dt><dd>{selected.status}</dd></div>
                <div><dt>{text.stats}</dt><dd>{formatSkillStats(selected, language)}</dd></div>
                <div><dt>{text.requiredTools}</dt><dd>{selected.applicability.requiredTools.join(", ") || text.none}</dd></div>
                <div><dt>{text.triggers}</dt><dd>{selected.applicability.keywords.join(", ") || text.none}</dd></div>
              </dl>
              <section className="skillPreview">
                <div className="panelHeader">
                  <h3>{text.preview}</h3>
                  <button className="textButton iconText" type="button" onClick={() => void navigator.clipboard?.writeText(selected.body)}>
                    <Copy size={14} />
                    {text.copy}
                  </button>
                </div>
                <MarkdownText content={selected.body || text.noBody} />
              </section>
            </>
          ) : (
            <LibraryEmpty text={text.empty} />
          )}
        </section>
      </div>

      {modalMode ? (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModalMode(null)}>
          <form
            aria-modal="true"
            className="providerDialog skillDialog"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <header className="dialogHeader">
              <div>
                <h3>{modalMode === "edit" ? text.edit : text.create}</h3>
                <p>{modalMode === "edit" && selected ? selected.id : text.createHelp}</p>
              </div>
              <button aria-label={text.close} className="iconButton" type="button" onClick={() => setModalMode(null)}>
                <X size={16} />
              </button>
            </header>
            <label className="fieldStack">
              <span>{text.fieldTitle}</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <div className="editorSplit">
              <label className="fieldStack">
                <span>{text.status}</span>
                <AccordionSelect
                  ariaLabel={text.status}
                  value={draft.status}
                  options={statuses.map((status) => ({ value: status, label: status }))}
                  onChange={(value) => setDraft({ ...draft, status: value as SkillRecord["status"] })}
                />
              </label>
              <label className="fieldStack">
                <span>{text.minConfidence}</span>
                <input value={draft.minConfidence} onChange={(event) => setDraft({ ...draft, minConfidence: event.target.value })} />
              </label>
            </div>
            <label className="fieldStack">
              <span>{text.description}</span>
              <textarea value={draft.description} rows={3} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.body}</span>
              <textarea value={draft.body} rows={12} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </label>
            <div className="editorSplit">
              <label className="fieldStack">
                <span>{text.triggers}</span>
                <input value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} />
                <small>{text.triggersHelp}</small>
              </label>
              <label className="fieldStack">
                <span>{text.requiredTools}</span>
                <input value={draft.requiredTools} onChange={(event) => setDraft({ ...draft, requiredTools: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>{text.context}</span>
                <input value={draft.requiredContext} onChange={(event) => setDraft({ ...draft, requiredContext: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>{text.exclusions}</span>
                <input value={draft.exclusions} onChange={(event) => setDraft({ ...draft, exclusions: event.target.value })} />
              </label>
            </div>
            <footer className="dialogActions">
              <button className="subtleButton" type="button" onClick={() => setModalMode(null)}>
                {text.cancel}
              </button>
              <button className="subtleButton iconText" type="submit">
                <Save size={14} />
                {text.save}
              </button>
            </footer>
          </form>
        </div>
      ) : null}

      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.delete}
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void onDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      >
        <p>{deleteTarget ? text.deleteBody(deleteTarget.title) : ""}</p>
      </ConfirmDialog>
    </section>
  );

  function openEdit(skill: SkillRecord) {
    setSelectedId(skill.id);
    setDraft(draftFromSkill(skill));
    setModalMode("edit");
  }

  async function saveDraft() {
    const payload = draftToPayload(draft);
    if (modalMode === "edit" && selected) await onUpdate(selected.id, payload);
    else {
      await onCreate({
        title: payload.title ?? "",
        body: payload.body ?? "",
        status: payload.status ?? "candidate",
        applicability: payload.applicability ?? {},
        sourceMemoryIds: [],
        relatedPatterns: []
      });
    }
    setModalMode(null);
  }
}

function LibraryEmpty({ text }: { text: string }) {
  return (
    <div className="libraryEmpty">
      <Search size={20} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function Pagination({
  label,
  page,
  pageCount,
  onPage
}: {
  label: string;
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
}) {
  return (
    <div className="paginationBar">
      <button className="iconButton" type="button" disabled={page <= 0} onClick={() => onPage(Math.max(0, page - 1))}>
        ‹
      </button>
      <span>{label}</span>
      <button className="iconButton" type="button" disabled={page >= pageCount - 1} onClick={() => onPage(Math.min(pageCount - 1, page + 1))}>
        ›
      </button>
    </div>
  );
}

function draftFromSkill(skill: SkillRecord): SkillDraft {
  return {
    title: skill.title,
    body: skill.body,
    status: skill.status,
    description: skill.applicability.description,
    keywords: skill.applicability.keywords.join(", "),
    requiredTools: skill.applicability.requiredTools.join(", "),
    requiredContext: skill.applicability.requiredContext.join(", "),
    exclusions: skill.applicability.exclusions.join(", "),
    minConfidence: String(skill.applicability.minConfidence)
  };
}

function draftToPayload(draft: SkillDraft): SkillUpdateRequest {
  return {
    title: draft.title.trim(),
    body: draft.body.trim(),
    status: draft.status,
    applicability: {
      description: draft.description.trim() || `Tasks similar to: ${draft.title.trim()}`,
      keywords: splitList(draft.keywords),
      requiredTools: splitList(draft.requiredTools),
      requiredContext: splitList(draft.requiredContext),
      exclusions: splitList(draft.exclusions),
      minConfidence: Math.max(0, Math.min(1, Number(draft.minConfidence) || 0.7))
    }
  };
}

function splitList(value: string): string[] {
  return value
    .split(/[,，\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 1 || /^[a-z0-9_-]+$/i.test(item));
}

function formatSkillStats(skill: SkillRecord, language?: string | null): string {
  if (skill.stats.totalUses <= 0) return language === "zh-CN" ? "尚未使用" : "not used yet";
  return `${Math.round(skill.stats.successRate * 100)}% · ${skill.stats.totalUses} ${language === "zh-CN" ? "次使用" : "uses"}`;
}

function getSkillCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: "Skills",
    docs: zh ? "文档" : "Docs",
    reflect: zh ? "提取建议" : "Extract suggestions",
    newSkill: zh ? "新建 Skill" : "New skill",
    duplicateGroups: zh ? "组重复 Skill" : "duplicate groups",
    duplicateHelp: zh ? "检测到重复固化。合并后可以保持 Agent 记忆干净。" : "Repeated promotions were detected. Merge them to keep agent memory clean.",
    mergeAll: zh ? "全部合并" : "Merge all",
    search: zh ? "搜索 Skills" : "Search skills",
    statusFilter: zh ? "筛选 Skill 状态" : "Filter Skill status",
    allStatuses: zh ? "全部状态" : "All statuses",
    selected: zh ? "已选择" : "selected",
    deleteSelected: zh ? "删除所选" : "Delete selected",
    empty: zh ? "没有匹配的 Skill。" : "No skills match this view.",
    duplicate: zh ? "重复" : "duplicate",
    edit: zh ? "编辑 Skill" : "Edit skill",
    create: zh ? "创建 Skill" : "Create skill",
    createHelp: zh ? "新 Skill 默认进入候选状态，除非你明确启用。" : "New skills start as candidate unless explicitly activated.",
    export: zh ? "导出" : "Export",
    delete: zh ? "删除" : "Delete",
    cancel: zh ? "取消" : "Cancel",
    close: zh ? "关闭" : "Close",
    deleteTitle: zh ? "删除 Skill？" : "Delete Skill?",
    deleteBody: (title: string) => zh ? `“${title}” 会从资料库移除。任务历史不会被删除。` : `"${title}" will be removed from the library. Task history is kept.`,
    save: zh ? "保存" : "Save",
    duplicateDetected: zh ? "检测到重复组。" : "Duplicate group detected.",
    mergeGroup: zh ? "合并该组" : "Merge group",
    conflicts: zh ? "个冲突" : "conflicts",
    fieldTitle: zh ? "标题" : "Title",
    status: zh ? "状态" : "Status",
    stats: zh ? "使用统计" : "Stats",
    body: zh ? "正文" : "Body",
    triggers: zh ? "触发条件" : "Trigger conditions",
    triggersHelp: zh ? "写完整短语或场景标签，系统会过滤无意义的单字 token。" : "Use complete phrases or scenario tags. Single-character noise is filtered.",
    requiredTools: zh ? "需要的工具" : "Required tools",
    context: zh ? "适用上下文" : "Context",
    minConfidence: zh ? "最小置信度" : "Min confidence",
    description: zh ? "适用场景" : "Applicability",
    exclusions: zh ? "排除条件" : "Exclusions",
    preview: zh ? "预览" : "Preview",
    copy: zh ? "复制正文" : "Copy body",
    noBody: zh ? "还没有 Skill 正文。" : "No skill body yet.",
    noApplicability: zh ? "未填写适用场景" : "No applicability notes",
    none: zh ? "无" : "None",
    pageLabel: (page: number, total: number) => zh ? `第 ${page} / ${total} 页` : `Page ${page} / ${total}`
  };
}
