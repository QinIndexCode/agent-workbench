import type { ReactNode } from "react";
import { Menu } from "lucide-react";
import { PanelBoundary } from "./PanelBoundary.js";

export type SettingsSection = "skills" | "learning" | "permissions" | "mcp" | "memory";

const sections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "skills", label: "Skills", description: "Review, edit, merge, and export reusable agent behaviors" },
  { id: "learning", label: "Learning", description: "Task memory, patterns, reflection, and conflicts" },
  { id: "permissions", label: "Permissions", description: "Global risk grants and agent preferences" },
  { id: "mcp", label: "MCP", description: "Connected tool servers and discovered tools" },
  { id: "memory", label: "Memory", description: "Project facts and durable conventions" }
];

export function SettingsView({
  activeSection,
  children,
  onOpenTasks,
  onSection
}: {
  activeSection: SettingsSection;
  children: Record<SettingsSection, ReactNode>;
  onOpenTasks: () => void;
  onSection: (section: SettingsSection) => void;
}) {
  const active = sections.find((section) => section.id === activeSection) ?? sections[0]!;

  return (
    <section className="settingsView" aria-label="Settings">
      <header className="settingsHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          Tasks
        </button>
        <div>
          <h1>Settings</h1>
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
