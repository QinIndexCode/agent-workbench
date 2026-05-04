import { useEffect, useMemo, useState } from 'react';
import { Download, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { api } from '../../api/client';
import type { ExperienceRecord, ExperienceUpsertPayload, SkillCatalogEntry } from '../../types';
import type { SummaryStripItem } from '../../lib/workbench';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import {
  ManagementTable,
  ManagementTableBody,
  ManagementTableHeader,
  ManagementTableRow,
} from '../ui/management-table';
import { PaginationBar } from '../ui/pagination-bar';
import { SelectInput } from '../ui/select-input';
import { AdminModal } from '../ui/admin-modal';
import { AdminPageShell } from '../workbench/AdminPageShell';
import { SummaryStrip } from '../workbench/SummaryStrip';


const PAGE_SIZE = 8;

export interface GovernanceExperienceDraft {
  proposalId: string;
  patternKey: string;
  title: string;
  referenceSummary: string;
  applicableScenarios: string;
  limitations: string;
  confidence: string;
  validationStatus: ExperienceRecord['validationStatus'];
  successfulReuseTaskIds: string;
  failedReuseTaskIds: string;
  draftExperienceMarkdown: string;
}

const EMPTY_DRAFT: GovernanceExperienceDraft = {
  proposalId: '',
  patternKey: '',
  title: '',
  referenceSummary: '',
  applicableScenarios: '',
  limitations: '',
  confidence: '0.5',
  validationStatus: 'monitoring',
  successfulReuseTaskIds: '',
  failedReuseTaskIds: '',
  draftExperienceMarkdown: '',
};

export function normalizeGovernanceExperienceId(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function parseGovernanceLines(value: string) {
  return value
    .split(/\r?\n|,/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function formatGovernanceTime(value: number | null | undefined) {
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

export function createGovernanceExperienceDraft(record?: ExperienceRecord | null): GovernanceExperienceDraft {
  return {
    proposalId: record?.proposalId ?? '',
    patternKey: record?.patternKey ?? '',
    title: record?.title ?? '',
    referenceSummary: record?.referenceSummary ?? '',
    applicableScenarios: record?.applicableScenarios.join('\n') ?? '',
    limitations: record?.limitations.join('\n') ?? '',
    confidence: String(record?.confidence ?? 0.5),
    validationStatus: record?.validationStatus ?? 'monitoring',
    successfulReuseTaskIds: record?.successfulReuseTaskIds.join('\n') ?? '',
    failedReuseTaskIds: record?.failedReuseTaskIds.join('\n') ?? '',
    draftExperienceMarkdown: '',
  };
}

export function toGovernanceExperiencePayload(draft: GovernanceExperienceDraft): ExperienceUpsertPayload {
  return {
    proposalId: draft.proposalId.trim() || undefined,
    patternKey: draft.patternKey.trim() || undefined,
    title: draft.title.trim(),
    referenceSummary: draft.referenceSummary.trim(),
    applicableScenarios: parseGovernanceLines(draft.applicableScenarios),
    limitations: parseGovernanceLines(draft.limitations),
    confidence: Number.isFinite(Number(draft.confidence)) ? Number(draft.confidence) : 0.5,
    validationStatus: draft.validationStatus,
    successfulReuseTaskIds: parseGovernanceLines(draft.successfulReuseTaskIds),
    failedReuseTaskIds: parseGovernanceLines(draft.failedReuseTaskIds),
    draftExperienceMarkdown: draft.draftExperienceMarkdown.trim() || undefined,
  };
}

function downloadTextFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function getGovernanceStatusVariant(status: ExperienceRecord['validationStatus']) {
  switch (status) {
    case 'promotable':
      return 'success' as const;
    case 'conflicted':
      return 'warning' as const;
    default:
      return 'outline' as const;
  }
}

export function GovernanceSettingsSection({
  experiences,
  skills,
  onReload,
  onNotice,
}: {
  experiences: ExperienceRecord[];
  skills: SkillCatalogEntry[];
  onReload: () => Promise<void>;
  onNotice: (tone: 'success' | 'error' | 'info', message: string) => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [modalMode, setModalMode] = useState<'create' | 'edit' | 'view'>('create');
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTargetId, setModalTargetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<GovernanceExperienceDraft>(EMPTY_DRAFT);
  const [deleteTarget, setDeleteTarget] = useState<ExperienceRecord | null>(null);
  const [bulkDeleteRequested, setBulkDeleteRequested] = useState(false);

  const orderedExperiences = useMemo(
    () => [...experiences].sort((left, right) => right.updatedAt - left.updatedAt),
    [experiences],
  );
  const orderedSkills = useMemo(
    () => [...skills].sort((left, right) => left.skill.name.localeCompare(right.skill.name)),
    [skills],
  );
  const totalPages = Math.max(1, Math.ceil(orderedExperiences.length / PAGE_SIZE));
  const pagedExperiences = orderedExperiences.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
  const selectedExperienceIds = orderedExperiences
    .filter((record) => selectedIds.has(record.proposalId))
    .map((record) => record.proposalId);

  useEffect(() => {
    setCurrentPage((current) => Math.min(current, totalPages));
  }, [totalPages]);

  useEffect(() => {
    setSelectedIds((current) => {
      const allowed = new Set(orderedExperiences.map((record) => record.proposalId));
      const next = new Set([...current].filter((id) => allowed.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [orderedExperiences]);

  const summaryItems = useMemo<SummaryStripItem[]>(() => {
    const promotable = orderedExperiences.filter((record) => record.validationStatus === 'promotable').length;
    const conflicted = orderedExperiences.filter((record) => record.validationStatus === 'conflicted').length;
    return [
      { label: 'Experiences', value: orderedExperiences.length, note: 'Approved reusable experience references.', variant: orderedExperiences.length ? 'info' : 'outline' },
      { label: 'Promotable', value: promotable, note: 'Validated enough to consider skill promotion.', variant: promotable ? 'success' : 'outline' },
      { label: 'Conflicted', value: conflicted, note: 'Reuse evidence recorded a conflict.', variant: conflicted ? 'warning' : 'outline' },
      { label: 'Skills', value: skills.length, note: 'Runtime and instruction skills in the catalog.', variant: skills.length ? 'success' : 'outline' },
    ];
  }, [orderedExperiences, skills.length]);

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

  const openCreate = () => {
    const proposalId = `experience-${Date.now()}`;
    setModalMode('create');
    setModalTargetId(null);
    setDraft({
      ...EMPTY_DRAFT,
      proposalId,
      patternKey: normalizeGovernanceExperienceId(proposalId),
      title: 'New reusable experience',
      referenceSummary: 'Describe the repeated task pattern and the evidence that makes it reusable.',
    });
    setModalOpen(true);
  };

  const openEdit = (record: ExperienceRecord, mode: 'edit' | 'view') => {
    setModalMode(mode);
    setModalTargetId(record.proposalId);
    setDraft(createGovernanceExperienceDraft(record));
    setModalOpen(true);
  };

  const saveExperience = async () => {
    const payload = toGovernanceExperiencePayload(draft);
    if (modalMode === 'edit' && modalTargetId) {
      return api.updateExperience(modalTargetId, payload);
    }
    return api.createExperience(payload);
  };

  const exportExperiences = async (format: 'json' | 'markdown') => {
    const bundle = await api.exportExperiences(format);
    const extension = format === 'markdown' ? 'md' : 'json';
    downloadTextFile(
      `experience-export-${new Date(bundle.generatedAt).toISOString().replace(/[:.]/g, '-')}.${extension}`,
      bundle.content,
      format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8',
    );
  };

  const exportSkills = async (format: 'json' | 'markdown') => {
    const bundle = await api.exportSkills(format);
    const extension = format === 'markdown' ? 'md' : 'json';
    downloadTextFile(
      `skill-export-${new Date(bundle.generatedAt).toISOString().replace(/[:.]/g, '-')}.${extension}`,
      bundle.content,
      format === 'markdown' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8',
    );
  };

  const toggleSelection = (experienceId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(experienceId);
      } else {
        next.delete(experienceId);
      }
      return next;
    });
  };

  const togglePageSelection = (checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const record of pagedExperiences) {
        if (checked) {
          next.add(record.proposalId);
        } else {
          next.delete(record.proposalId);
        }
      }
      return next;
    });
  };

  return (
    <AdminPageShell
      summary={<SummaryStrip items={summaryItems} />}
    >
      <Card className="border-border-subtle bg-surface/30">
        <CardHeader className="flex flex-col gap-3 py-3.5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Experience governance</p>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">Experience to skill pipeline</h2>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              Manage approved experience references, export them, and promote validated records into instruction skills.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button data-testid="settings-governance-experience-create" disabled={busyKey !== null} onClick={openCreate}>
              <Plus className="h-4 w-4" />
              Create experience
            </Button>
            <Button data-testid="settings-governance-experience-export-json" variant="secondary" disabled={busyKey !== null} onClick={() => void runAction('experience-export-json', () => exportExperiences('json'), 'Experience JSON export prepared.', { reload: false })}>
              <Download className="h-4 w-4" />
              Export JSON
            </Button>
            <Button data-testid="settings-governance-experience-export-markdown" variant="secondary" disabled={busyKey !== null} onClick={() => void runAction('experience-export-md', () => exportExperiences('markdown'), 'Experience Markdown export prepared.', { reload: false })}>
              <Download className="h-4 w-4" />
              Export MD
            </Button>
            <Button data-testid="settings-governance-experience-bulk-delete" variant="ghost" disabled={busyKey !== null || selectedExperienceIds.length === 0} onClick={() => setBulkDeleteRequested(true)}>
              <Trash2 className="h-4 w-4" />
              Delete selected
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ManagementTable testId="settings-governance-experience-table">
            <ManagementTableHeader columns="2rem minmax(0,1.35fr) minmax(0,0.75fr) minmax(0,0.8fr) minmax(0,0.8fr) auto">
              <Checkbox
                checked={pagedExperiences.length > 0 && pagedExperiences.every((record) => selectedIds.has(record.proposalId))}
                aria-label="Select page experiences"
                onChange={(event) => togglePageSelection(event.currentTarget.checked)}
              />
              <span>Experience</span>
              <span>Status</span>
              <span>Evidence</span>
              <span>Updated</span>
              <span className="text-right">Actions</span>
            </ManagementTableHeader>
            <ManagementTableBody>
              {pagedExperiences.map((record) => (
                <ManagementTableRow
                  key={record.proposalId}
                  columns="2rem minmax(0,1.35fr) minmax(0,0.75fr) minmax(0,0.8fr) minmax(0,0.8fr) auto"
                  testId={`settings-governance-experience-row-${record.proposalId}`}
                >
                  <Checkbox
                    checked={selectedIds.has(record.proposalId)}
                    aria-label={`Select ${record.title}`}
                    onChange={(event) => toggleSelection(record.proposalId, event.currentTarget.checked)}
                  />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{record.title}</p>
                    <p className="mt-1 line-clamp-1 text-sm text-text-secondary">{record.referenceSummary}</p>
                    <p className="mt-1 truncate text-xs text-text-muted">{record.materializedPath}</p>
                  </div>
                  <div>
                    <Badge variant={getGovernanceStatusVariant(record.validationStatus)}>{record.validationStatus}</Badge>
                    <p className="mt-2 text-xs text-text-secondary">confidence {record.confidence.toFixed(2)}</p>
                  </div>
                  <div className="text-sm text-text-secondary">
                    <p>{record.successfulReuseTaskIds.length} successful</p>
                    <p className="mt-1">{record.failedReuseTaskIds.length} failed</p>
                  </div>
                  <div className="text-sm text-text-secondary">{formatGovernanceTime(record.updatedAt)}</div>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    <Button size="sm" variant="secondary" onClick={() => openEdit(record, 'view')}>View</Button>
                    <Button size="sm" variant="secondary" disabled={busyKey !== null} onClick={() => openEdit(record, 'edit')}>
                      <Pencil className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busyKey !== null}
                      onClick={() => void runAction(`experience-promote-${record.proposalId}`, () => api.promoteExperienceToSkill(record.proposalId), 'Experience promoted into a managed skill.')}
                    >
                      <Sparkles className="h-4 w-4" />
                      Promote
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busyKey !== null} onClick={() => setDeleteTarget(record)}>
                      Delete
                    </Button>
                  </div>
                </ManagementTableRow>
              ))}
            </ManagementTableBody>
          </ManagementTable>
          <div className="mt-4">
            <PaginationBar
              currentPage={currentPage}
              totalPages={totalPages}
              totalItems={orderedExperiences.length}
              itemLabel="experiences"
              disabled={busyKey !== null}
              onPrevious={() => setCurrentPage((current) => Math.max(1, current - 1))}
              onNext={() => setCurrentPage((current) => Math.min(totalPages, current + 1))}
            />
          </div>
        </CardContent>
      </Card>

      <Card className="border-border-subtle bg-surface/30" data-testid="settings-governance-skills-card">
        <CardHeader className="flex flex-col gap-3 py-3.5 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-text-muted">Skill governance</p>
            <h2 className="mt-1 text-lg font-semibold text-text-primary">Managed skill catalog</h2>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              Review runtime and instruction skills generated from promoted experience records or maintained directly in the skill catalog.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button data-testid="settings-governance-skill-export-json" variant="secondary" disabled={busyKey !== null} onClick={() => void runAction('skill-export-json', () => exportSkills('json'), 'Skill JSON export prepared.', { reload: false })}>
              <Download className="h-4 w-4" />
              Export JSON
            </Button>
            <Button data-testid="settings-governance-skill-export-markdown" variant="secondary" disabled={busyKey !== null} onClick={() => void runAction('skill-export-md', () => exportSkills('markdown'), 'Skill Markdown export prepared.', { reload: false })}>
              <Download className="h-4 w-4" />
              Export MD
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ManagementTable testId="settings-governance-skill-table">
            <ManagementTableHeader columns="minmax(0,1.35fr) minmax(0,0.75fr) minmax(0,0.75fr) minmax(0,1fr)">
              <span>Skill</span>
              <span>Kind</span>
              <span>Status</span>
              <span>Source</span>
            </ManagementTableHeader>
            <ManagementTableBody>
              {orderedSkills.map((entry) => (
                <ManagementTableRow
                  key={entry.skill.id}
                  columns="minmax(0,1.35fr) minmax(0,0.75fr) minmax(0,0.75fr) minmax(0,1fr)"
                  testId={`settings-governance-skill-row-${entry.skill.id}`}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-text-primary">{entry.skill.name}</p>
                    <p className="mt-1 truncate text-xs text-text-muted">{entry.skill.rootDir}</p>
                  </div>
                  <Badge variant="outline">{entry.kind}</Badge>
                  <Badge variant={entry.readiness === 'ready' ? 'success' : 'outline'}>{entry.readiness}</Badge>
                  <div className="min-w-0 text-sm text-text-secondary">
                    <p className="truncate">{entry.source}</p>
                    <p className="mt-1 text-xs text-text-muted">{entry.editable ? 'editable' : 'managed'}</p>
                  </div>
                </ManagementTableRow>
              ))}
            </ManagementTableBody>
          </ManagementTable>
        </CardContent>
      </Card>

      <AdminModal
        open={modalOpen}
        testId="settings-governance-experience-modal"
        eyebrow={modalMode === 'create' ? 'New experience' : modalMode === 'view' ? 'Experience details' : 'Edit experience'}
        title={draft.title || 'Experience'}
        description="Keep reusable knowledge explicit: experience.md remains advisory until it has enough reuse evidence to become a skill."
        size="xl"
        onClose={() => setModalOpen(false)}
        footer={(
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-text-secondary">Markdown is generated automatically unless a draft body is provided.</p>
            <div className="flex gap-2">
              <Button variant="ghost" disabled={busyKey !== null} onClick={() => setModalOpen(false)}>
                {modalMode === 'view' ? 'Close' : 'Cancel'}
              </Button>
              {modalMode !== 'view' ? (
                <Button
                  disabled={busyKey !== null || !draft.title.trim() || !draft.referenceSummary.trim()}
                  onClick={() => void runAction(
                    modalMode === 'create' ? 'experience-create' : `experience-save-${modalTargetId ?? 'draft'}`,
                    async () => {
                      const result = await saveExperience();
                      setModalOpen(false);
                      return result;
                    },
                    modalMode === 'create' ? 'Experience created.' : 'Experience saved.',
                  )}
                >
                  {modalMode === 'create' ? 'Create experience' : 'Save changes'}
                </Button>
              ) : null}
            </div>
          </div>
        )}
      >
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.2fr)]">
          <div className="space-y-3">
            <label className="grid gap-2 text-sm text-text-secondary">
              ID
              <Input value={draft.proposalId} readOnly={modalMode !== 'create'} onChange={(event) => setDraft((current) => ({ ...current, proposalId: event.target.value, patternKey: current.patternKey || normalizeGovernanceExperienceId(event.target.value) }))} />
            </label>
            <label className="grid gap-2 text-sm text-text-secondary">
              Title
              <Input value={draft.title} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))} />
            </label>
            <label className="grid gap-2 text-sm text-text-secondary">
              Pattern key
              <Input value={draft.patternKey} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, patternKey: event.target.value }))} />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-2 text-sm text-text-secondary">
                Status
                <SelectInput value={draft.validationStatus} disabled={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, validationStatus: event.target.value as ExperienceRecord['validationStatus'] }))}>
                  <option value="monitoring">monitoring</option>
                  <option value="promotable">promotable</option>
                  <option value="conflicted">conflicted</option>
                </SelectInput>
              </label>
              <label className="grid gap-2 text-sm text-text-secondary">
                Confidence
                <Input type="number" min="0" max="1" step="0.01" value={draft.confidence} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, confidence: event.target.value }))} />
              </label>
            </div>
            <label className="grid gap-2 text-sm text-text-secondary">
              Reference summary
              <Textarea rows={5} value={draft.referenceSummary} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, referenceSummary: event.target.value }))} />
            </label>
          </div>
          <div className="space-y-3">
            <label className="grid gap-2 text-sm text-text-secondary">
              Applicable scenarios
              <Textarea rows={5} value={draft.applicableScenarios} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, applicableScenarios: event.target.value }))} />
            </label>
            <label className="grid gap-2 text-sm text-text-secondary">
              Limits
              <Textarea rows={5} value={draft.limitations} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, limitations: event.target.value }))} />
            </label>
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-2 text-sm text-text-secondary">
                Successful reuse task IDs
                <Textarea rows={4} value={draft.successfulReuseTaskIds} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, successfulReuseTaskIds: event.target.value }))} />
              </label>
              <label className="grid gap-2 text-sm text-text-secondary">
                Failed reuse task IDs
                <Textarea rows={4} value={draft.failedReuseTaskIds} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, failedReuseTaskIds: event.target.value }))} />
              </label>
            </div>
            <label className="grid gap-2 text-sm text-text-secondary">
              Optional experience.md body
              <Textarea rows={8} className="font-mono text-[13px]" value={draft.draftExperienceMarkdown} readOnly={modalMode === 'view'} onChange={(event) => setDraft((current) => ({ ...current, draftExperienceMarkdown: event.target.value }))} />
            </label>
          </div>
        </div>
      </AdminModal>

      <ConfirmDialog
        open={deleteTarget !== null}
        title={deleteTarget ? `Delete "${deleteTarget.title}"?` : 'Delete experience?'}
        description="Deleting an approved experience removes the governance record and its generated experience.md file."
        confirmLabel="Delete experience"
        cancelLabel="Keep experience"
        tone="danger"
        busy={busyKey !== null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) {
            return;
          }
          void runAction(
            `experience-delete-${deleteTarget.proposalId}`,
            async () => {
              const result = await api.deleteExperience(deleteTarget.proposalId);
              setDeleteTarget(null);
              return result;
            },
            'Experience deleted.',
          );
        }}
      />

      <ConfirmDialog
        open={bulkDeleteRequested}
        testId="settings-governance-experience-bulk-delete-confirm"
        title={`Delete ${selectedExperienceIds.length} selected experience(s)?`}
        description="This removes selected approved experience records and their generated Markdown files."
        confirmLabel="Delete selected"
        cancelLabel="Keep experiences"
        tone="danger"
        busy={busyKey !== null}
        onCancel={() => setBulkDeleteRequested(false)}
        onConfirm={() => {
          void runAction(
            'experience-bulk-delete',
            async () => {
              const result = await api.bulkDeleteExperiences(selectedExperienceIds);
              setBulkDeleteRequested(false);
              setSelectedIds(new Set());
              return result;
            },
            `Deleted ${selectedExperienceIds.length} selected experience(s).`,
          );
        }}
      />
    </AdminPageShell>
  );
}
