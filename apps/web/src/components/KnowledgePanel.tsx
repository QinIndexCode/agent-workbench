import { useEffect, useMemo, useRef, useState } from "react";
import type { KnowledgeCreateRequest, KnowledgeItem, KnowledgeModelAssetKind, KnowledgeModelDownloadRequest, KnowledgeModelDownloadResult, KnowledgeModelStatus, KnowledgePatchRequest, KnowledgeSearchRequest, KnowledgeSearchResult, KnowledgeUploadRequest, PreferencesPatch, UserPreferences } from "@agent-workbench/shared";
import { BrainCircuit, Download, Edit3, FileText, FileUp, Plus, RefreshCw, Save, Search, Trash2, X } from "lucide-react";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { MarkdownText } from "./MarkdownText.js";
import { SettingsPrimer } from "./SettingsAssist.js";

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
  onOpenDocs,
  onCreate,
  onDelete,
  onReindex,
  onSearch,
  onUpdate,
  onUpload,
  preferences,
  onPreference,
  onLoadModels,
  onDownloadModel
}: {
  items: KnowledgeItem[];
  language?: string | null;
  query?: string;
  onOpenDocs?: (() => void) | undefined;
  onCreate: (input: KnowledgeCreateRequest) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onReindex?: (id: string) => Promise<void> | void;
  onSearch?: (input: KnowledgeSearchRequest) => Promise<KnowledgeSearchResult[]>;
  onUpdate: (id: string, input: KnowledgePatchRequest) => Promise<void> | void;
  onUpload: (input: KnowledgeUploadRequest) => Promise<void> | void;
  preferences?: UserPreferences | null;
  onPreference?: (patch: PreferencesPatch) => Promise<void> | void;
  onLoadModels?: () => Promise<KnowledgeModelStatus>;
  onDownloadModel?: (input: KnowledgeModelDownloadRequest) => Promise<KnowledgeModelDownloadResult>;
}) {
  const text = getKnowledgeCopy(language);
  const fileRef = useRef<HTMLInputElement>(null);
  const [localQuery, setLocalQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(items[0]?.id ?? null);
  const [page, setPage] = useState(0);
  const [modalMode, setModalMode] = useState<"create" | "edit" | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeItem | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [searchResults, setSearchResults] = useState<KnowledgeSearchResult[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [modelStatus, setModelStatus] = useState<KnowledgeModelStatus | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [modelKind, setModelKind] = useState<KnowledgeModelAssetKind>("fasttext_vectors");
  const [modelUrl, setModelUrl] = useState("");
  const [modelFileName, setModelFileName] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [kindFilter, setKindFilter] = useState<"all" | KnowledgeItem["kind"]>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | KnowledgeItem["indexStatus"]>("all");
  const selected = selectedId ? items.find((item) => item.id === selectedId) ?? null : null;
  const [draft, setDraft] = useState<KnowledgeDraft>(selected ? draftFromItem(selected) : emptyDraft());
  const searchText = `${query} ${localQuery}`.trim().toLowerCase();
  const filtered = useMemo(() => {
    return items.filter((item) => {
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (statusFilter !== "all" && item.indexStatus !== statusFilter) return false;
      if (!searchText) return true;
      return `${item.title} ${item.content} ${item.tags.join(" ")} ${item.fileName ?? ""}`.toLowerCase().includes(searchText);
    });
  }, [items, kindFilter, searchText, statusFilter]);

  useEffect(() => {
    if (selectedId && !items.some((item) => item.id === selectedId)) setSelectedId(items[0]?.id ?? null);
  }, [items, selectedId]);

  useEffect(() => {
    if (modalMode === "edit" && selected) setDraft(draftFromItem(selected));
  }, [modalMode, selected]);

  useEffect(() => {
    setPage(0);
  }, [kindFilter, searchText, statusFilter]);

  useEffect(() => {
    if (!onLoadModels) return;
    let cancelled = false;
    void onLoadModels()
      .then((status) => {
        if (!cancelled) setModelStatus(status);
      })
      .catch((error: unknown) => {
        if (!cancelled) setModelError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [onLoadModels]);

  useEffect(() => {
    setSelectedIds((current) => {
      const itemIds = new Set(items.map((item) => item.id));
      const next = new Set([...current].filter((id) => itemIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const visibleItems = filtered.slice(page * pageSize, page * pageSize + pageSize);

  return (
    <section className="knowledgePanel">
      <header className="libraryPanelHero">
        <div>
          <h2>{text.title}</h2>
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
      <SettingsPrimer
        language={language}
        summary={text.primer.summary}
        focus={text.primer.focus}
        impact={text.primer.impact}
        nextStep={text.primer.nextStep}
        onOpenDocs={onOpenDocs}
      />

      <div className="knowledgeGrid libraryManagerGrid">
        <div aria-label={text.title} className="knowledgeListPane" role="region">
          <label className="skillSearch">
            <Search size={15} />
            <input aria-label={text.search} placeholder={text.search} value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} />
          </label>
          <div className="knowledgeFilters">
            <select aria-label={text.kindFilter} value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | KnowledgeItem["kind"])}>
              <option value="all">{text.allKinds}</option>
              <option value="memory">{text.memory}</option>
              <option value="file">{text.file}</option>
            </select>
            <select aria-label={text.statusFilter} value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | KnowledgeItem["indexStatus"])}>
              <option value="all">{text.allStatuses}</option>
              <option value="indexed">indexed</option>
              <option value="pending">pending</option>
              <option value="failed">failed</option>
              <option value="metadata_only">metadata_only</option>
            </select>
          </div>
          {selectedIds.size > 0 ? (
            <div className="knowledgeBatchBar">
              <span>{text.selectedCount(selectedIds.size)}</span>
              {onReindex ? (
                <button className="textButton iconText" type="button" onClick={() => void reindexSelected()}>
                  <RefreshCw size={14} />
                  {text.reindexSelected}
                </button>
              ) : null}
              <button className="textButton dangerText iconText" type="button" onClick={() => setBatchDeleteOpen(true)}>
                <Trash2 size={14} />
                {text.deleteSelected}
              </button>
            </div>
          ) : null}
          <div className="skillRows">
            {filtered.length === 0 ? <LibraryEmpty text={text.empty} /> : null}
            {visibleItems.map((item) => (
              <article className={selectedId === item.id ? "knowledgeRow selectableKnowledgeRow selected" : "knowledgeRow selectableKnowledgeRow"} key={item.id}>
                <input
                  aria-label={`${text.select} ${item.title}`}
                  checked={selectedIds.has(item.id)}
                  type="checkbox"
                  onChange={(event) => toggleSelected(item.id, event.currentTarget.checked)}
                />
                <button className="knowledgeRowMain" type="button" onClick={() => setSelectedId(item.id)}>
                  <strong>{item.title}</strong>
                  <span>{item.kind === "file" ? item.fileName ?? text.file : text.memory}</span>
                  <small>{item.indexStatus} · {item.chunkCount} chunks · {item.tags.slice(0, 3).join(", ") || text.noTags}</small>
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
        </div>

        <section className="knowledgeDetailPane libraryPreviewPane">
          {selected ? (
            <>
              <div className="libraryPreviewHeader">
                <div>
                  <h3>{selected.title}</h3>
                  <p>{selected.kind === "file" ? selected.fileName ?? text.file : text.memory}</p>
                </div>
                <div className="rowIconActions">
                  {onReindex ? (
                    <button aria-label={`${text.reindex} ${selected.title}`} className="iconButton" type="button" onClick={() => void onReindex(selected.id)}>
                      <RefreshCw size={15} />
                    </button>
                  ) : null}
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
                <div><dt>{text.index}</dt><dd>{selected.indexStatus} · {selected.chunkCount}</dd></div>
                <div><dt>{text.lastIndexed}</dt><dd>{selected.lastIndexedAt ? new Date(selected.lastIndexedAt).toLocaleString() : text.none}</dd></div>
                <div><dt>{text.source}</dt><dd title={selected.sourceUri ?? selected.fileName ?? ""}>{selected.sourceUri ?? selected.fileName ?? text.none}</dd></div>
              </dl>
              {selected.indexError ? <p className="knowledgeError">{selected.indexError}</p> : null}
              {onSearch ? (
                <section className="skillPreview">
                  <h3>{text.searchTest}</h3>
                  <form
                    className="inlineSearchForm"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void runKnowledgeSearch();
                    }}
                  >
                    <input aria-label={text.searchTest} value={localQuery} onChange={(event) => setLocalQuery(event.target.value)} placeholder={text.searchPlaceholder} />
                    <button className="subtleButton" disabled={searchBusy || !localQuery.trim()} type="submit">
                      <Search size={14} /> {text.searchAction}
                    </button>
                  </form>
                  {searchResults.length > 0 ? (
                    <div className="compactList">
                      {searchResults.map((result) => (
                        <article className="providerRow" key={result.chunk.id}>
                          <span className="providerIcon"><FileText size={15} /></span>
                          <div className="knowledgeSearchResult">
                            <strong>{result.item.title}</strong>
                            <small>
                              {Math.round(result.score * 100)}% · {text.rerank}: {result.rerankStatus ?? "skipped"}
                              {typeof result.rerankScore === "number" ? ` · ${Math.round(result.rerankScore * 100)}%` : ""}
                              {typeof result.semanticScore === "number" ? ` · fastText ${Math.round(result.semanticScore * 100)}%` : ""}
                            </small>
                            {result.matchedFields?.length ? (
                              <div className="knowledgeHitFields">
                                {result.matchedFields.map((field) => <span key={field}>{field}</span>)}
                              </div>
                            ) : null}
                            {result.highlights?.length ? (
                              <div className="knowledgeHighlights">
                                {result.highlights.slice(0, 3).map((highlight, index) => (
                                  <p key={`${highlight.field}-${index}`}>
                                    <span>{highlight.field}</span>
                                    {highlight.text}
                                  </p>
                                ))}
                              </div>
                            ) : (
                              <p className="knowledgeHighlights"><span>{text.snippet}</span>{result.chunk.content.slice(0, 180)}</p>
                            )}
                            {result.rankReason ? <small>{result.rankReason}</small> : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
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
      {onLoadModels || onDownloadModel ? (
        <details className="knowledgeModelCard">
          <summary className="knowledgeModelHeader">
            <span className="prefSectionIcon"><BrainCircuit size={16} aria-hidden="true" /></span>
            <div>
              <h3>{text.modelTitle}</h3>
              <p>{text.modelSubtitle}</p>
            </div>
          </summary>
          <div className="knowledgeModelAssets">
            {(modelStatus?.assets ?? []).map((asset) => (
              <article className={asset.exists ? "knowledgeModelAsset ready" : "knowledgeModelAsset"} key={asset.kind}>
                <strong>{asset.label}</strong>
                <span>{asset.exists ? text.ready : asset.configured ? text.missing : text.notConfigured}</span>
                <small title={asset.path ?? ""}>{asset.path ?? text.noPath}{asset.size ? ` · ${formatBytes(asset.size)}` : ""}</small>
              </article>
            ))}
          </div>
          <form
            className="knowledgeModelDownload"
            onSubmit={(event) => {
              event.preventDefault();
              void downloadModel();
            }}
          >
            <select aria-label={text.modelKind} value={modelKind} onChange={(event) => setModelKind(event.target.value as KnowledgeModelAssetKind)}>
              <option value="fasttext_vectors">fastText .vec/.txt</option>
              <option value="tiny_reranker_model">Tiny reranker .onnx</option>
              <option value="tiny_reranker_vocab">Tiny reranker vocab.txt</option>
            </select>
            <input aria-label={text.modelUrl} placeholder={text.modelUrlPlaceholder} value={modelUrl} onChange={(event) => setModelUrl(event.target.value)} />
            <input aria-label={text.modelFileName} placeholder={text.modelFileNamePlaceholder} value={modelFileName} onChange={(event) => setModelFileName(event.target.value)} />
            <button className="subtleButton iconText" disabled={modelBusy || !modelUrl.trim()} type="submit">
              <Download size={14} />
              {modelBusy ? text.downloading : text.download}
            </button>
          </form>
          <div className="knowledgeModelToggles">
            <label>
              <input
                checked={preferences?.knowledgeActiveInjection ?? true}
                type="checkbox"
                onChange={(event) => void onPreference?.({ knowledgeActiveInjection: event.currentTarget.checked })}
              />
              {text.activeInjection}
            </label>
            <label>
              <input
                checked={preferences?.knowledgeTinyRerankerEnabled ?? false}
                disabled={!hasReadyAsset(modelStatus, "tiny_reranker_model") || !hasReadyAsset(modelStatus, "tiny_reranker_vocab")}
                type="checkbox"
                onChange={(event) => void onPreference?.({ knowledgeTinyRerankerEnabled: event.currentTarget.checked })}
              />
              {text.tinyReranker}
            </label>
          </div>
          {modelError ? <p className="knowledgeError">{modelError}</p> : null}
        </details>
      ) : null}

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

      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.deleteSelected}
        open={batchDeleteOpen}
        title={text.batchDeleteTitle}
        onCancel={() => setBatchDeleteOpen(false)}
        onConfirm={() => void deleteSelected()}
      >
        <p>{text.batchDeleteBody(selectedIds.size)}</p>
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

  async function runKnowledgeSearch() {
    if (!onSearch || !localQuery.trim()) return;
    setSearchBusy(true);
    try {
      setSearchResults(await onSearch({ query: localQuery.trim(), projectId: "default", limit: 5 }));
    } finally {
      setSearchBusy(false);
    }
  }

  async function downloadModel() {
    if (!onDownloadModel || !modelUrl.trim()) return;
    setModelBusy(true);
    setModelError(null);
    try {
      const result = await onDownloadModel({
        kind: modelKind,
        url: modelUrl.trim(),
        ...(modelFileName.trim() ? { fileName: modelFileName.trim() } : {})
      });
      setModelStatus((current) => {
        if (!current) return { assets: [result.asset], presets: [], tinyRerankerEnabled: result.preferences.knowledgeTinyRerankerEnabled };
        return {
          ...current,
          assets: current.assets.map((asset) => asset.kind === result.asset.kind ? result.asset : asset),
          tinyRerankerEnabled: result.preferences.knowledgeTinyRerankerEnabled
        };
      });
      setModelUrl("");
      setModelFileName("");
    } catch (error) {
      setModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setModelBusy(false);
    }
  }

  function toggleSelected(id: string, selected: boolean) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function reindexSelected() {
    if (!onReindex) return;
    for (const id of selectedIds) await onReindex(id);
    setSelectedIds(new Set());
  }

  async function deleteSelected() {
    for (const id of selectedIds) await onDelete(id);
    setSelectedIds(new Set());
    setBatchDeleteOpen(false);
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

function hasReadyAsset(status: KnowledgeModelStatus | null, kind: KnowledgeModelAssetKind): boolean {
  return Boolean(status?.assets.some((asset) => asset.kind === kind && asset.exists));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 102.4) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${bytes} B`;
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
    select: zh ? "选择条目" : "Select item",
    kindFilter: zh ? "按类型筛选" : "Filter by type",
    statusFilter: zh ? "按索引状态筛选" : "Filter by index status",
    allKinds: zh ? "全部类型" : "All types",
    allStatuses: zh ? "全部状态" : "All statuses",
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
    index: zh ? "索引" : "Index",
    lastIndexed: zh ? "最近索引" : "Last indexed",
    source: zh ? "来源" : "Source",
    reindex: zh ? "重建索引" : "Reindex",
    selectedCount: (count: number) => zh ? `已选择 ${count} 项` : `${count} selected`,
    reindexSelected: zh ? "批量重建" : "Reindex selected",
    deleteSelected: zh ? "批量删除" : "Delete selected",
    batchDeleteTitle: zh ? "删除选中的知识条目？" : "Delete selected knowledge items?",
    batchDeleteBody: (count: number) => zh ? `将从资料库移除 ${count} 个条目。` : `${count} items will be removed from the library.`,
    searchTest: zh ? "检索测试" : "Search test",
    searchPlaceholder: zh ? "输入要查找的知识..." : "Search stored knowledge...",
    searchAction: zh ? "检索" : "Search",
    rerank: zh ? "重排" : "Rerank",
    snippet: zh ? "片段" : "Snippet",
    modelTitle: zh ? "本地小模型" : "Local small models",
    modelSubtitle: zh ? "下载 fastText 向量与 TinyBERT/MobileBERT ONNX 重排器，下载后自动配置到资料库检索。" : "Download fastText vectors and TinyBERT/MobileBERT ONNX rerankers. Downloads are configured automatically for knowledge search.",
    modelKind: zh ? "模型类型" : "Model type",
    modelUrl: zh ? "模型下载 URL" : "Model download URL",
    modelUrlPlaceholder: zh ? "https://.../model.onnx 或 vectors.vec" : "https://.../model.onnx or vectors.vec",
    modelFileName: zh ? "保存文件名" : "Saved file name",
    modelFileNamePlaceholder: zh ? "可选，默认使用 URL 文件名" : "Optional, defaults to URL file name",
    download: zh ? "下载并配置" : "Download and configure",
    downloading: zh ? "下载中" : "Downloading",
    ready: zh ? "可用" : "Ready",
    missing: zh ? "文件缺失" : "Missing file",
    notConfigured: zh ? "未配置" : "Not configured",
    noPath: zh ? "无路径" : "No path",
    activeInjection: zh ? "主动注入短知识摘要" : "Inject compact knowledge brief",
    tinyReranker: zh ? "启用 Tiny ONNX 重排器" : "Enable Tiny ONNX reranker",
    size: zh ? "大小" : "Size",
    none: zh ? "无" : "None",
    pageLabel: (page: number, total: number) => zh ? `第 ${page} / ${total} 页` : `Page ${page} / ${total}`,
    primer: {
      summary: zh ? "知识库保存可复用资料和引用片段，用来补充当前任务，而不是代替实时工作区检查。" : "Knowledge stores reusable notes and citation-ready material that supports a task without replacing live workspace inspection.",
      focus: zh ? "优先管理条目内容、标签和索引质量；本地检索模型只是高级增强，不该抢占首屏。" : "Prioritize item content, tagging, and index quality. Local retrieval models are an advanced enhancement and should not dominate the first screen.",
      impact: zh ? "会影响 knowledge_search 的命中质量、主动注入摘要的稳定性，以及用户能否快速找回可信资料。" : "Changes affect knowledge_search quality, active knowledge brief stability, and how quickly users can recover trusted reference material.",
      nextStep: zh ? "先整理内容和标签，再在 Advanced 区按需开启本地模型和重排器。" : "Clean up content and tags first, then enable local models and rerankers from the Advanced section only if needed."
    }
  };
}
