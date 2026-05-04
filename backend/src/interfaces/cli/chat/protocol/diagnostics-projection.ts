import { deriveTaskProgressSummary, summarizeTask, TaskDebugResponse, TaskQueryApiResponse } from '../../shared';
import { CliInspectorSnapshot, WorkspaceChatSessionState } from './chat-envelopes';

export function projectTaskSummary(task: TaskQueryApiResponse, debug: TaskDebugResponse | null = null): Record<string, unknown> {
  return summarizeTask(task, debug);
}

export function projectTaskDiagnostics(task: TaskQueryApiResponse, debug: TaskDebugResponse | null = null): Record<string, unknown> {
  const summary = deriveTaskProgressSummary(task, debug);
  return {
    taskId: task.definition.taskId,
    lifecycleStatus: task.runtime.lifecycleStatus,
    currentUnitId: task.runtime.currentUnitId,
    primaryAction: task.primaryAction,
    nextActionSummary: task.nextActionSummary,
    visibleToolActivities: task.visibleToolActivities ?? [],
    lastError: task.diagnostics.lastError,
    issuePlane: debug?.executionSummary?.issuePlane ?? null,
    issueCategory: debug?.executionSummary?.issueCategory ?? null,
    issueSummary: debug?.executionSummary?.issueSummary ?? null,
    suggestedAction: debug?.executionSummary?.suggestedAction ?? null,
    workingDirectory: debug?.executionSummary?.workingDirectory ?? null,
    providerSummary: debug?.executionSummary?.providerSummary ?? null,
    summary,
    planner: task.runtime.planner,
    activeStage: task.runtime.activeStage,
    pendingToolBatches: task.runtime.pendingToolBatches,
    consolidationState: task.runtime.consolidationState,
    compressionPolicy: task.runtime.compressionPolicy ?? null,
    compressionDowngraded: task.runtime.compressionDowngraded ?? false,
    batchAdmissionDecisions: task.runtime.batchAdmissionDecisions ?? [],
    unsafeBatchRejectedCount: task.runtime.unsafeBatchRejectedCount ?? 0,
    plannerFallbackRate: task.runtime.plannerFallbackRate ?? 0,
    guardrails: task.runtime.guardrails ?? null,
    promptSectionAttribution: task.runtime.promptSectionAttribution ?? null,
    stageMemorySummary: task.runtime.stageMemorySummary ?? null,
    capabilitySelectionSummary: task.runtime.capabilitySelectionSummary ?? null,
    retrievalSelectionSummary: task.runtime.retrievalSelectionSummary ?? null,
    contractDiagnostics: task.runtime.contractDiagnostics,
    providerFailure: task.diagnostics.providerFailure,
    executionSummary: debug?.executionSummary ?? null,
    acceptance: debug?.executionSummary?.acceptance ?? null,
    experienceSummary: debug?.executionSummary?.experienceSummary ?? null
  };
}

export function projectPendingApprovals(task: TaskQueryApiResponse): Array<Record<string, unknown>> {
  if (Array.isArray(task.pendingApprovalItems) && task.pendingApprovalItems.length > 0) {
    return task.pendingApprovalItems.map((approval) => ({
      invocationId: approval.invocationId,
      toolId: approval.toolId,
      toolName: approval.toolName,
      status: approval.status,
      requestedAt: approval.requestedAt,
      argumentsSummary: approval.argumentsSummary,
      availableActions: approval.availableActions,
    }));
  }
  return task.pendingApprovals.map((approval) => {
    const matchingInvocation = task.toolInvocations.find((invocation) => invocation.invocationId === approval.invocationId) ?? null;
    return {
      invocationId: approval.invocationId,
      toolId: approval.toolId,
      toolName: approval.toolId,
      unitId: approval.unitId,
      status: approval.status,
      createdAt: approval.createdAt,
      arguments:
        (matchingInvocation?.arguments && typeof matchingInvocation.arguments === 'object' && !Array.isArray(matchingInvocation.arguments))
          ? matchingInvocation.arguments
          : null
    };
  });
}

export function buildInspectorSnapshot(state: WorkspaceChatSessionState): CliInspectorSnapshot {
  return {
    activeTask: state.latestTaskSummary,
    diagnostics: state.latestDiagnostics,
    approvals: state.latestApprovals,
    viewMode: state.viewMode,
    recentTaskIds: [...state.recentTaskIds],
    selectedApprovalIndex: state.selectedApprovalIndex,
    lastViewPayload: state.lastViewPayload
  };
}
