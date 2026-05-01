import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function isSkippableRemovalError(error) {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')
  );
}

async function safeRemove(target) {
  try {
    await fs.rm(target, { recursive: true, force: true });
    return { removed: true };
  } catch (error) {
    if (isSkippableRemovalError(error)) {
      return {
        removed: false,
        skipped: true,
        reason: error.code
      };
    }
    throw error;
  }
}

async function listDirectorySafe(target) {
  try {
    return await fs.readdir(target, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function cleanHistoricalTestArtifacts(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const tmpDir = options.tmpDir ?? os.tmpdir();
  const tempPrefixes = options.tempPrefixes ?? ['backend-new-'];
  const logsDir = options.logsDir ?? path.resolve(cwd, '.codex-run', 'logs');
  const preservedLogPatterns = options.preservedLogPatterns ?? [
    /^release-scorecard(?:\.[^.]+)?\.json$/,
    /^live-cost-probe(?:\.[^.]+)?\.json$/,
    /^live-provider-scenarios(?:\.[^.]+)?\.json$/,
    /^real-task-wave-report(?:\.[^.]+)?\.(?:json|md)$/,
    /^real-task-wave-matrix$/,
    /^human-task-matrix$/,
    /^real-task-manual-review(?:\.[^.]+)?\.(?:json|md)$/,
    /^frontend-smoke-report(?:\.[^.]+)?\.json$/,
    /^frontend-smoke-snapshots$/,
    /^frontend-mainline-review(?:\.[^.]+)?\.json$/,
    /^frontend-mainline-review$/,
    /^frontend-e2e-report(?:\.[^.]+)?\.json$/,
    /^frontend-e2e$/,
    /^actual-user-cli-report(?:\.[^.]+)?\.json$/,
    /^workflow(?:\.[^.]+)?\.json$/,
    /^breadth(?:\.[^.]+)?\.json$/,
    /^flagship(?:\.[^.]+)?\.json$/,
    /^general-complex(?:\.[^.]+)?\.json$/,
    /^real-task-completion(?:\.[^.]+)?\.json$/,
    /^public-capability-parity(?:\.[^.]+)?\.json$/,
    /^manual-artifact-audit(?:\.[^.]+)?\.json$/,
    /^practical-task-acceptance(?:\.[^.]+)?\.json$/,
    /^practical-manual-audit(?:\.[^.]+)?\.json$/,
    /^practical-live-task-acceptance(?:\.[^.]+)?\.json$/,
    /^practical-live-manual-audit(?:\.[^.]+)?\.json$/,
    /^ecommerce-delivery(?:\.[^.]+)?\.json$/,
    /^ecommerce-readiness(?:\.[^.]+)?\.json$/,
    /^cli-interaction-transcript(?:\.[^.]+)?\.json$/,
    /^runtime-stress-validation(?:\.[^.]+)?\.json$/,
    /^benchmark(?:\.[^.]+)?\.json$/
  ];
  const projectArtifactPaths = options.projectArtifactPaths ?? [
    'backend/docs/docs',
    'backend/docs/live-review-artifacts',
    'backend/docs/actual-cli-artifacts'
  ];

  const tempEntries = await listDirectorySafe(tmpDir);
  const removedTempRoots = [];
  const skippedTempRoots = [];
  for (const entry of tempEntries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!tempPrefixes.some((prefix) => entry.name.startsWith(prefix))) {
      continue;
    }
    const target = path.join(tmpDir, entry.name);
    const result = await safeRemove(target);
    if (result.removed) {
      removedTempRoots.push(target);
      continue;
    }
    skippedTempRoots.push({ target, reason: result.reason ?? 'unknown' });
  }

  const logEntries = await listDirectorySafe(logsDir);
  const removedLogs = [];
  const skippedLogs = [];
  for (const entry of logEntries) {
    if (preservedLogPatterns.some((pattern) => pattern.test(entry.name))) {
      skippedLogs.push({ target: path.join(logsDir, entry.name), reason: 'preserved' });
      continue;
    }
    const target = path.join(logsDir, entry.name);
    const result = await safeRemove(target);
    if (result.removed) {
      removedLogs.push(target);
      continue;
    }
    skippedLogs.push({ target, reason: result.reason ?? 'unknown' });
  }
  await fs.mkdir(logsDir, { recursive: true });

  const removedProjectArtifacts = [];
  const skippedProjectArtifacts = [];
  for (const relativePath of projectArtifactPaths) {
    const target = path.resolve(cwd, relativePath);
    if (!isInside(cwd, target)) {
      skippedProjectArtifacts.push({ target, reason: 'outside_workspace' });
      continue;
    }
    const result = await safeRemove(target);
    if (result.removed) {
      removedProjectArtifacts.push(target);
      continue;
    }
    skippedProjectArtifacts.push({ target, reason: result.reason ?? 'unknown' });
  }

  return {
    removedTempRoots,
    skippedTempRoots,
    removedLogs,
    skippedLogs,
    removedProjectArtifacts,
    skippedProjectArtifacts
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cleanHistoricalTestArtifacts()
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exit(1);
    });
}
