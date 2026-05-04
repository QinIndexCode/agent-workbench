import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExperienceRecord, SkillCatalogEntry } from '../../types';
import {
  createGovernanceExperienceDraft,
  formatGovernanceTime,
  getGovernanceStatusVariant,
  GovernanceSettingsSection,
  normalizeGovernanceExperienceId,
  parseGovernanceLines,
  toGovernanceExperiencePayload,
} from './GovernanceSettingsSection';

const apiMock = vi.hoisted(() => ({
  bulkDeleteExperiences: vi.fn(),
  createExperience: vi.fn(),
  updateExperience: vi.fn(),
  deleteExperience: vi.fn(),
  exportExperiences: vi.fn(),
  promoteExperienceToSkill: vi.fn(),
  bulkDeleteSkills: vi.fn(),
  exportSkills: vi.fn(),
  refreshSkills: vi.fn(),
  createSkill: vi.fn(),
  updateSkill: vi.fn(),
  duplicateSkill: vi.fn(),
  deleteSkill: vi.fn(),
  importSkill: vi.fn(),
  importMarketplaceSkills: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  api: apiMock,
}));

const sampleExperience: ExperienceRecord = {
  proposalId: 'experience-runtime-guidance',
  patternKey: 'runtime-guidance',
  title: 'Runtime guidance loop',
  materializedPath: 'platform/generated-experiences/experience-runtime-guidance/experience.md',
  referenceSummary: 'Operators can insert guidance while a task keeps running.',
  applicableScenarios: ['running task correction'],
  limitations: ['requires backend confirmation'],
  confidence: 0.82,
  validationStatus: 'promotable',
  successfulReuseTaskIds: ['task-a'],
  failedReuseTaskIds: [],
  lastValidatedAt: 1777740000000,
  createdAt: 1777730000000,
  updatedAt: 1777740000000,
};

const sampleSkill: SkillCatalogEntry = {
  skill: {
    id: 'skill-runtime-guidance',
    name: 'Runtime guidance',
    rootDir: 'skills/runtime-guidance',
    description: 'Guide running task corrections.',
    kind: 'instruction-skill',
  },
  runtimeRegistered: true,
  capability: null,
  kind: 'instruction-skill',
  readiness: 'ready',
  source: 'generated',
  editable: true,
  deletable: true,
  duplicable: true,
  updatedAt: 1777740000000,
  content: '## Goal\n\nGuide running tasks.',
  assetSummary: null,
  instructionSource: null,
  declaredDependencies: {
    mcpServers: [],
  },
};

function renderGovernance(overrides?: {
  experiences?: ExperienceRecord[];
  skills?: SkillCatalogEntry[];
  onReload?: () => Promise<void>;
  onNotice?: (tone: 'success' | 'error' | 'info', message: string) => void;
}) {
  return render(
    <GovernanceSettingsSection
      experiences={overrides?.experiences ?? [sampleExperience]}
      skills={overrides?.skills ?? [sampleSkill]}
      onReload={overrides?.onReload ?? vi.fn().mockResolvedValue(undefined)}
      onNotice={overrides?.onNotice ?? vi.fn()}
    />,
  );
}

