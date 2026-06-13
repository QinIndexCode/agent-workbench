import { useEffect, useMemo, useState } from "react";
import type { MemoryDocument, MemoryDocumentCompactResult, ProjectMemory, ProjectMemoryCreateRequest, ProjectMemoryPatchRequest, TaskFolderRecord } from "@agent-workbench/shared";
import { BookMarked, Database, Edit3, Plus, Save, Scissors, Search, Trash2, UserRound, X } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { MarkdownText } from "./MarkdownText.js";

type MemoryDocKey = "user" | "project";
type ProjectMemoryCategory = ProjectMemoryCreateRequest["category"];

type MemoryDraft = {
  title: string;
  category: ProjectMemoryCategory;
  tags: string;
  content: string;
};

const categories: ProjectMemoryCategory[] = ["architecture", "tech_stack", "business_logic", "convention"];

export function ProjectMemoryPanel({
  activeFolderId,
  folders,
  language,
  memories,
  query = "",
  onOpenDocs,
  onCompactProjectMemory,
  onCreate,
  onDelete,
  onUpdateMemory,
  onLoadProjectMemory,
  onLoadUserProfile,
  onSaveProjectMemory,
  onSaveUserProfile
}: {
  activeFolderId: string;
  folders: TaskFolderRecord[];
  language?: string | null;
  memories: ProjectMemory[];
  query?: string;
  onOpenDocs?: (() => void) | undefined;
  onCompactProjectMemory: (folderId: string) => Promise<MemoryDocumentCompactResult>;
  onCreate: (input: ProjectMemoryCreateRequest) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onUpdateMemory?: (id: string, input: ProjectMemoryPatchRequest) => Promise<void> | void;
  onLoadProjectMemory: (folderId: string) => Promise<MemoryDocument>;
  onLoadUserProfile: () => Promise<MemoryDocument>;
  onSaveProjectMemory: (folderId: string, content: string) => Promise<MemoryDocument>;
  onSaveUserProfile: (content: string) => Promise<MemoryDocument>;
}) {
  const text = getMemoryCopy(language);
  const folder = folders.find((item) => item.id === activeFolderId) ?? folders.find((item) => item.id === "default");
  const folderId = folder?.id ?? activeFolderId ?? "default";
  const [activeDoc, setActiveDoc] = useState<MemoryDocKey>("user");
  const [userDoc, setUserDoc] = useState<MemoryDocument | null>(null);
  const [projectDoc, setProjectDoc] = useState<MemoryDocument | null>(null);
  const [userContent, setUserContent] = useState("");
  const [projectContent, setProjectContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compactResult, setCompactResult] = useState<MemoryDocumentCompactResult | null>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [selectedMemoryId, setSelectedMemoryId] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [editingMemoryId, setEditingMemoryId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryDraft>(emptyDraft());
  const [deleteTarget, setDeleteTarget] = useState<ProjectMemory | null>(null);
  const searchText = `${query} ${localQuery}`.trim().toLowerCase();
  const folderMemories = useMemo(
    () => memories.filter((memory) => memory.projectId === folderId),
    [memories, folderId]
  );
  const filteredMemories = useMemo(() => {
    if (!searchText) return folderMemories;
    return folderMemories.filter((memory) =>
      `${memory.title} ${memory.content} ${memory.category} ${memory.tags.join(" ")}`.toLowerCase().includes(searchText)
    );
  }, [folderMemories, searchText]);
  const selectedMemory = selectedMemoryId ? filteredMemories.find((memory) => memory.id === selectedMemoryId) ?? null : filteredMemories[0] ?? null;
  const selectedDoc = activeDoc === "user" ? userDoc : projectDoc;
  const selectedDocContent = activeDoc === "user" ? userContent : projectContent;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCompactResult(null);
    void Promise.all([onLoadUserProfile(), onLoadProjectMemory(folderId)])
      .then(([nextUserDoc, nextProjectDoc]) => {
        if (cancelled) return;
        setUserDoc(nextUserDoc);
        setProjectDoc(nextProjectDoc);
        setUserContent(nextUserDoc.content);
        setProjectContent(nextProjectDoc.content);
      })
      .catch((loadError) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : String(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folderId, onLoadProjectMemory, onLoadUserProfile]);

  useEffect(() => {
    if (selectedMemoryId && !filteredMemories.some((memory) => memory.id === selectedMemoryId)) {
      setSelectedMemoryId(filteredMemories[0]?.id ?? null);
    }
  }, [filteredMemories, selectedMemoryId]);

  return (
    <section className="memoryPanel">
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
          <button className="subtleButton iconText" type="button" onClick={() => { setEditingMemoryId(null); setDraft(emptyDraft()); setDraftOpen(true); }}>
            <Plus size={15} />
            {text.newMemory}
          </button>
        </div>
      </header>

      {error ? <p className="formError">{error}</p> : null}
      {compactResult ? (
        <p className="fieldHint">{text.compacted(compactResult.beforeChars, compactResult.afterChars, compactResult.removedLines)}</p>
      ) : null}

      <div className="knowledgeGrid memoryGrid libraryManagerGrid">
        <div aria-label={text.title} className="knowledgeListPane" role="region">
          <div className="memoryDocList">
            <button className={activeDoc === "user" ? "knowledgeRow selected" : "knowledgeRow"} type="button" onClick={() => setActiveDoc("user")}>
              <span className="providerIcon"><UserRound size={15} /></span>
              <span className="knowledgeRowMain memoryDocMain">
                <strong>{text.userProfile}</strong>
                <span className="knowledgeRowMeta">
                  <span className="memoryCategoryBadge">{userDoc?.fileName ?? "USER.md"}</span>
                  <small>{text.charCount(userContent.length, userDoc?.charLimit)}</small>
                </span>
              </span>
            </button>
            <button className={activeDoc === "project" ? "knowledgeRow selected" : "knowledgeRow"} type="button" onClick={() => setActiveDoc("project")}>
              <span className="providerIcon"><BookMarked size={15} /></span>
              <span className="knowledgeRowMain memoryDocMain">
                <strong>{text.projectMemory}</strong>
                <span className="knowledgeRowMeta">
                  <span className="memoryCategoryBadge" title={folder?.name ?? folderId}>{folder?.name ?? folderId}</span>
                  <small>{text.charCount(projectContent.length, projectDoc?.charLimit)}</small>
                </span>
              </span>
            </button>
          </div>

          <label className="skillSearch">
            <Search size={15} />
            <input aria-label={text.search} placeholder={text.search} value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} />
          </label>
          <div className="skillRows">
            {filteredMemories.length === 0 ? <LibraryEmpty text={text.empty} /> : null}
            {filteredMemories.map((memory) => {
              const tagSummary = summarizeMemoryTags(memory.tags, text.noTags);
              return (
                <article className={selectedMemory?.id === memory.id ? "knowledgeRow selected" : "knowledgeRow"} key={memory.id}>
                  <button className="knowledgeRowMain" type="button" onClick={() => setSelectedMemoryId(memory.id)}>
                    <strong>{memory.title}</strong>
                    <div className="knowledgeRowMeta">
                      <span className={`memoryCategoryBadge ${memory.category}`}>{text.categories[memory.category]}</span>
                      <small title={tagSummary}>{tagSummary}</small>
                    </div>
                  </button>
                  <div className="rowIconActions">
                    {onUpdateMemory ? (
                      <button aria-label={`${text.edit} ${memory.title}`} className="iconButton" type="button" onClick={() => openEditMemory(memory)}>
                        <Edit3 size={14} />
                      </button>
                    ) : null}
                    <button aria-label={`${text.delete} ${memory.title}`} className="iconButton dangerIcon" type="button" onClick={() => setDeleteTarget(memory)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        </div>

        <section className="knowledgeDetailPane libraryPreviewPane">
          <div className="libraryPreviewHeader">
            <div>
              <h3>{activeDoc === "user" ? text.userProfile : text.projectMemory}</h3>
              <p>{selectedDoc?.path ?? (loading ? text.loading : text.notLoaded)}</p>
            </div>
            <div className="rowIconActions">
              {activeDoc === "project" ? (
                <button className="iconButton" type="button" aria-label={text.compact} disabled={Boolean(busy) || !projectDoc} onClick={() => void compactProjectDoc()}>
                  <Scissors size={15} />
                </button>
              ) : null}
              <button className="iconButton" type="button" aria-label={text.save} disabled={Boolean(busy) || !selectedDoc} onClick={() => void saveActiveDoc()}>
                <Save size={15} />
              </button>
            </div>
          </div>
          <dl className="libraryMetaGrid">
            <div><dt>{text.scope}</dt><dd>{activeDoc}</dd></div>
            <div><dt>{text.folder}</dt><dd>{activeDoc === "project" ? folder?.name ?? folderId : text.global}</dd></div>
            <div><dt>{text.file}</dt><dd>{selectedDoc?.fileName ?? text.none}</dd></div>
            <div><dt>{text.updated}</dt><dd>{selectedDoc ? new Date(selectedDoc.updatedAt).toLocaleString() : text.none}</dd></div>
          </dl>
          <label className="fieldStack memoryEditor">
            <span>{activeDoc === "user" ? text.userProfileContent : text.projectMemoryContent}</span>
            <textarea
              aria-label={activeDoc === "user" ? text.userProfileContent : text.projectMemoryContent}
              disabled={loading}
              rows={14}
              value={selectedDocContent}
              onChange={(event) => activeDoc === "user" ? setUserContent(event.target.value) : setProjectContent(event.target.value)}
            />
          </label>

          <section className="skillPreview">
            <h3>{text.structuredPreview}</h3>
            {selectedMemory ? (
              <>
                <dl className="libraryMetaGrid">
                  <div>
                    <dt>{text.category}</dt>
                    <dd><span className={`memoryCategoryBadge ${selectedMemory.category}`}>{text.categories[selectedMemory.category]}</span></dd>
                  </div>
                  <div><dt>{text.tags}</dt><dd>{selectedMemory.tags.join(", ") || text.noTags}</dd></div>
                  <div><dt>{text.updated}</dt><dd>{new Date(selectedMemory.updatedAt).toLocaleString()}</dd></div>
                  <div><dt>{text.project}</dt><dd>{selectedMemory.projectId}</dd></div>
                </dl>
                <MarkdownText content={selectedMemory.content} />
              </>
            ) : (
              <LibraryEmpty text={text.empty} />
            )}
          </section>
        </section>
      </div>

      {draftOpen ? (
        <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setDraftOpen(false)}>
          <form
            aria-label={editingMemoryId ? text.editDialog : text.createDialog}
            aria-modal="true"
            className="providerDialog knowledgeDialog"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void createMemory();
            }}
          >
            <header className="dialogHeader">
              <div>
                <h3>{editingMemoryId ? text.editDialog : text.createDialog}</h3>
                <p>{editingMemoryId ? editingMemoryId : text.createHelp(folder?.name ?? folderId)}</p>
              </div>
              <button aria-label={text.cancel} className="iconButton" type="button" onClick={() => { setDraftOpen(false); setEditingMemoryId(null); }}>
                <X size={16} />
              </button>
            </header>
            <label className="fieldStack">
              <span>{text.itemTitle}</span>
              <input aria-label={text.itemTitle} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required />
            </label>
            <label className="fieldStack">
              <span>{text.category}</span>
              <AccordionSelect
                ariaLabel={text.category}
                options={categories.map((category) => ({ value: category, label: text.categories[category] }))}
                value={draft.category}
                onChange={(value) => setDraft({ ...draft, category: value as ProjectMemoryCategory })}
              />
            </label>
            <label className="fieldStack">
              <span>{text.tags}</span>
              <input aria-label={text.tags} value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.content}</span>
              <textarea aria-label={text.content} rows={10} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} required />
            </label>
            <footer className="dialogActions">
              <button className="subtleButton" type="button" onClick={() => { setDraftOpen(false); setEditingMemoryId(null); }}>
                {text.cancel}
              </button>
              <button className="subtleButton iconText" type="submit">
                <Database size={14} />
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

  async function saveActiveDoc() {
    setBusy(`save-${activeDoc}`);
    setError(null);
    try {
      if (activeDoc === "user") {
        const next = await onSaveUserProfile(userContent);
        setUserDoc(next);
        setUserContent(next.content);
      } else {
        const next = await onSaveProjectMemory(folderId, projectContent);
        setProjectDoc(next);
        setProjectContent(next.content);
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function compactProjectDoc() {
    setBusy("compact-project");
    setError(null);
    try {
      const result = await onCompactProjectMemory(folderId);
      setCompactResult(result);
      setProjectDoc(result.document);
      setProjectContent(result.document.content);
      setActiveDoc("project");
    } catch (compactError) {
      setError(compactError instanceof Error ? compactError.message : String(compactError));
    } finally {
      setBusy(null);
    }
  }

  async function createMemory() {
    const payload = {
      title: draft.title.trim(),
      content: draft.content.trim(),
      category: draft.category,
      tags: splitList(draft.tags)
    };
    if (!payload.title || !payload.content) return;
    if (editingMemoryId && onUpdateMemory) {
      await onUpdateMemory(editingMemoryId, payload);
    } else {
      await onCreate({ ...payload, projectId: folderId });
    }
    setDraftOpen(false);
    setEditingMemoryId(null);
  }

  function openEditMemory(memory: ProjectMemory) {
    setSelectedMemoryId(memory.id);
    setEditingMemoryId(memory.id);
    setDraft({
      title: memory.title,
      content: memory.content,
      category: memory.category,
      tags: memory.tags.join(", ")
    });
    setDraftOpen(true);
  }
}

function LibraryEmpty({ text }: { text: string }) {
  return (
    <div className="libraryEmpty">
      <Database size={20} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

function emptyDraft(): MemoryDraft {
  return { title: "", category: "architecture", tags: "", content: "" };
}

function splitList(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function summarizeMemoryTags(tags: string[], empty: string): string {
  return tags.slice(0, 3).join(", ") || empty;
}

function getMemoryCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "记忆" : "Memory",
    docs: zh ? "文档" : "Docs",
    userProfile: zh ? "用户画像" : "User profile",
    projectMemory: zh ? "项目记忆" : "Project memory",
    newMemory: zh ? "新建项目记忆" : "New project memory",
    search: zh ? "搜索项目记忆" : "Search project memories",
    empty: zh ? "当前文件夹还没有结构化项目记忆。" : "No structured project memories for this folder.",
    loading: zh ? "加载中..." : "Loading...",
    notLoaded: zh ? "未加载" : "Not loaded",
    save: zh ? "保存" : "Save",
    cancel: zh ? "取消" : "Cancel",
    compact: zh ? "压缩项目记忆" : "Compact project memory",
    scope: zh ? "范围" : "Scope",
    folder: zh ? "文件夹" : "Folder",
    file: zh ? "文件" : "File",
    updated: zh ? "更新时间" : "Updated",
    none: zh ? "无" : "None",
    global: zh ? "全局" : "Global",
    userProfileContent: zh ? "USER.md 内容" : "USER.md content",
    projectMemoryContent: zh ? "MEMORY.md 内容" : "MEMORY.md content",
    structuredPreview: zh ? "结构化项目事实" : "Structured project facts",
    createDialog: zh ? "创建项目记忆" : "Create project memory",
    editDialog: zh ? "编辑项目记忆" : "Edit project memory",
    edit: zh ? "编辑" : "Edit",
    createHelp: (folderName: string) => zh ? `这条记忆会绑定到“${folderName}”。` : `This memory will be attached to ${folderName}.`,
    itemTitle: zh ? "标题" : "Title",
    category: zh ? "分类" : "Category",
    categories: {
      architecture: zh ? "架构" : "Architecture",
      tech_stack: zh ? "技术栈" : "Tech stack",
      business_logic: zh ? "业务逻辑" : "Business logic",
      convention: zh ? "约定" : "Convention"
    } satisfies Record<ProjectMemoryCategory, string>,
    tags: zh ? "标签" : "Tags",
    noTags: zh ? "无标签" : "No tags",
    content: zh ? "内容" : "Content",
    project: zh ? "项目" : "Project",
    delete: zh ? "删除" : "Delete",
    deleteTitle: zh ? "删除项目记忆？" : "Delete project memory?",
    deleteBody: (title: string) => zh ? `“${title}” 会从结构化项目记忆中移除。` : `"${title}" will be removed from structured project memory.`,
    charCount: (chars: number, limit?: number) => limit ? `${chars} / ${limit}` : `${chars}`,
    compacted: (before: number, after: number, lines: number) => zh ? `已压缩项目记忆：${before} -> ${after} 字符，移除 ${lines} 行。` : `Compacted project memory: ${before} -> ${after} chars, removed ${lines} lines.`
  };
}
