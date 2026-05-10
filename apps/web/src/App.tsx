import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ApprovalDecision, PreferencesPatch, RiskCategory, SkillDuplicateGroup, TaskAttachment } from "@scc/shared";
import { type AppRoute, useAppRoute } from "./app-router.js";
import { api } from "./api.js";
import { ProviderBrandIcon } from "./components/ProviderBrandIcon.js";
import { SupportDialog } from "./components/SupportDialog.js";
import { TaskList } from "./components/TaskList.js";
import type { ComposerMode, ComposerPermissionMode, PermissionPreset } from "./components/Composer.js";
import type { LibrarySection } from "./components/LibraryView.js";
import type { SettingsSection } from "./components/SettingsView.js";
import { useWorkbenchData } from "./useWorkbenchData.js";

const DocsView = lazy(() => import("./components/DocsView.js").then((module) => ({ default: module.DocsView })));
const HistoryPage = lazy(() => import("./components/HistoryPage.js").then((module) => ({ default: module.HistoryPage })));
const IntegrationsPanel = lazy(() => import("./components/IntegrationsPanel.js").then((module) => ({ default: module.IntegrationsPanel })));
const KnowledgePanel = lazy(() => import("./components/KnowledgePanel.js").then((module) => ({ default: module.KnowledgePanel })));
const LibraryView = lazy(() => import("./components/LibraryView.js").then((module) => ({ default: module.LibraryView })));
const McpPanel = lazy(() => import("./components/McpPanel.js").then((module) => ({ default: module.McpPanel })));
const ModelProvidersPanel = lazy(() => import("./components/ModelProvidersPanel.js").then((module) => ({ default: module.ModelProvidersPanel })));
const PermissionsPanel = lazy(() => import("./components/PermissionsPanel.js").then((module) => ({ default: module.PermissionsPanel })));
const ProjectMemoryPanel = lazy(() => import("./components/ProjectMemoryPanel.js").then((module) => ({ default: module.ProjectMemoryPanel })));
const ReflectionPanel = lazy(() => import("./components/ReflectionPanel.js").then((module) => ({ default: module.ReflectionPanel })));
const SettingsView = lazy(() => import("./components/SettingsView.js").then((module) => ({ default: module.SettingsView })));
const ScheduledTasksPanel = lazy(() => import("./components/ScheduledTasksPanel.js").then((module) => ({ default: module.ScheduledTasksPanel })));
const SkillCuratorPanel = lazy(() => import("./components/SkillCuratorPanel.js").then((module) => ({ default: module.SkillCuratorPanel })));
const SkillPanel = lazy(() => import("./components/SkillPanel.js").then((module) => ({ default: module.SkillPanel })));
const TaskThread = lazy(() => import("./components/TaskThread.js").then((module) => ({ default: module.TaskThread })));
const WebSearchPanel = lazy(() => import("./components/WebSearchPanel.js").then((module) => ({ default: module.WebSearchPanel })));

const allRiskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const readOnlyRiskCategories: RiskCategory[] = ["host_observation", "workspace_read"];

