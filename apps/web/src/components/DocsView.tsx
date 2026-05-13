import { useEffect, useState } from "react";
import { ArrowLeft, Languages } from "lucide-react";
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

const DOCS_LANG_KEY = "scc-docs-language";

function getDocsLanguage(globalLanguage: string | null | undefined): string {
  try {
    const saved = localStorage.getItem(DOCS_LANG_KEY);
    if (saved) return saved;
  } catch {
    // localStorage 不可用则忽略
  }
  return globalLanguage ?? "zh-CN";
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
  const [docsLang, setDocsLang] = useState<string>(() => getDocsLanguage(language));
  const [content, setContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const zh = docsLang === "zh" || docsLang === "zh-CN";

  const activeMeta = docMetas.find((doc) => doc.id === activeSection) ?? docMetas[0]!;

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

  function toggleLanguage() {
    const next = zh ? "en" : "zh-CN";
    setDocsLang(next);
    setDocsLanguage(next);
  }

  return (
    <section className="docsView" aria-label={zh ? "文档" : "Docs"}>
      <header className="docsTopbar">
        <button className="subtleButton iconText" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          {zh ? "返回" : "Back"}
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
      <div className="docsLayout">
        <nav className="docsToc" aria-label="Docs">
          {docMetas.map((doc) => {
            const Icon = doc.icon;
            return (
              <button
                className={doc.id === activeSection ? "docsTocItem selected" : "docsTocItem"}
                type="button"
                key={doc.id}
                onClick={() => onSection(doc.id)}
              >
                <span className="docsTocItemLabel">
                  <Icon size={15} aria-hidden="true" />
                  {getDocTitle(doc, docsLang)}
                </span>
              </button>
            );
          })}
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
}
