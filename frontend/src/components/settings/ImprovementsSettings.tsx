import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/empty-state';
import { ExpandableRow } from '../ui/expandable-row';
import {
  SettingsSection,
  SettingsGrid,
  StatCard,
} from './SettingsSection';
import type { PlatformOverviewData } from '../../hooks/usePlatformOverview';
import type { ImprovementProposal } from '../../types';

interface ImprovementsSettingsProps {
  data?: PlatformOverviewData | null;
  busyKey: string | null;
  onAction: <T>(key: string, action: () => Promise<T>, successMessage: string, options?: { reload?: boolean }) => Promise<T | null>;
}

const FILTERS = [
  ['all', 'All'],
  ['pending', 'Pending'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['conflicted', 'Conflicted'],
  ['duplicates', 'Duplicates'],
  ['archive-eligible', 'Archive eligible'],
] as const;

function ProposalBadge({ proposal }: { proposal: ImprovementProposal }) {
  const variant = proposal.status === 'APPROVED'
    ? 'success'
    : proposal.status === 'REJECTED'
      ? 'outline'
      : 'warning';
  const label = proposal.kind === 'experience'
    ? 'Experience'
    : proposal.kind === 'instruction_skill'
      ? 'Instruction skill'
      : proposal.kind === 'optimization'
        ? 'Optimization'
        : 'Lesson';
  return <Badge variant={variant}>{label} · {proposal.status.toLowerCase()}</Badge>;
}

export function ImprovementsSettings({ data, busyKey, onAction }: ImprovementsSettingsProps) {
  const [filter, setFilter] = useState<string>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const proposals = data?.improvements ?? [];
  const archive = data?.archive ?? [];
  const report = data?.complexReport ?? null;

  const filteredProposals = useMemo(() => {
    switch (filter) {
      case 'all':
        return proposals;
      case 'conflicted':
        return proposals.filter((p: ImprovementProposal) => p.conflictsWithProposalIds.length > 0);
      case 'duplicates':
        return proposals.filter((p: ImprovementProposal) => Boolean(p.duplicateOfProposalId));
      case 'archive-eligible':
        return proposals.filter((p: ImprovementProposal) => p.archiveEligible);
      default:
        return proposals.filter((p: ImprovementProposal) => p.status.toLowerCase() === filter);
    }
  }, [proposals, filter]);

  const visibleCount = 4;
  const visibleProposals = showAll ? filteredProposals : filteredProposals.slice(0, visibleCount);
  const hasMore = filteredProposals.length > visibleCount;

  return (
    <div className="space-y-4">
      <SettingsSection
        eyebrow="Improvements"
        title="Proposal inbox"
        description="Review generated lessons, experience references, and optimization recommendations."
      >
        <SettingsGrid cols={4}>
          <StatCard
            label="Proposals"
            value={proposals.length}
            note="Generated post-task"
            variant={proposals.length > 0 ? 'info' : 'default'}
          />
          <StatCard
            label="Archive eligible"
            value={report?.archiveEligibleCount ?? archive.length}
            note="Complex tasks retained"
            variant="default"
          />
          <StatCard
            label="Governance noise"
            value={(report?.duplicateProposalCount ?? 0) + (report?.conflictedProposalCount ?? 0)}
            note="Duplicates & conflicts"
            variant={(report?.duplicateProposalCount ?? 0) + (report?.conflictedProposalCount ?? 0) > 0 ? 'warning' : 'default'}
          />
          <StatCard
            label="Experience refs"
            value={report?.generatedExperienceCount ?? 0}
            note="Pending validation"
            variant={report?.generatedExperienceCount ?? 0 > 0 ? 'success' : 'default'}
          />
        </SettingsGrid>

        <div className="flex flex-wrap gap-2">
          {FILTERS.map(([key, label]) => (
            <Button
              key={key}
              variant={filter === key ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                setFilter(key);
                setShowAll(false);
              }}
              data-testid={`settings-improvements-filter-${key}`}
            >
              {label}
            </Button>
          ))}
        </div>

        <div className="space-y-3">
          {filteredProposals.length === 0 ? (
            <EmptyState
              title="No proposals match"
              description="Terminal tasks will generate proposals here once archived."
            />
          ) : (
            <>
              {visibleProposals.map((proposal: ImprovementProposal) => (
                <ExpandableRow
                  key={proposal.proposalId}
                  testId={`settings-improvement-${proposal.proposalId}`}
                  summaryTestId={`settings-improvement-toggle-${proposal.proposalId}`}
                  open={expandedId === proposal.proposalId}
                  onToggle={() => setExpandedId((current) =>
                    current === proposal.proposalId ? null : proposal.proposalId
                  )}
                  summary={(
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="truncate text-sm font-semibold text-text-primary">{proposal.title}</p>
                          <ProposalBadge proposal={proposal} />
                          {proposal.archiveEligible ? <Badge variant="info">archive</Badge> : null}
                          {proposal.duplicateOfProposalId ? <Badge variant="warning">duplicate</Badge> : null}
                          {proposal.conflictsWithProposalIds.length > 0 ? <Badge variant="warning">conflict</Badge> : null}
                        </div>
                        <p className="mt-1 text-xs text-text-secondary">
                          {proposal.kind.replace('_', ' ')} · {proposal.status.toLowerCase()} · Evidence: {proposal.evidenceTaskIds.length} · Quality: {proposal.qualityScore.toFixed(2)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right text-[11px] text-text-muted">
                        <p>{proposal.experienceReport.outcome}</p>
                      </div>
                    </div>
                  )}
                  details={(
                    <div className="space-y-3">
                      <div className="rounded-lg border border-border-subtle bg-surface/18 px-3 py-3">
                        <p className="text-[11px] uppercase tracking-[0.2em] text-text-muted">Summary</p>
                        <p className="mt-2 text-sm leading-6 text-text-primary">{proposal.summary}</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={busyKey !== null || proposal.status === 'APPROVED'}
                          onClick={() => void onAction(
                            `approve-${proposal.proposalId}`,
                            () => api.approveImprovementProposal(proposal.proposalId),
                            'Improvement proposal approved.'
                          )}
                        >
                          Approve
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={busyKey !== null || proposal.status === 'REJECTED'}
                          onClick={() => void onAction(
                            `reject-${proposal.proposalId}`,
                            () => api.rejectImprovementProposal(proposal.proposalId),
                            'Improvement proposal rejected.'
                          )}
                        >
                          Reject
                        </Button>
                      </div>
                    </div>
                  )}
                />
              ))}
              {hasMore ? (
                <div className="flex justify-center pt-1">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShowAll((current) => !current)}
                  >
                    {showAll ? 'Show fewer' : `Show ${filteredProposals.length - visibleCount} more`}
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </SettingsSection>

      {archive.length > 0 ? (
        <SettingsSection
          eyebrow="Archive"
          title="Complex task archive"
          description="Terminal tasks that crossed the complexity threshold."
        >
          <div className="space-y-3">
            {archive.slice(0, 4).map((entry) => (
              <div
                key={entry.archiveEntryId}
                data-testid={`settings-archive-${entry.archiveEntryId}`}
                className="flex items-start justify-between gap-3 rounded-lg border border-border-subtle bg-surface/18 px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-semibold text-text-primary">{entry.taskTitle}</p>
                    <Badge variant={entry.lifecycleStatus === 'COMPLETED' ? 'success' : entry.lifecycleStatus === 'FAILED' ? 'error' : 'outline'}>
                      {entry.lifecycleStatus.toLowerCase()}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    Quality {entry.qualityScore.toFixed(2)} · {entry.patternKey}
                  </p>
                </div>
                <div className="shrink-0 text-right text-[11px] text-text-muted">
                  <p>{entry.complexitySignals.length} signals</p>
                </div>
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}
    </div>
  );
}