export function App() {
  const data = useWorkbenchData();
  const [route, navigateRoute] = useAppRoute();
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false);
  const [previousNonDocsRoute, setPreviousNonDocsRoute] = useState<AppRoute>({ view: "tasks" });
  const [supportOpen, setSupportOpen] = useState(false);
  const [libraryQuery, setLibraryQuery] = useState("");
  const [activeTaskFolderId, setActiveTaskFolderId] = useState("default");
  const [titleIssue, setTitleIssue] = useState<{ goal: string; error: string } | null>(null);
  const [settingsStartCustom, setSettingsStartCustom] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<TaskAttachment[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [optimisticPermissionPreset, setOptimisticPermissionPreset] = useState<ComposerPermissionMode | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("dark");
  const permissionMutationRef = useRef<Promise<void> | null>(null);
  const language = data.preferences?.language ?? "zh-CN";
  const theme = data.preferences?.theme ?? "dark";
  const activeView = route.view;
  const activeTask = route.view === "tasks" && route.newTask ? null : data.selected;
  const activeTranscript = route.view === "tasks" && route.newTask ? [] : data.selectedTranscript;
  const selectedId = route.view === "tasks" && route.newTask ? null : data.selectedId;
  const settingsSection: SettingsSection = route.view === "settings" ? route.section : "providers";
  const librarySection: LibrarySection = route.view === "library" ? route.section : "skills";
  const syncFresh = data.lastSuccessfulSyncAt === null || Date.now() - data.lastSuccessfulSyncAt < 35_000;
  const engineStatus = data.backendHealthy === false || (data.realtimeStale && !syncFresh) ? "attention" : data.realtimeConnected ? "streaming" : "running";
  const activeProvider = data.modelProviders.find((provider) => provider.id === data.preferences?.activeModelProviderId) ?? data.modelProviders.find((provider) => provider.enabled);
  const activeModel = activeProvider?.models.find((model) => model.id === activeProvider.defaultModelId) ?? activeProvider?.models[0];
  const modelLabel = activeProvider && activeModel ? (activeModel.label || activeModel.id) : "not configured";
  const permissionPreset = optimisticPermissionPreset ?? getPermissionPreset(data.permissions);
  const permissionScopeLabel = formatPermissionPreset(permissionPreset, language);
  const hasCustomSnapshot = Boolean(data.preferences?.customPermissionSnapshot?.length);
  const modelOptions = activeProvider
    ? activeProvider.models.map((model) => ({
      icon: <ProviderBrandIcon className="providerBadgeInline" modelId={model.id} vendor={activeProvider.vendor} />,
      label: model.label || model.id,
      value: model.id
    }))
    : [];
  const taskFolderOptions = data.taskFolders.length > 0
    ? data.taskFolders.map((folder) => ({
        label: folder.id === "default" || folder.isDefault ? getDefaultFolderLabel(language) : folder.name,
        value: folder.id,
        ...(folder.rootPath ? { description: folder.rootPath } : {})
      }))
    : [{ label: language === "zh-CN" ? "默认文件夹" : "Default", value: "default" }];
  const composerFolderValue = activeTaskFolderId;

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    const apply = () => {
      const resolved = theme === "system" ? (media?.matches ? "light" : "dark") : theme;
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
      setResolvedTheme(resolved);
    };
    apply();
    if (theme !== "system" || !media) return;
    media.addEventListener?.("change", apply);
    return () => media.removeEventListener?.("change", apply);
  }, [theme]);

  useEffect(() => {
    const html = document.documentElement;
    const lang = language === "zh-CN" ? "zh-CN" : "en";
    if (html.lang !== lang) html.lang = lang;
  }, [language]);

  useEffect(() => {
    if (route.view !== "docs") setPreviousNonDocsRoute(route);
    if (route.view === "tasks" && route.newTask) data.clearSelection();
    if (route.view === "tasks" && route.taskId && route.taskId !== data.selectedId) void data.selectTask(route.taskId);
  }, [route]);

  useEffect(() => {
    if (!optimisticPermissionPreset || permissionBusy) return;
    if (getPermissionPreset(data.permissions) === optimisticPermissionPreset) {
      setOptimisticPermissionPreset(null);
    }
  }, [data.permissions, optimisticPermissionPreset, permissionBusy]);

  return (
    <main className={activeView === "docs" ? "shell docsShell" : "shell"}>
      {activeView !== "docs" ? (
        <TaskList
          activeView={activeView}
          engineStatus={engineStatus}
          language={language}
          resolvedTheme={resolvedTheme}
          open={taskDrawerOpen}
          tasks={data.tasks}
          folders={data.taskFolders}
          selectedId={selectedId}
          activeFolderId={activeTaskFolderId}
          onClose={() => setTaskDrawerOpen(false)}
          onNewTask={() => {
            navigateRoute({ view: "tasks", newTask: true });
            setTaskDrawerOpen(false);
            data.clearSelection();
          }}
          onOpenDocs={() => openDocs()}
          onOpenHistory={() => {
            navigateRoute({ view: "history" });
            setTaskDrawerOpen(false);
          }}
          onOpenLibrary={() => {
            navigateRoute({ view: "library", section: "skills" });
            setTaskDrawerOpen(false);
          }}
          onOpenSettings={() => {
            navigateRoute({ view: "settings", section: "providers" });
            setTaskDrawerOpen(false);
          }}
          onOpenSupport={() => {
            setSupportOpen(true);
            setTaskDrawerOpen(false);
          }}
          onDelete={(taskId, options) => data.deleteTask(taskId, options)}
          onDeleteFolder={(folderId, options) => {
            if (activeTaskFolderId === folderId) setActiveTaskFolderId("default");
            return data.deleteTaskFolder(folderId, options);
          }}
          onCreateFolder={(name, rootPath) => data.runSideAction(() => api.createTaskFolder({ name, rootPath }))}
          onFolderSelect={(folderId) => setActiveTaskFolderId(folderId)}
          onUpdateTask={(taskId, input) => data.patchTask(taskId, input)}
          onUpdateFolder={(folderId, name, rootPath) => data.runSideAction(() => api.patchTaskFolder(folderId, { name, rootPath }))}
          onSelect={(taskId) => {
            navigateRoute({ view: "tasks", taskId });
            setTaskDrawerOpen(false);
            void data.selectTask(taskId);
          }}
        />
      ) : null}

      <Suspense fallback={<div className="empty">{language === "zh-CN" ? "正在加载..." : "Loading..."}</div>}>
      {activeView === "tasks" ? (
        <TaskThread
          task={activeTask}
          transcriptEvents={activeTranscript}
          busy={data.busy}
          busySince={data.busySince}
          attachments={pendingAttachments}
          attachmentBusy={attachmentBusy}
          attachmentError={attachmentError}
          error={data.error}
          language={language}
          engineStatus={engineStatus}
          folderOptions={taskFolderOptions}
          folderValue={composerFolderValue}
          preferences={data.preferences}
          modelLabel={modelLabel}
          modelOptions={modelOptions}
          permissionPreset={permissionPreset}
          permissionScopeLabel={permissionScopeLabel}
          permissionBusy={permissionBusy}
          permissionError={permissionError}
          onModelChange={(modelId) => updateModelSelection(modelId)}
          onFilesSelected={(files) => uploadComposerFiles(files)}
          onRemoveAttachment={(attachmentId) => removeComposerAttachment(attachmentId)}
          onFolderChange={(folderId) => setActiveTaskFolderId(folderId)}
          onOpenConnect={() => {
            navigateRoute({ view: "settings", section: "providers" });
          }}
          onOpenPermissionSettings={() => {
            navigateRoute({ view: "settings", section: "permissions" });
          }}
          onOpenCustomPermissions={() => {
            setSettingsStartCustom(true);
            navigateRoute({ view: "settings", section: "permissions" });
          }}
          onRestoreCustomPermissions={() => restoreCustomPermissions()}
          hasCustomSnapshot={hasCustomSnapshot}
          onPermissionPresetChange={(preset) => applyPermissionPreset(preset)}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onSubmit={(mode, text) => submitComposer(mode, text)}
          onStop={() => data.selected && void data.runTaskAction(() => api.control(data.selected!.id, "pause"))}
          onCancelBusy={() => data.cancelBusy()}
          onPreviewRollback={(input) => data.selected ? data.previewRollbackTask(data.selected.id, input) : Promise.reject(new Error("No task selected"))}
          onRollback={(input) => data.selected ? data.rollbackTask(data.selected.id, input) : Promise.reject(new Error("No task selected"))}
          onRevertLatestTurn={() => data.selected ? data.revertLatestTurn(data.selected.id) : Promise.reject(new Error("No task selected"))}
          onLoadContextSummaries={() => data.selected ? api.listConversationSummaries(data.selected.id) : Promise.resolve([])}
          onLoadPromptCacheStats={() => data.selected ? api.listPromptCacheStats(data.selected.id) : Promise.resolve([])}
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
            navigateRoute({ view: "tasks", taskId });
            void data.selectTask(taskId);
          }}
        />
      ) : activeView === "library" ? (
        <LibraryView
          activeSection={librarySection}
          language={language}
          query={libraryQuery}
          onQuery={setLibraryQuery}
          onSection={(section) => navigateRoute({ view: "library", section })}
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
            curator: (
              <SkillCuratorPanel
                items={data.skillCurator}
                language={language}
                onRunReflection={() => void data.runSideAction(() => api.runReflection())}
                onActivateSkill={(skillId) => data.runSideAction(() => api.patchSkill(skillId, { status: "active" }))}
                onSuspendSkill={(skillId) => data.runSideAction(() => api.patchSkill(skillId, { status: "suspended" }))}
                onMergeDuplicate={(skillIds) => mergeDuplicateIds(skillIds)}
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
                onReindex={(id) => data.runSideAction(() => api.reindexKnowledgeItem(id))}
                onSearch={(input) => api.searchKnowledge(input)}
              />
            ),
            memory: (
              <ProjectMemoryPanel
                activeFolderId={activeTaskFolderId}
                folders={data.taskFolders}
                language={language}
                memories={data.projectMemories}
                query={libraryQuery}
                onLoadUserProfile={() => api.getUserProfile()}
                onSaveUserProfile={(content) => api.updateUserProfile({ content })}
                onLoadProjectMemory={(folderId) => api.getProjectMemory(folderId)}
                onSaveProjectMemory={(folderId, content) => api.updateProjectMemory(folderId, { content })}
                onCompactProjectMemory={(folderId) => api.compactProjectMemory(folderId)}
                onCreate={(input) => data.runSideAction(() => api.createProjectMemory(input))}
                onDelete={(id) => data.runSideAction(() => api.deleteProjectMemory(id))}
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
        <DocsView language={language} onBack={() => navigateRoute(previousNonDocsRoute)} />
      ) : (
        <SettingsView
          activeSection={settingsSection}
          language={language}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onSection={(section) => navigateRoute({ view: "settings", section })}
        >
          {{
            providers: (
              <ModelProvidersPanel
                activeProviderId={activeProvider?.id ?? null}
                currentModelLabel={modelLabel === "not configured" ? null : modelLabel}
                language={language}
                preferences={data.preferences}
                providers={data.modelProviders}
                onCreate={(input) => data.runSideAction(() => api.createModelProvider(input))}
                onDelete={(providerId) => data.runSideAction(() => api.deleteModelProvider(providerId))}
                onPreference={(patch) => data.runSideAction(() => api.updatePreferences(patch))}
                onUpdate={(providerId, input) => data.runSideAction(() => api.patchModelProvider(providerId, input))}
              />
            ),
            permissions: (
              <PermissionsPanel
                language={language}
                permissions={data.permissions}
                preferences={data.preferences}
                startCustom={settingsStartCustom}
                onStartCustomConsumed={() => setSettingsStartCustom(false)}
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
            integrations: (
              <IntegrationsPanel
                folders={data.taskFolders}
                integrations={data.integrations}
                language={language}
                onConnect={(id) => data.runSideAction(() => api.connectIntegration(id))}
                onCreate={(input) => data.runSideAction(() => api.createIntegration(input))}
                onDelete={(id) => data.runSideAction(() => api.deleteIntegration(id))}
                onDisconnect={(id) => data.runSideAction(() => api.disconnectIntegration(id))}
                onUpdate={(id, input) => data.runSideAction(() => api.patchIntegration(id, input))}
              />
            ),
            scheduled: (
              <ScheduledTasksPanel
                folders={data.taskFolders}
                language={language}
                scheduledTasks={data.scheduledTasks}
                onCreate={(input) => data.runSideAction(() => api.createScheduledTask(input))}
                onDelete={(taskId) => data.runSideAction(() => api.deleteScheduledTask(taskId))}
                onUpdate={(taskId, input) => data.runSideAction(() => api.patchScheduledTask(taskId, input))}
              />
            ),
            search: (
              <WebSearchPanel
                language={language}
                providers={data.webSearchProviders}
                onCreate={(input) => data.runSideAction(() => api.createWebSearchProvider(input))}
                onDelete={(providerId) => data.runSideAction(() => api.deleteWebSearchProvider(providerId))}
                onUpdate={(providerId, input) => data.runSideAction(() => api.patchWebSearchProvider(providerId, input))}
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
      </Suspense>
      <SupportDialog language={language} open={supportOpen} onClose={() => setSupportOpen(false)} onOpenDocs={() => openDocs()} />
    </main>
  );

  function openDocs() {
    if (activeView !== "docs") setPreviousNonDocsRoute(route);
    navigateRoute({ view: "docs" });
    setTaskDrawerOpen(false);
  }

  function submitComposer(mode: ComposerMode, text: string) {
    void submitComposerAfterPermissionSync(mode, text);
  }

  async function submitComposerAfterPermissionSync(mode: ComposerMode, text: string) {
    if (!(await waitForPermissionMutation())) return;
    const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
    if (mode === "guidance" || mode === "continue") {
      setTitleIssue(null);
      void data.runTaskAction(async () => {
        const task = activeTask ? await api.sendMessage(activeTask.id, text, attachmentIds) : await submitNewTaskAction(text, false, attachmentIds);
        setPendingAttachments([]);
        return task;
      });
      return;
    }
    setTitleIssue(null);
    void data.runTaskAction(async () => {
      const task = await submitNewTaskAction(text, false, attachmentIds);
      setPendingAttachments([]);
      return task;
    });
  }

  function submitNewTask(goal: string, useLocalFallback: boolean, attachmentIds = pendingAttachments.map((attachment) => attachment.id)) {
    void (async () => {
      if (!(await waitForPermissionMutation())) return;
      await data.runTaskAction(async () => {
        const task = await submitNewTaskAction(goal, useLocalFallback, attachmentIds);
        setPendingAttachments([]);
        return task;
      });
    })();
  }

  async function submitNewTaskAction(goal: string, useLocalFallback: boolean, attachmentIds = pendingAttachments.map((attachment) => attachment.id)) {
    let title: string | undefined;
    if (useLocalFallback) {
      try {
        title = (await api.generateTaskTitle(goal, language, true)).title;
      } catch (error) {
        setTitleIssue({ goal, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    setTitleIssue(null);
    const task = await api.createTask(goal, title, activeTaskFolderId, attachmentIds);
    navigateRoute({ view: "tasks", taskId: task.id });
    return task;
  }

  function approve(approvalId: string, decision: ApprovalDecision) {
    if (!data.selected) return;
    void (async () => {
      if (!(await waitForPermissionMutation())) return;
      await data.runTaskAction(() => api.decideApproval(data.selected!.id, approvalId, decision));
    })();
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
    setOptimisticPermissionPreset(preset);
    setPermissionError(null);
    setPermissionBusy(true);
    const mutation = (async () => {
      const granted = new Set(data.permissions.map((permission) => permission.riskCategory));

      if (permissionPreset === "custom") {
        const snapshot = allRiskCategories.filter((risk) => granted.has(risk));
        await api.updatePreferences({ customPermissionSnapshot: snapshot });
      }

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
      await data.refresh(data.selectedId);
    })();
    permissionMutationRef.current = mutation;
    void mutation
      .catch((error) => {
        setPermissionError(error instanceof Error ? error.message : String(error));
        setOptimisticPermissionPreset(null);
      })
      .finally(() => {
        if (permissionMutationRef.current === mutation) {
          permissionMutationRef.current = null;
          setPermissionBusy(false);
        }
      });
  }

  function restoreCustomPermissions() {
    const snapshot = data.preferences?.customPermissionSnapshot;
    if (!snapshot || snapshot.length === 0) return;
    void data.runSideAction(async () => {
      const granted = new Set(data.permissions.map((p) => p.riskCategory));
      for (const risk of allRiskCategories) {
        if (snapshot.includes(risk) && !granted.has(risk)) {
          await api.grantGlobalPermission(risk, "Restored custom permission snapshot.");
        }
        if (!snapshot.includes(risk) && granted.has(risk)) {
          await api.revokeGlobalPermission(risk);
        }
      }
    });
  }

  async function waitForPermissionMutation(): Promise<boolean> {
    const mutation = permissionMutationRef.current;
    if (!mutation) return true;
    try {
      await mutation;
      return true;
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  function updateModelSelection(modelId: string) {
    void data.runSideAction(async () => {
      if (activeProvider) {
        const model = activeProvider.models.find((item) => item.id === modelId);
        await api.patchModelProvider(activeProvider.id, { defaultModelId: modelId, makeActive: true });
        await api.updatePreferences({
          activeModelProviderId: activeProvider.id,
          defaultModel: modelId,
          providerBaseUrl: activeProvider.baseUrl,
          ...(model ? { maxTokensPerRequest: model.contextWindow } : {})
        });
        return;
      }
      await api.updatePreferences({ defaultModel: modelId });
    });
  }

  async function uploadComposerFiles(files: File[]) {
    setAttachmentBusy(true);
    setAttachmentError(null);
    try {
      const uploaded: TaskAttachment[] = [];
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} exceeds the 20MB file limit.`);
        const dataBase64 = arrayBufferToBase64(await file.arrayBuffer());
        uploaded.push(await api.uploadTaskAttachment({ fileName: file.name, mimeType: file.type || "application/octet-stream", size: file.size, dataBase64 }));
      }
      const totalBytes = [...pendingAttachments, ...uploaded].reduce((sum, attachment) => sum + attachment.size, 0);
      if (totalBytes > 100 * 1024 * 1024) {
        for (const attachment of uploaded) await api.deleteTaskAttachment(attachment.id).catch(() => undefined);
        throw new Error("Task attachments exceed the 100MB task limit.");
      }
      setPendingAttachments((current) => [...current, ...uploaded]);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      setAttachmentBusy(false);
    }
  }

  async function removeComposerAttachment(attachmentId: string) {
    await api.deleteTaskAttachment(attachmentId).catch(() => undefined);
    setPendingAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
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

  function mergeDuplicateIds(skillIds: string[]) {
    const [targetSkillId, ...sourceSkillIds] = [...new Set(skillIds)];
    if (!targetSkillId || sourceSkillIds.length === 0) return Promise.resolve();
    return data.runSideAction(() => api.mergeSkills(targetSkillId, { targetSkillId, sourceSkillIds, deleteSources: true }));
  }
}

function getDefaultFolderLabel(language: string | null | undefined): string {
  return language === "zh-CN" ? "默认文件夹" : "Default";
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
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
