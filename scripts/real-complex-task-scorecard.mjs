import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { resolveBackendRuntimeRoot } from './lib/backend-runtime-paths.mjs';

const rootDir = process.cwd();
const logsDir = path.resolve(rootDir, '.codex-run', 'logs');
const backendDataDir = path.join(resolveBackendRuntimeRoot(rootDir), 'platform', 'improvements');
const reportPath = process.env.REAL_COMPLEX_TASK_SCORECARD_REPORT
  ?? path.resolve(logsDir, 'real-complex-task-scorecard.json');

async function readJsonIfExists(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function countBy(items, predicate) {
  return items.filter(predicate).length;
}

function normalizeReportStatus(report) {
  if (!report) {
    return 'missing';
  }
  if (typeof report.status === 'string') {
    return report.status.toLowerCase();
  }
  if (report.passes === true) {
    return 'achieved';
  }
  return 'unknown';
}

function normalizeCuratedEntry(name, report) {
  const status = normalizeReportStatus(report);
  return {
    name,
    status,
    passed: status === 'achieved' || status === 'passed' || status === 'success',
    generatedAt: report?.generatedAt ?? report?.completedAt ?? report?.timestamp ?? null,
  };
}

async function main() {
  const [
    mainlineReview,
    liveReview,
    delegationReview,
    improvementAudit,
    instructionSkillAudit,
    governanceAudit,
    lessonMemoryDedupeAudit,
    archive,
    taskStates,
    proposals,
    memories,
  ] = await Promise.all([
    readJsonIfExists(path.join(logsDir, 'frontend-mainline-review.json')),
    readJsonIfExists(path.join(logsDir, 'frontend-live-task-review.json')),
    readJsonIfExists(path.join(logsDir, 'frontend-delegation-live-review.json')),
    readJsonIfExists(path.join(logsDir, 'frontend-improvement-proposal-audit.json')),
    readJsonIfExists(path.join(logsDir, 'frontend-instruction-skill-proposal-audit.json')),
    readJsonIfExists(path.join(logsDir, 'frontend-improvement-governance-audit.json')),
    readJsonIfExists(path.join(logsDir, 'lesson-memory-dedupe-audit.json')),
    readJsonIfExists(path.join(backendDataDir, 'real-task-archive.json')),
    readJsonIfExists(path.join(backendDataDir, 'task-states.json')),
    readJsonIfExists(path.join(backendDataDir, 'proposals.json')),
    readJsonIfExists(path.join(resolveBackendRuntimeRoot(rootDir), 'platform', 'memories.json')),
  ]);

  const archiveEntries = Array.isArray(archive) ? archive : [];
  const taskStateEntries = Array.isArray(taskStates) ? taskStates : [];
  const proposalEntries = Array.isArray(proposals) ? proposals : [];
  const memoryEntries = Array.isArray(memories) ? memories : [];
  const curated = [
    normalizeCuratedEntry('mainline-review', mainlineReview),
    normalizeCuratedEntry('live-review', liveReview),
    normalizeCuratedEntry('delegation-live-review', delegationReview),
    normalizeCuratedEntry('improvement-proposal-audit', improvementAudit),
    normalizeCuratedEntry('instruction-skill-proposal-audit', instructionSkillAudit),
    normalizeCuratedEntry('improvement-governance-audit', governanceAudit),
    normalizeCuratedEntry('lesson-memory-dedupe-audit', lessonMemoryDedupeAudit),
  ];

  const failureCounter = new Map();
  for (const entry of archiveEntries) {
    const taxonomy = Array.isArray(entry?.experienceReport?.failureTaxonomy)
      ? entry.experienceReport.failureTaxonomy
      : [];
    for (const category of taxonomy) {
      failureCounter.set(category, (failureCounter.get(category) ?? 0) + 1);
    }
  }

  const truthComplete = countBy(
    archiveEntries,
    (entry) => entry?.experienceReport?.truthCompleteness === 'complete',
  );
  const truthPartial = countBy(
    archiveEntries,
    (entry) => entry?.experienceReport?.truthCompleteness === 'partial',
  );
  const delivered = countBy(
    archiveEntries,
    (entry) => entry?.experienceReport?.artifactEvidence === 'delivered',
  );
  const artifactOnly = countBy(
    archiveEntries,
    (entry) => entry?.experienceReport?.artifactEvidence === 'artifact_only',
  );
  const archiveEligibleCount = countBy(
    taskStateEntries,
    (entry) => entry?.archiveStatus?.eligible === true,
  );
  const archiveSkipped = taskStateEntries.filter((entry) => entry?.archiveStatus?.eligible !== true);
  const skipReasonCounter = new Map();
  for (const entry of archiveSkipped) {
    const reason = entry?.archiveStatus?.reason ?? 'unknown';
    skipReasonCounter.set(reason, (skipReasonCounter.get(reason) ?? 0) + 1);
  }
  const duplicateProposalCount = countBy(
    proposalEntries,
    (entry) => Boolean(entry?.duplicateOfProposalId),
  );
  const conflictedProposalCount = countBy(
    proposalEntries,
    (entry) => Array.isArray(entry?.conflictsWithProposalIds) && entry.conflictsWithProposalIds.length > 0,
  );
  const supersededProposalCount = countBy(
    proposalEntries,
    (entry) => Boolean(entry?.supersededByProposalId),
  );
  const lessonMemoryCount = countBy(
    memoryEntries,
    (entry) => entry?.metadata?.layer === 'lesson',
  );
  const generatedInstructionSkillCount = countBy(
    proposalEntries,
    (entry) => entry?.kind === 'instruction_skill' && Boolean(entry?.instructionSkillProposal?.materializedRootDir),
  );
  const duplicateRatio = proposalEntries.length > 0 ? duplicateProposalCount / proposalEntries.length : 0;
  const conflictedRatio = proposalEntries.length > 0 ? conflictedProposalCount / proposalEntries.length : 0;
  const completeRatio = archiveEntries.length > 0 ? truthComplete / archiveEntries.length : 0;
  const curatedPassed = curated.every((entry) => entry.passed);
  const status = curatedPassed
    && archiveEligibleCount > 0
    && duplicateRatio <= 0.25
    && conflictedRatio <= 0.2
    && completeRatio >= 0.8
    ? 'achieved'
    : 'open_gap';

  const report = {
    generatedAt: new Date().toISOString(),
    status,
    curatedSuite: {
      total: curated.length,
      passed: curated.filter((entry) => entry.passed).length,
      failed: curated.filter((entry) => !entry.passed).length,
      entries: curated,
    },
    realTaskArchive: {
      total: archiveEntries.length,
      completed: countBy(archiveEntries, (entry) => entry?.lifecycleStatus === 'COMPLETED'),
      failed: countBy(archiveEntries, (entry) => entry?.lifecycleStatus === 'FAILED'),
      cancelled: countBy(archiveEntries, (entry) => entry?.lifecycleStatus === 'CANCELLED'),
      delivered,
      artifactOnly,
      proposalGenerated: archiveEntries.reduce((count, entry) => count + (Array.isArray(entry?.proposalIds) ? entry.proposalIds.length : 0), 0),
    },
    archiveEligibilityEvidence: {
      archiveEligibleCount,
      archiveSkippedCount: archiveSkipped.length,
      skipReasons: [...skipReasonCounter.entries()].map(([reason, count]) => ({ reason, count })),
    },
    governanceNoise: {
      duplicateProposalCount,
      conflictedProposalCount,
      supersededProposalCount,
      duplicateRatio,
      conflictedRatio,
    },
    proposalInventory: {
      total: proposalEntries.length,
      pending: countBy(proposalEntries, (entry) => entry?.status === 'PENDING'),
      approved: countBy(proposalEntries, (entry) => entry?.status === 'APPROVED'),
      rejected: countBy(proposalEntries, (entry) => entry?.status === 'REJECTED'),
      lesson: countBy(proposalEntries, (entry) => entry?.kind === 'lesson'),
      instructionSkill: countBy(proposalEntries, (entry) => entry?.kind === 'instruction_skill'),
      optimization: countBy(proposalEntries, (entry) => entry?.kind === 'optimization'),
    },
    truthCompleteness: {
      complete: truthComplete,
      partial: truthPartial,
      completeRatio,
    },
    failureTaxonomy: [...failureCounter.entries()].map(([category, count]) => ({ category, count })),
    proposalGenerationEvidence: {
      lesson: countBy(proposalEntries, (entry) => entry?.kind === 'lesson'),
      instructionSkill: countBy(proposalEntries, (entry) => entry?.kind === 'instruction_skill'),
      optimization: countBy(proposalEntries, (entry) => entry?.kind === 'optimization'),
      lessonMemoryCount,
      generatedInstructionSkillCount,
    },
  };

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
