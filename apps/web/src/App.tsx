import { useState } from "react";
import type { ApprovalDecision, RiskCategory, SkillDuplicateGroup, UserPreferences } from "@scc/shared";
import { api } from "./api.js";
import { LearningPanel } from "./components/LearningPanel.js";
import { McpPanel } from "./components/McpPanel.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { ProjectMemoryPanel } from "./components/ProjectMemoryPanel.js";
import { SettingsView, type SettingsSection } from "./components/SettingsView.js";
import { SkillPanel } from "./components/SkillPanel.js";
import { TaskList } from "./components/TaskList.js";
import { TaskThread } from "./components/TaskThread.js";
import type { ComposerMode } from "./components/Composer.js";
import { useWorkbenchData } from "./useWorkbenchData.js";

export function App() {
  const data = useWorkbenchData();
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [activeView, setActiveView] = useState<"tasks" | "settings">("tasks");
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("skills");

  return (
    <main className="shell">
      <TaskList
        activeView={activeView}
        open={taskDrawerOpen}
        tasks={data.tasks}
        selectedId={data.selectedId}
        onClose={() => setTaskDrawerOpen(false)}
        onNewTask={() => {
          setActiveView("tasks");
          setTaskDrawerOpen(false);
          data.clearSelection();
        }}
        onOpenSettings={() => {
          setActiveView("settings");
          setTaskDrawerOpen(false);
        }}
        onDelete={(taskId, options) => data.deleteTask(taskId, options)}
        onSelect={(taskId) => {
          setActiveView("tasks");
          setTaskDrawerOpen(false);
          void data.selectTask(taskId);
        }}
      />

      {activeView === "tasks" ? (
        <TaskThread
          task={data.selected}
          busy={data.busy}
          error={data.error}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onSubmit={(mode, text) => submitComposer(mode, text)}
          onStop={() => data.selected && void data.runTaskAction(() => api.control(data.selected!.id, "pause"))}
          onApprovalDecision={(approvalId, decision) => approve(approvalId, decision)}
        />
      ) : (
        <SettingsView
          activeSection={settingsSection}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onSection={(section) => setSettingsSection(section)}
        >
          {{
            learning: (
              <LearningPanel
                memories={data.memories}
                patterns={data.patterns}
                conflicts={data.skillConflicts}
                reflections={data.reflections}
                onRunReflection={() => void data.runSideAction(() => api.runReflection())}
              />
            ),
            skills: (
              <SkillPanel
                skills={data.skills}
                duplicates={data.skillDuplicates}
                conflicts={data.skillConflicts}
                onCreate={(input) => data.runSideAction(() => api.createSkill(input))}
                onUpdate={(skillId, input) => data.runSideAction(() => api.patchSkill(skillId, input))}
                onDelete={(skillId) => data.runSideAction(() => api.deleteSkill(skillId))}
                onBulkDelete={(skillIds) => data.runSideAction(() => api.bulkDeleteSkills({ skillIds }))}
                onMergeDuplicate={(group) => mergeDuplicate(group)}
                onExport={(skillId) => exportSkill(skillId)}
              />
            ),
            permissions: (
              <PermissionsPanel
                permissions={data.permissions}
                preferences={data.preferences}
                onGrant={(risk) => void grantGlobal(risk)}
                onRevoke={(risk) => void data.runSideAction(() => api.revokeGlobalPermission(risk))}
                onPreference={(patch) => void updatePreference(patch)}
              />
            ),
            memory: (
              <ProjectMemoryPanel
                memories={data.projectMemories}
                onCreate={(title, content) =>
                  void data.runSideAction(() =>
                    api.createProjectMemory({ title, content, category: "convention", tags: [], projectId: "default" })
                  )
                }
                onDelete={(id) => void data.runSideAction(() => api.deleteProjectMemory(id))}
              />
            ),
            mcp: (
              <McpPanel
                servers={data.mcpServers}
                tools={data.mcpTools}
                onCreate={(input) => void data.runSideAction(() => api.createMcpServer(input))}
                onConnect={(serverId) => void data.runSideAction(() => api.connectMcpServer(serverId))}
                onDisconnect={(serverId) => void data.runSideAction(() => api.disconnectMcpServer(serverId))}
                onDelete={(serverId) => void data.runSideAction(() => api.deleteMcpServer(serverId))}
              />
            )
          }}
        </SettingsView>
      )}
    </main>
  );

  function submitComposer(mode: ComposerMode, text: string) {
    void data.runTaskAction(() => {
      if (mode === "guidance" || mode === "continue") {
        if (!data.selected) return api.createTask(text);
        return api.sendMessage(data.selected.id, text);
      }
      return api.createTask(text);
    });
  }

  function approve(approvalId: string, decision: ApprovalDecision) {
    if (!data.selected) return;
    void data.runTaskAction(() => api.decideApproval(data.selected!.id, approvalId, decision));
  }

  function grantGlobal(risk: RiskCategory) {
    void data.runSideAction(() =>
      api.grantGlobalPermission(
        risk,
        risk === "destructive"
          ? "User explicitly granted destructive global permission from the workbench UI."
          : "User granted global permission from the workbench UI."
      )
    );
  }

  function updatePreference(patch: Partial<UserPreferences>) {
    void data.runSideAction(() => api.updatePreferences(patch));
  }

  async function exportSkill(skillId: string) {
    await data.runSideAction(async () => {
      const payload = await api.exportSkill(skillId);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${skillId}-skill-export.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    });
  }

  function mergeDuplicate(group: SkillDuplicateGroup) {
    const sourceSkillIds = group.skills.filter((skill) => skill.id !== group.canonicalSkillId).map((skill) => skill.id);
    return data.runSideAction(() =>
      api.mergeSkills(group.canonicalSkillId, { targetSkillId: group.canonicalSkillId, sourceSkillIds, deleteSources: true })
    );
  }
}
