import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentProps, type ComponentType } from "react";
import type { ApprovalDecision, PreferencesPatch, RiskCategory, SkillDuplicateGroup, TaskAttachment, UserPreferences } from "@agent-workbench/shared";
import { type AppRoute, useAppRoute } from "./app-router.js";
import { api } from "./api.js";
import { ProviderBrandIcon } from "./components/ProviderBrandIcon.js";
import { TaskList } from "./components/TaskList.js";
import { TaskThread } from "./components/TaskThread.js";
import type { ComposerMode, ComposerPermissionMode, PermissionPreset } from "./components/Composer.js";
import type { LibrarySection } from "./components/LibraryView.js";
import type { SettingsSection } from "./components/SettingsView.js";
import type { DocsSection } from "./docs/index.js";
import { parseComposerSlashCommand, type SlashNavigationTarget } from "./slash-commands.js";
import { useWorkbenchData } from "./useWorkbenchData.js";

type PreloadableComponent<TProps extends object> = ComponentType<TProps> & {
  preload: () => Promise<void>;
};

function preloadable<TProps extends object>(loader: () => Promise<{ default: ComponentType<TProps> }>): PreloadableComponent<TProps> {
  let resolved: ComponentType<TProps> | null = null;
  let loading: Promise<{ default: ComponentType<TProps> }> | null = null;
  const load = () => {
    loading ??= loader().then((module) => {
      resolved = module.default;
      return module;
    });
    return loading;
  };
  const LazyComponent = lazy(load);
  const Component = ((props: TProps) => {
    const ResolvedComponent = resolved;
    return ResolvedComponent ? <ResolvedComponent {...props} /> : <LazyComponent {...props} />;
  }) as unknown as PreloadableComponent<TProps>;
  Component.preload = () => load().then(() => undefined);
  return Component;
}

const DocsView = preloadable<ComponentProps<typeof import("./components/DocsView.js").DocsView>>(() => import("./components/DocsView.js").then((module) => ({ default: module.DocsView })));
const HistoryPage = preloadable<ComponentProps<typeof import("./components/HistoryPage.js").HistoryPage>>(() => import("./components/HistoryPage.js").then((module) => ({ default: module.HistoryPage })));
const IntegrationsPanel = preloadable<ComponentProps<typeof import("./components/IntegrationsPanel.js").IntegrationsPanel>>(() => import("./components/IntegrationsPanel.js").then((module) => ({ default: module.IntegrationsPanel })));
const KnowledgePanel = preloadable<ComponentProps<typeof import("./components/KnowledgePanel.js").KnowledgePanel>>(() => import("./components/KnowledgePanel.js").then((module) => ({ default: module.KnowledgePanel })));
const LibraryView = preloadable<ComponentProps<typeof import("./components/LibraryView.js").LibraryView>>(() => import("./components/LibraryView.js").then((module) => ({ default: module.LibraryView })));
const McpPanel = preloadable<ComponentProps<typeof import("./components/McpPanel.js").McpPanel>>(() => import("./components/McpPanel.js").then((module) => ({ default: module.McpPanel })));
const ModelProvidersPanel = preloadable<ComponentProps<typeof import("./components/ModelProvidersPanel.js").ModelProvidersPanel>>(() => import("./components/ModelProvidersPanel.js").then((module) => ({ default: module.ModelProvidersPanel })));
const PermissionsPanel = preloadable<ComponentProps<typeof import("./components/PermissionsPanel.js").PermissionsPanel>>(() => import("./components/PermissionsPanel.js").then((module) => ({ default: module.PermissionsPanel })));
const ProjectMemoryPanel = preloadable<ComponentProps<typeof import("./components/ProjectMemoryPanel.js").ProjectMemoryPanel>>(() => import("./components/ProjectMemoryPanel.js").then((module) => ({ default: module.ProjectMemoryPanel })));
const SettingsView = preloadable<ComponentProps<typeof import("./components/SettingsView.js").SettingsView>>(() => import("./components/SettingsView.js").then((module) => ({ default: module.SettingsView })));
const ScheduledTasksPanel = preloadable<ComponentProps<typeof import("./components/ScheduledTasksPanel.js").ScheduledTasksPanel>>(() => import("./components/ScheduledTasksPanel.js").then((module) => ({ default: module.ScheduledTasksPanel })));
const SkillCuratorPanel = preloadable<ComponentProps<typeof import("./components/SkillCuratorPanel.js").SkillCuratorPanel>>(() => import("./components/SkillCuratorPanel.js").then((module) => ({ default: module.SkillCuratorPanel })));
const SkillPanel = preloadable<ComponentProps<typeof import("./components/SkillPanel.js").SkillPanel>>(() => import("./components/SkillPanel.js").then((module) => ({ default: module.SkillPanel })));
const SupportDialog = preloadable<ComponentProps<typeof import("./components/SupportDialog.js").SupportDialog>>(() => import("./components/SupportDialog.js").then((module) => ({ default: module.SupportDialog })));
const WebSearchPanel = preloadable<ComponentProps<typeof import("./components/WebSearchPanel.js").WebSearchPanel>>(() => import("./components/WebSearchPanel.js").then((module) => ({ default: module.WebSearchPanel })));
const preloadablePages = [
  DocsView,
  HistoryPage,
  LibraryView,
  SettingsView,
  SkillPanel,
  SkillCuratorPanel,
  KnowledgePanel,
  ProjectMemoryPanel,
  ModelProvidersPanel,
  PermissionsPanel,
  McpPanel,
  IntegrationsPanel,
  ScheduledTasksPanel,
  WebSearchPanel
] as const;

const allRiskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];
const readOnlyRiskCategories: RiskCategory[] = ["host_observation", "workspace_read"];
const defaultAutoApprovalRiskCategories: UserPreferences["autoApproveRiskCategories"] = ["host_observation", "workspace_read", "network"];
const nonDestructiveRiskCategories: UserPreferences["autoApproveRiskCategories"] = ["host_observation", "workspace_read", "workspace_write", "shell", "network"];
type PermissionMode = UserPreferences["permissionMode"];
type GoalPermissionPreset = "ask" | "non_destructive" | "full_risk";
const settingsDocsSections: Record<SettingsSection, DocsSection> = {
  providers: "providers",
  permissions: "permissions",
  mcp: "mcp",
  integrations: "integrations",
  scheduled: "scheduled",
  search: "search",
  preferences: "preferences"
};
const libraryDocsSections: Record<LibrarySection, DocsSection> = {
  skills: "skills",
  curator: "curator",
  knowledge: "knowledge",
  memory: "memory"
};
const LAST_TASK_FOLDER_KEY = "agent-workbench.lastTaskFolderId";
const LEGACY_LAST_TASK_FOLDER_KEY = "scc.lastTaskFolderId";
const LAST_TASK_KEY = "agent-workbench.lastTaskId";
const LEGACY_LAST_TASK_KEY = "scc.lastTaskId";

