import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button } from '../ui/button';
import { FolderIcon } from '../ui/icons';
import type {
  AgentUnit,
  TaskPathPolicy,
  WorkspaceDirectoryListing,
} from '../../types';

type TaskFamilyId =
  | 'analyze'
  | 'implement'
  | 'verify'
  | 'multi_agent_delegation';

interface TaskComposerDialogProps {
  state: 'open' | 'closed';
  onClose: () => void;
  onCreated: (taskId: string) => void;
}

const TASK_FAMILY_UNITS: Record<TaskFamilyId, AgentUnit[]> = {
  analyze: [
    {
      id: 'AGENT-001',
      role: 'Analyst',
      goal: 'Analyze the request, gather evidence, and return grounded findings.',
      executionProfileId: 'analyze',
      outputContract: '{"summary":"string","findings":["string"],"evidence":["string"],"issues":[]}',
      dependencies: [],
    },
  ],
  implement: [
    {
      id: 'AGENT-001',
      role: 'Implementer',
      goal: 'Implement the requested change and provide verification evidence.',
      executionProfileId: 'implement',
      outputContract: '{"summary":"string","changedFiles":["string"],"verification":["string"],"issues":[]}',
      dependencies: [],
    },
  ],
  verify: [
    {
      id: 'AGENT-001',
      role: 'Verifier',
      goal: 'Run checks, classify failures, and report exact pass/fail evidence.',
      executionProfileId: 'verify',
      outputContract: '{"summary":"string","checks":[{"name":"string","status":"passed|failed|blocked","evidence":"string"}],"issues":[]}',
      dependencies: [],
    },
  ],
  multi_agent_delegation: [
    {
      id: 'AGENT-001',
      role: 'Coordinator',
      goal: 'Plan the parent thread, delegate bounded subtasks when useful, and synthesize the final result.',
      executionProfileId: 'implement',
      outputContract: '{"summary":"string","delegations":["string"],"integration":"string","issues":[]}',
      delegationRequired: true,
      delegationContract: {
        title: 'Scoped child task',
        goal: 'Handle one bounded subtask and return evidence to the parent thread.',
      },
      dependencies: [],
    },
  ],
};

const TASK_FAMILY_OPTIONS: Array<{ value: TaskFamilyId; label: string; description: string }> = [
  { value: 'analyze', label: 'Analyze', description: 'Investigate, map evidence, and report grounded findings.' },
  { value: 'implement', label: 'Implement', description: 'Make a bounded code or artifact change and verify it.' },
  { value: 'verify', label: 'Verify', description: 'Run checks and classify exact pass, fail, or blocker evidence.' },
  { value: 'multi_agent_delegation', label: 'Delegation', description: 'Coordinate scoped child tasks and synthesize the result.' },
];

const DEFAULT_UNITS: AgentUnit[] = TASK_FAMILY_UNITS.analyze;
const TASK_COMPOSER_FIELD_CLASS = 'w-full rounded-lg border border-border-subtle bg-surface-elevated/70 px-3.5 py-2.5 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/25';

function formatUnitsTemplate(taskFamily: TaskFamilyId): string {
  return JSON.stringify(TASK_FAMILY_UNITS[taskFamily], null, 2);
}

function validateComposerInput(input: {
  title: string;
  intent: string;
  providerId: string;
  unitsText: string;
  pathPolicy: TaskPathPolicy;
  outputDir: string;
  workingDirectory: string;
}): { units: AgentUnit[] | null; errors: string[] } {
  const errors: string[] = [];
  if (!input.title.trim()) {
    errors.push('Add a title so the thread is identifiable.');
  }
  if (!input.intent.trim()) {
    errors.push('Describe the intent before creating the task.');
  }
  if (!input.providerId.trim()) {
    errors.push('Choose a provider id, or configure a runtime default in Connections first.');
  }
  if (input.pathPolicy === 'project_relative' && !input.outputDir.trim()) {
    errors.push('Project-relative artifact delivery needs an output directory.');
  }

  try {
    const parsed = JSON.parse(input.unitsText) as AgentUnit[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      errors.push('Units JSON must be a non-empty array.');
      return { units: null, errors };
    }
    return { units: parsed, errors };
  } catch {
    errors.push('Units JSON is not valid.');
    return { units: null, errors };
  }
}

