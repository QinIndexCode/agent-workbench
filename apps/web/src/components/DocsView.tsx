import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Languages, Menu, Search, X } from "lucide-react";
import "../styles/settings.css";
import { MarkdownText } from "./MarkdownText.js";
import { docMetas, getDocTitle, loadDocContent, type DocsSection } from "../docs/index.js";

/*
 * 文档界面采用固定白色主题设计。
 * 原因：
 * 1. 文档阅读场景需要高对比度和长时间阅读的舒适性，白色背景是行业共识。
 * 2. 与 OpenAI、Anthropic、Google 等主流模型厂商的文档站点风格保持一致，
 *    降低用户认知成本，提供熟悉的阅读体验。
 * 3. 白色主题能更好地呈现代码块、表格等富文本内容的视觉层次。
 * 4. 文档作为独立的信息展示页面，与主应用的深色工作区形成明确的场景区分。
 */

const DOCS_LANG_KEY = "agent-workbench.docs.language";
const LEGACY_DOCS_LANG_KEY = "scc-docs-language";

const docGroups: Array<{ id: string; label: Record<"en" | "zh", string>; docs: DocsSection[] }> = [
  { id: "start", label: { en: "Start here", zh: "入门" }, docs: ["overview", "input", "task-management"] },
  { id: "library", label: { en: "Library and learning", zh: "资料与学习" }, docs: ["library", "skills", "curator", "knowledge", "memory"] },
  { id: "settings", label: { en: "Settings and operations", zh: "设置与运维" }, docs: ["settings", "providers", "permissions", "mcp", "integrations", "scheduled", "search", "preferences", "troubleshooting"] }
];

function getDocsLanguage(globalLanguage: string | null | undefined): string {
  const stored = readStoredDocsLanguage();
  if (stored) return stored;
  return normalizeDocsLanguage(globalLanguage);
}

function hasStoredDocsLanguage(): boolean {
  try {
    return Boolean(localStorage.getItem(DOCS_LANG_KEY) ?? localStorage.getItem(LEGACY_DOCS_LANG_KEY));
  } catch {
    return false;
  }
}

function readStoredDocsLanguage(): string | null {
  try {
    return localStorage.getItem(DOCS_LANG_KEY) ?? localStorage.getItem(LEGACY_DOCS_LANG_KEY);
  } catch {
    return null;
  }
}

function normalizeDocsLanguage(language: string | null | undefined): string {
  return language === "zh" || language === "zh-CN" ? "zh-CN" : "en";
}

function setDocsLanguage(lang: string): void {
  try {
    localStorage.setItem(DOCS_LANG_KEY, lang);
  } catch {
    // localStorage 不可用则忽略
  }
}


