import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api/client';
import type { SummaryStripItem } from '../../lib/workbench';
import type { SkillCatalogEntry } from '../../types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { AdminModal } from '../ui/admin-modal';
import { CompactEmptyState } from '../ui/compact-empty-state';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PlusIcon, RefreshIcon, ViewIcon } from '../ui/icons';
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

interface SkillEditorDraft {
  id: string;
  name: string;
  description: string;
  kind: 'runtime-skill' | 'instruction-skill';
  content: string;
}

interface SkillImportDraft {
  id: string;
  name: string;
  rootDir: string;
  description: string;
  kind: 'runtime-skill' | 'instruction-skill';
}

interface MarketplaceImportDraft {
  marketplaceFile: string;
  pluginName: string;
  skillPath: string;
}

interface DeleteIntent {
  id: string;
  label: string;
}

const EMPTY_SKILL_DRAFT: SkillEditorDraft = {
  id: '',
  name: '',
  description: '',
  kind: 'instruction-skill',
  content: '',
};

function normalizeNameToId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function createSkillEditorDraft(entry?: SkillCatalogEntry | null): SkillEditorDraft {
  return {
    id: entry?.skill.id ?? '',
    name: entry?.skill.name ?? '',
    description: entry?.skill.description ?? '',
    kind: entry?.kind ?? 'instruction-skill',
    content: entry?.content ?? '',
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

function formatUpdatedTime(value: number | null) {
  if (!value) {
    return 'unknown';
  }
  return new Date(value).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSourceLabel(entry: SkillCatalogEntry) {
  switch (entry.source) {
    case 'generated':
      return 'generated';
    case 'marketplace':
      return 'marketplace';
    case 'imported':
      return 'imported';
    case 'config_root':
      return 'config';
    default:
      return 'builtin';
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

function DuplicateIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" className="h-5 w-5" aria-hidden="true">
      <path d="M7.5 6.875h7.5v8.75h-7.5zm-2.5 0H4.375a.625.625 0 0 0-.625.625v8.125c0 .345.28.625.625.625H12.5m-5-11.25V4.375c0-.345.28-.625.625-.625h6.25c.345 0 .625.28.625.625v1.25" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SkillsSettingsSection({
  skills,
  onReload,
  onNotice,
}: {
  skills: SkillCatalogEntry[];
  onReload: () => Promise<void>;
  onNotice: (tone: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [skillModalOpen, setSkillModalOpen] = useState(false);
  const [skillModalMode, setSkillModalMode] = useState<'create' | 'edit' | 'duplicate' | 'view'>('create');
  const [skillModalTargetId, setSkillModalTargetId] = useState<string | null>(null);
  const [skillModalDraft, setSkillModalDraft] = useState<SkillEditorDraft>(EMPTY_SKILL_DRAFT);
  const [skillDeleteIntent, setSkillDeleteIntent] = useState<DeleteIntent | null>(null);
  const [localImportOpen, setLocalImportOpen] = useState(false);
  const [marketplaceImportOpen, setMarketplaceImportOpen] = useState(false);
  const [skillImportDraft, setSkillImportDraft] = useState<SkillImportDraft>({
    id: '',
    name: '',
    rootDir: '',
    description: '',
    kind: 'instruction-skill',
  });
  const [marketplaceDraft, setMarketplaceDraft] = useState<MarketplaceImportDraft>({
    marketplaceFile: '',
    pluginName: '',
    skillPath: '',
  });

  const orderedSkills = useMemo(
    () => [...skills].sort((left, right) => left.skill.name.localeCompare(right.skill.name)),
    [skills],
  );
  const totalPages = useMemo(() => Math.max(1, Math.ceil(orderedSkills.length / PAGE_SIZE)), [orderedSkills.length]);
  const pagedSkills = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return orderedSkills.slice(start, start + PAGE_SIZE);
  }, [currentPage, orderedSkills]);

  useEffect(() => {
    setCurrentPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  const summaryItems = useMemo<SummaryStripItem[]>(() => {
    const editableCount = orderedSkills.filter((entry) => entry.editable).length;
    const generatedCount = orderedSkills.filter((entry) => entry.source === 'generated').length;
    const readyCount = orderedSkills.filter((entry) => entry.readiness.toLowerCase() === 'ready').length;
    return [
      {
        label: 'Skills',
        value: orderedSkills.length,
        note: 'Total catalog entries available to the runtime.',
        variant: orderedSkills.length > 0 ? 'info' : 'outline',
      },
      {
        label: 'Editable',
        value: editableCount,
        note: 'Local and generated skills you can directly manage.',
        variant: editableCount > 0 ? 'success' : 'outline',
      },
      {
        label: 'Generated',
        value: generatedCount,
        note: 'Managed skills created from the product itself.',
        variant: generatedCount > 0 ? 'info' : 'outline',
      },
      {
        label: 'Ready',
        value: readyCount,
        note: 'Catalog entries currently ready to load.',
        variant: readyCount > 0 ? 'success' : 'warning',
      },
    ];
  }, [orderedSkills]);

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

  const closeSkillModal = () => {
    setSkillModalOpen(false);
    setSkillModalTargetId(null);
  };

  const openCreateSkillModal = () => {
    const nextId = `generated-skill-${Date.now()}`;
    setSkillModalMode('create');
    setSkillModalTargetId(null);
    setSkillModalDraft({
      ...EMPTY_SKILL_DRAFT,
      id: nextId,
      name: 'New instruction skill',
      content: '## Goal\n\nDescribe the reusable instruction flow.\n',
    });
    setSkillModalOpen(true);
  };

  const openEditSkillModal = (entry: SkillCatalogEntry) => {
    setSkillModalMode('edit');
    setSkillModalTargetId(entry.skill.id);
    setSkillModalDraft(createSkillEditorDraft(entry));
    setSkillModalOpen(true);
  };

  const openDuplicateSkillModal = (entry: SkillCatalogEntry) => {
    setSkillModalMode('duplicate');
    setSkillModalTargetId(entry.skill.id);
    setSkillModalDraft({
      ...createSkillEditorDraft(entry),
      id: `${normalizeNameToId(entry.skill.name)}-copy`,
      name: `${entry.skill.name} copy`,
    });
    setSkillModalOpen(true);
  };

  const openViewSkillModal = (entry: SkillCatalogEntry) => {
    setSkillModalMode('view');
    setSkillModalTargetId(entry.skill.id);
    setSkillModalDraft(createSkillEditorDraft(entry));
    setSkillModalOpen(true);
  };

  const skillModalReadOnly = skillModalMode === 'view';

  async function saveSkill() {
    const payload = {
      id: skillModalDraft.id.trim(),
      name: skillModalDraft.name.trim(),
      description: skillModalDraft.description.trim() || undefined,
      kind: skillModalDraft.kind,
      content: skillModalDraft.content,
    };
    if (!payload.id || !payload.name || !payload.content.trim()) {
      throw new Error('Skill id, name, and content are required.');
    }
    if (skillModalMode === 'edit' && skillModalTargetId) {
      const result = await api.updateSkill(skillModalTargetId, payload);
      closeSkillModal();
      return result;
    }
    if (skillModalMode === 'duplicate' && skillModalTargetId) {
      const result = await api.duplicateSkill(skillModalTargetId, {
        id: payload.id,
        name: payload.name,
      });
      closeSkillModal();
      return result;
    }
    const result = await api.createSkill(payload);
    closeSkillModal();
    return result;
  }

  return (
    <AdminPageShell summary={<SummaryStrip items={summaryItems} />}>
      <Card className="rounded-[20px] border-border-subtle bg-surface/30">
        <CardHeader className="flex flex-col gap-3 py-4 lg:flex-row lg:items-start lg:justify-between">
          <SectionLead
            eyebrow="Skills"
            title="Managed skill catalog"
            description="Treat skills like managed assets: quiet list by default, modal editing when you actually need the content."
          />
          <div className="flex flex-wrap gap-2">
            <Button
              data-testid="settings-skills-refresh"
              variant="secondary"
              disabled={busyKey !== null}
              onClick={() => void runAction('skills-refresh', () => api.refreshSkills(), 'Skill catalog refreshed.')}
            >
              <RefreshIcon className="h-4 w-4" />
              Refresh
            </Button>
            <Button
              variant="secondary"
              disabled={busyKey !== null}
              onClick={() => setLocalImportOpen(true)}
              data-testid="settings-skills-open-local-import"
            >
              Import local
            </Button>
            <Button
              variant="secondary"
              disabled={busyKey !== null}
              onClick={() => setMarketplaceImportOpen(true)}
              data-testid="settings-skills-open-marketplace-import"
            >
              Import marketplace
            </Button>
            <Button data-testid="settings-skills-create" disabled={busyKey !== null} onClick={openCreateSkillModal}>
              <PlusIcon className="h-4 w-4" />
              Create skill
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {orderedSkills.length === 0 ? (
            <CompactEmptyState
              title="No managed skills yet"
              description="Create a new instruction skill or import one from a local directory or marketplace manifest."
              action={<Button onClick={openCreateSkillModal}>Create first skill</Button>}
            />
          ) : (
            <>
              <ManagementTable testId="settings-skills-table">
                <ManagementTableHeader columns="minmax(0,1.45fr) minmax(0,0.8fr) minmax(0,0.85fr) minmax(0,0.8fr) auto">
                  <span>Skill</span>
                  <span>Source</span>
                  <span>Status</span>
                  <span>Updated</span>
                  <span className="text-right">Actions</span>
                </ManagementTableHeader>
                <ManagementTableBody>
                  {pagedSkills.map((entry) => (
                    <ManagementTableRow
                      key={entry.skill.id}
                      columns="minmax(0,1.45fr) minmax(0,0.8fr) minmax(0,0.85fr) minmax(0,0.8fr) auto"
                      testId={`settings-skills-row-${entry.skill.id}`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-text-primary">{entry.skill.name}</p>
                        <p className="mt-1 line-clamp-1 text-sm text-text-secondary">
                          {entry.skill.description ?? entry.skill.rootDir}
                        </p>
                      </div>
                      <div className="min-w-0 text-sm text-text-secondary">
                        <p className="font-medium text-text-primary">{formatSourceLabel(entry)}</p>
                        <p className="mt-1 text-xs text-text-muted">{entry.kind}</p>
                      </div>
                      <div className="min-w-0">
                        <Badge variant={getReadinessVariant(entry.readiness)}>{entry.readiness}</Badge>
                        <p className="mt-2 text-xs text-text-secondary">
                          {entry.editable ? 'Editable' : entry.duplicable ? 'Duplicate to edit' : 'Read only'}
                        </p>
                      </div>
                      <div className="text-sm text-text-secondary">{formatUpdatedTime(entry.updatedAt)}</div>
                      <div className="flex items-center justify-end gap-1">
                        {entry.editable ? (
                          <IconActionButton
                            label={`Edit ${entry.skill.name}`}
                            disabled={busyKey !== null}
                            testId={`settings-skills-edit-${entry.skill.id}`}
                            onClick={() => openEditSkillModal(entry)}
                          >
                            <EditIcon />
                          </IconActionButton>
                        ) : null}
                        {entry.duplicable ? (
                          <IconActionButton
                            label={`Duplicate ${entry.skill.name}`}
                            disabled={busyKey !== null}
                            testId={`settings-skills-duplicate-${entry.skill.id}`}
                            onClick={() => openDuplicateSkillModal(entry)}
                          >
                            <DuplicateIcon />
                          </IconActionButton>
                        ) : null}
                        {entry.deletable ? (
                          <IconActionButton
                            label={`Delete ${entry.skill.name}`}
                            disabled={busyKey !== null}
                            testId={`settings-skills-delete-${entry.skill.id}`}
                            onClick={() => setSkillDeleteIntent({ id: entry.skill.id, label: entry.skill.name })}
                          >
                            <DeleteIcon />
                          </IconActionButton>
                        ) : null}
                        {!entry.editable && !entry.duplicable && !entry.deletable ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busyKey !== null}
                            data-testid={`settings-skills-view-${entry.skill.id}`}
                            onClick={() => openViewSkillModal(entry)}
                          >
                            <ViewIcon className="h-4 w-4" />
                            View details
                          </Button>
                        ) : null}
                      </div>
                    </ManagementTableRow>
                  ))}
                </ManagementTableBody>
              </ManagementTable>

              <PaginationBar
                currentPage={currentPage}
                totalPages={totalPages}
                totalItems={orderedSkills.length}
                itemLabel="skills"
                disabled={busyKey !== null}
                testId="settings-skills-pagination"
                onPrevious={() => setCurrentPage((current) => Math.max(1, current - 1))}
                onNext={() => setCurrentPage((current) => Math.min(totalPages, current + 1))}
              />
            </>
          )}
        </CardContent>
      </Card>

      <AdminModal
        open={skillModalOpen}
        testId="settings-skills-modal"
        eyebrow={
          skillModalMode === 'create'
            ? 'New skill'
            : skillModalMode === 'duplicate'
              ? 'Duplicate skill'
              : skillModalMode === 'view'
                ? 'Skill details'
                : 'Edit skill'
        }
        title={
          skillModalMode === 'create'
            ? 'Create managed skill'
            : skillModalMode === 'view'
              ? skillModalDraft.name || 'Skill details'
              : skillModalDraft.name || 'Skill editor'
        }
        description={
          skillModalMode === 'view'
            ? 'Review managed metadata and SKILL.md content without opening an edit flow.'
            : 'Keep the catalog readable by moving metadata and SKILL.md editing into a focused workspace.'
        }
        size="xl"
        onClose={closeSkillModal}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">
              {skillModalMode === 'view'
                ? 'Read-only entries stay inspectable even when they cannot be changed from the catalog.'
                : skillModalMode === 'duplicate'
                ? 'Duplicate builtin or marketplace skills before editing them.'
                : 'Keep the list compact; do the full content work here.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={closeSkillModal} disabled={busyKey !== null}>
                {skillModalReadOnly ? 'Close' : 'Cancel'}
              </Button>
              {!skillModalReadOnly ? (
                <Button
                  type="button"
                  data-testid={
                    skillModalMode === 'create'
                      ? 'settings-skills-create-submit'
                      : skillModalMode === 'duplicate'
                        ? `settings-skills-duplicate-submit-${skillModalTargetId ?? 'draft'}`
                        : `settings-skills-save-${skillModalTargetId ?? 'draft'}`
                  }
                  disabled={busyKey !== null || !skillModalDraft.id.trim() || !skillModalDraft.name.trim() || !skillModalDraft.content.trim()}
                  onClick={() => void runAction(
                    skillModalMode === 'create' ? 'skill-create' : `skill-save-${skillModalTargetId ?? 'draft'}`,
                    saveSkill,
                    skillModalMode === 'duplicate'
                      ? `Duplicated skill ${skillModalDraft.name}.`
                      : skillModalMode === 'edit'
                        ? `Saved skill ${skillModalDraft.name}.`
                        : `Created skill ${skillModalDraft.name}.`,
                  )}
                >
                  {skillModalMode === 'duplicate' ? 'Duplicate skill' : skillModalMode === 'edit' ? 'Save changes' : 'Create skill'}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-1">
              <div className="space-y-2">
                <FieldLabel>ID</FieldLabel>
                <TextInput
                  data-testid="settings-skills-editor-id"
                  value={skillModalDraft.id}
                  readOnly={skillModalReadOnly}
                  onChange={(event) => setSkillModalDraft((current) => ({ ...current, id: event.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel>Name</FieldLabel>
                <TextInput
                  data-testid="settings-skills-editor-name"
                  value={skillModalDraft.name}
                  readOnly={skillModalReadOnly}
                  onChange={(event) => setSkillModalDraft((current) => ({ ...current, name: event.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-2">
              <FieldLabel>Description</FieldLabel>
              <TextAreaInput
                rows={4}
                data-testid="settings-skills-editor-description"
                value={skillModalDraft.description}
                readOnly={skillModalReadOnly}
                onChange={(event) => setSkillModalDraft((current) => ({ ...current, description: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel>Kind</FieldLabel>
              <SelectInput
                data-testid="settings-skills-editor-kind"
                value={skillModalDraft.kind}
                disabled={skillModalReadOnly}
                onChange={(event) => setSkillModalDraft((current) => ({ ...current, kind: event.target.value as SkillEditorDraft['kind'] }))}
              >
                <option value="instruction-skill">instruction-skill</option>
                <option value="runtime-skill">runtime-skill</option>
              </SelectInput>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Skill content</p>
                <p className="mt-1 text-sm text-text-secondary">Use markdown for instruction skills and code for runtime skills.</p>
              </div>
              <Badge variant={skillModalDraft.kind === 'instruction-skill' ? 'info' : 'warning'}>
                {skillModalDraft.kind}
              </Badge>
            </div>
            <TextAreaInput
              rows={18}
              data-testid="settings-skills-editor-content"
              value={skillModalDraft.content}
              className="font-mono text-[13px] leading-6"
              readOnly={skillModalReadOnly}
              onChange={(event) => setSkillModalDraft((current) => ({ ...current, content: event.target.value }))}
            />
          </div>
        </div>
      </AdminModal>

      <AdminModal
        open={localImportOpen}
        testId="settings-skills-import-modal"
        eyebrow="Import local"
        title="Import local skill"
        description="Bring an existing local skill directory into the managed catalog without dumping the import fields into the main page."
        onClose={() => setLocalImportOpen(false)}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">Use this for repo-local or generated directories that already contain a skill bundle.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={() => setLocalImportOpen(false)} disabled={busyKey !== null}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="settings-skills-import-local"
                disabled={busyKey !== null || !skillImportDraft.rootDir.trim()}
                onClick={() => void runAction(
                  'skills-import-local',
                  async () => {
                    const result = await api.importSkill({
                      id: skillImportDraft.id || undefined,
                      name: skillImportDraft.name || undefined,
                      rootDir: skillImportDraft.rootDir,
                      description: skillImportDraft.description || undefined,
                      kind: skillImportDraft.kind,
                    });
                    setLocalImportOpen(false);
                    return result;
                  },
                  'Local skill imported.',
                )}
              >
                Import local skill
              </Button>
            </div>
          </div>
        )}
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <FieldLabel>Root directory</FieldLabel>
            <TextInput
              data-testid="settings-skills-import-root"
              value={skillImportDraft.rootDir}
              onChange={(event) => setSkillImportDraft((current) => ({ ...current, rootDir: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Name</FieldLabel>
            <TextInput
              data-testid="settings-skills-import-name"
              value={skillImportDraft.name}
              onChange={(event) => setSkillImportDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>ID</FieldLabel>
            <TextInput
              data-testid="settings-skills-import-id"
              value={skillImportDraft.id}
              onChange={(event) => setSkillImportDraft((current) => ({ ...current, id: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Kind</FieldLabel>
            <SelectInput
              data-testid="settings-skills-import-kind"
              value={skillImportDraft.kind}
              onChange={(event) => setSkillImportDraft((current) => ({ ...current, kind: event.target.value as SkillImportDraft['kind'] }))}
            >
              <option value="instruction-skill">instruction-skill</option>
              <option value="runtime-skill">runtime-skill</option>
            </SelectInput>
          </div>
          <div className="space-y-2 md:col-span-2">
            <FieldLabel>Description</FieldLabel>
            <TextAreaInput
              rows={4}
              data-testid="settings-skills-import-description"
              value={skillImportDraft.description}
              onChange={(event) => setSkillImportDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </div>
        </div>
      </AdminModal>

      <AdminModal
        open={marketplaceImportOpen}
        testId="settings-skills-marketplace-modal"
        eyebrow="Import marketplace"
        title="Import marketplace skill"
        description="Pull a skill from a marketplace manifest into the managed catalog, then duplicate it if you want to edit it."
        onClose={() => setMarketplaceImportOpen(false)}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">Marketplace imports stay traceable while keeping the main skill list focused.</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={() => setMarketplaceImportOpen(false)} disabled={busyKey !== null}>
                Cancel
              </Button>
              <Button
                type="button"
                data-testid="settings-skills-import-marketplace"
                disabled={busyKey !== null || !marketplaceDraft.marketplaceFile.trim() || !marketplaceDraft.pluginName.trim()}
                onClick={() => void runAction(
                  'skills-import-marketplace',
                  async () => {
                    const result = await api.importMarketplaceSkills({
                      marketplaceFile: marketplaceDraft.marketplaceFile,
                      pluginName: marketplaceDraft.pluginName,
                      skillPath: marketplaceDraft.skillPath || undefined,
                    });
                    setMarketplaceImportOpen(false);
                    return result;
                  },
                  'Marketplace skill import completed.',
                )}
              >
                Import marketplace skill
              </Button>
            </div>
          </div>
        )}
      >
        <div className="grid gap-4">
          <div className="space-y-2">
            <FieldLabel>Marketplace file</FieldLabel>
            <TextInput
              data-testid="settings-skills-marketplace-file"
              value={marketplaceDraft.marketplaceFile}
              onChange={(event) => setMarketplaceDraft((current) => ({ ...current, marketplaceFile: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Plugin name</FieldLabel>
            <TextInput
              data-testid="settings-skills-marketplace-plugin"
              value={marketplaceDraft.pluginName}
              onChange={(event) => setMarketplaceDraft((current) => ({ ...current, pluginName: event.target.value }))}
            />
          </div>
          <div className="space-y-2">
            <FieldLabel>Skill path</FieldLabel>
            <TextInput
              data-testid="settings-skills-marketplace-path"
              value={marketplaceDraft.skillPath}
              onChange={(event) => setMarketplaceDraft((current) => ({ ...current, skillPath: event.target.value }))}
            />
          </div>
        </div>
      </AdminModal>

      <ConfirmDialog
        open={skillDeleteIntent !== null}
        title={skillDeleteIntent ? `Delete skill "${skillDeleteIntent.label}"?` : 'Delete skill?'}
        description="Deleting a managed skill removes it from the catalog and from generated skill storage. Builtin and marketplace entries should be duplicated instead of deleted."
        confirmLabel="Delete skill"
        cancelLabel="Keep skill"
        tone="danger"
        busy={busyKey !== null}
        testId="settings-skills-delete-dialog"
        confirmTestId="settings-skills-delete-confirm"
        cancelTestId="settings-skills-delete-cancel"
        onCancel={() => setSkillDeleteIntent(null)}
        onConfirm={() => {
          if (!skillDeleteIntent) {
            return;
          }
          void runAction(
            `skill-delete-${skillDeleteIntent.id}`,
            async () => {
              const result = await api.deleteSkill(skillDeleteIntent.id);
              setSkillDeleteIntent(null);
              return result;
            },
            `Deleted skill ${skillDeleteIntent.id}.`,
          );
        }}
      />
    </AdminPageShell>
  );
}
