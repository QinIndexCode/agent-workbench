import { useState } from "react";
import type { ApprovalDecision, PreferencesPatch, RiskCategory, SkillDuplicateGroup } from "@scc/shared";
import { api } from "./api.js";
import { DocsView } from "./components/DocsView.js";
import { HistoryPage } from "./components/HistoryPage.js";
import { KnowledgePanel } from "./components/KnowledgePanel.js";
import { LibraryView, type LibrarySection } from "./components/LibraryView.js";
import { McpPanel } from "./components/McpPanel.js";
import { ModelProvidersPanel } from "./components/ModelProvidersPanel.js";
import { PermissionsPanel } from "./components/PermissionsPanel.js";
import { ReflectionPanel } from "./components/ReflectionPanel.js";
import { SettingsView, type SettingsSection } from "./components/SettingsView.js";
import { SkillPanel } from "./components/SkillPanel.js";
import { SupportDialog } from "./components/SupportDialog.js";
import { TaskList } from "./components/TaskList.js";
import { TaskThread } from "./components/TaskThread.js";
import type { ComposerMode, ComposerPermissionMode, PermissionPreset } from "./components/Composer.js";
import { normalizeContextPatch, providerById } from "./llm-presets.js";
import { useWorkbenchData } from "./useWorkbenchData.js";

type ActiveView = "tasks" | "history" | "library" | "docs" | "settings";

const allRiskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const readOnlyRiskCategories: RiskCategory[] = ["host_observation", "workspace_read"];