export function TaskComposerDialog({ state, onClose, onCreated }: TaskComposerDialogProps) {
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [taskFamily, setTaskFamily] = useState<TaskFamilyId>('analyze');
  const [providerId, setProviderId] = useState('');
  const [pathPolicy, setPathPolicy] = useState<TaskPathPolicy>('task_workspace');
  const [outputDir, setOutputDir] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [workingDirectoryBrowser, setWorkingDirectoryBrowser] = useState<WorkspaceDirectoryListing | null>(null);
  const [workingDirectoryBrowserOpen, setWorkingDirectoryBrowserOpen] = useState(false);
  const [workingDirectoryBrowserError, setWorkingDirectoryBrowserError] = useState<string | null>(null);
  const [unitsText, setUnitsText] = useState(JSON.stringify(DEFAULT_UNITS, null, 2));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    try {
      setError(null);
      const preflight = validateComposerInput({
        title,
        intent,
        providerId,
        unitsText,
        pathPolicy,
        outputDir,
        workingDirectory,
      });
      if (preflight.errors.length > 0 || !preflight.units) {
        setError(preflight.errors.join('\n'));
        return;
      }
      const response = await api.submitTask({
        title,
        intent,
        units: preflight.units,
        preferredProviderId: providerId || null,
        pathPolicy,
        preferredArtifactDir: outputDir || null,
        workingDirectory: workingDirectory.trim() || null,
        metadata: {
          executionMode: 'product_runtime'
        }
      });
      onCreated(response.command.taskId);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to create task.');
    }
  }

  const selectedFamily = TASK_FAMILY_OPTIONS.find((option) => option.value === taskFamily) ?? TASK_FAMILY_OPTIONS[0];
  const errorMessages = error?.split('\n').filter(Boolean) ?? [];
  const workingDirectoryAdvisory = workingDirectory.trim()
    ? `Agent workspace selected: ${workingDirectory.trim()}`
    : 'No working directory selected. The Agent will use the isolated task workspace and must ask before project-local reads or commands.';

  function handleTaskFamilyChange(value: TaskFamilyId) {
    setTaskFamily(value);
    setUnitsText(formatUnitsTemplate(value));
  }

  async function fillWorkspaceRoot() {
    try {
      setWorkingDirectoryBrowserError(null);
      const workflow = await api.getWorkspaceWorkflow();
      if (!workflow.workspaceRoot) {
        setWorkingDirectoryBrowserError('No configured workspace root was found. Paste a path or browse from the runtime root.');
        return;
      }
      setWorkingDirectory(workflow.workspaceRoot);
    } catch (loadError) {
      setWorkingDirectoryBrowserError(loadError instanceof Error ? loadError.message : 'Failed to load workspace root.');
    }
  }

  async function pasteWorkingDirectory() {
    try {
      setWorkingDirectoryBrowserError(null);
      const value = await navigator.clipboard.readText();
      setWorkingDirectory(value.trim());
    } catch {
      setWorkingDirectoryBrowserError('Clipboard is unavailable. Paste the directory path into the field directly.');
    }
  }

  async function loadWorkingDirectoryBrowser(path?: string | null) {
    try {
      setWorkingDirectoryBrowserError(null);
      const listing = await api.listWorkspaceDirectories(path ?? undefined);
      setWorkingDirectoryBrowser(listing);
      setWorkingDirectoryBrowserOpen(true);
    } catch (loadError) {
      setWorkingDirectoryBrowserError(loadError instanceof Error ? loadError.message : 'Failed to browse directories.');
    }
  }

  return (
    <div className={`motion-fade fixed inset-0 z-50 flex items-center justify-center p-4 md:p-6 ${state === 'open' ? 'motion-overlay-open bg-black/70 backdrop-blur-sm' : 'motion-overlay-closed bg-black/0 backdrop-blur-none'}`}>
      <form
        onSubmit={handleSubmit}
        className={`motion-fade grid max-h-[92vh] w-full max-w-4xl grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-border-subtle bg-surface shadow-2xl ${state === 'open' ? 'motion-modal-open' : 'motion-modal-closed'}`}
        data-testid="task-composer-dialog"
      >
        <div className="flex items-start justify-between gap-4 border-b border-border-subtle px-5 py-4">
          <div>
            <p className="text-[11px] font-medium uppercase tracking-[0.28em] text-text-muted">New thread</p>
            <h2 className="mt-1.5 text-xl font-semibold text-text-primary">Create a task</h2>
          </div>
          <Button type="button" variant="ghost" onClick={onClose}>Close</Button>
        </div>

        <div className="min-h-0 overflow-y-auto p-5 scrollbar-thin">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
            <div className="space-y-4">
              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Title</span>
                <input
                  data-testid="task-composer-title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="Short task name"
                  className={TASK_COMPOSER_FIELD_CLASS}
                />
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Task type</span>
                <select
                  data-testid="task-composer-task-type"
                  value={taskFamily}
                  onChange={(event) => handleTaskFamilyChange(event.target.value as TaskFamilyId)}
                  className={TASK_COMPOSER_FIELD_CLASS}
                >
                  {TASK_FAMILY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <span className="block text-xs text-text-muted">{selectedFamily.description}</span>
              </label>

              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Goal</span>
                <textarea
                  data-testid="task-composer-intent"
                  value={intent}
                  onChange={(event) => setIntent(event.target.value)}
                  placeholder="Describe what should be done. Add paths or constraints when they matter."
                  className={`${TASK_COMPOSER_FIELD_CLASS} min-h-[160px] resize-none leading-6`}
                />
              </label>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-text-secondary">Work path</span>
                  <select
                    data-testid="task-composer-path-policy"
                    value={pathPolicy}
                    onChange={(event) => setPathPolicy(event.target.value as TaskPathPolicy)}
                    className={TASK_COMPOSER_FIELD_CLASS}
                  >
                    <option value="task_workspace">Use task workspace</option>
                    <option value="ask_if_unclear">Ask if path is unclear</option>
                    <option value="project_relative">Project-relative path</option>
                  </select>
                </label>
                <label className="space-y-2 text-sm">
                  <span className="text-text-secondary">Output directory</span>
                  <input
                    data-testid="task-composer-output-dir"
                    value={outputDir}
                    onChange={(event) => setOutputDir(event.target.value)}
                    placeholder="Optional path"
                    className={TASK_COMPOSER_FIELD_CLASS}
                  />
                </label>
              </div>

              <div className="rounded-lg border border-border-subtle bg-surface-elevated/35 p-3.5" data-testid="task-composer-working-dir-panel">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-text-primary">Agent working directory</p>
                    <p className="mt-1 text-xs leading-5 text-text-muted">
                      Optional. If empty, project-local commands are blocked behind an explicit operator directory question.
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid="task-composer-working-dir-paste"
                      onClick={pasteWorkingDirectory}
                    >
                      Paste
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid="task-composer-working-dir-default"
                      onClick={fillWorkspaceRoot}
                    >
                      Use workspace root
                    </Button>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      data-testid="task-composer-working-dir-browse"
                      onClick={() => loadWorkingDirectoryBrowser(workingDirectory.trim() || null)}
                    >
                      Browse
                    </Button>
                  </div>
                </div>
                <input
                  data-testid="task-composer-working-dir"
                  value={workingDirectory}
                  onChange={(event) => setWorkingDirectory(event.target.value)}
                  placeholder="Optional absolute or project-relative directory"
                  className={`${TASK_COMPOSER_FIELD_CLASS} mt-3`}
                />
                <p
                  className={`mt-2 text-xs leading-5 ${workingDirectory.trim() ? 'text-success' : 'text-warning'}`}
                  data-testid="task-composer-working-dir-advisory"
                >
                  {workingDirectoryAdvisory}
                </p>
                {workingDirectoryBrowserError ? (
                  <p className="mt-2 text-xs leading-5 text-error" data-testid="task-working-dir-browser-error">
                    {workingDirectoryBrowserError}
                  </p>
                ) : null}
                {workingDirectoryBrowserOpen && workingDirectoryBrowser ? (
                  <div className="mt-3 rounded-lg border border-border-subtle bg-black/18 p-3" data-testid="task-working-dir-browser">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-[0.2em] text-text-muted">Browse directory</p>
                        <p className="truncate text-sm text-text-primary">{workingDirectoryBrowser.currentPath}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          data-testid="task-working-dir-up"
                          disabled={!workingDirectoryBrowser.parentPath}
                          onClick={() => loadWorkingDirectoryBrowser(workingDirectoryBrowser.parentPath)}
                        >
                          Up
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          data-testid="task-working-dir-select"
                          onClick={() => {
                            setWorkingDirectory(workingDirectoryBrowser.currentPath);
                            setWorkingDirectoryBrowserOpen(false);
                          }}
                        >
                          Select this folder
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 grid max-h-48 gap-2 overflow-y-auto pr-1 scrollbar-thin">
                      {workingDirectoryBrowser.entries.length === 0 ? (
                        <p className="rounded-md border border-border-subtle bg-surface/50 px-3 py-2 text-xs text-text-muted">No child folders.</p>
                      ) : (
                        workingDirectoryBrowser.entries.map((entry) => (
                          <button
                            key={entry.absolutePath}
                            type="button"
                            data-testid="task-working-dir-option"
                            aria-label={`Open ${entry.name} folder`}
                            className="flex items-center justify-between gap-3 rounded-md border border-border-subtle bg-surface/55 px-3 py-2 text-left text-sm text-text-secondary transition duration-fast hover:border-accent/45 hover:bg-surface-hover hover:text-text-primary"
                            onClick={() => loadWorkingDirectoryBrowser(entry.path)}
                          >
                            <span className="inline-flex min-w-0 items-center gap-2">
                              <FolderIcon className="h-4 w-4 flex-shrink-0 text-accent" />
                              <span className="truncate">{entry.name}</span>
                            </span>
                            {entry.path !== entry.name ? (
                              <span className="truncate text-xs text-text-muted">{entry.path}</span>
                            ) : null}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <aside className="space-y-3 rounded-lg border border-border-subtle bg-surface-elevated/35 p-4">
              <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-text-muted">Run settings</p>
              <label className="space-y-2 text-sm">
                <span className="text-text-secondary">Provider / model</span>
                <input
                  data-testid="task-composer-provider"
                  value={providerId}
                  onChange={(event) => setProviderId(event.target.value)}
                  placeholder="Default routing"
                  className={TASK_COMPOSER_FIELD_CLASS}
                />
              </label>
              <details
                className="rounded-lg border border-border-subtle bg-black/10"
                open={advancedOpen}
                onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
              >
                <summary className="cursor-pointer px-3 py-2.5 text-sm text-text-primary">Advanced contract</summary>
                <div className="space-y-3 px-3 pb-3">
                  <label className="space-y-2 text-sm">
                    <span className="text-text-secondary">Units JSON</span>
                    <textarea
                      data-testid="task-composer-units"
                      value={unitsText}
                      onChange={(event) => setUnitsText(event.target.value)}
                      className={`${TASK_COMPOSER_FIELD_CLASS} min-h-[220px] resize-none font-mono text-xs leading-5`}
                    />
                  </label>
                </div>
              </details>
              <p className="text-xs leading-5 text-text-muted">
                Product tasks use agent-selected tools, runtime evidence, and operator guidance by default.
              </p>
            </aside>
          </div>
        </div>

        {errorMessages.length ? (
          <div className="border-t border-border-subtle px-5 pt-3 text-sm text-error" data-testid="task-composer-preflight">
            <p className="font-medium">Fix these before creating the task:</p>
            <ul className="mt-2 space-y-1">
              {errorMessages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            {errorMessages.some((message) => /provider|Connections/i.test(message)) ? (
              <a className="mt-2 inline-flex text-xs text-accent hover:underline" href="/settings/connections">
                Open Connections
              </a>
            ) : null}
          </div>
        ) : null}
        <div className="flex justify-end gap-3 border-t border-border-subtle px-5 py-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button data-testid="task-composer-submit" type="submit">Create task</Button>
        </div>
      </form>
    </div>
  );
}
