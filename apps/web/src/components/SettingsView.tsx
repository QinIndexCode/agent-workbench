import type { ReactNode } from "react";
import { Menu, Cpu, Shield, Blocks, SlidersHorizontal, CalendarClock, Search, Cable } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import "../styles/settings.css";
import { PanelBoundary } from "./PanelBoundary.js";

export type SettingsSection = "providers" | "permissions" | "mcp" | "integrations" | "scheduled" | "search" | "preferences";

const sectionIds: SettingsSection[] = ["providers", "permissions", "mcp", "integrations", "scheduled", "search", "preferences"];

const sectionIcons: Record<SettingsSection, ReactNode> = {
  providers: <Cpu size={16} />,
  permissions: <Shield size={16} />,
  mcp: <Blocks size={16} />,
  integrations: <Cable size={16} />,
  scheduled: <CalendarClock size={16} />,
  search: <Search size={16} />,
  preferences: <SlidersHorizontal size={16} />
};

export function SettingsView({
  activeSection,
  children,
  error,
  language,
  onOpenTasks,
  onSection
}: {
  activeSection: SettingsSection;
  children: Record<SettingsSection, ReactNode>;
  error?: string | null;
  language?: string | null;
  onOpenTasks: () => void;
  onSection: (section: SettingsSection) => void;
}) {
  const text = getUiCopy(language);
  const sections = sectionIds.map((id) => ({
    id,
    label: text.settings.sections[id][0]
  }));

  return (
    <section className="settingsView" aria-label="Settings">
      <header className="settingsHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {text.shell.tasks}
        </button>
        <div>
          <h1>{text.settings.title}</h1>
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
              {sectionIcons[section.id]}
              <span>{section.label}</span>
            </button>
          ))}
        </nav>
        <div className="settingsPanel">
          {error ? <p className="panelError" role="alert">{error}</p> : null}
          <PanelBoundary name={sections.find((s) => s.id === activeSection)?.label ?? sections[0]!.label}>
            {children[activeSection]}
          </PanelBoundary>
        </div>
      </div>
    </section>
  );
}
