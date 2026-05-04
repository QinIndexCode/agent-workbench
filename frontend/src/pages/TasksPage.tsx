import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { WebSocketClient, type RealtimeTransportStatus } from '../api/websocket';
import { Button } from '../components/ui/button';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { TaskComposerDialog } from '../components/tasks/TaskComposerDialog';
import { TaskInspectorRail } from '../components/tasks/TaskInspectorRail';
import { TaskThreadComposer } from '../components/tasks/TaskThreadComposer';
import { TaskTimelineView } from '../components/tasks/TaskTimelineView';
import {
  PlusIcon,
  RefreshIcon,
} from '../components/ui/icons';
import { useTaskDetail, useTasks } from '../hooks/useTasks';
import { useAnimatedPresence } from '../hooks/useAnimatedPresence';
import type {
  RuntimeEvent,
  TaskDebugResponse,
  TaskDetail,
} from '../types';

import {
  buildCredibilitySummary,
  buildInspectorSnapshot,
  buildTimeline,
  formatTime,
  getBlockingStripLabel,
  getComposerModel,
  getPendingApprovalEntries,
  getPrimaryStatusSummary,
  getRealtimeStatusLabel,
  getVisibleIssueSummary,
  getWorkspaceGuidanceNotice,
  isTerminalLifecycle,
  mergeInspectorSnapshot,
  requiresArtifactSelection,
  shouldAutoOpenContextRail,
  TaskDetailTabPanel,
  type ApprovalListEntry,
  type ComposerModel,
  type DetailTab,
  type TaskInspectorSnapshot,
} from '../components/tasks/taskPageModel';
export function TasksPage() {
  const {
    tasks,
    reload: reloadTasks,
    applyTaskSnapshot: applyTaskSummarySnapshot,
  } = useTasks({ includeArchived: false });
  const { tasks: allTasks, applyTaskSnapshot: applyAllTaskSummarySnapshot } = useTasks({ includeArchived: true });
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const {
    task: loadedTask,
    events,
    loading: taskLoading,
    error: taskError,
    reload: reloadTask,
    appendEvent,
    applySnapshot,
  } = useTaskDetail(selectedTaskId);
  const [debug, setDebug] = useState<TaskDebugResponse | null>(null);
  const debugCacheRef = useRef<Map<string, TaskDebugResponse>>(new Map());
  const debugRequestSequence = useRef(0);
  const inspectorSnapshotCacheRef = useRef<Map<string, TaskInspectorSnapshot>>(new Map());
  const [detailsOpen, setDetailsOpen] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true));
  const [latchedAutoOpenTaskId, setLatchedAutoOpenTaskId] = useState<string | null>(null);
  const [dismissedAutoOpenTaskId, setDismissedAutoOpenTaskId] = useState<string | null>(null);
  const [shallowVerticalViewport, setShallowVerticalViewport] = useState(() => (typeof window !== 'undefined' ? window.innerHeight < 760 : false));
  const [compactVerticalViewport, setCompactVerticalViewport] = useState(() => (typeof window !== 'undefined' ? window.innerHeight < 640 : false));
  const [ultraCompactVerticalViewport, setUltraCompactVerticalViewport] = useState(() => (typeof window !== 'undefined' ? window.innerHeight < 560 : false));
  const [activeTab, setActiveTab] = useState<DetailTab>('summary');
  const [composerOpen, setComposerOpen] = useState(false);
  const [continueMessage, setContinueMessage] = useState('');
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [latchedComposerModel, setLatchedComposerModel] = useState<ComposerModel | null>(null);
  const [artifactDir, setArtifactDir] = useState('');
  const [customArtifactMode, setCustomArtifactMode] = useState(false);
  const [realtimeStatus, setRealtimeStatus] = useState<RealtimeTransportStatus>({
    connected: false,
    mode: 'reconnecting',
    reason: 'Realtime transport has not connected yet.',
    latestEventId: null,
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedApprovalId, setExpandedApprovalId] = useState<string | null>(null);
  const [taskDeleteRequested, setTaskDeleteRequested] = useState(false);
  const [wideContextViewport, setWideContextViewport] = useState(() => (typeof window !== 'undefined' ? window.innerWidth >= 1024 : true));

  const ws = useMemo(() => new WebSocketClient({
    fetchEvents: (taskId, afterEventId) => api.getTaskEvents(taskId, afterEventId),
  }), []);
  const requestedTaskId = searchParams.get('task');
  const createTaskRequested = searchParams.get('create') === '1';
  const explicitNoSelection = requestedTaskId === 'none';
  const task = loadedTask && selectedTaskId && loadedTask.definition.taskId === selectedTaskId ? loadedTask : null;
  const shouldShowTaskLoadingShell = Boolean(selectedTaskId && !task && !taskError);

  function commitDebugSnapshot(taskId: string, snapshot: TaskDebugResponse) {
    debugCacheRef.current.set(taskId, snapshot);
    setDebug(snapshot);
  }

  useEffect(() => () => ws.disconnect(), [ws]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handleResize = () => {
      setWideContextViewport(window.innerWidth >= 1024);
      setShallowVerticalViewport(window.innerHeight < 760);
      setCompactVerticalViewport(window.innerHeight < 640);
      setUltraCompactVerticalViewport(window.innerHeight < 560);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (explicitNoSelection) {
      if (selectedTaskId !== null) {
        setSelectedTaskId(null);
      }
      return;
    }

    if (requestedTaskId) {
      if (requestedTaskId !== selectedTaskId) {
        setSelectedTaskId(requestedTaskId);
        return;
      }

      const requestedTaskKnown = tasks.some((entry) => entry.taskId === requestedTaskId)
        || allTasks.some((entry) => entry.taskId === requestedTaskId);
      if (!taskLoading && taskError && !requestedTaskKnown && tasks.length > 0) {
        const fallbackTaskId = tasks[0].taskId;
        setSelectedTaskId(fallbackTaskId);
        const nextParams = new URLSearchParams(searchParams);
        nextParams.set('task', fallbackTaskId);
        setSearchParams(nextParams, { replace: true });
      }
      return;
    }

    if (!selectedTaskId && tasks.length > 0) {
      const fallbackTaskId = tasks[0].taskId;
      setSelectedTaskId(fallbackTaskId);
      const nextParams = new URLSearchParams(searchParams);
      nextParams.set('task', fallbackTaskId);
      setSearchParams(nextParams, { replace: true });
    }
  }, [allTasks, explicitNoSelection, requestedTaskId, searchParams, selectedTaskId, setSearchParams, taskError, taskLoading, tasks]);

  useEffect(() => {
    if (createTaskRequested) {
      setComposerOpen(true);
    }
  }, [createTaskRequested]);

  useEffect(() => {
    if (!selectedTaskId) {
      debugRequestSequence.current += 1;
      setDebug(null);
      setTaskDeleteRequested(false);
      return;
    }

    const cachedDebug = debugCacheRef.current.get(selectedTaskId) ?? null;
    setDebug(cachedDebug);
    const currentRequest = debugRequestSequence.current + 1;
    debugRequestSequence.current = currentRequest;

    void api.getTaskDebug(selectedTaskId)
      .then((value) => {
        if (debugRequestSequence.current !== currentRequest) {
          return;
        }
        commitDebugSnapshot(selectedTaskId, value);
        setArtifactDir((current) => {
          const selectedDir = value.executionSummary.selectedArtifactDir ?? '';
          const recommendedDir = value.executionSummary.recommendedArtifactDir ?? '';
          if (selectedDir) {
            return selectedDir;
          }
          if (current.trim()) {
            return current;
          }
          return recommendedDir;
        });
        setCustomArtifactMode((current) => {
          const selectedDir = value.executionSummary.selectedArtifactDir ?? '';
          const recommendedDir = value.executionSummary.recommendedArtifactDir ?? '';
          if (value.executionSummary.artifactPathState === 'applied') {
            return false;
          }
          if (selectedDir && selectedDir !== recommendedDir) {
            return true;
          }
          if (value.executionSummary.artifactPathState === 'unresolved' && !selectedDir) {
            return current;
          }
          return false;
        });
      })
      .catch(() => {
        if (debugRequestSequence.current !== currentRequest) {
          return;
        }
        setDebug((current) => current ?? cachedDebug);
      });
  }, [selectedTaskId, task?.runtime.lifecycleStatus, task?.pendingApprovals?.length, task?.pendingApprovalItems?.length]);

  useEffect(() => {
    if (!task?.canDelete) {
      setTaskDeleteRequested(false);
    }
  }, [task?.canDelete, task?.definition.taskId]);

  useEffect(() => {
    const unsubscribeEvent = ws.onEvent((event) => {
      appendEvent(event);
      if (event.taskId === selectedTaskId) {
        void api.getTaskDebug(event.taskId).then((value) => {
          if (event.taskId === selectedTaskId) {
            commitDebugSnapshot(event.taskId, value);
          }
        }).catch(() => undefined);
      }
      void reloadTasks();
    });
    const unsubscribeSnapshot = ws.onSnapshot((snapshot) => {
      applyTaskSummarySnapshot(snapshot.task);
      applyAllTaskSummarySnapshot(snapshot.task);
      if (snapshot.taskId && snapshot.taskId === selectedTaskId) {
        applySnapshot(snapshot.task);
      }
    });
    const unsubscribeStatus = ws.onStatusChange((status) => setRealtimeStatus(status));
    return () => {
      unsubscribeEvent();
      unsubscribeSnapshot();
      unsubscribeStatus();
    };
  }, [appendEvent, applyAllTaskSummarySnapshot, applySnapshot, applyTaskSummarySnapshot, reloadTasks, selectedTaskId, ws]);

  useEffect(() => {
    if (!selectedTaskId) {
      return;
    }
    ws.subscribe(selectedTaskId);
    return () => ws.unsubscribe(selectedTaskId);
  }, [selectedTaskId, ws]);

  const timeline = buildTimeline(task, events, debug);
  const primarySummary = getPrimaryStatusSummary(task, debug, realtimeStatus);
  const liveComposerModel = getComposerModel(task, debug);
  const keepLatchedComposerModel = Boolean(
    latchedComposerModel
    && latchedComposerModel.requiresMessage
    && (composerFocused || continueMessage.trim().length > 0)
  );
  const composerModel = keepLatchedComposerModel ? latchedComposerModel! : liveComposerModel;
  const hasComposerDraft = continueMessage.trim().length > 0;
  const composerModelChangedWhileEditing = Boolean(
    hasComposerDraft
    && (
      !composerModel.requiresMessage
      || (
        keepLatchedComposerModel
        && (
          liveComposerModel.mode !== latchedComposerModel!.mode
          || liveComposerModel.submitKind !== latchedComposerModel!.submitKind
          || liveComposerModel.buttonLabel !== latchedComposerModel!.buttonLabel
          || liveComposerModel.description !== latchedComposerModel!.description
        )
      )
    )
  );
  const workspaceGuidance = getWorkspaceGuidanceNotice(debug, task);
  const autoOpenContext = shouldAutoOpenContextRail(task, debug);
  const effectiveDetailsOpen = Boolean(
    detailsOpen
    || (
      wideContextViewport
      && latchedAutoOpenTaskId
      && selectedTaskId
      && latchedAutoOpenTaskId === selectedTaskId
      && dismissedAutoOpenTaskId !== selectedTaskId
    )
  );
  const contextRailPresence = useAnimatedPresence(effectiveDetailsOpen, 160);
  const composerPresence = useAnimatedPresence(composerOpen, 160);
  const detailsToggleLabel = effectiveDetailsOpen ? 'Hide details' : 'Show details';

  useEffect(() => {
    setCustomArtifactMode(false);
    setContinueMessage('');
    setComposerFocused(false);
    setLatchedComposerModel(null);
  }, [selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId || (!composerFocused && continueMessage.trim().length === 0)) {
      setLatchedComposerModel(null);
    }
  }, [composerFocused, continueMessage, selectedTaskId]);

  useEffect(() => {
    if (!selectedTaskId) {
      setDismissedAutoOpenTaskId(null);
      setLatchedAutoOpenTaskId(null);
      setDetailsOpen(false);
      return;
    }
    if (wideContextViewport) {
      setDetailsOpen(true);
      setDismissedAutoOpenTaskId(null);
    }
  }, [selectedTaskId, wideContextViewport]);

  useEffect(() => {
    if (!selectedTaskId) {
      setLatchedAutoOpenTaskId(null);
      return;
    }
    if (dismissedAutoOpenTaskId === selectedTaskId) {
      setLatchedAutoOpenTaskId((current) => (current === selectedTaskId ? null : current));
      return;
    }
    if (autoOpenContext) {
      setLatchedAutoOpenTaskId(selectedTaskId);
      return;
    }
    setLatchedAutoOpenTaskId((current) => (current === selectedTaskId ? null : current));
  }, [autoOpenContext, dismissedAutoOpenTaskId, selectedTaskId]);

  async function refreshSelectedTask() {
    await Promise.allSettled([
      reloadTasks(),
      reloadTask(),
      selectedTaskId ? api.getTaskDebug(selectedTaskId).then((value) => commitDebugSnapshot(selectedTaskId, value)) : Promise.resolve(),
    ]);
  }

  async function runAction(label: string, action: () => Promise<unknown>) {
    try {
      setBusyAction(label);
      setActionError(null);
      await action();
      await refreshSelectedTask();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Task action failed.');
    } finally {
      setBusyAction(null);
    }
  }

  async function resolveApproval(approval: ApprovalListEntry, status: 'APPROVED' | 'APPROVED_ONCE' | 'REJECTED') {
    await runAction(status, async () => {
      const metadata = status === 'APPROVED_ONCE'
        ? { grantScope: 'single_invocation' }
        : status === 'APPROVED'
          ? {
            grantScope: 'task_risk_category',
            riskCategory: approval.riskCategory ?? undefined,
          }
          : undefined;
      await api.resolveApproval(
        selectedTaskId!,
        approval.invocationId,
        status === 'APPROVED_ONCE' ? 'APPROVED' : status,
        undefined,
        metadata,
      );
    });
  }

  async function submitContinue() {
    await runAction('continue', async () => {
      if (task?.runtime.lifecycleStatus === 'RUNNING') {
        await api.sendGuidance(selectedTaskId!, continueMessage, {
          reason: 'operator guidance during running task',
          metadata: { productRuntime: true }
        });
      } else {
        await api.continueTask(selectedTaskId!, continueMessage || undefined, { autoRun: true });
      }
      setContinueMessage('');
      setComposerFocused(false);
      setLatchedComposerModel(null);
      setComposerExpanded(false);
    });
  }

  async function triggerComposerPrimaryAction() {
    if (!selectedTaskId || busyAction !== null) {
      return;
    }
    if (continueMessage.trim().length > 0) {
      await submitContinue();
      return;
    }
    if (composerModel.disabled) {
      return;
    }

    if (composerModel.submitKind === 'continue') {
      await submitContinue();
      return;
    }

    if (composerModel.submitKind === 'start') {
      await runAction('start', async () => {
        await api.startTask(selectedTaskId, undefined, { autoRun: true });
      });
      return;
    }

    if (composerModel.submitKind === 'resume') {
      await runAction('resume', async () => {
        await api.resumeTask(selectedTaskId, undefined, { autoRun: true });
      });
      return;
    }

  }

  async function applyArtifacts(destinationDir?: string) {
    await runAction('apply', async () => {
      await api.applyArtifacts(selectedTaskId!, destinationDir);
      setCustomArtifactMode(false);
    });
  }

  async function useRecommendedArtifactPath() {
    await applyArtifacts();
  }

  function openCustomArtifactPath() {
    const recommendedDir = debug?.executionSummary.recommendedArtifactDir ?? '';
    setArtifactDir((current) => (current.trim() === recommendedDir ? '' : current));
    setCustomArtifactMode(true);
    setDismissedAutoOpenTaskId(null);
    setDetailsOpen(true);
  }

  async function applyCustomArtifactPath() {
    await applyArtifacts(artifactDir.trim() || undefined);
  }

  async function archiveSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    if (!task.canArchive) {
      setActionError('Only terminal tasks can be archived.');
      return;
    }
    await runAction('archive', async () => {
      await api.archiveTask(selectedTaskId);
    });
  }

  async function unarchiveSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    await runAction('unarchive', async () => {
      await api.unarchiveTask(selectedTaskId);
    });
  }

  function requestDeleteSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    if (!task.canDelete) {
      setActionError('Only terminal tasks can be deleted permanently.');
      return;
    }
    setTaskDeleteRequested(true);
  }

  async function deleteSelectedTask() {
    if (!task || !selectedTaskId) {
      return;
    }
    const previousTaskId = selectedTaskId;
    const previousParams = new URLSearchParams(searchParams);
    try {
      setBusyAction('delete');
      setActionError(null);
      setTaskDeleteRequested(false);
      const pendingParams = new URLSearchParams(searchParams);
      pendingParams.set('task', 'none');
      setSelectedTaskId(null);
      setSearchParams(pendingParams, { replace: true });
      setDebug(null);
      await api.deleteTask(selectedTaskId);
      const nextTasks = await api.getTasks(false);
      setContinueMessage('');
      setComposerFocused(false);
      setLatchedComposerModel(null);
      setComposerExpanded(false);
      const nextParams = new URLSearchParams(searchParams);
      if (nextTasks.length > 0) {
        setSelectedTaskId(nextTasks[0].taskId);
        nextParams.set('task', nextTasks[0].taskId);
      } else {
        setSelectedTaskId(null);
        nextParams.set('task', 'none');
      }
      setSearchParams(nextParams, { replace: true });
      await reloadTasks();
    } catch (error) {
      setSelectedTaskId(previousTaskId);
      setSearchParams(previousParams, { replace: true });
      setActionError(error instanceof Error ? error.message : 'Task action failed.');
    } finally {
      setBusyAction(null);
    }
  }

  function selectTask(taskId: string | null) {
    setSelectedTaskId(taskId);
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('task', taskId ?? 'none');
    nextParams.delete('create');
    setSearchParams(nextParams, { replace: true });
  }

  function openTaskComposer() {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('create', '1');
    setSearchParams(nextParams, { replace: true });
    setComposerOpen(true);
  }

  function closeTaskComposer() {
    setComposerOpen(false);
    if (!createTaskRequested) {
      return;
    }
    const nextParams = new URLSearchParams(searchParams);
    nextParams.delete('create');
    setSearchParams(nextParams, { replace: true });
  }

  const showRefresh = Boolean(selectedTaskId);
  const reducedSummaryViewport = shallowVerticalViewport || compactVerticalViewport;
  const showCollapsedFollowUp = false;
  const showFooterActionRow = Boolean(
    showRefresh
    || task?.isArchived
    || task?.canArchive
    || task?.canDelete
  );
  const timelineBottomPaddingClass = showFooterActionRow ? 'pb-40 sm:pb-48' : 'pb-28 sm:pb-32';
  const pendingApprovalEntries = getPendingApprovalEntries(task);
  const primaryApproval = pendingApprovalEntries[0] ?? null;
  const primaryApprovalArgumentSummary = primaryApproval?.argumentsSummary ?? null;
  const artifactSelectionRequired = requiresArtifactSelection(task);
  const visibleIssueSummary = getVisibleIssueSummary(task, debug);
  const hasRecoveryBlocker = Boolean(
    task
    && (
      task.runtime.lifecycleStatus === 'FAILED'
      || task.runtime.lifecycleStatus === 'CANCELLED'
      || task.primaryAction.kind === 'send_guidance'
    )
    && (
      task.diagnostics.lastError
      || debug?.executionSummary.recovery.recoveryReason
      || visibleIssueSummary
    )
  );
  const hasRuntimeBlocker = Boolean(
    task
    && !isTerminalLifecycle(task.runtime.lifecycleStatus)
    && task.primaryAction.kind === 'wait'
    && visibleIssueSummary
  );
  const shouldShowStatusStrip = Boolean(
    task
    && (
      Boolean(task.delegationSummary.activeChildTask)
      || hasRecoveryBlocker
      || hasRuntimeBlocker
    )
  );
  const recommendedArtifactDir = artifactSelectionRequired
    ? (
      task?.primaryAction.kind === 'use_recommended_path'
        ? task.primaryAction.destinationDir
        : debug?.executionSummary.recommendedArtifactDir ?? null
      )
      : null;
  const blockingStripLabel = getBlockingStripLabel(task, debug);
  const importantContextCards = (() => {
    if (!task) {
      return [];
    }
    const cards: Array<{ label: string; title: string; detail: string }> = [];
    if (primaryApproval) {
      cards.push({
        label: 'Approval summary',
        title: primaryApproval.toolName,
        detail: primaryApproval.argumentsSummary ?? 'An operator decision is required before the thread can continue.',
      });
    }
    if (task.delegationSummary.activeChildTask) {
      cards.push({
        label: 'Delegation',
        title: task.delegationSummary.activeChildTask.title || 'Delegated child task active',
        detail: task.delegationSummary.activeChildTask.goal || task.nextActionSummary.reason || 'Wait for the bounded child task to finish.',
      });
    }
    if (hasRecoveryBlocker) {
      cards.push({
        label: 'Recovery',
        title: task.primaryAction.label || task.statusSummary.label,
        detail: task.diagnostics.lastError || debug?.executionSummary.recovery.recoveryReason || visibleIssueSummary || task.statusSummary.detail || 'Review the last failure before continuing.',
      });
    }
    if (hasRuntimeBlocker) {
      cards.push({
        label: 'Runtime blocker',
        title: task.statusSummary.label,
        detail: visibleIssueSummary ?? 'The runtime is waiting on a blocker before it can continue.',
      });
    }
    return cards;
  })();
  const cachedInspectorSnapshot = selectedTaskId
    ? inspectorSnapshotCacheRef.current.get(selectedTaskId) ?? null
    : null;
  const inspectorSnapshotCandidate = task ? buildInspectorSnapshot({
    task,
    debug,
    importantCards: importantContextCards,
    pendingApprovalEntries,
    artifactSelectionRequired,
  }) : null;
  const activeInspectorSnapshot = task
    ? mergeInspectorSnapshot(inspectorSnapshotCandidate, cachedInspectorSnapshot)
    : cachedInspectorSnapshot;
  const approvalEntriesForInspector = activeInspectorSnapshot?.pendingApprovalEntries ?? pendingApprovalEntries;
  const artifactContextForInspector = activeInspectorSnapshot?.artifactContext ?? null;
  const inspectorLoading = Boolean(selectedTaskId && !activeInspectorSnapshot && (taskLoading || (!task && !taskError)));
  const showHeaderFollowUpAction = ultraCompactVerticalViewport && task?.runtime.lifecycleStatus === 'COMPLETED' && showCollapsedFollowUp;
  const showHeaderLifecycleActions = ultraCompactVerticalViewport && Boolean(task?.isArchived || task?.canArchive || task?.canDelete);
  const hasCompactHeaderActions = Boolean(
    primaryApproval
    || artifactSelectionRequired
    || showHeaderFollowUpAction
    || showHeaderLifecycleActions
  );

  useEffect(() => {
    if (pendingApprovalEntries.length === 0) {
      setExpandedApprovalId(null);
      return;
    }
    if (!expandedApprovalId || !pendingApprovalEntries.some((approval) => approval.invocationId === expandedApprovalId)) {
      setExpandedApprovalId(pendingApprovalEntries[0]?.invocationId ?? null);
    }
  }, [expandedApprovalId, pendingApprovalEntries]);

  useEffect(() => {
    if (!selectedTaskId) {
      inspectorSnapshotCacheRef.current.clear();
      return;
    }
    const mergedSnapshot = mergeInspectorSnapshot(
      inspectorSnapshotCandidate,
      inspectorSnapshotCacheRef.current.get(selectedTaskId) ?? null
    );
    if (mergedSnapshot) {
      inspectorSnapshotCacheRef.current.set(selectedTaskId, mergedSnapshot);
    }
  }, [inspectorSnapshotCandidate, selectedTaskId]);

  const shouldShowCustomArtifactInput = Boolean(
    task
    && artifactSelectionRequired
    && (customArtifactMode || task.primaryAction.kind === 'choose_custom_path' || !recommendedArtifactDir)
  );
  const composerProviderLabel = [debug?.executionSummary.providerSummary.providerId, debug?.executionSummary.providerSummary.modelId]
    .filter(Boolean)
    .join(' / ') || task?.definition.preferredProviderId || 'No provider selected';
  const composerDestinationLabel = debug?.executionSummary.selectedArtifactDir
    ?? debug?.executionSummary.recommendedArtifactDir
    ?? task?.primaryAction.destinationDir
    ?? 'workspace';
  const executionTruth = debug?.executionSummary ?? null;
  const credibilitySummary = buildCredibilitySummary(task, executionTruth);
  const confidenceScore = !task || !executionTruth
    ? 24
    : credibilitySummary.gaps.length === 0 && task.runtime.lifecycleStatus === 'COMPLETED'
      ? 92
      : Math.max(36, 78 - credibilitySummary.gaps.length * 14);
  const acceptanceVerdict = executionTruth?.acceptance?.deterministic?.contract?.verdict ?? 'pending';
  const issuePlaneLabel = executionTruth?.issuePlane ?? 'none';
  const issueSummaryLabel = executionTruth?.issueSummary ?? task?.diagnostics.lastError ?? 'No blocking issues detected.';
  const suggestedActionLabel = executionTruth?.suggestedAction?.label ?? task?.primaryAction.label ?? 'Review task truth';
  const suggestedActionReason = executionTruth?.suggestedAction?.reason ?? task?.nextActionSummary.reason ?? task?.primaryAction.description ?? 'Select a thread or create a task.';
  const artifactPathStateLabel = executionTruth?.artifactPathState ?? 'sandbox_only';
  const deliveredArtifactCount = executionTruth?.artifactDestinationPaths.length ?? 0;
  const createdArtifactCount = executionTruth?.artifactPaths.length ?? 0;
  const workingDirectoryTruth = executionTruth?.workingDirectory ?? null;
  const workingDirectoryLabel = workingDirectoryTruth?.workingDirectory ?? 'not selected';
  const workingDirectoryStatusLabel = workingDirectoryTruth?.status ?? 'missing';
  const providerReadinessStatus = executionTruth?.providerSummary.recentStatus
    ?? (composerProviderLabel === 'No provider selected' ? 'not_selected' : 'ready');
  const providerNeedsAttention = composerProviderLabel === 'No provider selected' || providerReadinessStatus !== 'ready';
  const providerReadinessLabel = String(providerReadinessStatus).replaceAll('_', ' ');
  const showSuggestedActionCard = Boolean(
    issuePlaneLabel !== 'none'
    || (credibilitySummary.gaps.length > 0 && !artifactSelectionRequired && !primaryApproval)
  );
  const composerContextChips = [
    providerNeedsAttention ? `Provider: ${composerProviderLabel}` : null,
    artifactSelectionRequired ? `Destination: ${composerDestinationLabel}` : null,
    workingDirectoryTruth?.requiresSelection ? 'Workspace: needs directory' : null,
    issuePlaneLabel !== 'none' && !artifactSelectionRequired && !primaryApproval ? `Plane: ${issuePlaneLabel}` : null,
    credibilitySummary.gaps.length > 0 && !artifactSelectionRequired ? `${credibilitySummary.gaps.length} evidence gap${credibilitySummary.gaps.length === 1 ? '' : 's'}` : null,
  ].filter((chip): chip is string => Boolean(chip));

  useEffect(() => {
    setComposerExpanded(false);
  }, [selectedTaskId, composerModel.mode]);

  function toggleContextPanel() {
    if (!task || !selectedTaskId) {
      setDetailsOpen((value) => !value);
      return;
    }
    if (effectiveDetailsOpen) {
      setDetailsOpen(false);
      if (autoOpenContext && wideContextViewport) {
        setDismissedAutoOpenTaskId(selectedTaskId);
      }
      return;
    }
    setDismissedAutoOpenTaskId(null);
    setDetailsOpen(true);
  }

  function focusThreadComposer() {
    setComposerExpanded(true);
    window.setTimeout(() => {
      const node = document.querySelector('[data-testid="task-continue-message"]');
      if (node instanceof HTMLTextAreaElement) {
        node.focus();
      }
    }, 0);
  }

  return (
    <div className="relative flex h-full max-h-full min-h-0 min-w-0 overflow-hidden bg-[radial-gradient(circle_at_30%_0%,rgba(59,130,246,0.12),transparent_28rem),radial-gradient(circle_at_72%_12%,rgba(139,92,246,0.10),transparent_30rem),linear-gradient(180deg,#0b0b0d_0%,#080809_100%)]" data-testid="tasks-page">
      <main className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden" data-testid="tasks-agent-shell">
        <section className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="task-detail-pane">
          <div
            className={`sticky top-0 z-40 border-b border-border-subtle bg-surface/92 backdrop-blur-sm flex-shrink-0 ${
              ultraCompactVerticalViewport
                ? 'px-4 py-0.5 sm:px-5 sm:py-0.5'
                : reducedSummaryViewport
                  ? 'px-4 py-1 sm:px-5 sm:py-1'
                : compactVerticalViewport
                  ? 'px-4 py-1 sm:px-5 sm:py-1'
                  : 'px-4 py-2.5 sm:px-5 sm:py-2.5'
            }`}
            data-testid="tasks-operator-summary"
          >
            <div className={`flex flex-wrap items-center justify-between ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-3'}`}>
              <div className="min-w-0">
                <p className={`${ultraCompactVerticalViewport ? 'text-[10px] tracking-[0.24em]' : 'text-[11px] tracking-[0.28em]'} uppercase text-text-muted font-medium`}>Current thread</p>
                <h2 className={`mt-0.5 font-semibold leading-tight text-text-primary ${
                  ultraCompactVerticalViewport
                    ? 'line-clamp-1 text-[0.76rem] sm:text-[0.82rem]'
                    : reducedSummaryViewport
                      ? 'line-clamp-1 text-[0.95rem] sm:text-[1.02rem]'
                    : compactVerticalViewport
                      ? 'text-[0.92rem] sm:text-[0.96rem]'
                      : 'text-[1.08rem] sm:text-[1.22rem]'
                }`}>
                  {task?.definition.title ?? 'Select a thread'}
                </h2>
                {!reducedSummaryViewport && task ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-5 text-text-muted">
                    <span>Task ID: {task.definition.taskId.slice(0, 12)}</span>
                    <span>Updated {formatTime(task.runtime.updatedAt)}</span>
                    <span>{primarySummary.providerLabel ?? 'Provider pending'}</span>
                  </div>
                ) : !reducedSummaryViewport && !effectiveDetailsOpen ? (
                  <p className="mt-1 max-w-3xl line-clamp-2 text-sm leading-5 text-text-secondary lg:line-clamp-1">
                    Choose a thread from the global task list or create a new one to start working.
                  </p>
                ) : null}
              </div>
              <div className={`flex flex-wrap items-center ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-2'}`}>
                <button
                  type="button"
                  onClick={toggleContextPanel}
                  data-testid="task-context-toggle"
                  aria-expanded={effectiveDetailsOpen}
                  title={detailsToggleLabel}
                  className={`inline-flex min-w-[5.75rem] shrink-0 items-center justify-center rounded-md border border-border-subtle bg-surface px-3 text-xs leading-none text-text-secondary transition duration-fast hover:bg-surface-hover hover:text-text-primary ${
                    ultraCompactVerticalViewport ? 'h-7' : 'h-9'
                  } ${
                    effectiveDetailsOpen
                      ? 'border-accent bg-accent/15 text-accent'
                      : ''
                  }`}
                >
                  {detailsToggleLabel}
                </button>
              </div>
            </div>
            {shouldShowStatusStrip ? (
              <div className={`border border-border-subtle bg-surface/50 ${
                ultraCompactVerticalViewport
                  ? 'mt-1 rounded-lg px-2 py-0.5 sm:px-2.5 sm:py-0.5'
                  : reducedSummaryViewport
                    ? 'mt-1 rounded-lg px-3 py-1 sm:px-3.5 sm:py-1'
                  : compactVerticalViewport
                    ? 'mt-1 px-3 py-1 sm:px-4'
                    : 'mt-2 px-3 py-2 sm:px-4'
              }`} data-testid="task-status-strip">
              {reducedSummaryViewport ? (
                <div className={`flex items-center ${ultraCompactVerticalViewport ? 'gap-1.5' : 'gap-3'}`}>
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-[0.24em] text-text-muted">{blockingStripLabel}</p>
                    <p className={`${ultraCompactVerticalViewport ? 'text-[11px]' : 'text-[12px]'} font-medium leading-4 text-text-primary`}>
                      {primarySummary.blocker}
                    </p>
                    {!ultraCompactVerticalViewport ? (
                      <p className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-text-secondary">{primarySummary.nextAction}</p>
                    ) : null}
                  </div>
                </div>
              ) : (
                <div className="grid gap-2 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:items-center">
                  <div className="min-w-0">
                    <p className="mb-1 text-[10px] uppercase tracking-[0.24em] text-text-muted">{blockingStripLabel}</p>
                    <p className="text-xs leading-5 text-text-secondary sm:line-clamp-2 sm:text-sm">{primarySummary.blocker}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="line-clamp-2 text-sm text-text-primary">{primarySummary.nextAction}</p>
                  </div>
                </div>
              )}
              </div>
            ) : null}
            {task && (artifactSelectionRequired || (ultraCompactVerticalViewport && hasCompactHeaderActions)) ? (
              <div className={`flex flex-wrap items-center gap-2 ${ultraCompactVerticalViewport ? 'mt-1' : 'mt-2'}`}>
                {primaryApproval ? (
                  <>
                    <Button
                      data-testid="task-primary-approve"
                      size="sm"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void resolveApproval(primaryApproval, 'APPROVED')}
                    >
                      Approve
                    </Button>
                    <Button
                      data-testid="task-primary-reject"
                      size="sm"
                      variant="secondary"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={() => void resolveApproval(primaryApproval, 'REJECTED')}
                    >
                      Reject
                    </Button>
                  </>
                ) : null}
                {artifactSelectionRequired ? (
                  <>
                    {recommendedArtifactDir ? (
                      <Button
                        data-testid="task-action-use-recommended-path"
                        size="sm"
                        disabled={!selectedTaskId || busyAction !== null}
                        onClick={() => void useRecommendedArtifactPath()}
                      >
                        Use recommended path
                      </Button>
                    ) : null}
                    <Button
                      data-testid="task-action-choose-custom-path"
                      size="sm"
                      variant={recommendedArtifactDir ? 'secondary' : undefined}
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={openCustomArtifactPath}
                    >
                      Choose custom path
                    </Button>
                  </>
                ) : null}
                {showHeaderFollowUpAction ? (
                  <Button
                    data-testid="task-compact-action-open-follow-up"
                    size="sm"
                    disabled={!selectedTaskId || busyAction !== null}
                    onClick={() => setComposerExpanded(true)}
                  >
                    Continue
                  </Button>
                ) : null}
                {showHeaderLifecycleActions && task.isArchived ? (
                  <Button
                    data-testid="task-compact-action-unarchive"
                    size="sm"
                    variant="secondary"
                    disabled={!selectedTaskId || busyAction !== null}
                    onClick={() => void unarchiveSelectedTask()}
                  >
                    Restore
                  </Button>
                ) : showHeaderLifecycleActions && task.canArchive ? (
                  <Button
                    data-testid="task-compact-action-archive"
                    size="sm"
                    variant="secondary"
                    disabled={!selectedTaskId || busyAction !== null}
                    onClick={() => void archiveSelectedTask()}
                  >
                    Archive
                  </Button>
                ) : null}
                {showHeaderLifecycleActions && task.canDelete ? (
                    <Button
                      data-testid="task-compact-action-delete"
                      size="sm"
                      variant="ghost"
                      disabled={!selectedTaskId || busyAction !== null}
                      onClick={requestDeleteSelectedTask}
                    >
                      Delete
                    </Button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className={`flex-1 min-h-0 overflow-y-auto px-4 py-4 scrollbar-thin sm:px-5 ${timelineBottomPaddingClass}`} data-testid="task-timeline-scroll">
            <TaskTimelineView
              task={task}
              debug={debug}
              events={events}
              timeline={timeline}
              taskError={taskError}
              taskLoading={taskLoading}
              selectedTaskId={selectedTaskId}
              busyAction={busyAction}
              shouldShowTaskLoadingShell={shouldShowTaskLoadingShell}
              primaryApproval={primaryApproval}
              primaryApprovalArgumentSummary={primaryApprovalArgumentSummary}
              onResolveApproval={resolveApproval}
            />
          </div>

          <div
            className={`sticky bottom-0 z-10 border-t border-border-subtle bg-surface/95 backdrop-blur-sm flex-shrink-0 ${
              ultraCompactVerticalViewport
                ? 'px-4 py-0.5 sm:px-5 sm:py-0.5'
                : compactVerticalViewport
                  ? 'px-4 py-1 sm:px-5 sm:py-1'
                  : 'px-4 py-2.5 sm:px-5'
            }`}
            data-testid="task-bottom-action-bar"
          >
            {actionError && <p className="mb-3 text-sm text-error">{actionError}</p>}
            {showFooterActionRow ? (
              <div className={`flex flex-wrap items-center justify-between ${
                ultraCompactVerticalViewport
                  ? 'mb-0.5 gap-1'
                  : compactVerticalViewport
                    ? 'mb-1 gap-1'
                    : 'mb-2 gap-2'
              }`}>
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                  {task?.isArchived ? <Button data-testid="task-action-unarchive" size="sm" variant="secondary" disabled={!selectedTaskId || busyAction !== null} onClick={() => void unarchiveSelectedTask()}>Unarchive</Button> : null}
                  {!task?.isArchived && task?.canArchive ? <Button data-testid="task-action-archive" size="sm" variant="secondary" disabled={!selectedTaskId || busyAction !== null} onClick={() => void archiveSelectedTask()}>Archive</Button> : null}
                  {task?.canDelete ? <Button data-testid="task-action-delete" size="sm" variant="ghost" disabled={!selectedTaskId || busyAction !== null} onClick={requestDeleteSelectedTask}>Delete</Button> : null}
                  {showRefresh ? (
                    <Button
                      data-testid="task-action-refresh"
                      size="sm"
                      variant="ghost"
                      disabled={!selectedTaskId}
                      onClick={() => void refreshSelectedTask()}
                    >
                      <RefreshIcon className="h-4 w-4" />
                      Refresh
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}
            <TaskThreadComposer
              autoOpenContext={autoOpenContext}
              busyAction={busyAction}
              compactVerticalViewport={compactVerticalViewport}
              composerExpanded={composerExpanded}
              composerModel={composerModel}
              contextChips={composerContextChips}
              continueMessage={continueMessage}
              effectiveDetailsOpen={effectiveDetailsOpen}
              hasComposerDraft={hasComposerDraft}
              liveComposerModel={liveComposerModel}
              selectedTaskId={selectedTaskId}
              showCollapsedFollowUp={showCollapsedFollowUp}
              ultraCompactVerticalViewport={ultraCompactVerticalViewport}
              composerModelChangedWhileEditing={composerModelChangedWhileEditing}
              taskLifecycleStatus={task?.runtime.lifecycleStatus ?? null}
              onBlurMessage={() => setComposerFocused(false)}
              onChangeMessage={(value) => {
                if (composerModel.requiresMessage) {
                  setLatchedComposerModel((current) => current ?? composerModel);
                }
                setContinueMessage(value);
              }}
              onCollapseFollowUp={() => {
                setComposerExpanded(false);
                setContinueMessage('');
                setComposerFocused(false);
                setLatchedComposerModel(null);
              }}
              onExpandFollowUp={() => setComposerExpanded(true)}
              onFocusMessage={() => {
                setComposerFocused(true);
                if (composerModel.requiresMessage) {
                  setLatchedComposerModel((current) => current ?? composerModel);
                }
              }}
              onOpenContext={() => {
                setDismissedAutoOpenTaskId(null);
                setDetailsOpen(true);
              }}
              onPrimaryAction={() => void triggerComposerPrimaryAction()}
              onPauseTask={() => void runAction('pause', async () => { await api.pauseTask(selectedTaskId!); })}
            />
          </div>
        </section>

        <TaskInspectorRail
          acceptanceVerdict={acceptanceVerdict}
          activeInspectorSnapshot={activeInspectorSnapshot}
          activeTab={activeTab}
          approvalEntriesForInspector={approvalEntriesForInspector}
          artifactContextForInspector={artifactContextForInspector}
          artifactDir={artifactDir}
          artifactPathStateLabel={artifactPathStateLabel}
          busyAction={busyAction}
          composerDestinationLabel={composerDestinationLabel}
          composerProviderLabel={composerProviderLabel}
          confidenceScore={confidenceScore}
          contextRailPresence={contextRailPresence}
          createdArtifactCount={createdArtifactCount}
          credibilitySummary={credibilitySummary}
          debug={debug}
          deliveredArtifactCount={deliveredArtifactCount}
          detailsToggleLabel={detailsToggleLabel}
          effectiveDetailsOpen={effectiveDetailsOpen}
          events={events}
          expandedApprovalId={expandedApprovalId}
          inspectorLoading={inspectorLoading}
          issuePlaneLabel={issuePlaneLabel}
          issueSummaryLabel={issueSummaryLabel}
          pendingApprovalEntries={pendingApprovalEntries}
          providerNeedsAttention={providerNeedsAttention}
          providerReadinessLabel={providerReadinessLabel}
          recommendedArtifactDir={recommendedArtifactDir}
          selectedTaskId={selectedTaskId}
          shouldShowCustomArtifactInput={shouldShowCustomArtifactInput}
          showSuggestedActionCard={showSuggestedActionCard}
          suggestedActionLabel={suggestedActionLabel}
          suggestedActionReason={suggestedActionReason}
          task={task}
          workingDirectoryLabel={workingDirectoryLabel}
          workingDirectoryStatusLabel={workingDirectoryStatusLabel}
          workingDirectoryTruth={workingDirectoryTruth}
          workspaceGuidance={workspaceGuidance}
          onApplyCustomArtifactPath={() => void applyCustomArtifactPath()}
          onArtifactDirChange={setArtifactDir}
          onOpenCustomArtifactPath={openCustomArtifactPath}
          onResolveApproval={(approval, status) => void resolveApproval(approval, status)}
          onTabChange={setActiveTab}
          onToggleApproval={(approvalId) => setExpandedApprovalId((current) => (current === approvalId ? null : approvalId))}
          onToggleContextPanel={toggleContextPanel}
          onUseRecommendedArtifactPath={() => void useRecommendedArtifactPath()}
        />
      </main>

      <ConfirmDialog
        open={taskDeleteRequested && Boolean(task?.canDelete && selectedTaskId)}
        title={task ? `Delete thread "${task.definition.title}" permanently?` : 'Delete thread permanently?'}
        description="Deleting removes the thread from the workspace. This action cannot be undone."
        details={[
          'Only terminal tasks can be deleted.',
          'Artifacts already delivered remain on disk, but the thread record and workspace state are removed.',
        ]}
        confirmLabel="Delete permanently"
        cancelLabel="Keep thread"
        tone="danger"
        busy={busyAction === 'delete'}
        testId="task-delete-dialog"
        confirmTestId="task-delete-confirm"
        cancelTestId="task-delete-cancel"
        onCancel={() => setTaskDeleteRequested(false)}
        onConfirm={() => void deleteSelectedTask()}
      />

      {composerPresence.mounted ? (
        <TaskComposerDialog
          state={composerPresence.state}
          onClose={closeTaskComposer}
          onCreated={(taskId) => {
            closeTaskComposer();
            selectTask(taskId);
            void Promise.allSettled([
              reloadTasks(),
              api.getTaskDebug(taskId).then((value) => commitDebugSnapshot(taskId, value)),
            ]);
          }}
        />
      ) : null}
    </div>
  );
}
