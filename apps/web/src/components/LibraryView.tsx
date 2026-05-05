import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { PanelBoundary } from "./PanelBoundary.js";

export type LibrarySection = "skills" | "knowledge";

export function LibraryView({
  activeSection,
  children,
  language,
  onOpenTasks,
  onSection
}: {
  activeSection: LibrarySection;
  children: Record<LibrarySection, ReactNode>;
  language?: string | null;
  onOpenTasks: () => void;
  onSection: (section: LibrarySection) => void;
}) {
  const text = getLibraryCopy(language);
  const shell = getUiCopy(language).shell;
  const sections: Array<{ id: LibrarySection; label: string; description: string }> = [
    { id: "skills", label: text.skills, description: text.skillsDescription },
    { id: "knowledge", label: text.knowledge, description: text.knowledgeDescription }
  ];
  const active = sections.find((section) => section.id === activeSection) ?? sections[0]!;
  return (
    <section className="settingsView libraryView" aria-label={text.title}>
      <header className="settingsHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {shell.tasks}
        </button>
        <div>
          <h1>{text.title}</h1>
          <p>{active.description}</p>
        </div>
      </header>
      <div className="settingsBody">
        <nav className="settingsNav" aria-label={text.title}>
          {sections.map((section) => (
            <button className={activeSection === section.id ? "settingsNavItem selected" : "settingsNavItem"} key={section.id} type="button" onClick={() => onSection(section.id)}>
              <span>{section.label}</span>
              <small>{section.description}</small>
            </button>
          ))}
        </nav>
        <div className="settingsPanel">
          <PanelBoundary name={active.label}>{children[activeSection]}</PanelBoundary>
        </div>
      </div>
    </section>
  );
}

function getLibraryCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "资料库" : "Library",
    skills: "Skills",
    knowledge: zh ? "知识库" : "Knowledge",
    skillsDescription: zh ? "审核、编辑、合并和导出可复用的 Agent 能力。" : "Review, edit, merge, and export reusable agent capabilities.",
    knowledgeDescription: zh ? "管理项目记忆、文件资料和 Agent 可引用的信息。" : "Manage project memories, files, and information the agent can reference."
  };
}
