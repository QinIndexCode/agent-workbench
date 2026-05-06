import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeCreateRequest, KnowledgeItem, KnowledgePatchRequest, KnowledgeUploadRequest } from "@scc/shared";
import { Edit3, FileText, FileUp, Plus, Save, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { MarkdownText } from "./MarkdownText.js";

type KnowledgeDraft = {
  title: string;
  content: string;
  tags: string;
};

const pageSize = 8;

export function KnowledgePanel({
  items,
  language,
  query = "",
  onCreate,
  onDelete,
  onUpdate,
  onUpload
}: {
  items: KnowledgeItem[];
  language?: string | null;
  query?: string;
  onCreate: (input: KnowledgeCreateRequest) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onUpdate: (id: string, input: KnowledgePatchRequest) => Promise<void> | void;
  onUpload: (input: KnowledgeUploadRequest) => Promise<void> | void;
}) {
  const text = getKnowledgeCopy(language);
  const fileRef = useRef<HTMLInputElement>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [page, setPage] = useState(0);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null);
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;
  const [draft, setDraft] = useState<KnowledgeDraft>(selected ? draftFromItem(selected) : emptyDraft());
  const searchText = `${query} ${localQuery}`.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!searchText) return items;
    return items.filter((item) => `${item.title} ${item.content} ${item.tags.join(" ")} ${item.fileName ?? ""}`.toLowerCase().includes(searchText));
  }, [items, searchText]);

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId]);

  useEffect(() => {
    if (modalMode === "edit" && selected) setDraft(draftFromItem(selected));
  }, [modalMode, selected]);

  useEffect(() => {
    setPage(0);
  }, [searchText]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleItems = filtered.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <section className="knowledgePanel">
      <header className="libraryPanelHero">
        <div>
          <h3>{text.title}</h3>
          <p>{text.subtitle}</p>
        </div>
        <div className="inlineActions">
          <button className="textButton iconText" type="button" onClick={() => fileRef.current?.click()}>
            <FileUp size={15} />
            {text.upload}
          </button>
          <button
            className="subtleButton iconText"
            type="button"
            onClick={() => {
              setDraft(emptyDraft());
              setModalMode("create");
            }}
          >
            <Plus size={15} />
            {text.newItem}
          </button>
        </div>
        <input hidden multiple ref={fileRef} type="file" onChange={(event) => void uploadFiles(event.currentTarget.files)} />
      </header>

      <div className="knowledgeGrid libraryManagerGrid">
        <aside className="knowledgeListPane">
          <label className="skillSearch">
            <Search size={15} />
            <input aria-label={text.search} placeholder={text.search} value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} />
          </label>
          <div className="skillRows">
            {filtered.length === 0 ? <LibraryEmpty text={text.empty} /> : null}
            {visibleItems.map((item) => (
              <article className={selectedId === item.id ? "knowledgeRow selected" : "knowledgeRow"} key={item.id}>
                <button className="knowledgeRowMain" type="button" onClick={() => setSelectedId(item.id)}>
                  <strong>{item.title}</strong>
                  <span>{item.kind === "file" ? item.fileName ?? text.file : text.memory}</span>
                  <small>{item.tags.slice(0, 4).join(", ") || text.noTags}</small>
                </button>
                <div className="rowIconActions">
                  <button aria-label={`${text.edit} ${item.title}`} className="iconButton" type="button" onClick={() => openEdit(item)}>
                    <Edit3 size={14} />
                  </button>
                  <button aria-label={`${text.delete} ${item.title}`} className="iconButton dangerIcon" type="button" onClick={() => setDeleteTarget(item)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </article>
            ))}
          </div>
          <Pagination page={page} pageCount={pageCount} label={text.pageLabel(page + 1, pageCount)} onPage={setPage} />
        </aside>

        <section className="knowledgeDetailPane libraryPreviewPane">
          {selected ? (
            <>
              <div className="libraryPreviewHeader">
                <div>
                  <h3>{selected.title}</h3>
                  <p>{selected.kind === "file" ? selected.fileName ?? text.file : text.memory}</p>
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
              <dl className="libraryMetaGrid">
                <div><dt>{text.kind}</dt><dd>{selected.kind}</dd></div>
                <div><dt>{text.tags}</dt><dd>{selected.tags.join(", ") || text.noTags}</dd></div>
                <div><dt>{text.updated}</dt><dd>{new Date(selected.updatedAt).toLocaleString()}</dd></div>
                <div><dt>{text.size}</dt><dd>{selected.size ? `${selected.size} B` : text.none}</dd></div>
              </dl>
              <section className="skillPreview">
                <h3>{text.preview}</h3>
                <MarkdownText content={selected.content || text.noPreview} />
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
            className="providerDialog knowledgeDialog"
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <header className="dialogHeader">
              <div>
                <h3>{modalMode === "edit" ? text.edit : text.create}</h3>
                <p>{modalMode === "edit" && selected ? selected.id : text.createHelp}</p>
              </div>
              <button aria-label={text.cancel} className="iconButton" type="button" onClick={() => setModalMode(null)}>
                <X size={16} />
              </button>
            </header>
            <label className="fieldStack">
              <span>{text.itemTitle}</span>
              <input aria-label={text.itemTitle} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.tags}</span>
              <input aria-label={text.tags} value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.content}</span>
              <textarea aria-label={text.content} rows={14} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
            </label>
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

  function openEdit(item: KnowledgeItem) {
    setSelectedId(item.id);
    setDraft(draftFromItem(item));
    setModalMode("edit");
  }

  async function save() {
    const payload = { title: draft.title.trim(), content: draft.content.trim(), tags: splitList(draft.tags) };
    if (!payload.title || !payload.content) return;
    if (modalMode === "edit" && selected) await onUpdate(selected.id, payload);
    else await onCreate({ projectId: "default", kind: "memory", ...payload });
    setModalMode(null);
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length) return;
    for (const file of [...files].slice(0, 8)) {
      const content = await readUploadContent(file);
      await onUpload({
        projectId: "default",
        title: file.name,
        fileName: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        content,
        tags: []
      });
    }
    if (fileRef.current) fileRef.current.value = "";
  }
}

