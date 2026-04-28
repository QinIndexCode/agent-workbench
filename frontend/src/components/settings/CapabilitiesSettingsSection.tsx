import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { SummaryStripItem } from '../../lib/workbench';
import type { McpCatalogEntry, WorkspaceWorkflowView } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { AdminModal } from '../ui/admin-modal';
import { CompactEmptyState } from '../ui/compact-empty-state';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { IconActionButton } from '../ui/icon-action-button';
import {
  ManagementTable,
  ManagementTableBody,
  ManagementTableHeader,
  ManagementTableRow,
} from '../ui/management-table';
import { PaginationBar } from '../ui/pagination-bar';
import { SelectInput } from '../ui/select-input';
import { AdminPageShell } from '../workbench/AdminPageShell';
import { SummaryStrip } from '../workbench/SummaryStrip';

const PAGE_SIZE = 10;
const MCP_TRANSPORTS: Array<McpDraft['transport']> = ['stdio', 'http', 'ws'];

interface McpDraft {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'ws';
  command: string;
  args: string;
  url: string;
}

interface DeleteIntent {
  id: string;
  label: string;
}

function createMcpDraft(entry?: McpCatalogEntry | null): McpDraft {
  return {
    id: entry?.server.id ?? '',
    name: entry?.server.name ?? '',
    transport: entry?.server.transport ?? 'stdio',
    command: entry?.server.command ?? '',
    args: entry?.server.args?.join('\n') ?? '',
    url: entry?.server.url ?? '',
  };
}

function getReadinessVariant(readiness: string) {
  switch (readiness.toLowerCase()) {
    case 'ready':
    case 'stable':
      return 'success' as const;
    case 'warning':
    case 'degraded':
      return 'warning' as const;
    case 'blocked':
    case 'missing':
      return 'error' as const;
    default:
      return 'outline' as const;
  }
}