export function App() {
  const [route, navigateRoute] = useAppRoute();
  const activeView = route.view;
  const settingsSection: SettingsSection = route.view === "settings" ? route.section : "providers";
  const librarySection: LibrarySection = route.view === "library" ? route.section : "skills";
  const loadProfile = useMemo(() => ({ activeView, librarySection, settingsSection }), [activeView, librarySection, settingsSection]);
  const data = useWorkbenchData(loadProfile);
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
  const [optimisticPermissionMode, setOptimisticPermissionMode] = useState<PermissionMode | null>(null);
  const [optimisticPermissionRisks, setOptimisticPermissionRisks] = useState<RiskCategory[] | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [goalConfirmation, setGoalConfirmation] = useState<{ goal: string; attachmentIds: string[] } | null>(null);
  const [commandIssue, setCommandIssue] = useState<string | null>(null);
  const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">("dark");
  const permissionMutationRef = useRef<Promise<void> | null>(null);
  const language = data.preferences?.language ?? "zh-CN";
  const theme = data.preferences?.theme ?? "dark";
  const activeTask = route.view === "tasks" && route.newTask ? null : data.selected;
  const activeParentTask =
    activeTask?.kind === "subagent" && activeTask.parentTaskId
      ? data.tasks.find((task) => task.id === activeTask.parentTaskId) ?? null
      : null;
  const activeTranscript = route.view === "tasks" && route.newTask ? [] : data.selectedTranscript;
  const selectedId = route.view === "tasks" && route.newTask ? null : data.selectedId;
  const syncFresh = data.lastSuccessfulSyncAt === null || Date.now() - data.lastSuccessfulSyncAt < 35_000;
  const engineStatus = data.backendHealthy === false || (data.realtimeStale && !syncFresh) ? "attention" : data.realtimeConnected ? "streaming" : "running";
  const activeProvider = useMemo(
    () => data.modelProviders.find((provider) => provider.id === data.preferences?.activeModelProviderId) ?? data.modelProviders.find((provider) => provider.enabled) ?? null,
    [data.modelProviders, data.preferences?.activeModelProviderId]
  );
  const activeModel = useMemo(
    () => activeProvider?.models.find((model) => model.id === activeProvider.defaultModelId) ?? activeProvider?.models[0] ?? null,
    [activeProvider]
  );
  const modelLabel = activeProvider && activeModel ? (activeModel.label || activeModel.id) : data.preferences?.defaultModel || "not configured";
  const permissionPreset = optimisticPermissionPreset ?? getPermissionPreset(data.permissions, data.preferences);
  const permissionScopeLabel = formatPermissionPreset(permissionPreset, language);
  const hasCustomSnapshot = Boolean(data.preferences?.customPermissionSnapshot?.length);
  const modelOptions = useMemo(
    () => {
      if (activeProvider) {
        return activeProvider.models.map((model) => ({
          icon: <ProviderBrandIcon className="providerBadgeInline" modelId={model.id} vendor={activeProvider.vendor} />,
          label: model.label || model.id,
          value: model.id
        }));
      }
      if (data.preferences?.defaultModel) {
        return [{ label: data.preferences.defaultModel, value: data.preferences.defaultModel }];
      }
      return [];
    },
    [activeProvider, data.preferences?.defaultModel]
  );
  const taskFolderOptions = useMemo(
    () =>
      data.taskFolders.length > 0
        ? data.taskFolders.map((folder) => ({
            label: folder.id === "default" || folder.isDefault ? getDefaultFolderLabel(language) : folder.name,
            value: folder.id,
            ...(folder.rootPath ? { description: folder.rootPath } : {})
          }))
        : [{ label: language === "zh-CN" ? "默认文件夹" : "Default", value: "default" }],
    [data.taskFolders, language]
  );
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

  useEffect(() => preloadAppPagesDuringIdle(language), [language]);

  useEffect(() => {
    if (!supportOpen) return;
    void DocsView.preload();
    void import("./docs/index.js").then((module) => module.preloadDocContents(language)).catch(() => undefined);
  }, [language, supportOpen]);

  const routeSyncRef = useRef({
    clearSelection: data.clearSelection,
    selectTask: data.selectTask,
    selectedId: data.selectedId
  });
  routeSyncRef.current = {
    clearSelection: data.clearSelection,
    selectTask: data.selectTask,
    selectedId: data.selectedId
  };

  useEffect(() => {
    if (route.view !== "docs") {
      setPreviousNonDocsRoute((current) => (sameRoute(current, route) ? current : route));
    }
    if (route.view === "tasks" && route.newTask) routeSyncRef.current.clearSelection();
    if (route.view === "tasks" && route.taskId && route.taskId !== routeSyncRef.current.selectedId) void routeSyncRef.current.selectTask(route.taskId);
  }, [route]);

  useEffect(() => {
    if (!optimisticPermissionPreset || permissionBusy) return;
    if (getPermissionPreset(data.permissions) === optimisticPermissionPreset) {
      setOptimisticPermissionPreset(null);
    }
  }, [data.permissions, optimisticPermissionPreset, permissionBusy]);

  useEffect(() => {
    if (activeTask?.folderId && activeTask.folderId !== activeTaskFolderId) {
      setActiveTaskFolderId(activeTask.folderId);
      safeLocalStorageSet(LAST_TASK_FOLDER_KEY, activeTask.folderId);
    }
  }, [activeTask?.id, activeTask?.folderId, activeTaskFolderId]);

  useEffect(() => {
    if (activeTaskFolderId) safeLocalStorageSet(LAST_TASK_FOLDER_KEY, activeTaskFolderId);
  }, [activeTaskFolderId]);

  useEffect(() => {
    if (route.view !== "tasks" || route.taskId || route.newTask || data.tasks.length === 0) return;
    const startupView = data.preferences?.startupView ?? "last_task";
    if (startupView === "new_task") {
      navigateRoute({ view: "tasks", newTask: true }, { replace: true });
      return;
    }
    if (startupView === "last_folder") {
      const folderId = safeLocalStorageGet(LAST_TASK_FOLDER_KEY, LEGACY_LAST_TASK_FOLDER_KEY);
      if (folderId && data.taskFolders.some((folder) => folder.id === folderId)) setActiveTaskFolderId(folderId);
      return;
    }
    const lastTaskId = safeLocalStorageGet(LAST_TASK_KEY, LEGACY_LAST_TASK_KEY);
    const task = data.tasks.find((item) => item.id === lastTaskId) ?? data.tasks[0];
    if (task) navigateRoute({ view: "tasks", taskId: task.id }, { replace: true });
  }, [route, data.tasks, data.taskFolders, data.preferences?.startupView, navigateRoute]);

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
            safeLocalStorageSet(LAST_TASK_KEY, taskId);
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
          parentTask={activeParentTask}
          delegatedChildren={activeTask?.kind === "subagent" ? [] : data.selectedChildren}
          transcriptEvents={activeTranscript}
          busy={data.busy}
          busySince={data.busySince}
          attachments={pendingAttachments}
          attachmentBusy={attachmentBusy}
          attachmentError={attachmentError}
          error={commandIssue ?? data.error}
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
          onLoadStreamText={(taskId, streamId, type) => data.getTaskStreamText(taskId, streamId, type)}
          onRevertTurn={(turnId) => data.selected ? data.revertTaskTurn(data.selected.id, turnId) : Promise.reject(new Error("No task selected"))}
          onLoadContextSummaries={() => data.selected ? api.listConversationSummaries(data.selected.id) : Promise.resolve([])}
          titleIssue={titleIssue}
          onRetryTitle={() => titleIssue && submitNewTask(titleIssue.goal, false)}
          onUseLocalTitle={() => titleIssue && submitNewTask(titleIssue.goal, true)}
          onApprovalDecision={(approvalId, decision) => approve(approvalId, decision)}
          onAnswerUserInput={(answer) => answerUserInput(answer)}
          onOpenDelegatedTask={(taskId) => {
            safeLocalStorageSet(LAST_TASK_KEY, taskId);
            navigateRoute({ view: "tasks", taskId });
            void data.selectTask(taskId);
          }}
          onReturnToParent={() => {
            if (!activeParentTask) return;
            safeLocalStorageSet(LAST_TASK_KEY, activeParentTask.id);
            navigateRoute({ view: "tasks", taskId: activeParentTask.id });
            void data.selectTask(activeParentTask.id);
          }}
        />
      ) : activeView === "history" ? (
        <HistoryPage
          language={language}
          tasks={data.tasks}
          onOpenTasks={() => setTaskDrawerOpen(true)}
          onDelete={(taskId, options) => data.deleteTask(taskId, options)}
          onOpenTask={(taskId) => {
            safeLocalStorageSet(LAST_TASK_KEY, taskId);
            navigateRoute({ view: "tasks", taskId });
            void data.selectTask(taskId);
          }}
        />
      ) : activeView === "library" ? (
        <LibraryView
          activeSection={librarySection}
          error={data.error}
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
                onOpenDocs={() => openDocs(libraryDocsSections.skills)}
                onRunCuratorExtraction={() => void data.runSideAction(() => api.runCuratorExtraction())}
                onCreate={async (input) => {
                  await data.runSideActionResult(() => api.createSkill(input), { rethrow: true });
                }}
                onUpdate={async (skillId, input) => {
                  await data.runSideActionResult(() => api.patchSkill(skillId, input), { rethrow: true });
                }}
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
                conflicts={data.skillConflicts}
                duplicates={data.skillDuplicates}
                curatorRuns={data.curatorRuns}
                onOpenDocs={() => openDocs(libraryDocsSections.curator)}
                onRunCuratorExtraction={() => void data.runSideAction(() => api.runCuratorExtraction())}
                onDeleteCuratorRun={(id) => data.runSideAction(() => api.deleteCuratorRun(id))}
                onDeleteMemory={(id) => data.runSideAction(() => api.deleteTaskMemory(id))}
                onClearCuratorRuns={() => data.runSideAction(() => api.clearCuratorRuns())}
                onActivateSkill={(skillId) => data.runSideAction(() => api.patchSkill(skillId, { status: "active" }))}
                onSuspendSkill={(skillId) => data.runSideAction(() => api.patchSkill(skillId, { status: "suspended" }))}
                onMergeDuplicate={(skillIds) => mergeDuplicateIds(skillIds)}
              />
            ),
            knowledge: (
              <KnowledgePanel
                query={libraryQuery}
                projectId={activeTaskFolderId}
                language={language}
                items={data.knowledgeItems.filter((item) => item.projectId === activeTaskFolderId)}
                onOpenDocs={() => openDocs(libraryDocsSections.knowledge)}
                onCreate={async (input) => {
                  await data.runSideActionResult(() => api.createKnowledgeItem(input), { rethrow: true });
                }}
                onDelete={(id) => data.runSideAction(() => api.deleteKnowledgeItem(id))}
                onUpdate={async (id, input) => {
                  await data.runSideActionResult(() => api.patchKnowledgeItem(id, input), { rethrow: true });
                }}
                onUpload={async (input) => {
                  await data.runSideActionResult(() => api.uploadKnowledgeFile(input), { rethrow: true });
                }}
                onReindex={(id) => data.runSideAction(() => api.reindexKnowledgeItem(id))}
                onSearch={(input) => api.searchKnowledge(input)}
                preferences={data.preferences}
                onPreference={(patch) => void updatePreference(patch)}
                onLoadModels={() => api.getKnowledgeModelStatus()}
                onDownloadModel={async (input) => {
                  const result = await api.downloadKnowledgeModel(input);
                  await data.refresh(data.selected?.id ?? null);
                  return result;
                }}
              />
            ),
            memory: (
              <ProjectMemoryPanel
                activeFolderId={activeTaskFolderId}
                folders={data.taskFolders}
                language={language}
                memories={data.projectMemories}
                query={libraryQuery}
                onOpenDocs={() => openDocs(libraryDocsSections.memory)}
                onLoadUserProfile={() => api.getUserProfile()}
                onSaveUserProfile={(content) => api.updateUserProfile({ content })}
                onLoadProjectMemory={(folderId) => api.getProjectMemory(folderId)}
                onSaveProjectMemory={(folderId, content) => api.updateProjectMemory(folderId, { content })}
                onCompactProjectMemory={(folderId) => api.compactProjectMemory(folderId)}
                onCreate={(input) => data.runSideAction(() => api.createProjectMemory(input))}
                onUpdateMemory={(id, input) => data.runSideAction(() => api.patchProjectMemory(id, input))}
                onDelete={(id) => data.runSideAction(() => api.deleteProjectMemory(id))}
              />
            )
          }}
        </LibraryView>
      ) : activeView === "docs" ? (
        <DocsView
          activeSection={route.view === "docs" ? route.section : "overview"}
          language={language}
          onBack={() => navigateRoute(previousNonDocsRoute)}
          onSection={(section) => navigateRoute({ view: "docs", section })}
        />
      ) : (
        <SettingsView
          activeSection={settingsSection}
          error={data.error}
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
                onOpenDocs={() => openDocs(settingsDocsSections.providers)}
                preferences={data.preferences}
                providers={data.modelProviders}
                onCreate={(input) => data.runSideActionResult(() => api.createModelProvider(input), { rethrow: true })}
                onDelete={(providerId) => data.runSideAction(() => api.deleteModelProvider(providerId))}
                onPreference={(patch) => data.runSideAction(() => api.updatePreferences(patch))}
                onTest={(providerId) => data.runSideActionResult(() => api.testModelProvider(providerId), { rethrow: true })}
                onUpdate={(providerId, input) => data.runSideActionResult(() => api.patchModelProvider(providerId, input), { rethrow: true })}
              />
            ),
            permissions: (
              <PermissionsPanel
                language={language}
                onOpenDocs={() => openDocs(settingsDocsSections.permissions)}
                permissions={data.permissions}
                preferences={data.preferences}
                startCustom={settingsStartCustom}
                optimisticMode={optimisticPermissionMode}
                optimisticRisks={optimisticPermissionRisks}
                onStartCustomConsumed={() => setSettingsStartCustom(false)}
                onPermissionModeChange={(mode, risks) => applyPermissionMode(mode, risks)}
                onPreference={(patch) => void updatePreference(patch)}
              />
            ),
            mcp: (
              <McpPanel
                language={language}
                onOpenDocs={() => openDocs(settingsDocsSections.mcp)}
                servers={data.mcpServers}
                tools={data.mcpTools}
                onCreate={(input) => data.runSideActionResult(() => api.createMcpServer(input), { rethrow: true })}
                onUpdate={(serverId, input) => data.runSideActionResult(() => api.patchMcpServer(serverId, input), { rethrow: true })}
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
                onOpenDocs={() => openDocs(settingsDocsSections.integrations)}
                onConnect={(id) => data.runSideAction(() => api.connectIntegration(id))}
                onCreate={(input) => data.runSideActionResult(() => api.createIntegration(input), { rethrow: true })}
                onDelete={(id) => data.runSideAction(() => api.deleteIntegration(id))}
                onDisconnect={(id) => data.runSideAction(() => api.disconnectIntegration(id))}
                onUpdate={(id, input) => data.runSideActionResult(() => api.patchIntegration(id, input), { rethrow: true })}
              />
            ),
            scheduled: (
              <ScheduledTasksPanel
                folders={data.taskFolders}
                language={language}
                onOpenDocs={() => openDocs(settingsDocsSections.scheduled)}
                scheduledTasks={data.scheduledTasks}
                onCreate={(input) => data.runSideActionResult(() => api.createScheduledTask(input), { rethrow: true })}
                onDelete={(taskId) => data.runSideAction(() => api.deleteScheduledTask(taskId))}
                onUpdate={(taskId, input) => data.runSideActionResult(() => api.patchScheduledTask(taskId, input), { rethrow: true })}
              />
            ),
            search: (
              <WebSearchPanel
                language={language}
                onOpenDocs={() => openDocs(settingsDocsSections.search)}
                providers={data.webSearchProviders}
                onCreate={(input) => data.runSideActionResult(() => api.createWebSearchProvider(input), { rethrow: true })}
                onDelete={(providerId) => data.runSideAction(() => api.deleteWebSearchProvider(providerId))}
                onUpdate={(providerId, input) => data.runSideActionResult(() => api.patchWebSearchProvider(providerId, input), { rethrow: true })}
              />
            ),
            preferences: (
              <PermissionsPanel
                language={language}
                onOpenDocs={() => openDocs(settingsDocsSections.preferences)}
                permissions={data.permissions}
                preferences={data.preferences}
                preferencesOnly
                optimisticMode={optimisticPermissionMode}
                optimisticRisks={optimisticPermissionRisks}
                onPermissionModeChange={(mode, risks) => applyPermissionMode(mode, risks)}
                onPreference={(patch) => void updatePreference(patch)}
              />
            )
          }}
        </SettingsView>
      )}
      </Suspense>
      <GoalModeDialog
        busy={permissionBusy || data.busy}
        language={language}
        open={Boolean(goalConfirmation)}
        onCancel={() => setGoalConfirmation(null)}
        onConfirm={(preset) => confirmGoalMode(preset)}
      />
      {supportOpen ? (
        <Suspense fallback={null}>
          <SupportDialog language={language} open={supportOpen} onClose={() => setSupportOpen(false)} onOpenDocs={() => openDocs()} />
        </Suspense>
      ) : null}
    </main>
  );

  function openDocs(section: DocsSection = "overview") {
    if (activeView !== "docs") setPreviousNonDocsRoute(route);
    navigateRoute({ view: "docs", section });
    setTaskDrawerOpen(false);
  }

  function submitComposer(mode: ComposerMode, text: string) {
    void submitComposerAfterPermissionSync(mode, text);
  }

  async function submitComposerAfterPermissionSync(mode: ComposerMode, text: string) {
    if (!(await waitForPermissionMutation())) return;
    const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
    const command = parseComposerSlashCommand(text, language);
    if (command.kind === "error") {
      setCommandIssue(command.message);
      return;
    }
    if (command.kind === "navigate") {
      setCommandIssue(null);
      openSlashNavigation(command.target);
      return;
    }
    setCommandIssue(null);
    if (command.runMode === "target") {
      setGoalConfirmation({ goal: command.text, attachmentIds });
      return;
    }
    if (mode === "guidance" || mode === "continue") {
      setTitleIssue(null);
      void data.runTaskAction(async () => {
        const task = activeTask ? await api.sendMessage(activeTask.id, command.text, attachmentIds) : await submitNewTaskAction(command.text, false, attachmentIds, command.runMode);
        setPendingAttachments([]);
        return task;
      });
      return;
    }
    setTitleIssue(null);
    void data.runTaskAction(async () => {
      const task = await submitNewTaskAction(command.text, false, attachmentIds, command.runMode);
      setPendingAttachments([]);
      return task;
    });
  }

  function openSlashNavigation(target: SlashNavigationTarget) {
    if (target.area === "docs") {
      openDocs(target.section);
      return;
    }
    if (target.area === "library") {
      navigateRoute({ view: "library", section: target.section });
      setTaskDrawerOpen(false);
      return;
    }
    navigateRoute({ view: "settings", section: target.section });
    setTaskDrawerOpen(false);
  }

  async function confirmGoalMode(preset: GoalPermissionPreset) {
    const confirmation = goalConfirmation;
    if (!confirmation) return;
    const permissionUpdated =
      preset === "non_destructive"
        ? await runPermissionModeMutation("auto_approval", nonDestructiveRiskCategories)
        : preset === "full_risk"
          ? await runPermissionModeMutation("full_access")
          : await runPermissionModeMutation("ask");
    if (!permissionUpdated) return;
    setGoalConfirmation(null);
    await data.runTaskAction(async () => {
      const task = await submitNewTaskAction(confirmation.goal, false, confirmation.attachmentIds, "target");
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

  async function submitNewTaskAction(goal: string, useLocalFallback: boolean, attachmentIds = pendingAttachments.map((attachment) => attachment.id), runMode: "normal" | "target" = "normal") {
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
    const task = await api.createTask(goal, title, activeTaskFolderId, attachmentIds, runMode === "target" ? { runMode: "target" } : {});
    safeLocalStorageSet(LAST_TASK_KEY, task.id);
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

  function answerUserInput(answer: string) {
    if (!data.selected) return;
    void data.runTaskAction(() => api.sendMessage(data.selected!.id, answer, []));
  }

  function updatePreference(patch: PreferencesPatch) {
    void data.runSideAction(() => api.updatePreferences(patch));
  }

  function applyPermissionMode(mode: PermissionMode, selectedRisks?: RiskCategory[]) {
    void runPermissionModeMutation(mode, selectedRisks);
  }

  function applyPermissionPreset(preset: PermissionPreset) {
    void runPermissionPresetMutation(preset);
  }

  async function runPermissionPresetMutation(preset: PermissionPreset): Promise<boolean> {
    const mode: PermissionMode = preset === "all" ? "full_access" : preset === "read_only" ? "read_only" : "ask";
    return runPermissionModeMutation(mode);
  }

  async function runPermissionModeMutation(mode: PermissionMode, selectedRisks?: RiskCategory[]): Promise<boolean> {
    const optimisticPreset: ComposerPermissionMode = mode === "full_access" ? "all" : mode === "read_only" ? "read_only" : (mode === "custom" || mode === "auto_approval") ? "custom" : "ask";
    const target = new Set<RiskCategory>(targetRisksForPermissionMode(mode, selectedRisks));
    const preferencePatch = preferencesForPermissionMode(mode, selectedRisks);
    setOptimisticPermissionMode(mode);
    setOptimisticPermissionRisks([...target]);
    const ok = await runPermissionMutation(optimisticPreset, target, preferencePatch, `User selected ${mode} permission mode from the workbench UI.`);
    if (ok) {
      setOptimisticPermissionMode(null);
      setOptimisticPermissionRisks(null);
    }
    return ok;
  }

  async function runPermissionMutation(
    nextPreset: ComposerPermissionMode,
    target: Set<RiskCategory>,
    preferencePatch: PreferencesPatch,
    reason: string
  ): Promise<boolean> {
    setOptimisticPermissionPreset(nextPreset);
    setPermissionError(null);
    setPermissionBusy(true);
    const previousPreset = permissionPreset;
    const mutation = (async () => {
      await data.loadPermissions();
      const grants = data.permissions.length > 0 ? data.permissions : await api.listGlobalPermissions();
      const granted = new Set(grants.map((permission) => permission.riskCategory));

      if (previousPreset === "custom") {
        const snapshot = allRiskCategories.filter((risk) => granted.has(risk));
        await api.updatePreferences({ customPermissionSnapshot: snapshot });
      }

      for (const risk of allRiskCategories) {
        if (target.has(risk) && !granted.has(risk)) {
          await api.grantGlobalPermission(risk, reason);
        }
        if (!target.has(risk) && granted.has(risk)) {
          await api.revokeGlobalPermission(risk);
        }
      }
      await api.updatePreferences(preferencePatch);
      await data.refresh(data.selectedId);
    })();
    permissionMutationRef.current = mutation;
    try {
      await mutation;
      return true;
    } catch (error) {
      setPermissionError(error instanceof Error ? error.message : String(error));
      setOptimisticPermissionPreset(null);
      setOptimisticPermissionMode(null);
      setOptimisticPermissionRisks(null);
      return false;
    } finally {
      if (permissionMutationRef.current === mutation) {
        permissionMutationRef.current = null;
        setPermissionBusy(false);
      }
    }
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
      const providers = data.modelProviders.length > 0 ? data.modelProviders : await api.listModelProviders();
      const provider = providers.find((item) => item.id === data.preferences?.activeModelProviderId) ?? providers.find((item) => item.enabled);
      if (provider) {
        const model = provider.models.find((item) => item.id === modelId);
        await api.patchModelProvider(provider.id, { defaultModelId: modelId, makeActive: true });
        await api.updatePreferences({
          activeModelProviderId: provider.id,
          defaultModel: modelId,
          providerBaseUrl: provider.baseUrl,
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

function GoalModeDialog({
  busy,
  language,
  open,
  onCancel,
  onConfirm
}: {
  busy: boolean;
  language: string;
  open: boolean;
  onCancel: () => void;
  onConfirm: (preset: GoalPermissionPreset) => Promise<void> | void;
}) {
  const [selected, setSelected] = useState<GoalPermissionPreset | null>(null);
  const [fullRiskAcknowledged, setFullRiskAcknowledged] = useState(false);
  const zh = language === "zh-CN";
  useLayoutEffect(() => {
    if (open) {
      setSelected(null);
      setFullRiskAcknowledged(false);
    }
  }, [open]);
  if (!open) return null;
  const options: Array<{ value: GoalPermissionPreset; label: string; detail: string }> = zh
    ? [
        { value: "ask", label: "Ask every time", detail: "保持逐次审批；/goal 仍会更主动推进和验证。" },
        { value: "non_destructive", label: "Non-destructive max", detail: "自动放开观察、读取、写入、shell 和网络；破坏性操作仍不自动审批。" },
        { value: "full_risk", label: "Full risk", detail: "全局允许全部风险类别，包括删除、覆盖和终止进程等高危操作。" }
      ]
    : [
        { value: "ask", label: "Ask every time", detail: "Keep per-tool approval; /goal will still push harder and verify longer." },
        { value: "non_destructive", label: "Non-destructive max", detail: "Auto-approve observe, read, write, shell, and network risks. Destructive stays outside automation." },
        { value: "full_risk", label: "Full risk", detail: "Globally allow every risk class, including delete, overwrite, and process termination." }
      ];
  const requiresFullRiskAcknowledgement = selected === "full_risk" && !fullRiskAcknowledged;
  return (
    <div className="modalBackdrop stdBackdrop" role="presentation" onClick={(event) => { if (event.currentTarget === event.target && !busy) onCancel(); }}>
      <section aria-modal="true" aria-labelledby="goal-mode-title" className="stdModal stdModalNarrow targetModeDialog goalModeDialog" role="dialog">
        <div className="stdHeader">
          <h3 id="goal-mode-title">{zh ? "启动 /goal" : "Start /goal"}</h3>
          <button aria-label={zh ? "取消" : "Cancel"} className="stdClose" disabled={busy} type="button" onClick={onCancel}>×</button>
        </div>
        <div className="stdBody">
          <p className="stdDialogHelp">
            {zh
              ? "/goal 会更主动地持续探索、实现和验证目标，可能消耗更多模型额度、运行更久、连续读写文件、运行命令或访问网络。你可以随时暂停。"
              : "/goal pushes harder toward a verified goal. It may spend more model quota, run longer, repeatedly read/write files, run commands, or access the network. You can pause anytime."}
          </p>
          <div className="targetPermissionGrid" role="radiogroup" aria-label={zh ? "选择权限范围" : "Choose permission preset"}>
            {options.map((option) => (
              <button
                aria-checked={selected === option.value}
                className={selected === option.value ? "targetPermissionOption selected" : "targetPermissionOption"}
                disabled={busy}
                key={option.value}
                role="radio"
                type="button"
                onClick={() => setSelected(option.value)}
              >
                <strong>{option.label}</strong>
                <span>{option.detail}</span>
              </button>
            ))}
          </div>
          {selected === "full_risk" ? (
            <label className="goalDangerAck">
              <input
                checked={fullRiskAcknowledged}
                disabled={busy}
                type="checkbox"
                onChange={(event) => setFullRiskAcknowledged(event.target.checked)}
              />
              <span>
                {zh
                  ? "我理解 Full risk 会全局允许 destructive 操作，可能删除、覆盖、终止进程或不可逆改变本机/远程状态。"
                  : "I understand Full risk globally allows destructive operations that may delete, overwrite, terminate processes, or irreversibly change local or remote state."}
              </span>
            </label>
          ) : null}
        </div>
        <div className="stdFooter">
          <button className="stdCancelBtn" disabled={busy} type="button" onClick={onCancel}>
            {zh ? "取消" : "Cancel"}
          </button>
          <button className="primaryInlineButton" disabled={!selected || requiresFullRiskAcknowledgement || busy} type="button" onClick={() => selected && onConfirm(selected)}>
            {busy ? (zh ? "正在启动..." : "Starting...") : (zh ? "启动目标完成模式" : "Start goal mode")}
          </button>
        </div>
      </section>
    </div>
  );
}

function getDefaultFolderLabel(language: string | null | undefined): string {
  return language === "zh-CN" ? "默认文件夹" : "Default";
}

function sameRoute(left: AppRoute, right: AppRoute): boolean {
  if (left.view !== right.view) return false;
  if (left.view === "tasks" && right.view === "tasks") return left.taskId === right.taskId && left.newTask === right.newTask;
  if (left.view === "settings" && right.view === "settings") return left.section === right.section;
  if (left.view === "library" && right.view === "library") return left.section === right.section;
  if (left.view === "docs" && right.view === "docs") return left.section === right.section;
  return true;
}

function safeLocalStorageGet(key: string, legacyKey?: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    if (value !== null || !legacyKey) return value;
    return window.localStorage.getItem(legacyKey);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures; current in-memory UI state remains authoritative.
  }
}

function preloadAppPagesDuringIdle(language: string | null | undefined): () => void {
  const jobs: Array<() => Promise<void>> = [
    ...preloadablePages.map((page) => () => page.preload()),
    () => import("./docs/index.js").then((module) => module.preloadDocContents(language))
  ];
  return runIdlePreloadQueue(jobs);
}

function runIdlePreloadQueue(jobs: Array<() => Promise<void>>): () => void {
  if (typeof window === "undefined") return () => undefined;
  let cancelled = false;
  let idleHandle: number | null = null;
  let timeoutHandle: number | null = null;
  const clearScheduled = () => {
    if (idleHandle !== null) {
      window.cancelIdleCallback?.(idleHandle);
      idleHandle = null;
    }
    if (timeoutHandle !== null) {
      window.clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  };
  const scheduleNext = () => {
    if (cancelled) return;
    const runNext = () => {
      idleHandle = null;
      timeoutHandle = null;
      if (cancelled) return;
      const job = jobs.shift();
      if (!job) return;
      void job()
        .catch(() => undefined)
        .finally(() => {
          scheduleNext();
        });
    };
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(runNext, { timeout: 2500 });
    } else {
      timeoutHandle = window.setTimeout(runNext, 350);
    }
  };
  scheduleNext();
  return () => {
    cancelled = true;
    clearScheduled();
  };
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

function getPermissionPreset(permissions: Array<{ riskCategory: RiskCategory }>, preferences?: UserPreferences | null): ComposerPermissionMode {
  if (permissions.length === 0 && preferences) {
    if (preferences.permissionMode === "full_access") return "all";
    if (preferences.permissionMode === "read_only") return "read_only";
    if (preferences.permissionMode === "custom") return "custom";
    return "ask";
  }
  const granted = new Set(permissions.map((permission) => permission.riskCategory));
  if (allRiskCategories.every((risk) => granted.has(risk))) return "all";
  if (readOnlyRiskCategories.every((risk) => granted.has(risk)) && allRiskCategories.every((risk) => readOnlyRiskCategories.includes(risk) || !granted.has(risk))) {
    return "read_only";
  }
  if (allRiskCategories.every((risk) => !granted.has(risk))) return "ask";
  return "custom";
}

function formatPermissionPreset(preset: ComposerPermissionMode, language: string): string {
  if (preset === "all") return language === "zh-CN" ? "完全访问" : "Full access";
  if (preset === "custom") return "Custom";
  if (preset === "read_only") return "Read only";
  return "Ask";
}

function targetRisksForPermissionMode(mode: PermissionMode, selectedRisks?: RiskCategory[]): RiskCategory[] {
  if (mode === "read_only") return readOnlyRiskCategories;
  if (mode === "full_access") return allRiskCategories;
  if (mode === "custom") return allRiskCategories.filter((risk) => selectedRisks?.includes(risk));
  return [];
}

function preferencesForPermissionMode(mode: PermissionMode, selectedRisks?: RiskCategory[]): PreferencesPatch {
  if (mode !== "auto_approval") {
    return {
      permissionMode: mode,
      autoApprove: "none",
      autoApproveStrategy: "ask",
      autoApproveRiskCategories: []
    };
  }
  const selected = (selectedRisks?.filter((risk): risk is UserPreferences["autoApproveRiskCategories"][number] =>
    nonDestructiveRiskCategories.includes(risk as UserPreferences["autoApproveRiskCategories"][number])
  ) ?? defaultAutoApprovalRiskCategories);
  const risks = selectedRisks ? selected : defaultAutoApprovalRiskCategories;
  return {
    permissionMode: "auto_approval",
    autoApprove: legacyAutoApproveForRisks(risks),
    autoApproveStrategy: "custom",
    autoApproveRiskCategories: risks
  };
}

function legacyAutoApproveForRisks(risks: UserPreferences["autoApproveRiskCategories"]): UserPreferences["autoApprove"] {
  const selected = new Set(risks);
  if (nonDestructiveRiskCategories.every((risk) => selected.has(risk))) return "all";
  if (defaultAutoApprovalRiskCategories.every((risk) => selected.has(risk)) && selected.size === defaultAutoApprovalRiskCategories.length) return "medium";
  if (readOnlyRiskCategories.every((risk) => selected.has(risk as UserPreferences["autoApproveRiskCategories"][number])) && selected.size === readOnlyRiskCategories.length) return "low";
  return "none";
}