function LibraryEmpty({ text }: { text: string }) {
  return (
    <div className="libraryEmpty">
      <FileText size={20} aria-hidden="true" />
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

function emptyDraft(): KnowledgeDraft {
  return { title: "", content: "", tags: "" };
}

function draftFromItem(item: KnowledgeItem): KnowledgeDraft {
  return { title: item.title, content: item.content, tags: item.tags.join(", ") };
}

function splitList(value: string): string[] {
  return value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

async function readUploadContent(file: File): Promise<string> {
  if (file.size > 750_000 || !isTextLike(file)) {
    return [`File: ${file.name}`, `Type: ${file.type || "unknown"}`, `Size: ${file.size} bytes`, "", "This file is stored as metadata. Ask the agent to inspect it when needed."].join("\n");
  }
  return file.text();
}

function isTextLike(file: File): boolean {
  return file.type.startsWith("text/") || /(\.md|\.txt|\.json|\.csv|\.ts|\.tsx|\.js|\.jsx|\.css|\.html|\.xml|\.yaml|\.yml)$/i.test(file.name);
}

function getKnowledgeCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "知识库" : "Knowledge",
    subtitle: zh ? "浏览项目事实、说明文件和可引用内容。" : "Browse project facts, notes, and referenceable content.",
    upload: zh ? "上传文件" : "Upload files",
    newItem: zh ? "新建条目" : "New item",
    search: zh ? "搜索知识库" : "Search knowledge",
    empty: zh ? "没有匹配的知识条目。" : "No matching knowledge items.",
    file: zh ? "文件" : "File",
    memory: zh ? "项目记忆" : "Project memory",
    kind: zh ? "类型" : "Type",
    noTags: zh ? "无标签" : "No tags",
    edit: zh ? "编辑条目" : "Edit item",
    create: zh ? "创建条目" : "Create item",
    createHelp: zh ? "记录一个可复用的项目事实或资料。" : "Record a reusable project fact or note.",
    delete: zh ? "删除" : "Delete",
    deleteTitle: zh ? "删除知识条目？" : "Delete knowledge item?",
    deleteBody: (title: string) => zh ? `“${title}” 会从资料库移除。` : `"${title}" will be removed from the library.`,
    cancel: zh ? "取消" : "Cancel",
    save: zh ? "保存" : "Save",
    itemTitle: zh ? "标题" : "Title",
    tags: zh ? "标签" : "Tags",
    content: zh ? "内容" : "Content",
    preview: zh ? "预览" : "Preview",
    noPreview: zh ? "还没有内容。" : "No content yet.",
    updated: zh ? "更新时间" : "Updated",
    size: zh ? "大小" : "Size",
    none: zh ? "无" : "None",
    pageLabel: (page: number, total: number) => zh ? `第 ${page} / ${total} 页` : `Page ${page} / ${total}`
  };
}
