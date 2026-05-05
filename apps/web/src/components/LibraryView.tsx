import type { ReactNode } from "react";
import { BrainCircuit, BookOpen, Search, Sparkles } from "lucide-react";
import { PanelBoundary } from "./PanelBoundary.js";

export type LibrarySection = "skills" | "knowledge" | "reflections";

export function LibraryView({
  activeSection,
  children,
  language,
  query,
  onQuery,
  onSection
}: {
  activeSection: LibrarySection;
  children: Record<LibrarySection, ReactNode>;
  language?: string | null;
  query: string;
  onQuery: (query: string) => void;
  onSection: (section: LibrarySection) => void;
}) {
  const text = getLibraryCopy(language);
  const sections: Array<{ id: LibrarySection; label: string; description: string; icon: typeof Sparkles }> = [
    { id: "skills", label: text.skills, description: text.skillsDescription, icon: Sparkles },
    { id: "knowledge", label: text.knowledge, description: text.knowledgeDescription, icon: BookOpen },
    { id: "reflections", label: text.reflections, description: text.reflectionsDescription, icon: BrainCircuit }
  ];
  return (
    <section className="libraryView" aria-label={text.title}>
      <header className="libraryHeader">
        <div className="libraryTitleBlock">
          <h1>{text.title}</h1>
          <p>{text.subtitle}</p>
        </div>
        <label className="librarySearch">
          <Search size={16} aria-hidden="true" />
          <input aria-label={text.search} placeholder={text.search} value={query} onChange={(event) => onQuery(event.target.value)} />
        </label>
      </header>
      <div className="librarySections" role="tablist" aria-label={text.title}>
        {sections.map((section) => {
          const Icon = section.icon;
          return (
            <button
              aria-selected={activeSection === section.id}
              className={activeSection === section.id ? "librarySectionCard selected" : "librarySectionCard"}
              key={section.id}
              role="tab"
              type="button"
              onClick={() => onSection(section.id)}
            >
              <span className="librarySectionIcon">
                <Icon size={18} aria-hidden="true" />
              </span>
              <span>
                <strong>{section.label}</strong>
                <small>{section.description}</small>
              </span>
            </button>
          );
        })}
      </div>
      <div className="libraryContent">
        <PanelBoundary name={sections.find((section) => section.id === activeSection)?.label ?? sections[0]!.label}>{children[activeSection]}</PanelBoundary>
      </div>
    </section>
  );
}

function getLibraryCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "资料库" : "Library",
    subtitle: zh ? "把可复用能力、项目资料和 Agent 反思分开管理。" : "Manage reusable skills, project knowledge, and agent reflections separately.",
    search: zh ? "搜索资料库" : "Search library",
    skills: "Skills",
    knowledge: zh ? "知识库" : "Knowledge",
    reflections: zh ? "Agent 反思" : "Reflections",
    skillsDescription: zh ? "审核、编辑、合并和导出可复用的 Agent 能力。" : "Review, edit, merge, and export reusable agent capabilities.",
    knowledgeDescription: zh ? "管理项目记忆、文件资料和 Agent 可引用的信息。" : "Manage project memories, files, and information the agent can reference.",
    reflectionsDescription: zh ? "查看候选建议、阻塞原因和最近学习活动。" : "Review suggestions, blocked promotions, and recent learning activity."
  };
}
