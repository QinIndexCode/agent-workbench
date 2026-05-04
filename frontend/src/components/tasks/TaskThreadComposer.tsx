import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { type ComposerModel, renderComposerButtonIcon } from './taskPageModel';

interface TaskThreadComposerProps {
  autoOpenContext: boolean;
  busyAction: string | null;
  compactVerticalViewport: boolean;
  composerExpanded: boolean;
  composerModel: ComposerModel;
  contextChips: string[];
  continueMessage: string;
  effectiveDetailsOpen: boolean;
  hasComposerDraft: boolean;
  liveComposerModel: ComposerModel;
  selectedTaskId: string | null;
  showCollapsedFollowUp: boolean;
  ultraCompactVerticalViewport: boolean;
  composerModelChangedWhileEditing: boolean;
  taskLifecycleStatus?: string | null;
  onChangeMessage: (value: string) => void;
  onCollapseFollowUp: () => void;
  onExpandFollowUp: () => void;
  onFocusMessage: () => void;
  onBlurMessage: () => void;
  onOpenContext: () => void;
  onPrimaryAction: () => void;
  onPauseTask?: () => void;
}

export function TaskThreadComposer({
  autoOpenContext: _autoOpenContext,
  busyAction,
  compactVerticalViewport,
  composerExpanded: _composerExpanded,
  composerModel,
  contextChips: _contextChips,
  continueMessage,
  effectiveDetailsOpen: _effectiveDetailsOpen,
  hasComposerDraft,
  liveComposerModel: _liveComposerModel,
  selectedTaskId,
  showCollapsedFollowUp: _showCollapsedFollowUp,
  ultraCompactVerticalViewport,
  composerModelChangedWhileEditing: _composerModelChangedWhileEditing,
  taskLifecycleStatus,
  onBlurMessage,
  onChangeMessage,
  onCollapseFollowUp: _onCollapseFollowUp,
  onExpandFollowUp: _onExpandFollowUp,
  onFocusMessage,
  onOpenContext: _onOpenContext,
  onPrimaryAction,
  onPauseTask,
}: TaskThreadComposerProps) {
  const isRunning = taskLifecycleStatus === 'RUNNING';
  const hasDraft = hasComposerDraft || continueMessage.trim().length > 0;
  const isBusy = busyAction !== null && !(isRunning && (busyAction === 'start' || busyAction === 'resume'));
  const buttonMode = isRunning && !hasDraft ? 'pause' : hasDraft ? 'send' : 'action';
  const canRunPrimary = Boolean(selectedTaskId) && !isBusy && (
    buttonMode === 'send'
    || buttonMode === 'pause'
    || (!composerModel.disabled && composerModel.submitKind !== null)
  );
  const buttonTestId = buttonMode === 'pause'
    ? 'task-action-pause'
    : buttonMode === 'send'
      ? 'task-action-continue'
      : composerModel.buttonTestId;
  const buttonTitle = buttonMode === 'pause'
    ? 'Pause thread'
    : buttonMode === 'send'
      ? (isRunning ? 'Send guidance' : 'Send')
      : composerModel.buttonLabel;
  const placeholder = selectedTaskId
    ? isRunning
      ? 'Send guidance while the task is running...'
      : composerModel.placeholder
    : 'Select a task first...';
  const buttonShape = buttonMode === 'pause' ? 'rounded-lg' : 'rounded-full';
  const buttonTone = buttonMode === 'pause'
    ? 'border border-border-default bg-surface-elevated text-text-primary hover:bg-surface-hover'
    : 'bg-accent text-white hover:bg-accent-hover';

  return (
    <div data-testid="task-composer" className="mx-auto w-full max-w-[52rem]">
      <div
        data-testid="task-composer-card"
        className={`flex items-end gap-2 rounded-lg border border-border-subtle bg-background/92 shadow-[0_16px_48px_-34px_rgba(99,102,241,0.52)] ${
          ultraCompactVerticalViewport
            ? 'px-2.5 py-1.5'
            : compactVerticalViewport
              ? 'px-3 py-2'
              : 'px-3.5 py-2.5'
        }`}
      >
        <textarea
          data-testid="task-continue-message"
          value={continueMessage}
          onFocus={onFocusMessage}
          onBlur={onBlurMessage}
          onChange={(event) => onChangeMessage(event.target.value)}
          placeholder={placeholder}
          rows={1}
          className="max-h-32 min-h-[40px] w-full flex-1 resize-none border-0 bg-transparent px-1 py-2 text-sm leading-6 text-text-primary outline-none placeholder:text-text-muted"
        />
        <button
          type="button"
          data-testid={buttonTestId}
          className={`inline-flex h-9 w-9 shrink-0 items-center justify-center ${buttonShape} transition ${buttonTone} ${
            !canRunPrimary ? 'cursor-not-allowed opacity-50' : ''
          }`}
          disabled={!canRunPrimary}
          aria-label={isBusy ? 'Running' : buttonTitle}
          title={isBusy ? 'Running' : buttonTitle}
          onClick={() => {
            if (buttonMode === 'pause') {
              onPauseTask?.();
              return;
            }
            onPrimaryAction();
          }}
        >
          {isBusy ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : buttonMode === 'pause' ? (
            <Square className="h-3.5 w-3.5 fill-current" />
          ) : buttonMode === 'send' ? (
            <ArrowUp className="h-4 w-4" />
          ) : (
            renderComposerButtonIcon(composerModel.buttonIcon)
          )}
        </button>
      </div>
    </div>
  );
}
