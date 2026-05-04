import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import { ExpandableRow } from '../ui/expandable-row';
import {
  formatTime,
  TaskDetailTabPanel,
  type ApprovalListEntry,
  type DetailTab,
  type TaskInspectorSnapshot,
} from './taskPageModel';
import type { RuntimeEvent, TaskDebugResponse, TaskDetail } from '../../types';

interface TaskInspectorRailProps {
  acceptanceVerdict: string;
  activeInspectorSnapshot: TaskInspectorSnapshot | null;
  activeTab: DetailTab;
  approvalEntriesForInspector: ApprovalListEntry[];
  artifactContextForInspector: TaskInspectorSnapshot['artifactContext'];
  artifactDir: string;
  artifactPathStateLabel: string;
  busyAction: string | null;
  composerDestinationLabel: string;
  composerProviderLabel: string;
  confidenceScore: number;
  contextRailPresence: { mounted: boolean; state: 'open' | 'closed' };
  createdArtifactCount: number;
  credibilitySummary: { gaps: string[] };
  debug: TaskDebugResponse | null;
  deliveredArtifactCount: number;
  detailsToggleLabel: string;
  effectiveDetailsOpen: boolean;
  events: RuntimeEvent[];
  expandedApprovalId: string | null;
  inspectorLoading: boolean;
  issuePlaneLabel: string;
  issueSummaryLabel: string;
  pendingApprovalEntries: ApprovalListEntry[];
  providerNeedsAttention: boolean;
  providerReadinessLabel: string;
  recommendedArtifactDir: string | null;
  selectedTaskId: string | null;
  shouldShowCustomArtifactInput: boolean;
  showSuggestedActionCard: boolean;
  suggestedActionLabel: string;
  suggestedActionReason: string;
  task: TaskDetail | null;
  workingDirectoryLabel: string;
  workingDirectoryStatusLabel: string;
  workingDirectoryTruth: TaskDebugResponse['executionSummary']['workingDirectory'] | null;
  workspaceGuidance: { body: string } | null;
  onApplyCustomArtifactPath: () => void;
  onArtifactDirChange: (value: string) => void;
  onOpenCustomArtifactPath: () => void;
  onResolveApproval: (approval: ApprovalListEntry, status: 'APPROVED' | 'APPROVED_ONCE' | 'REJECTED') => void;
  onTabChange: (tab: DetailTab) => void;
  onToggleApproval: (approvalId: string) => void;
  onToggleContextPanel: () => void;
  onUseRecommendedArtifactPath: () => void;
}