function SectionLead({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">{eyebrow}</p>
      <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
      <p className="text-sm leading-6 text-text-secondary">{description}</p>
    </div>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <label className="text-[11px] font-semibold uppercase tracking-[0.2em] text-text-muted">{children}</label>;
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-2xl border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 ${props.className ?? ''}`}
    />
  );
}

function TextAreaInput(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`w-full rounded-2xl border border-border-default bg-surface-elevated px-3 py-2 text-sm text-text-primary outline-none transition duration-fast placeholder:text-text-muted focus:border-accent focus:ring-1 focus:ring-accent/30 ${props.className ?? ''}`}
    />
  );
}

function EditIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M13.75 3.75a1.768 1.768 0 1 1 2.5 2.5L8.125 14.375 5 15l.625-3.125L13.75 3.75Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function DeleteIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M4.375 5.625h11.25M7.5 5.625V4.375A.625.625 0 0 1 8.125 3.75h3.75a.625.625 0 0 1 .625.625v1.25m-6.25 0 .625 8.125c.032.41.374.725.785.725h4.68c.41 0 .753-.315.785-.725l.625-8.125" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M8.75 3.75 4.375 8.125l2.5 2.5L11.25 6.25m-2.5 10 6.875-6.875-2.5-2.5L6.25 13.75m2.5 2.5h6.875" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CapabilitiesSettingsSection({
  workflow,
  mcpServers,
  onReload,
  onNotice,
}: {
  workflow: WorkspaceWorkflowView;
  mcpServers: McpCatalogEntry[];
  onReload: () => Promise<void>;
  onNotice: (tone: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [mcpModalOpen, setMcpModalOpen] = useState(false);
  const [mcpModalMode, setMcpModalMode] = useState<'create' | 'edit'>('create');
  const [mcpModalTargetId, setMcpModalTargetId] = useState<string | null>(null);
  const [mcpModalDraft, setMcpModalDraft] = useState<McpDraft>(createMcpDraft(null));
  const [mcpDeleteIntent, setMcpDeleteIntent] = useState<DeleteIntent | null>(null);
  const [mcpTestResults, setMcpTestResults] = useState<Record<string, string>>({});

  const orderedServers = useMemo(
    () => [...mcpServers].sort((left, right) => left.server.name.localeCompare(right.server.name)),
    [mcpServers],
  );
  const totalPages = useMemo(() => Math.max(1, Math.ceil(orderedServers.length / PAGE_SIZE)), [orderedServers.length]);
  const pagedServers = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return orderedServers.slice(start, start + PAGE_SIZE);
  }, [currentPage, orderedServers]);

  useEffect(() => {
    setCurrentPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const summaryItems = useMemo<SummaryStripItem[]>(() => {
    const readyCount = orderedServers.filter((entry) => entry.readiness.toLowerCase() === 'ready').length;
    const testedCount = orderedServers.filter((entry) => entry.lastTestSummary?.ok).length;
    return [
      {
        label: 'Workflow',
        value: workflow.projectInstructionsPresent ? 'ready' : 'needs init',
        note: workflow.projectInstructionsSummary ?? 'Bootstrap workspace workflow and docs import.',
        variant: workflow.projectInstructionsPresent ? 'success' : 'warning',
      },
      {
        label: 'MCP',
        value: orderedServers.length,
        note: 'Registered model context servers.',
        variant: orderedServers.length > 0 ? 'info' : 'outline',
      },
      {
        label: 'Ready',
        value: readyCount,
        note: 'Servers the runtime can rely on right now.',
        variant: readyCount > 0 ? 'success' : 'warning',
      },
      {
        label: 'Tested',
        value: testedCount,
        note: 'Servers with a recent passing test.',
        variant: testedCount > 0 ? 'success' : 'outline',
      },
    ];
  }, [orderedServers, workflow.projectInstructionsPresent, workflow.projectInstructionsSummary]);

  const runAction = async <T,>(key: string, action: () => Promise<T>, successMessage: string, options?: { reload?: boolean }) => {
    try {
      setBusyKey(key);
      const result = await action();
      if (options?.reload !== false) {
        await onReload();
      }
      onNotice('success', successMessage);
      return result;
    } catch (error) {
      onNotice('error', error instanceof Error ? error.message : 'Action failed.');
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const closeModal = () => {
    setMcpModalOpen(false);
    setMcpModalTargetId(null);
  };

  const openCreateModal = () => {
    setMcpModalMode('create');
    setMcpModalTargetId(null);
    setMcpModalDraft(createMcpDraft(null));
    setMcpModalOpen(true);
  };

  const openEditModal = (entry: McpCatalogEntry) => {
    setMcpModalMode('edit');
    setMcpModalTargetId(entry.server.id);
    setMcpModalDraft(createMcpDraft(entry));
    setMcpModalOpen(true);
  };

  async function saveMcp() {
    const payload = {
      id: mcpModalDraft.id.trim(),
      name: mcpModalDraft.name.trim(),
      transport: mcpModalDraft.transport,
      command: mcpModalDraft.command.trim() || undefined,
      args: mcpModalDraft.args
        .split(/\r?\n|,/)
        .map((value) => value.trim())
        .filter(Boolean),
      url: mcpModalDraft.url.trim() || undefined,
    };
    if (!payload.id || !payload.name) {
      throw new Error('MCP server id and name are required.');
    }
    const result = await api.upsertMcpServer(payload.id, payload);
    closeModal();
    return result;
  }

  return (
    <AdminPageShell summary={<SummaryStrip items={summaryItems} />}>
      <Card className="rounded-[20px] border-border-subtle bg-surface/30">
        <CardHeader className="flex flex-col gap-3 py-4 lg:flex-row lg:items-start lg:justify-between">
          <SectionLead
            eyebrow="Workflow"
            title="Bootstrap and imports"
            description="Keep workspace bootstrap actions nearby, but leave the detailed MCP configuration inside the focused manager below."
          />
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="settings-capabilities-workflow-init"
              disabled={busyKey !== null}
              onClick={() => void runAction('workflow-init', () => api.initWorkspaceWorkflow(), 'Workspace workflow initialized.')}
            >
              Init workflow
            </Button>
            <Button
              data-testid="settings-capabilities-workflow-import-docs"
              variant="secondary"
              disabled={busyKey !== null}
              onClick={() => void runAction('workflow-import-docs', () => api.importWorkspaceDocs(), 'Workspace docs import completed.')}
            >
              Import docs
            </Button>
          </div>
        </CardHeader>
      </Card>

      <Card className="rounded-[20px] border-border-subtle bg-surface/30">
        <CardHeader className="flex flex-col gap-3 py-4 lg:flex-row lg:items-start lg:justify-between">
          <SectionLead
            eyebrow="MCP"
            title="Server roster"
            description="Keep the list quiet by default: identity, transport, readiness, and actions. Open the modal only when you need full configuration."
          />
          <Button data-testid="settings-capabilities-mcp-create" disabled={busyKey !== null} onClick={openCreateModal}>
            Add MCP server
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {orderedServers.length === 0 ? (
            <CompactEmptyState
              title="No MCP servers configured"
              description="Add a server when the runtime needs more tools, resources, or prompts."
              action={<Button onClick={openCreateModal}>Create first server</Button>}
            />
          ) : (
            <>
              <ManagementTable testId="settings-capabilities-mcp-table">
                <ManagementTableHeader columns="minmax(0,1.45fr) minmax(0,0.9fr) minmax(0,0.85fr) auto">
                  <span>Server</span>
                  <span>Transport</span>
                  <span>Status</span>
                  <span className="text-right">Actions</span>
                </ManagementTableHeader>
                <ManagementTableBody>
                  {pagedServers.map((entry) => (
                    <ManagementTableRow
                      key={entry.server.id}
                      columns="minmax(0,1.45fr) minmax(0,0.9fr) minmax(0,0.85fr) auto"
                      testId={`settings-capabilities-mcp-row-${entry.server.id}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{entry.server.name}</p>
                        <p className="mt-1 line-clamp-1 text-sm text-text-secondary">
                          {entry.server.url ?? entry.server.command ?? 'No endpoint configured yet.'}
                        </p>
                        <p className="mt-1 text-xs text-text-muted">
                          {entry.availableTools.length} tools · {entry.availableResources.length} resources · {entry.availablePrompts.length} prompts
                        </p>
                      </div>
                      <div className="min-w-0 text-sm text-text-secondary">
                        <p className="font-medium text-text-primary">{entry.server.transport}</p>
                        <p className="mt-1 text-xs text-text-muted">{entry.server.id}</p>
                      </div>
                      <div className="min-w-0">
                        <Badge variant={getReadinessVariant(entry.readiness)}>{entry.readiness}</Badge>
                        <p className="mt-2 line-clamp-2 text-xs leading-5 text-text-secondary">
                          {mcpTestResults[entry.server.id] ?? entry.lastTestSummary?.message ?? 'Not tested yet'}
                        </p>
                      </div>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          data-testid={`settings-capabilities-mcp-test-${entry.server.id}`}
                          disabled={busyKey !== null}
                          onClick={() => void runAction(
                            `mcp-test-${entry.server.id}`,
                            async () => {
                              const result = await api.testMcpServer(entry.server.id);
                              setMcpTestResults((current) => ({ ...current, [entry.server.id]: result.message }));
                              return result;
                            },
                            `Tested MCP server ${entry.server.id}.`,
                            { reload: false },
                          )}
                        >
                          Test
                        </Button>
                        <IconActionButton
                          label={`Edit ${entry.server.name}`}
                          disabled={busyKey !== null}
                          testId={`settings-capabilities-mcp-edit-${entry.server.id}`}
                          onClick={() => openEditModal(entry)}
                        >
                          <EditIcon />
                        </IconActionButton>
                        <IconActionButton
                          label={`Delete ${entry.server.name}`}
                          disabled={busyKey !== null}
                          testId={`settings-capabilities-mcp-delete-${entry.server.id}`}
                          onClick={() => setMcpDeleteIntent({ id: entry.server.id, label: entry.server.name })}
                        >
                          <DeleteIcon />
                        </IconActionButton>
                      </div>
                    </ManagementTableRow>
                  ))}
                </ManagementTableBody>
              </ManagementTable>

              <PaginationBar
                currentPage={currentPage}
                totalPages={totalPages}
                totalItems={orderedServers.length}
                itemLabel="servers"
                disabled={busyKey !== null}
                testId="settings-capabilities-mcp-pagination"
                onPrevious={() => setCurrentPage((current) => Math.max(1, current - 1))}
                onNext={() => setCurrentPage((current) => Math.min(totalPages, current + 1))}
              />
            </>
          )}
        </CardContent>
      </Card>

      <AdminModal
        open={mcpModalOpen}
        testId="settings-capabilities-mcp-modal"
        eyebrow={mcpModalMode === 'create' ? 'New MCP server' : 'Edit MCP server'}
        title={mcpModalMode === 'create' ? 'Create MCP server' : mcpModalDraft.name || 'Edit MCP server'}
        description="Keep the roster compact and move the full endpoint, transport, and argument detail into a focused modal."
        onClose={closeModal}
        actions={(
          mcpModalTargetId ? (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              data-testid={`settings-capabilities-mcp-test-${mcpModalTargetId}`}
              disabled={busyKey !== null}
              onClick={() => void runAction(
                `mcp-test-modal-${mcpModalTargetId}`,
                async () => {
                  const result = await api.testMcpServer(mcpModalTargetId);
                  setMcpTestResults((current) => ({ ...current, [mcpModalTargetId]: result.message }));
                  return result;
                },
                `Tested MCP server ${mcpModalTargetId}.`,
                { reload: false },
              )}
            >
              <ToolIcon />
              Test
            </Button>
          ) : null
        )}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">
              {mcpModalMode === 'create'
                ? 'Create the server first, then test it from the roster or this modal.'
                : 'Save the server without blowing out the main capabilities page.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={closeModal} disabled={busyKey !== null}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-create-submit' : `settings-capabilities-mcp-save-${mcpModalTargetId ?? 'draft'}`}
                disabled={busyKey !== null || !mcpModalDraft.id.trim() || !mcpModalDraft.name.trim()}
                onClick={() => void runAction(
                  mcpModalMode === 'create' ? 'mcp-create' : `mcp-save-${mcpModalTargetId ?? 'draft'}`,
                  saveMcp,
                  mcpModalMode === 'create'
                    ? `Created MCP server ${mcpModalDraft.name}.`
                    : `Saved MCP server ${mcpModalDraft.name}.`,
                )}
              >
                {mcpModalMode === 'create' ? 'Create server' : 'Save changes'}
              </Button>
            </div>
          </div>
        )}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <FieldLabel>ID</FieldLabel>
            <TextInput
              data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-new-id' : `settings-capabilities-mcp-id-${mcpModalTargetId ?? 'draft'}`}
              value={mcpModalDraft.id}
              onChange={(event) => setMcpModalDraft((current) => ({ ...current, id: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Name</FieldLabel>
            <TextInput
              data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-new-name' : `settings-capabilities-mcp-name-${mcpModalTargetId ?? 'draft'}`}
              value={mcpModalDraft.name}
              onChange={(event) => setMcpModalDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Transport</FieldLabel>
            <SelectInput
              data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-new-transport' : `settings-capabilities-mcp-transport-${mcpModalTargetId ?? 'draft'}`}
              value={mcpModalDraft.transport}
              onChange={(event) => setMcpModalDraft((current) => ({ ...current, transport: event.target.value as McpDraft['transport'] }))}
            >
              {MCP_TRANSPORTS.map((transport) => (
                <option key={transport} value={transport}>{transport}</option>
              ))}
            </SelectInput>
          </div>
          <div className="space-y-2">
            <FieldLabel>Command</FieldLabel>
            <TextInput
              data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-new-command' : `settings-capabilities-mcp-command-${mcpModalTargetId ?? 'draft'}`}
              value={mcpModalDraft.command}
              onChange={(event) => setMcpModalDraft((current) => ({ ...current, command: event.target.value }))}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <FieldLabel>Args</FieldLabel>
            <TextAreaInput
              rows={4}
              data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-new-args' : `settings-capabilities-mcp-args-${mcpModalTargetId ?? 'draft'}`}
              value={mcpModalDraft.args}
              onChange={(event) => setMcpModalDraft((current) => ({ ...current, args: event.target.value }))}
            />
          </div>
          <div className="space-y-2 md:col-span-2">
            <FieldLabel>URL</FieldLabel>
            <TextInput
              data-testid={mcpModalMode === 'create' ? 'settings-capabilities-mcp-new-url' : `settings-capabilities-mcp-url-${mcpModalTargetId ?? 'draft'}`}
              value={mcpModalDraft.url}
              onChange={(event) => setMcpModalDraft((current) => ({ ...current, url: event.target.value }))}
            />
          </div>
        </div>
      </AdminModal>

      <ConfirmDialog
        open={mcpDeleteIntent !== null}
        title={mcpDeleteIntent ? `Delete MCP server "${mcpDeleteIntent.label}"?` : 'Delete MCP server?'}
        description="This removes the server from the management roster. Runtime tools and prompts provided by this server will stop being available."
        confirmLabel="Delete server"
        cancelLabel="Keep server"
        tone="danger"
        busy={busyKey !== null}
        testId="settings-capabilities-mcp-delete-dialog"
        confirmTestId="settings-capabilities-mcp-delete-confirm"
        cancelTestId="settings-capabilities-mcp-delete-cancel"
        onCancel={() => setMcpDeleteIntent(null)}
        onConfirm={() => {
          if (!mcpDeleteIntent) {
            return;
          }
          void runAction(
            `mcp-delete-${mcpDeleteIntent.id}`,
            async () => {
              const result = await api.deleteMcpServer(mcpDeleteIntent.id);
              setMcpDeleteIntent(null);
              return result;
            },
            `Removed MCP server ${mcpDeleteIntent.id}.`,
          );
        }}
      />
    </AdminPageShell>
  );
}
