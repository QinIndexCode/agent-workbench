import { useEffect, useMemo, useState } from "react";
import type { SkillConflict, SkillCreateRequest, SkillDuplicateGroup, SkillRecord, SkillUpdateRequest } from "@scc/shared";
import { Copy, Download, Merge, Plus, Save, Search, Trash2 } from "lucide-react";

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
  onCreate,
  onUpdate,
  onDelete,
  onBulkDelete,
  onMergeDuplicate,
  onExport
}: {
  skills: SkillRecord[];
  duplicates: SkillDuplicateGroup[];
  conflicts: SkillConflict[];
  onCreate: (input: SkillCreateRequest) => Promise<void> | void;
  onUpdate: (skillId: string, input: SkillUpdateRequest) => Promise<void> | void;
  onDelete: (skillId: string) => Promise<void> | void;
  onBulkDelete: (skillIds: string[]) => Promise<void> | void;
  onMergeDuplicate: (group: SkillDuplicateGroup) => Promise<void> | void;
  onExport: (skillId: string) => Promise<void> | void;
}) {
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
          <h2>Skills</h2>
          <p>Reusable agent behavior stays useful only when it can be reviewed, edited, merged, and removed.</p>
        </div>
        <button className="subtleButton" type="button" onClick={() => setSelectedId("new")}>
          <Plus size={15} />
          New skill
        </button>
      </header>

      {safeDuplicates.length > 0 ? (
        <section className="duplicateBanner">
          <div>
            <strong>{safeDuplicates.length} duplicate group{safeDuplicates.length > 1 ? "s" : ""}</strong>
            <span>Repeated promotions were detected. Merge them to keep the agent memory clean.</span>
          </div>
          <button className="subtleButton" type="button" onClick={() => safeDuplicates.forEach((group) => void onMergeDuplicate(group))}>
            <Merge size={15} />
            Merge all
          </button>
        </section>
      ) : null}

      <div className="skillGrid">
        <aside className="skillListPane">
          <div className="skillToolbar">
            <label className="skillSearch">
              <Search size={15} />
              <input aria-label="Search skills" placeholder="Search skills" value={query} onChange={(event) => setQuery(event.target.value)} />
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
            <span>{checkedIds.length} selected</span>
            <button className="textButton" type="button" disabled={checkedIds.length === 0} onClick={() => void onBulkDelete(checkedIds)}>
              Delete selected
            </button>
          </div>

          <div className="skillRows">
            {filteredSkills.length === 0 ? <p className="muted">No skills match this view.</p> : null}
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
                      {skill.status} · {formatSkillStats(skill)}
                      {duplicate ? " · duplicate" : ""}
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
                <h3>{selected ? "Edit skill" : "Create skill"}</h3>
                <p>{selected ? selected.id : "New skills start as candidate unless explicitly activated."}</p>
              </div>
              <div className="editorActions">
                {selected ? (
                  <>
                    <button className="textButton iconText" type="button" onClick={() => void onExport(selected.id)}>
                      <Download size={14} />
                      Export
                    </button>
                    <button className="textButton iconText dangerText" type="button" onClick={() => void onDelete(selected.id)}>
                      <Trash2 size={14} />
                      Delete
                    </button>
                  </>
                ) : null}
                <button className="subtleButton iconText" type="submit">
                  <Save size={14} />
                  Save
                </button>
              </div>
            </div>

            {selectedDuplicate ? (
              <div className="inlineNotice">
                <span>Duplicate group detected.</span>
                <button className="textButton iconText" type="button" onClick={() => void onMergeDuplicate(selectedDuplicate)}>
                  <Merge size={14} />
                  Merge group
                </button>
              </div>
            ) : null}
            {selectedConflicts.length > 0 ? (
              <div className="inlineNotice warning">
                <span>{selectedConflicts.length} conflict{selectedConflicts.length > 1 ? "s" : ""}: {selectedConflicts[0]?.reason}</span>
              </div>
            ) : null}

            <label className="fieldStack">
              <span>Title</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>Status</span>
              <select value={draft.status} onChange={(event) => setDraft({ ...draft, status: event.target.value as SkillRecord["status"] })}>
                {statuses.map((status) => (
                  <option value={status} key={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="fieldStack">
              <span>Body</span>
              <textarea value={draft.body} rows={12} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
            </label>

            <div className="editorSplit">
              <label className="fieldStack">
                <span>Keywords</span>
                <input value={draft.keywords} onChange={(event) => setDraft({ ...draft, keywords: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>Required tools</span>
                <input value={draft.requiredTools} onChange={(event) => setDraft({ ...draft, requiredTools: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>Context</span>
                <input value={draft.requiredContext} onChange={(event) => setDraft({ ...draft, requiredContext: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>Min confidence</span>
                <input value={draft.minConfidence} onChange={(event) => setDraft({ ...draft, minConfidence: event.target.value })} />
              </label>
            </div>

            <label className="fieldStack">
              <span>Description</span>
              <textarea value={draft.description} rows={3} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>Exclusions</span>
              <input value={draft.exclusions} onChange={(event) => setDraft({ ...draft, exclusions: event.target.value })} />
            </label>
          </form>

          <section className="skillPreview">
            <div className="panelHeader">
              <h3>Preview</h3>
              <button className="textButton iconText" type="button" onClick={() => void navigator.clipboard?.writeText(draft.body)}>
                <Copy size={14} />
                Copy body
              </button>
            </div>
            <pre>{draft.body || "No skill body yet."}</pre>
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
    .filter(Boolean);
}

function formatSkillStats(skill: SkillRecord): string {
  if (skill.stats.totalUses <= 0) return "not used yet";
  return `${Math.round(skill.stats.successRate * 100)}% · ${skill.stats.totalUses} uses`;
}