export function App() {
  const data = useWorkbenchData();
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [activeView, setActiveView] = useState<ActiveView>("tasks");
  const [previousView, setPreviousView] = useState<Exclude<ActiveView, "docs">>("tasks");
  const [supportOpen, setSupportOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("providers");
  const [librarySection, setLibrarySection] = useState<LibrarySection>("skills");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [activeTaskFolderId, setActiveTaskFolderId] = useState("all");
  const [titleIssue, setTitleIssue] = useState<{ goal: string; error: string } | null>(null);
  const language = data.preferences?.language ?? "zh-CN";
  const engineStatus = data.error ? "attention" : data.realtimeConnected ? "streaming" : "running";
  const activeProvider = data.modelProviders.find((provider) => provider.id === data.preferences?.activeModelProviderId) ?? data.modelProviders.find((provider) => provider.enabled);
  const modelLabel = activeProvider?.defaultModelId || data.preferences?.defaultModel || "not configured";
  const permissionPreset = getPermissionPreset(data.permissions);
  const permissionScopeLabel = formatPermissionPreset(permissionPreset, language);
  const modelProvider = providerById(data.preferences?.llmProvider);
  const modelOptions =
    activeProvider?.models.map((model) => ({ label: model.label || model.id, value: model.id })) ??
    modelProvider.models.map((model) => ({ label: model.id, value: model.id }));

  return (
    <main className={activeView === "docs" ? "shell docsShell" : "shell"}>
      {activeView !== "docs" ? (
        <TaskList
          activeView={activeView}
          engineStatus={engineStatus}
          language={language}
          open={taskDrawerOpen}
          tasks={data.tasks}
          folders={data.taskFolders}
          selectedId={data.selectedId}
          activeFolderId={activeTaskFolderId}
          onClose={() => setTaskDrawerOpen(false)}
          onNewTask={() => {
            setActiveView("tasks");
            setTaskDrawerOpen(false);
            data.clearSelection();
          }}
          onOpenDocs={() => openDocs()}
          onOpenHistory={() => {
            setActiveView("history");
            setTaskDrawerOpen(false);
          }}
          onOpenLibrary={() => {
            setLibrarySection("skills");
            setActiveView("library");
            setTaskDrawerOpen(false);
          }}
          onOpenSettings={() => {
            setActiveView("settings");
            setTaskDrawerOpen(false);
          }}
          onOpenSupport={() => {
            setSupportOpen(true);
            setTaskDrawerOpen(false);
          }}
          onDelete={(taskId, options) => data.deleteTask(taskId, options)}
          onClearFolder={(folderId, options) => data.runSideAction(() => api.clearTaskFolder(folderId, options))}
          onCreateFolder={(name) => data.runSideAction(() => api.createTaskFolder({ name }))}
          onFolderSelect={(folderId) => setActiveTaskFolderId(folderId)}
          onUpdateFolder={(folderId, name) => data.runSideAction(() => api.patchTaskFolder(folderId, { name }))}
          onSelect={(taskId) => {
            setActiveView("tasks");
            setTaskDrawerOpen(false);
            void data.selectTask(taskId);
          }}
        />
      ) : null}

      {activeView === "tasks" ? (
        <TaskThread
          task={data.selected}
          busy={data.busy}
          error={data.error}
          language={language}
          engineStatus={engineStatus}
          preferences={data.preferences}
          modelLabel={modelLabel}
          modelOptions={modelOptions}
          permissionPreset={permissionPreset}
          permissionScopeLabel={permissionScopeLabel}
          onModelChange={(modelId) => updateModelSelection(modelId)}
          onOpenConnect={() => {
            setSettingsSection("permissions");
            setActiveView("settings");
          }}
          onOpenPermissionSettings={() => {
            setSettingsSection("permissions");
            setActiveView("settings");
          }}
          onPermissionPresetChange={(preset) => applyPermissionPreset(preset)}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onSubmit={(mode, text) => submitComposer(mode, text)}
          onStop={() => data.selected && void data.runTaskAction(() => api.control(data.selected!.id, "pause"))}
          titleIssue={titleIssue}
          onRetryTitle={() => titleIssue && submitNewTask(titleIssue.goal, false)}
          onUseLocalTitle={() => titleIssue && submitNewTask(titleIssue.goal, true)}
          onApprovalDecision={(approvalId, decision) => approve(approvalId, decision)}
        />
      ) : activeView === "history" ? (
        <HistoryPage
          language={language}
          tasks={data.tasks}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onDelete={(taskId, options) => data.deleteTask(taskId, options)}
          onOpenTask={(taskId) => {
            setActiveView("tasks");
            void data.selectTask(taskId);
          }}
        />
      ) : activeView === "library" ? (
        <LibraryView
          activeSection={librarySection}
          language={language}
          query={libraryQuery}
          onQuery={setLibraryQuery}
          onSection={(section) => setLibrarySection(section)}
          onOpenTasks={() => setTaskDrawerOpen(true)}
        >
          {{
            skills: (
              <SkillPanel
                query={libraryQuery}
                language={language}
                skills={data.skills}
                duplicates={data.skillDuplicates}
                conflicts={data.skillConflicts}
                reflections={data.reflections}
                onRunReflection={() => void data.runSideAction(() => api.runReflection())}
                onCreate={(input) => data.runSideAction(() => api.createSkill(input))}
                onUpdate={(skillId, input) => data.runSideAction(() => api.patchSkill(skillId, input))}
                onDelete={(skillId) => data.runSideAction(() => api.deleteSkill(skillId))}
                onBulkDelete={(skillIds) => data.runSideAction(() => api.bulkDeleteSkills({ skillIds }))}
                onMergeDuplicate={(group) => mergeDuplicate(group)}
                onExport={(skillId) => exportSkill(skillId)}
              />
            ),
            knowledge: (
              <KnowledgePanel
                query={libraryQuery}
                language={language}
                items={data.knowledgeItems}
                onCreate={(input) => data.runSideAction(() => api.createKnowledgeItem(input))}
                onDelete={(id) => data.runSideAction(() => api.deleteKnowledgeItem(id))}
                onUpdate={(id, input) => data.runSideAction(() => api.patchKnowledgeItem(id, input))}
                onUpload={(input) => data.runSideAction(() => api.uploadKnowledgeFile(input))}
              />
            ),
            reflections: (
              <ReflectionPanel
                conflicts={data.skillConflicts}
                duplicates={data.skillDuplicates}
                language={language}
                reflections={data.reflections}
                onRunReflection={() => void data.runSideAction(() => api.runReflection())}
              />
            )
          }}
        </LibraryView>
      ) : activeView === "docs" ? (
        <DocsView language={language} onBack={() => setActiveView(previousView)} />
      ) : (
        <SettingsView
          activeSection={settingsSection}
          language={language}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onSection={(section) => setSettingsSection(section)}
        >
          {{
            providers: (
              <ModelProvidersPanel
                activeProviderId={activeProvider?.id ?? null}
                currentModelLabel={modelLabel === "not configured" ? null : modelLabel}
                language={language}
                providers={data.modelProviders}
                onCreate={(input) => data.runSideAction(() => api.createModelProvider(input))}
                onDelete={(providerId) => data.runSideAction(() => api.deleteModelProvider(providerId))}
                onUpdate={(providerId, input) => data.runSideAction(() => api.patchModelProvider(providerId, input))}
              />
            ),
            permissions: (
              <PermissionsPanel
                language={language}
                permissions={data.permissions}
                preferences={data.preferences}
                onGrant={(risk) => void grantGlobal(risk)}
                onRevoke={(risk) => void data.runSideAction(() => api.revokeGlobalPermission(risk))}
                onPermissionPresetChange={(preset) => applyPermissionPreset(preset)}
                onPreference={(patch) => void updatePreference(patch)}
              />
            ),
            mcp: (
              <McpPanel
                language={language}
                servers={data.mcpServers}
                tools={data.mcpTools}
                onCreate={(input) => data.runSideAction(() => api.createMcpServer(input))}
                onUpdate={(serverId, input) => data.runSideAction(() => api.patchMcpServer(serverId, input))}
                onConnect={(serverId) => data.runSideAction(() => api.connectMcpServer(serverId))}
                onDisconnect={(serverId) => data.runSideAction(() => api.disconnectMcpServer(serverId))}
                onDelete={(serverId) => data.runSideAction(() => api.deleteMcpServer(serverId))}
              />
            ),
            preferences: (
              <PermissionsPanel
                language={language}
                permissions={data.permissions}
                preferences={data.preferences}
                preferencesOnly
                onGrant={(risk) => void grantGlobal(risk)}
                onRevoke={(risk) => void data.runSideAction(() => api.revokeGlobalPermission(risk))}
                onPermissionPresetChange={(preset) => applyPermissionPreset(preset)}
                onPreference={(patch) => void updatePreference(patch)}
              />
            )
          }}
        </SettingsView>
      )}
      <SupportDialog language={language} open={supportOpen} onClose={() => setSupportOpen(false)} onOpenDocs={() => openDocs()} />
    </main>
  );

  function openDocs() {
    if (activeView !== "docs") setPreviousView(activeView);
    setActiveView("docs");
    setTaskDrawerOpen(false);
  }

  function submitComposer(mode: ComposerMode, text: string) {
    if (mode === "guidance" || mode === "continue") {
      setTitleIssue(null);
      void data.runTaskAction(() => (data.selected ? api.sendMessage(data.selected.id, text) : submitNewTaskAction(text, false)));
      return;
    }
    submitNewTask(text, false);
  }

  function submitNewTask(goal: string, useLocalFallback: boolean) {
    void data.runTaskAction(() => submitNewTaskAction(goal, useLocalFallback));
  }

  async function submitNewTaskAction(goal: string, useLocalFallback: boolean) {
    try {
      const title = await api.generateTaskTitle(goal, language, useLocalFallback);
      setTitleIssue(null);
      return api.createTask(goal, title.title, taskCreateFolderId(activeTaskFolderId));
    } catch (error) {
      setTitleIssue({ goal, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
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

  function updatePreference(patch: PreferencesPatch) {
    void data.runSideAction(() => api.updatePreferences(patch));
  }

  function applyPermissionPreset(preset: PermissionPreset) {
    void data.runSideAction(async () => {
      const granted = new Set(data.permissions.map((permission) => permission.riskCategory));
      const target = new Set<RiskCategory>(
        preset === "all" ? allRiskCategories : preset === "read_only" ? readOnlyRiskCategories : []
      );
      for (const risk of allRiskCategories) {
        if (target.has(risk) && !granted.has(risk)) {
          await api.grantGlobalPermission(risk, `User selected ${preset} permission preset from the composer.`);
        }
        if (!target.has(risk) && granted.has(risk)) {
          await api.revokeGlobalPermission(risk);
        }
      }
    });
  }

  function updateModelSelection(modelId: string) {
    void data.runSideAction(async () => {
      if (activeProvider) {
        const model = activeProvider.models.find((item) => item.id === modelId);
        await api.patchModelProvider(activeProvider.id, { defaultModelId: modelId, makeActive: true });
        await api.updatePreferences(normalizeContextPatch(data.preferences, {
          activeModelProviderId: activeProvider.id,
          defaultModel: modelId,
          providerBaseUrl: activeProvider.baseUrl,
          ...(model ? { maxTokensPerRequest: model.contextWindow } : {})
        }));
        return;
      }
      await api.updatePreferences(normalizeContextPatch(data.preferences, { defaultModel: modelId }));
    });
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

function taskCreateFolderId(activeFolderId: string): string | undefined {
  return activeFolderId === "all" ? undefined : activeFolderId;
}

function getPermissionPreset(permissions: Array<{ riskCategory: RiskCategory }>): ComposerPermissionMode {
  const granted = new Set(permissions.map((permission) => permission.riskCategory));
  if (allRiskCategories.every((risk) => granted.has(risk))) return "all";
  if (readOnlyRiskCategories.every((risk) => granted.has(risk)) && allRiskCategories.every((risk) => readOnlyRiskCategories.includes(risk) || !granted.has(risk))) {
    return "read_only";
  }
  if (allRiskCategories.every((risk) => !granted.has(risk))) return "ask";
  return "custom";
}

function formatPermissionPreset(preset: ComposerPermissionMode, language: string): string {
  if (preset === "all") return "All";
  if (preset === "custom") return "Custom";
  if (preset === "read_only") return "Read only";
  return "Ask";
}