describe('GovernanceSettingsSection', () => {
  beforeEach(() => {
    apiMock.bulkDeleteExperiences.mockResolvedValue({
      resourceType: 'IMPROVEMENT',
      resourceId: 'experience-bulk-delete',
      action: 'DELETE',
      commandId: 'cmd-1',
      auditId: 'audit-1',
      appliedAt: 1777740000000,
      resource: {
        requestedIds: [sampleExperience.proposalId],
        deletedIds: [sampleExperience.proposalId],
        failed: [],
      },
    });
    apiMock.createExperience.mockResolvedValue({
      resourceType: 'IMPROVEMENT',
      resourceId: 'experience-new',
      action: 'CREATE',
      commandId: 'cmd-2',
      auditId: 'audit-2',
      appliedAt: 1777740000000,
      resource: sampleExperience,
    });
    apiMock.updateExperience.mockResolvedValue({
      resourceType: 'IMPROVEMENT',
      resourceId: sampleExperience.proposalId,
      action: 'UPDATE',
      commandId: 'cmd-4',
      auditId: 'audit-4',
      appliedAt: 1777740000000,
      resource: sampleExperience,
    });
    apiMock.deleteExperience.mockResolvedValue({
      resourceType: 'IMPROVEMENT',
      resourceId: sampleExperience.proposalId,
      action: 'DELETE',
      commandId: 'cmd-5',
      auditId: 'audit-5',
      appliedAt: 1777740000000,
      resource: { ok: true, experienceId: sampleExperience.proposalId },
    });
    apiMock.promoteExperienceToSkill.mockResolvedValue({
      resourceType: 'SKILL',
      resourceId: sampleSkill.skill.id,
      action: 'CREATE',
      commandId: 'cmd-6',
      auditId: 'audit-6',
      appliedAt: 1777740000000,
      resource: sampleSkill,
    });
    apiMock.exportExperiences.mockResolvedValue({
      generatedAt: 1777740000000,
      format: 'markdown',
      records: [sampleExperience],
      content: '# Experience Export\n',
    });
    apiMock.exportSkills.mockResolvedValue({
      generatedAt: 1777740000000,
      format: 'json',
      records: [sampleSkill],
      content: '{"records":[]}',
    });
    apiMock.bulkDeleteSkills.mockResolvedValue({
      resourceType: 'SKILL',
      resourceId: 'skills-bulk-delete',
      action: 'DELETE',
      commandId: 'cmd-3',
      auditId: 'audit-3',
      appliedAt: 1777740000000,
      resource: {
        requestedIds: [sampleSkill.skill.id],
        deletedIds: [sampleSkill.skill.id],
        failed: [],
      },
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:governance-export'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('renders experience and skill management in one governance workbench', () => {
    renderGovernance();

    expect(screen.getByText('Experience to skill pipeline')).toBeInTheDocument();
    expect(screen.getByText(sampleExperience.title)).toBeInTheDocument();
    expect(screen.getByText('Managed skill catalog')).toBeInTheDocument();
    expect(screen.getByText(sampleSkill.skill.name)).toBeInTheDocument();
  });

  it('bulk deletes selected experience records through the governance API', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn().mockResolvedValue(undefined);
    const onNotice = vi.fn();
    renderGovernance({ onReload, onNotice });

    await user.click(screen.getByLabelText(`Select ${sampleExperience.title}`));
    await user.click(screen.getByTestId('settings-governance-experience-bulk-delete'));

    const dialog = await screen.findByTestId('settings-governance-experience-bulk-delete-confirm-panel');
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete selected/i }));

    await waitFor(() => {
      expect(apiMock.bulkDeleteExperiences).toHaveBeenCalledWith([sampleExperience.proposalId]);
      expect(onReload).toHaveBeenCalled();
      expect(onNotice).toHaveBeenCalledWith('success', 'Deleted 1 selected experience(s).');
    });
  });

  it('creates experience records from the modal form', async () => {
    const user = userEvent.setup();
    renderGovernance({ experiences: [], skills: [] });

    await user.click(screen.getByRole('button', { name: /create experience/i }));
    await screen.findByTestId('settings-governance-experience-modal');

    const modal = screen.getByTestId('settings-governance-experience-modal-panel');
    fireEvent.change(within(modal).getByLabelText(/^id$/i), { target: { value: 'experience-new-guidance' } });
    fireEvent.change(within(modal).getByLabelText(/pattern key/i), { target: { value: 'new-guidance' } });
    fireEvent.change(within(modal).getByLabelText(/status/i), { target: { value: 'promotable' } });
    fireEvent.change(within(modal).getByLabelText(/confidence/i), { target: { value: '0.91' } });
    fireEvent.change(within(modal).getByLabelText(/title/i), { target: { value: 'Reusable pending guidance' } });
    fireEvent.change(within(modal).getByLabelText(/reference summary/i), { target: { value: 'Show pending guidance before backend confirmation.' } });
    fireEvent.change(within(modal).getByLabelText(/applicable scenarios/i), { target: { value: 'running task\noperator correction' } });
    fireEvent.change(within(modal).getByLabelText(/^limits$/i), { target: { value: 'needs backend ack' } });
    fireEvent.change(within(modal).getByLabelText(/successful reuse task ids/i), { target: { value: 'task-1\ntask-2' } });
    fireEvent.change(within(modal).getByLabelText(/failed reuse task ids/i), { target: { value: 'task-3' } });
    fireEvent.change(within(modal).getByLabelText(/optional experience.md body/i), { target: { value: '# Experience\n' } });

    const submitButtons = within(modal).getAllByRole('button', { name: /create experience/i });
    await user.click(submitButtons[submitButtons.length - 1]);

    await waitFor(() => {
      expect(apiMock.createExperience).toHaveBeenCalledWith(expect.objectContaining({
        proposalId: 'experience-new-guidance',
        patternKey: 'new-guidance',
        title: 'Reusable pending guidance',
        referenceSummary: 'Show pending guidance before backend confirmation.',
        applicableScenarios: ['running task', 'operator correction'],
        limitations: ['needs backend ack'],
        confidence: 0.91,
        validationStatus: 'promotable',
        successfulReuseTaskIds: ['task-1', 'task-2'],
        failedReuseTaskIds: ['task-3'],
        draftExperienceMarkdown: '# Experience',
      }));
    });
  });

  it('exports experience markdown bundles for review', async () => {
    const user = userEvent.setup();
    renderGovernance();

    await user.click(screen.getByTestId('settings-governance-experience-export-markdown'));

    await waitFor(() => {
      expect(apiMock.exportExperiences).toHaveBeenCalledWith('markdown');
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
  });

  it('exports experience JSON bundles and supports page selection cancelation', async () => {
    const user = userEvent.setup();
    renderGovernance();

    await user.click(screen.getByTestId('settings-governance-experience-export-json'));
    await waitFor(() => expect(apiMock.exportExperiences).toHaveBeenCalledWith('json'));

    await user.click(screen.getByLabelText(/select page experiences/i));
    expect(screen.getByTestId('settings-governance-experience-bulk-delete')).not.toBeDisabled();
    await user.click(screen.getByTestId('settings-governance-experience-bulk-delete'));
    const dialog = await screen.findByTestId('settings-governance-experience-bulk-delete-confirm-panel');
    await user.click(within(dialog).getByRole('button', { name: /keep experiences/i }));
    await waitFor(() => expect(screen.queryByTestId('settings-governance-experience-bulk-delete-confirm-panel')).not.toBeInTheDocument());
  });

  it('opens read-only experience details and closes without mutation', async () => {
    const user = userEvent.setup();
    renderGovernance();

    const row = screen.getByTestId(`settings-governance-experience-row-${sampleExperience.proposalId}`);
    await user.click(within(row).getByRole('button', { name: /view/i }));
    const modal = await screen.findByTestId('settings-governance-experience-modal-panel');
    expect(within(modal).getByLabelText(/title/i)).toHaveAttribute('readonly');
    const closeButtons = within(modal).getAllByRole('button', { name: /close/i });
    await user.click(closeButtons[closeButtons.length - 1]);
  });

  it('updates existing experience records from the edit modal', async () => {
    const user = userEvent.setup();
    renderGovernance();

    const row = screen.getByTestId(`settings-governance-experience-row-${sampleExperience.proposalId}`);
    await user.click(within(row).getByRole('button', { name: /edit/i }));
    const modal = await screen.findByTestId('settings-governance-experience-modal-panel');

    await user.clear(within(modal).getByLabelText(/reference summary/i));
    await user.type(within(modal).getByLabelText(/reference summary/i), 'Updated evidence summary.');
    await user.click(within(modal).getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(apiMock.updateExperience).toHaveBeenCalledWith(sampleExperience.proposalId, expect.objectContaining({
        referenceSummary: 'Updated evidence summary.',
      }));
    });
  });

  it('promotes an experience record into a managed skill', async () => {
    const user = userEvent.setup();
    const onReload = vi.fn().mockResolvedValue(undefined);
    renderGovernance({ onReload });

    await user.click(screen.getByRole('button', { name: /promote/i }));

    await waitFor(() => {
      expect(apiMock.promoteExperienceToSkill).toHaveBeenCalledWith(sampleExperience.proposalId);
      expect(onReload).toHaveBeenCalled();
    });
  });

  it('deletes a single experience record after confirmation', async () => {
    const user = userEvent.setup();
    renderGovernance();

    const deleteButtons = screen.getAllByRole('button', { name: /^delete$/i });
    await user.click(deleteButtons[0]);
    const dialog = await screen.findByText(`Delete "${sampleExperience.title}"?`);
    expect(dialog).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /delete experience/i }));

    await waitFor(() => {
      expect(apiMock.deleteExperience).toHaveBeenCalledWith(sampleExperience.proposalId);
    });
  });
});