export function DocsView({
  activeSection,
  language,
  onBack,
  onSection
}: {
  activeSection: DocsSection;
  language?: string | null;
  onBack: () => void;
  onSection: (section: DocsSection) => void;
}) {
  const hasStoredLanguageRef = useRef(hasStoredDocsLanguage());
  const [docsLang, setDocsLang] = useState<string>(() => getDocsLanguage(language));
  const [content, setContent] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [docSearchText, setDocSearchText] = useState<Record<string, string>>({});
  const [tocOpen, setTocOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const zh = docsLang === "zh" || docsLang === "zh-CN";

  const activeMeta = docMetas.find((doc) => doc.id === activeSection) ?? docMetas[0]!;
  const normalizedQuery = normalizeSearchText(searchQuery);
  const searchTerms = normalizedQuery.split(" ").filter(Boolean);
  const filteredDocs = useMemo(() => {
    if (searchTerms.length === 0) return docMetas;
    return docMetas.filter((doc) => {
      const haystack = [
        getDocTitle(doc, docsLang),
        doc.summary[zh ? "zh" : "en"] ?? doc.summary.en,
        docSearchText[doc.id] ?? ""
      ].map((value) => normalizeSearchText(value ?? "")).join(" ");
      return searchTerms.every((term) => haystack.includes(term));
    });
  }, [docSearchText, docsLang, searchTerms, zh]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadDocContent(activeSection, docsLang)
      .then((text) => {
        if (!cancelled) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setContent(`# ${getDocTitle(activeMeta, docsLang)}\n\nFailed to load content.`);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeSection, docsLang, activeMeta]);

  useEffect(() => {
    if (!hasStoredLanguageRef.current) setDocsLang(normalizeDocsLanguage(language));
  }, [language]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      docMetas.map(async (doc) => {
        const text = await loadDocContent(doc.id, docsLang).catch(() => "");
        return [doc.id, text] as const;
      })
    ).then((entries) => {
      if (!cancelled) setDocSearchText(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [docsLang]);

  useEffect(() => {
    if (!tocOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setTocOpen(false);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [tocOpen]);

  function toggleLanguage() {
    const next = zh ? "en" : "zh-CN";
    hasStoredLanguageRef.current = true;
    setDocsLang(next);
    setDocsLanguage(next);
  }

  return (
    <section className={tocOpen ? "docsView docsTocOpen" : "docsView"} aria-label={zh ? "文档" : "Docs"}>
      <header className="docsTopbar">
        <button className="subtleButton iconText" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          {zh ? "返回" : "Back"}
        </button>
        <button
          className="subtleButton iconButton docsMenuButton"
          type="button"
          aria-controls="docs-toc"
          aria-expanded={tocOpen}
          aria-label={zh ? "打开文档目录" : "Open docs navigation"}
          onClick={() => setTocOpen(true)}
        >
          <Menu size={17} />
        </button>
        <div>
          <h1>{zh ? "文档" : "Docs"}</h1>
          <p>{zh ? "按主题查看设置说明、模型配置和排障手册" : "Browse settings guides, model setup, and troubleshooting playbooks"}</p>
        </div>
        <button
          className="subtleButton iconText docsLangSwitch"
          type="button"
          onClick={toggleLanguage}
          title={zh ? "Switch to English" : "切换到中文"}
        >
          <Languages size={15} />
          {zh ? "English" : "中文"}
        </button>
      </header>
      <button className="docsTocBackdrop" type="button" aria-label={zh ? "关闭文档目录" : "Close docs navigation"} onClick={() => setTocOpen(false)} />
      <div className="docsLayout">
        <nav id="docs-toc" className="docsToc" aria-label="Docs">
          <div className="docsTocHeader">
            <span>{zh ? "目录" : "Contents"}</span>
            <small>{searchTerms.length > 0 ? `${filteredDocs.length}/${docMetas.length}` : `${docMetas.length}`}</small>
            <button className="docsTocClose" type="button" aria-label={zh ? "关闭目录" : "Close navigation"} onClick={() => setTocOpen(false)}>
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <label className="docsSearchField">
            <Search size={15} aria-hidden="true" />
            <input
              aria-label={zh ? "搜索文档" : "Search docs"}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={zh ? "搜索配置、权限、CLI..." : "Search setup, permissions, CLI..."}
            />
            {searchQuery ? (
              <button className="docsSearchClear" type="button" aria-label={zh ? "清空搜索" : "Clear search"} onClick={() => setSearchQuery("")}>
                <X size={14} aria-hidden="true" />
              </button>
            ) : null}
          </label>
          {searchTerms.length > 0 ? (
            <div className="docsTocResults" role="list" aria-label={zh ? "文档搜索结果" : "Docs search results"}>
              {filteredDocs.length > 0 ? filteredDocs.map((doc) => renderTocItem(doc, true)) : (
                <p className="docsNoResults">{zh ? "没有匹配的文档" : "No matching docs"}</p>
              )}
            </div>
          ) : (
            docGroups.map((group) => (
              <div className="docsTocGroup" key={group.id}>
                <p className="docsTocGroupTitle">{group.label[zh ? "zh" : "en"]}</p>
                {group.docs.map((id) => {
                  const doc = docMetas.find((item) => item.id === id);
                  return doc ? renderTocItem(doc, false) : null;
                })}
              </div>
            ))
          )}
        </nav>
        <article className="docsArticle">
          <div className="docsArticleHeader">
            <div>
              <h2>{getDocTitle(activeMeta, docsLang)}</h2>
              <p>{activeMeta.summary[zh ? "zh" : "en"] ?? activeMeta.summary.en}</p>
            </div>
          </div>
          <div className="docBody">
            {loading ? (
              <p style={{ color: "#9ca3af" }}>{zh ? "加载中…" : "Loading…"}</p>
            ) : (
              <MarkdownText content={content} />
            )}
          </div>
        </article>
      </div>
    </section>
  );

  function renderTocItem(doc: typeof docMetas[number], withSummary: boolean) {
    const Icon = doc.icon;
    return (
      <button
        className={doc.id === activeSection ? "docsTocItem selected" : "docsTocItem"}
        type="button"
        key={doc.id}
        onClick={() => {
          onSection(doc.id);
          setTocOpen(false);
        }}
      >
        <span className="docsTocItemLabel">
          <Icon size={15} aria-hidden="true" />
          {getDocTitle(doc, docsLang)}
        </span>
        {withSummary ? <small>{doc.summary[zh ? "zh" : "en"] ?? doc.summary.en}</small> : null}
      </button>
    );
  }
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_#[\](){}:;,.!?/\\|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
