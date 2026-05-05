import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeCreateRequest, KnowledgeItem, KnowledgePatchRequest, KnowledgeUploadRequest } from "@scc/shared";
import { FileUp, Plus, Save, Search, Trash2 } from "lucide-react";
import { MarkdownText } from "./MarkdownText.js";

type KnowledgeDraft = {
  title: string;
  content: string;
  tags: string;
};

export function KnowledgePanel({
  items,
  language,
  onCreate,
  onDelete,
  onUpdate,
  onUpload
}: {
  items: KnowledgeItem[];
  language?: string | null;
  onCreate: (input: KnowledgeCreateRequest) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onUpdate: (id: string, input: KnowledgePatchRequest) => Promise<void> | void;
  onUpload: (input: KnowledgeUploadRequest) => Promise<void> | void;
}) {
  const text = getKnowledgeCopy(language);
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | "new">(items[0]?.id ?? "new");
  const selected = selectedId === "new" ? null : items.find((item) => item.id === selectedId) ?? null;
  const [draft, setDraft] = useState<KnowledgeDraft>(selected ? draftFromItem(selected) : emptyDraft());
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => `${item.title} ${item.content} ${item.tags.join(" ")}`.toLowerCase().includes(needle));
  }, [items, query]);

  useEffect(() => {
    setDraft(selected ? draftFromItem(selected) : emptyDraft());
  }, [selectedId, selected?.updatedAt]);

  return (
    <section className="knowledgePanel">
      <header className="panelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <div className="inlineActions">
          <button className="subtleButton iconText" type="button" onClick={() => fileRef.current?.click()}>
            <FileUp size={15} />
            {text.upload}
          </button>
          <button className="subtleButton iconText" type="button" onClick={() => startNew()}>
            <Plus size={15} />
            {text.newItem}
          </button>
        </div>
        <input hidden multiple ref={fileRef} type="file" onChange={(event) => void uploadFiles(event.currentTarget.files)} />
      </header>

      <div className="knowledgeGrid">
        <aside className="knowledgeListPane">
          <label className="skillSearch">
            <Search size={15} />
            <input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="skillRows">
            {filtered.length === 0 ? <p className="muted">{text.empty}</p> : null}
            {filtered.map((item) => (
              <button className={selectedId === item.id ? "knowledgeRow selected" : "knowledgeRow"} key={item.id} type="button" onClick={() => selectItem(item)}>
                <strong>{item.title}</strong>
                <span>{item.kind === "file" ? item.fileName ?? text.file : text.memory}</span>
                <small>{item.tags.slice(0, 4).join(", ") || text.noTags}</small>
              </button>
            ))}
          </div>
        </aside>

        <section className="knowledgeDetailPane">
          <form
            className="skillEditor"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="editorHeader">
              <div>
                <h3>{selected ? text.edit : text.create}</h3>
                <p>{selected ? selected.id : text.createHelp}</p>
              </div>
              <div className="editorActions">
                {selected ? (
                  <button className="textButton iconText dangerText" type="button" onClick={() => void onDelete(selected.id)}>
                    <Trash2 size={14} />
                    {text.delete}
                  </button>
                ) : null}
                <button className="subtleButton iconText" type="submit">
                  <Save size={14} />
                  {text.save}
                </button>
              </div>
            </div>
            <label className="fieldStack">
              <span>{text.itemTitle}</span>
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.tags}</span>
              <input value={draft.tags} onChange={(event) => setDraft({ ...draft, tags: event.target.value })} />
            </label>
            <label className="fieldStack">
              <span>{text.content}</span>
              <textarea rows={14} value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} />
            </label>
          </form>
          <section className="skillPreview">
            <h3>{text.preview}</h3>
            <MarkdownText content={draft.content || text.noPreview} />
          </section>
        </section>
      </div>
    </section>
  );

  function startNew() {
    setSelectedId("new");
    setDraft(emptyDraft());
  }

  function selectItem(item: KnowledgeItem) {
    setSelectedId(item.id);
    setDraft(draftFromItem(item));
  }

  async function save() {
    const payload = { title: draft.title.trim(), content: draft.content.trim(), tags: splitList(draft.tags) };
    if (!payload.title || !payload.content) return;
    if (selected) await onUpdate(selected.id, payload);
    else await onCreate({ projectId: "default", kind: "memory", ...payload });
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
    subtitle: zh ? "保存项目记忆、说明文件和可被 Agent 引用的资料。" : "Save project memories, notes, and files the agent can reference.",
    upload: zh ? "上传文件" : "Upload files",
    newItem: zh ? "新建条目" : "New item",
    search: zh ? "搜索知识库" : "Search knowledge",
    empty: zh ? "没有匹配的知识条目。" : "No matching knowledge items.",
    file: zh ? "文件" : "File",
    memory: zh ? "项目记忆" : "Project memory",
    noTags: zh ? "无标签" : "No tags",
    edit: zh ? "编辑条目" : "Edit item",
    create: zh ? "创建条目" : "Create item",
    createHelp: zh ? "记录一个可复用的项目事实或资料。" : "Record a reusable project fact or note.",
    delete: zh ? "删除" : "Delete",
    save: zh ? "保存" : "Save",
    itemTitle: zh ? "标题" : "Title",
    tags: zh ? "标签" : "Tags",
    content: zh ? "内容" : "Content",
    preview: zh ? "预览" : "Preview",
    noPreview: zh ? "还没有内容。" : "No content yet."
  };
}
