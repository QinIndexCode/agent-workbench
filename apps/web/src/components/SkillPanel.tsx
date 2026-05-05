import { useEffect, useMemo, useState } from "react";
import type { ReflectionSession, SkillConflict, SkillCreateRequest, SkillDuplicateGroup, SkillRecord, SkillUpdateRequest } from "@scc/shared";
import { Copy, Download, Merge, Plus, RefreshCcw, Save, Search, Trash2 } from "lucide-react";

const statuses: SkillRecord["status"][] = ["candidate", "active", "suspended", "retired"];

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
  reflections,
  onCreate,
  onUpdate,
  onDelete,
  onBulkDelete,
  onMergeDuplicate,
  onExport,
  onRunReflection
}: {
  skills: SkillRecord[];
  duplicates: SkillDuplicateGroup[];
  conflicts: SkillConflict[];
  language?: string | null;
  reflections?: ReflectionSession[];
  onCreate: (input: SkillCreateRequest) => Promise<void> | void;
  onUpdate: (skillId: string, input: SkillUpdateRequest) => Promise<void> | void;
  onDelete: (skillId: string) => Promise<void> | void;
  onBulkDelete: (skillIds: string[]) => Promise<void> | void;
  onMergeDuplicate: (group: SkillDuplicateGroup) => Promise<void> | void;
  onExport: (skillId: string) => Promise<void> | void;
  onRunReflection?: () => Promise<void> | void;
}) {
  const text = getSkillCopy(language);
  const safeSkills = Array.isArray(skills) ? skills : [];
  const safeDuplicates = Array.isArray(duplicates) ? duplicates : [];
  const safeConflicts = Array.isArray(conflicts) ? conflicts : [];
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<SkillRecord["status"] | "all">("all");
  const [selectedId, setSelectedId] = useState<string | "new">(safeSkills[0]?.id ?? "new");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const selected = selectedId === "new" ? null : safeSkills.find((skill) => skill.id === selectedId) ?? null;
  const [draft, setDraft] = useState<SkillDraft>(selected ? draftFromSkill(selected) : emptyDraft);

  useEffect(() => {
    if (selectedId !== "new" && !safeSkills.some((skill) => skill.id === selectedId)) {
      setSelectedId(safeSkills[0]?.id ?? "new");
    }
  }, [safeSkills, selectedId]);

  useEffect(() => {
    setDraft(selected ? draftFromSkill(selected) : emptyDraft);
  }, [selected]);

  const filteredSkills = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return safeSkills.filter((skill) => {
      if (statusFilter !== "all" && skill.status !== statusFilter) return false;
      if (!needle) return true;
      return [skill.title, skill.body, skill.applicability.description, ...skill.applicability.keywords, ...skill.applicability.requiredTools]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [query, safeSkills, statusFilter]);

  const selectedDuplicate = safeDuplicates.find((group) => group.skills.some((skill) => skill.id === selectedId));
  const selectedConflicts = safeConflicts.filter((conflict) => conflict.skillIds.includes(String(selectedId)));
  const checkedIds = [...checked].filter((id) => safeSkills.some((skill) => skill.id === id));

  return (
    <section className="skillWorkbench" aria-label="Skills">
      <header className="panelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <div className="inlineActions">
          <button className="textButton iconText" type="button" onClick={() => void onRunReflection?.()}>
            <RefreshCcw size={15} />
            {text.reflect}
          </button>
          <button className="subtleButton iconText" type="button" onClick={() => setSelectedId("new")}>
            <Plus size={15} />
            {text.newSkill}
          </button>
        </div>
      </header>

      {reflections?.[0] ? (
        <section className="reflectionStrip">
          <strong>{text.latestReflection}</strong>
          <span>{reflections[0].progress.phase} · {reflections[0].status} · {new Date(reflections[0].createdAt).toLocaleString()}</span>
        </section>
      ) : null}

      {safeDuplicates.length > 0 ? (
        <section className="duplicateBanner">
          <div>
            <strong>{safeDuplicates.length} {text.duplicateGroups}</strong>
            <span>{text.duplicateHelp}</span>
          </div>
          <button className="subtleButton" type="button" onClick={() => safeDuplicates.forEach((group) => void onMergeDuplicate(group))}>
            <Merge size={15} />
            {text.mergeAll}
          </button>
        </section>
      ) : null}

      <div className="skillGrid">
        <aside className="skillListPane">
          <div className="skillToolbar">
            <label className="skillSearch">
              <Search size={15} />
              <input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as SkillRecord["status"] | "all")}>
              <option value="all">all</option>
              {statuses.map((status) => (
                <option value={status} key={status}>
                  {status}
                </option>
              ))}
            </select>
          </div>

          <div className="bulkActions">
            <span>{checkedIds.length} {text.selected}</span>
            <button className="textButton" type="button" disabled={checkedIds.length === 0} onClick={() => void onBulkDelete(checkedIds)}>
              {text.deleteSelected}
            </button>
          </div>

          <div className="skillRows">
            {filteredSkills.length === 0 ? <p className="muted">{text.empty}</p> : null}
            {filteredSkills.map((skill) => {
              const duplicate = safeDuplicates.some((group) => group.skills.some((item) => item.id === skill.id));
              return (
                <div
                  className={selectedId === skill.id ? "skillListRow selected" : "skillListRow"}
                  key={skill.id}
                >
                  <input
                    aria-label={`Select ${skill.title}`}
                    checked={checked.has(skill.id)}
                    onChange={(event) => {
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
                  </button>
                </div>
              );
            })}
          </div>
        </aside>

        <section className="skillDetailPane">
          <form
            className="skillEditor"
            onSubmit={(event) => {
              event.preventDefault();
              void saveDraft();
            }}
          >
            <div className="editorHeader">
              <div>
                <h3>{selected ? text.edit : text.create}</h3>
                <p>{selected ? selected.id : text.createHelp}</p>
              </div>
              <div className="editorActions">
                {selected ? (
                  <>
                    <button className="textButton iconText" type="button" onClick={() => void onExport(selected.id)}>
                      <Download size={14} />
                      {text.export}
                    </button>
                    <button className="textButton iconText dangerText" type="button" onClick={() => void onDelete(selected.id)}>
                      <Trash2 size={14} />
                      {text.delete}
                    </button>
                  </>
                ) : null}
                <button className="subtleButton iconText" type="submit">
                  <Save size={14} />
                  {text.save}
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

            <label className="fieldStack">
              <span>{text.fieldTitle}</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.status}</span>
              <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as SkillRecord["status"] })}>
                {statuses.map((status) => (
                  <option value={status} key={status}>
                    {status}
                  </option>
                ))}
              </select>
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
                <span>{text.minConfidence}</span>
                <input value={draft.minConfidence} onChange={(event) => setDraft({ ...draft, minConfidence: event.target.value })} />
              </label>
            </div>

            <label className="fieldStack">
              <span>{text.description}</span>
              <textarea value={draft.description} rows={3} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.exclusions}</span>
              <input value={draft.exclusions} onChange={(event) => setDraft({ ...draft, exclusions: event.target.value })} />
            </label>
          </form>

          <section className="skillPreview">
            <div className="panelHeader">
              <h3>{text.preview}</h3>
              <button className="textButton iconText" type="button" onClick={() => void navigator.clipboard?.writeText(draft.body)}>
                <Copy size={14} />
                {text.copy}
              </button>
            </div>
            <pre>{draft.body || text.noBody}</pre>
          </section>
        </section>
      </div>
    </section>
  );

  async function saveDraft() {
    const payload = draftToPayload(draft);
    if (selected) await onUpdate(selected.id, payload);
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
  }
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
    subtitle: zh ? "可复用能力需要可审核、可编辑、可合并，也能被删除。" : "Reusable capabilities must stay reviewable, editable, mergeable, and removable.",
    reflect: zh ? "Agent 反思" : "Agent reflection",
    newSkill: zh ? "新建 Skill" : "New skill",
    latestReflection: zh ? "最近反思" : "Latest reflection",
    duplicateGroups: zh ? "组重复 Skill" : "duplicate groups",
    duplicateHelp: zh ? "检测到重复固化。合并后可以保持 Agent 记忆干净。" : "Repeated promotions were detected. Merge them to keep agent memory clean.",
    mergeAll: zh ? "全部合并" : "Merge all",
    search: zh ? "搜索 Skills" : "Search skills",
    selected: zh ? "已选择" : "selected",
    deleteSelected: zh ? "删除所选" : "Delete selected",
    empty: zh ? "没有匹配的 Skill。" : "No skills match this view.",
    duplicate: zh ? "重复" : "duplicate",
    edit: zh ? "编辑 Skill" : "Edit skill",
    create: zh ? "创建 Skill" : "Create skill",
    createHelp: zh ? "新 Skill 默认进入候选状态，除非你明确启用。" : "New skills start as candidate unless explicitly activated.",
    export: zh ? "导出" : "Export",
    delete: zh ? "删除" : "Delete",
    save: zh ? "保存" : "Save",
    duplicateDetected: zh ? "检测到重复组。" : "Duplicate group detected.",
    mergeGroup: zh ? "合并该组" : "Merge group",
    conflicts: zh ? "个冲突" : "conflicts",
    fieldTitle: zh ? "标题" : "Title",
    status: zh ? "状态" : "Status",
    body: zh ? "正文" : "Body",
    triggers: zh ? "触发短语" : "Trigger phrases",
    triggersHelp: zh ? "用逗号分隔完整短语，系统会过滤无意义的单字 token。" : "Use comma-separated phrases. Single-character noise is filtered.",
    requiredTools: zh ? "需要的工具" : "Required tools",
    context: zh ? "适用上下文" : "Context",
    minConfidence: zh ? "最小置信度" : "Min confidence",
    description: zh ? "适用场景" : "Applicability",
    exclusions: zh ? "排除条件" : "Exclusions",
    preview: zh ? "预览" : "Preview",
    copy: zh ? "复制正文" : "Copy body",
    noBody: zh ? "还没有 Skill 正文。" : "No skill body yet."
  };
}
