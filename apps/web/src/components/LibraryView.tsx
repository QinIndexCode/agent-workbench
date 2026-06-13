import type { ReactNode } from "react";
import { BookOpen, Database, Menu, Search, Sparkles, WandSparkles } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import "../styles/settings.css";
import { PanelBoundary } from "./PanelBoundary.js";

export type LibrarySection = "skills" | "curator" | "knowledge" | "memory";

const sectionIds: LibrarySection[] = ["skills", "curator", "knowledge", "memory"];

const sectionIcons: Record<LibrarySection, ReactNode> = {
  skills: <Sparkles size={16} />,
  curator: <WandSparkles size={16} />,
  knowledge: <BookOpen size={16} />,
  memory: <Database size={16} />
};

export function LibraryView({
  activeSection,
  children,
  language,
  error,
  query,
  onQuery,
  onSection,
  onOpenTasks
}: {
  activeSection: LibrarySection;
  children: Record<LibrarySection, ReactNode>;
  language?: string | null;
  error?: string | null;
  query: string;
  onQuery: (query: string) => void;
  onSection: (section: LibrarySection) => void;
  onOpenTasks: () => void;
}) {
  const text = getLibraryCopy(language);
  const ui = getUiCopy(language);
  const sections = sectionIds.map((id) => ({
    id,
    label: text.sectionLabels[id]
  }));
  return (
    <section className="libraryView" aria-label={text.title}>
      <header className="libraryHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {ui.shell.tasks}
        </button>
        <div>
          <h1>{text.title}</h1>
        </div>
        <label className="librarySearch">
          <Search size={16} aria-hidden="true" />
          <input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => onQuery(event.target.value)} />
        </label>
      </header>
      <div className="libraryBody">
        <nav className="libraryNav" aria-label={text.title}>
          {sections.map((section) => (
            <button
              className={activeSection === section.id ? "libraryNavItem selected" : "libraryNavItem"}
              key={section.id}
              onClick={() => onSection(section.id)}
              type="button"
            >
              {sectionIcons[section.id]}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <div className="libraryPanel">
          {error ? <p className="panelError" role="alert">{error}</p> : null}
          <PanelBoundary name={sections.find((s) => s.id === activeSection)?.label ?? sections[0]!.label}>
            {children[activeSection]}
          </PanelBoundary>
        </div>
      </div>
    </section>
  );
}

function getLibraryCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "资料库" : "Library",
    search: zh ? "搜索资料库" : "Search library",
    sectionLabels: {
      skills: "Skills",
      curator: "Curator",
      knowledge: zh ? "知识库" : "Knowledge",
      memory: zh ? "记忆" : "Memory"
    }
  };
}
