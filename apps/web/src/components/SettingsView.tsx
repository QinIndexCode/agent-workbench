import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { PanelBoundary } from "./PanelBoundary.js";

export type SettingsSection = "providers" | "permissions" | "mcp" | "preferences";

const sectionIds: SettingsSection[] = ["providers", "permissions", "mcp", "preferences"];

export function SettingsView({
  activeSection,
  children,
  language,
  onOpenTasks,
  onSection
}: {
  activeSection: SettingsSection;
  children: Record<SettingsSection, ReactNode>;
  language?: string | null;
  onOpenTasks: () => void;
  onSection: (section: SettingsSection) => void;
}) {
  const text = getUiCopy(language);
  const sections = sectionIds.map((id) => ({
    id,
    label: text.settings.sections[id][0],
    description: text.settings.sections[id][1]
  }));
  const active = sections.find((section) => section.id === activeSection) ?? sections[0]!;

  return (
    <section className="settingsView" aria-label="Settings">
      <header className="settingsHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {text.shell.tasks}
        </button>
        <div>
          <h1>{text.settings.title}</h1>
          <p>{active.description}</p>
        </div>
      </header>
      <div className="settingsBody">
        <nav className="settingsNav" aria-label="Settings sections">
          {sections.map((section) => (
            <button
              className={activeSection === section.id ? "settingsNavItem selected" : "settingsNavItem"}
              key={section.id}
              onClick={() => onSection(section.id)}
              type="button"
            >
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