export function TaskInspectorRail(props: TaskInspectorRailProps) {
  const {
    acceptanceVerdict,
    activeInspectorSnapshot,
    activeTab,
    approvalEntriesForInspector,
    artifactContextForInspector,
    artifactDir,
    artifactPathStateLabel,
    busyAction,
    composerDestinationLabel,
    composerProviderLabel,
    confidenceScore,
    contextRailPresence,
    createdArtifactCount,
    credibilitySummary,
    debug,
    deliveredArtifactCount,
    detailsToggleLabel,
    effectiveDetailsOpen,
    events,
    expandedApprovalId,
    inspectorLoading,
    issuePlaneLabel,
    issueSummaryLabel,
    pendingApprovalEntries,
    providerNeedsAttention,
    providerReadinessLabel,
    recommendedArtifactDir,
    selectedTaskId,
    shouldShowCustomArtifactInput,
    showSuggestedActionCard,
    suggestedActionLabel,
    suggestedActionReason,
    task,
    workingDirectoryLabel,
    workingDirectoryStatusLabel,
    workingDirectoryTruth,
    workspaceGuidance,
    onApplyCustomArtifactPath,
    onArtifactDirChange,
    onOpenCustomArtifactPath,
    onResolveApproval,
    onTabChange,
    onToggleApproval,
    onToggleContextPanel,
    onUseRecommendedArtifactPath,
  } = props;

  if (!contextRailPresence.mounted) {
    return null;
  }

  return (        <aside
          className={`motion-fade fixed inset-x-4 bottom-4 top-24 z-30 flex w-auto min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface/95 shadow-2xl transition-[opacity,transform] duration-normal ease-[var(--ease-out)] lg:static lg:inset-auto lg:z-auto lg:h-full lg:min-h-0 lg:w-[21rem] lg:rounded-none lg:border-y-0 lg:border-r-0 lg:border-l lg:shadow-none xl:w-[22rem] ${
            contextRailPresence.state === 'open'
              ? 'motion-rail-open opacity-100 translate-x-0'
              : 'motion-rail-closed pointer-events-none opacity-0 translate-x-4 lg:translate-x-2'
          }`}
          data-testid="task-inspector"
        >
          <div data-testid="task-truth-inspector" className="flex h-full min-h-0 flex-col overflow-hidden">
            <div className="flex items-start justify-between px-4 py-4 flex-shrink-0">
              {effectiveDetailsOpen && (
                <div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="border-b border-violet-300 pb-1 font-semibold text-text-primary">Task truth</span>
                    <span className="pb-1 text-text-muted">Events</span>
                  </div>
                  <h3 className="mt-2 text-base font-semibold text-text-primary">Evidence inspector</h3>
                </div>
              )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="min-w-[6.5rem] justify-center"
                  aria-expanded={effectiveDetailsOpen}
                  title={detailsToggleLabel}
                  onClick={onToggleContextPanel}
                >
                  {detailsToggleLabel}
                </Button>
            </div>
          {effectiveDetailsOpen && (
            <div className="flex-1 min-h-0 space-y-3 overflow-y-auto scrollbar-thin px-4 pb-20 lg:pb-16" data-testid="task-inspector-scroll">
              {activeInspectorSnapshot?.importantCards.length ? activeInspectorSnapshot.importantCards.map((card) => (
                <Card key={`${card.label}-${card.title}`} className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs uppercase tracking-[0.24em] text-text-muted">{card.label}</p>
                    <p className="text-sm font-medium text-text-primary">{card.title}</p>
                    <p className="text-text-secondary">{card.detail}</p>
                  </CardContent>
                </Card>
              )) : inspectorLoading ? (
                <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Context</p>
                    <p className="text-sm font-medium text-text-primary">Loading task context</p>
                    <p className="text-text-secondary">Keeping the inspector stable while the latest task truth loads.</p>
                  </CardContent>
                </Card>
              ) : (
                <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Context</p>
                    <p className="text-sm font-medium text-text-primary">No urgent blockers</p>
                    <p className="text-text-secondary">
                      {workspaceGuidance?.body ?? 'Use Show details when you want the full task truth without inflating the main timeline.'}
                    </p>
                  </CardContent>
                </Card>
              )}
              <div className="space-y-3" data-testid="task-truth-summary-cards">
                <div className="grid grid-cols-2 gap-2" data-testid="task-truth-compact-strip">
                  <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">Confidence</p>
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-sm font-semibold text-success">{confidenceScore}%</span>
                      <span className="text-xs text-text-secondary">{acceptanceVerdict}</span>
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">Evidence: agent-visible</p>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/8">
                      <div
                        className={`h-full rounded-full ${
                          credibilitySummary.gaps.length === 0 ? 'bg-success' : 'bg-warning'
                        }`}
                        style={{ width: `${confidenceScore}%` }}
                      />
                    </div>
                  </div>
                  <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">Plane</p>
                    <p className={issuePlaneLabel === 'none' ? 'mt-2 text-sm font-semibold text-success' : 'mt-2 text-sm font-semibold text-warning'}>
                      {issuePlaneLabel}
                    </p>
                    <p className="mt-1 line-clamp-1 text-xs text-text-secondary">{issueSummaryLabel}</p>
                  </div>
                  <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-2.5">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">Artifact</p>
                    <p className={artifactPathStateLabel === 'unresolved' ? 'mt-2 text-sm font-semibold text-warning' : 'mt-2 text-sm font-semibold text-success'}>
                      {artifactPathStateLabel}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">{createdArtifactCount} created / {deliveredArtifactCount} delivered</p>
                  </div>
                  <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-2.5" data-testid="task-working-dir-truth">
                    <p className="text-[10px] uppercase tracking-[0.2em] text-text-muted">Workspace</p>
                    <p className={workingDirectoryStatusLabel === 'missing' ? 'mt-2 text-sm font-semibold text-warning' : 'mt-2 text-sm font-semibold text-success'}>
                      {workingDirectoryStatusLabel}
                    </p>
                    <p className="mt-1 line-clamp-1 break-all text-xs text-text-secondary">{workingDirectoryLabel}</p>
                  </div>
                </div>

                {providerNeedsAttention ? (
                  <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary">Provider needs attention</p>
                      <span className="text-sm font-semibold text-warning">{providerReadinessLabel}</span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-text-secondary">{composerProviderLabel}</p>
                  </div>
                ) : null}
                {workingDirectoryTruth?.requiresSelection ? (
                  <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-3" data-testid="task-working-dir-warning">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary">Working directory required</p>
                      <span className="text-sm font-semibold text-warning">{workingDirectoryStatusLabel}</span>
                    </div>
                    <p className="mt-2 break-all text-xs leading-5 text-text-secondary">{workingDirectoryLabel}</p>
                    <p className="mt-2 text-xs leading-5 text-warning">Agent must ask before project-local reads or commands.</p>
                  </div>
                ) : null}
                {artifactPathStateLabel === 'unresolved' ? (
                  <div className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary">Artifact destination required</p>
                      <span className="text-sm font-semibold text-warning">{artifactPathStateLabel}</span>
                    </div>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-text-muted">Created</p>
                        <p className="mt-1 font-medium text-text-primary">{createdArtifactCount}</p>
                      </div>
                      <div>
                        <p className="text-text-muted">Delivered</p>
                        <p className="mt-1 font-medium text-text-primary">{deliveredArtifactCount}</p>
                      </div>
                      <div>
                        <p className="text-text-muted">Destination</p>
                        <p className="mt-1 truncate font-medium text-text-primary">{composerDestinationLabel}</p>
                      </div>
                    </div>
                  </div>
                ) : null}
                {showSuggestedActionCard ? (
                  <div className="rounded-lg border border-violet-300/35 bg-violet-950/18 px-3 py-3 shadow-[0_0_0_1px_rgba(139,92,246,0.10)]">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-violet-100">Suggested action</p>
                      <Badge variant={credibilitySummary.gaps.length ? 'warning' : 'success'}>
                        {credibilitySummary.gaps.length ? `${credibilitySummary.gaps.length} gap` : 'clear'}
                      </Badge>
                    </div>
                    <p className="mt-2 text-sm font-medium text-text-primary">{suggestedActionLabel}</p>
                    <p className="mt-1 text-sm leading-6 text-text-secondary">{suggestedActionReason}</p>
                  </div>
                ) : null}
                {credibilitySummary.gaps.length > 0 ? (
                  <div className="rounded-lg border border-border-subtle bg-surface-elevated/72 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-semibold text-text-primary">Evidence gaps</p>
                      <span className="text-sm font-semibold text-warning">{credibilitySummary.gaps.length}</span>
                    </div>
                    <div className="mt-2 space-y-1.5">
                      {credibilitySummary.gaps.map((gap) => (
                        <p key={gap} className="text-sm leading-5 text-text-secondary">{gap}</p>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
                {approvalEntriesForInspector.length ? (
                  <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                    <CardContent className="space-y-3 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Approvals</p>
                          <p className="mt-1 text-sm text-text-secondary">Review the request summary first, then expand only the approval you want to inspect.</p>
                        </div>
                        <Badge variant="warning">{approvalEntriesForInspector.length} waiting</Badge>
                      </div>
                      <div className="space-y-2">
                        {approvalEntriesForInspector.map((approval) => (
                          <ExpandableRow
                            key={approval.invocationId}
                            testId="task-approval-card"
                            summaryTestId={`task-approval-toggle-${approval.invocationId}`}
                            open={expandedApprovalId === approval.invocationId}
                            onToggle={() => onToggleApproval(approval.invocationId)}
                            summary={(
                              <div className="flex min-w-0 items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <p className="text-sm font-semibold text-text-primary">{approval.toolName}</p>
                                    <Badge variant="warning">pending</Badge>
                                  </div>
                                  <p className="mt-1 line-clamp-2 text-xs leading-5 text-text-secondary">
                                    {approval.argumentsSummary ?? 'No argument summary was projected for this approval.'}
                                  </p>
                                </div>
                                <span className="shrink-0 text-[11px] text-text-muted">{formatTime(approval.requestedAt)}</span>
                              </div>
                            )}
                            details={(
                              <div className="space-y-3">
                                <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2.5">
                                  <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Invocation</p>
                                  <p className="mt-2 break-all text-sm text-text-primary">{approval.invocationId}</p>
                                </div>
                                {approval.riskCategory || approval.reason ? (
                                  <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2.5">
                                    <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Risk</p>
                                    <p className="mt-2 text-sm leading-6 text-text-secondary">
                                      {approval.riskCategory ? approval.riskCategory.replace(/_/g, ' ') : 'tool approval'}
                                      {approval.reason ? ` · ${approval.reason}` : ''}
                                    </p>
                                  </div>
                                ) : null}
                                {approval.argumentsSummary ? (
                                  <div className="rounded-lg border border-border-subtle bg-black/10 px-3 py-2.5">
                                    <p className="text-[11px] uppercase tracking-[0.22em] text-text-muted">Argument summary</p>
                                    <p className="mt-2 text-sm leading-6 text-text-secondary">{approval.argumentsSummary}</p>
                                  </div>
                                ) : null}
                                <div className="flex flex-wrap gap-2">
                                  <Button
                                    data-testid="task-approval-approve"
                                    size="sm"
                                    disabled={!task || !approval.availableActions.includes('APPROVED') || busyAction !== null}
                                    onClick={() => void onResolveApproval(approval, 'APPROVED')}
                                  >
                                    Allow similar
                                  </Button>
                                  <Button
                                    data-testid="task-approval-approve-once"
                                    size="sm"
                                    variant="secondary"
                                    disabled={!task || !approval.availableActions.includes('APPROVED_ONCE') || busyAction !== null}
                                    onClick={() => void onResolveApproval(approval, 'APPROVED_ONCE')}
                                  >
                                    Allow once
                                  </Button>
                                  <Button
                                    data-testid="task-approval-reject"
                                    size="sm"
                                    variant="secondary"
                                    disabled={!task || !approval.availableActions.includes('REJECTED') || busyAction !== null}
                                    onClick={() => void onResolveApproval(approval, 'REJECTED')}
                                  >
                                    Reject
                                  </Button>
                                </div>
                              </div>
                            )}
                          />
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ) : null}
              {artifactContextForInspector ? (
                <Card className="workbench-panel border-border-subtle bg-surface-elevated">
                  <CardContent className="space-y-3 text-sm">
                    <div>
                      <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Artifact path</p>
                      <p className="mt-1 text-text-primary">{artifactContextForInspector.artifactPathState}</p>
                    </div>
                    {artifactContextForInspector.recommendedArtifactDir ? (
                      <div data-testid="task-artifact-recommended">
                        <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Recommended destination</p>
                        <p className="mt-1 text-text-secondary">{artifactContextForInspector.recommendedArtifactDir}</p>
                      </div>
                    ) : null}
                    {artifactContextForInspector.selectedArtifactDir ? (
                      <div data-testid="task-artifact-selected">
                        <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Selected destination</p>
                        <p className="mt-1 text-text-secondary">{artifactContextForInspector.selectedArtifactDir}</p>
                      </div>
                    ) : null}
                    {artifactContextForInspector.artifactDestinationPaths.length ? (
                      <div data-testid="task-artifact-delivered">
                        <p className="text-xs uppercase tracking-[0.24em] text-text-muted">Delivered to</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {artifactContextForInspector.artifactDestinationPaths.map((artifactPath) => (
                            <span key={artifactPath} className="rounded-md border border-border-default bg-surface px-2.5 py-1 text-xs text-text-primary">
                              {artifactPath}
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : null}
                    {artifactContextForInspector.artifactPathState !== 'applied' ? (
                      <>
                        {task && artifactContextForInspector.canChoosePath && recommendedArtifactDir ? (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              data-testid="task-context-use-recommended-path"
                              size="sm"
                              disabled={!selectedTaskId || busyAction !== null}
                              onClick={() => void onUseRecommendedArtifactPath()}
                            >
                              Use recommended path
                            </Button>
                            <Button
                              data-testid="task-context-choose-custom-path"
                              size="sm"
                              variant="secondary"
                              disabled={!selectedTaskId || busyAction !== null}
                              onClick={onOpenCustomArtifactPath}
                            >
                              Choose custom path
                            </Button>
                          </div>
                        ) : null}
                        {shouldShowCustomArtifactInput ? (
                          <>
                            <input
                              data-testid="task-artifact-dir"
                              value={artifactDir}
                              onChange={(event) => onArtifactDirChange(event.target.value)}
                              placeholder={debug?.executionSummary.recommendedArtifactDir ?? 'project-relative destination'}
                              className="w-full rounded-xl border border-border-default bg-surface px-3 py-2 text-sm text-text-primary outline-none transition duration-fast focus:border-accent focus:ring-1 focus:ring-accent/30"
                            />
                            <Button
                              data-testid="task-action-apply-artifacts"
                              size="sm"
                              disabled={!selectedTaskId || busyAction !== null || !artifactDir.trim()}
                              onClick={() => void onApplyCustomArtifactPath()}
                            >
                              Apply custom path
                            </Button>
                          </>
                        ) : null}
                      </>
                    ) : null}
                  </CardContent>
                </Card>
              ) : null}
              <div>
                <details className="rounded-lg border border-border-subtle bg-surface-elevated/58" data-testid="task-advanced-summary">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-text-primary">Inspector details</summary>
                  <div className="px-4 pb-3 pt-1">
                    <div className="mb-3 flex flex-wrap gap-1.5 border-b border-border-subtle pb-2">
                      {(['summary', 'acceptance', 'experience', 'approvals', 'diagnostics', 'artifacts', 'events', 'raw'] as DetailTab[]).map((tab) => <button key={tab} type="button" data-testid={`task-tab-${tab}`} onClick={() => onTabChange(tab)} className={`rounded-md px-2.5 py-1.5 text-xs transition duration-fast ${activeTab === tab ? 'bg-surface-hover text-text-primary ring-1 ring-border-default' : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary'}`}>{tab}</button>)}
                    </div>
                    <TaskDetailTabPanel
                      activeTab={activeTab}
                      task={task}
                      debug={debug}
                      events={events}
                      pendingApprovalEntries={pendingApprovalEntries}
                    />
                  </div>
                </details>
              </div>
            </div>
          )}
          </div>
        </aside>
  );
}