describe('governance experience helpers', () => {
  it('normalizes ids, line lists, status variants, and timestamps', () => {
    expect(normalizeGovernanceExperienceId(' Runtime Guidance!! ')).toBe('runtime-guidance');
    expect(parseGovernanceLines('alpha, beta\n\n gamma ')).toEqual(['alpha', 'beta', 'gamma']);
    expect(formatGovernanceTime(null)).toBe('unknown');
    expect(formatGovernanceTime(1777740000000)).not.toBe('unknown');
    expect(getGovernanceStatusVariant('promotable')).toBe('success');
    expect(getGovernanceStatusVariant('conflicted')).toBe('warning');
    expect(getGovernanceStatusVariant('monitoring')).toBe('outline');
  });

  it('creates editable drafts and payloads without blank list entries', () => {
    const draft = createGovernanceExperienceDraft(sampleExperience);
    const payload = toGovernanceExperiencePayload({
      ...draft,
      applicableScenarios: 'task guidance,\n acceptance repair',
      limitations: 'backend confirmation',
      confidence: 'not-a-number',
      successfulReuseTaskIds: 'task-a,\n task-b',
      failedReuseTaskIds: '',
      draftExperienceMarkdown: '  ',
    });

    expect(draft.title).toBe(sampleExperience.title);
    expect(payload.applicableScenarios).toEqual(['task guidance', 'acceptance repair']);
    expect(payload.limitations).toEqual(['backend confirmation']);
    expect(payload.confidence).toBe(0.5);
    expect(payload.successfulReuseTaskIds).toEqual(['task-a', 'task-b']);
    expect(payload.failedReuseTaskIds).toEqual([]);
    expect(payload.draftExperienceMarkdown).toBeUndefined();
  });
});
