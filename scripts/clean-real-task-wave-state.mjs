import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  resolveBackendRuntimeRoot,
  resolveKnownLegacyResiduePaths,
} from './lib/backend-runtime-paths.mjs';

const DEFAULT_BACKEND_RUNTIME_DIRS = [
  'approvals',
  'checkpoints',
  'config-snapshots',
  'conversations',
  'events',
  'logs',
  'platform',
  'projections',
  'providers',
  'secrets',
  'sessions',
  'tasks',
  'tool-invocations',
  'traces',
  'validated-outputs',
  'workspace',
];

const DEFAULT_CODEX_RUN_DIRS = ['logs', 'tmp'];
const DEFAULT_EXTERNAL_PATHS = ['D:\\AAA'];
const STATIC_PRESERVED_REPO_PATHS = [
  'backend/data/.gitignore',
  'backend/data/providers/manifest.json',
];
const LEGACY_RESIDUE_LABELS = new Map([
  ['backend/backend', 'nested_backend_archive'],
  ['backend/config', 'nested_backend_legacy_config'],
  ['backend/workspace', 'nested_backend_legacy_workspace'],
  ['backend/backend_new_data', 'nested_backend_legacy_runtime_root'],
  ['backend_new_data', 'top_level_legacy_runtime_root'],
  ['config', 'top_level_legacy_config'],
  ['config-snapshots', 'top_level_legacy_config_snapshots'],
  ['platform', 'top_level_legacy_platform'],
  ['secrets', 'top_level_legacy_secrets'],
  ['workspace', 'top_level_legacy_workspace'],
  ['real-task-wave-run.log', 'legacy_real_task_wave_log'],
]);

function normalizeRepoRelativePath(value) {
  return value.split(path.sep).join('/');
}

function listDirectorySafe(target) {
  return fs.readdir(target, { withFileTypes: true }).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  });
}

function loadTrackedRepoPaths(rootDir) {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to read tracked repo paths.\n${result.stderr || result.stdout}`);
  }
  return new Set(
    result.stdout
      .split('\0')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => normalizeRepoRelativePath(entry)),
  );
}

function loadProtectedRepoPaths(rootDir) {
  const trackedPaths = loadTrackedRepoPaths(rootDir);
  for (const relativePath of STATIC_PRESERVED_REPO_PATHS) {
    trackedPaths.add(normalizeRepoRelativePath(relativePath));
  }
  return trackedPaths;
}

function hasTrackedDescendants(relativePath, trackedPaths) {
  const prefix = `${relativePath}/`;
  for (const trackedPath of trackedPaths) {
    if (trackedPath === relativePath || trackedPath.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

function describeLegacyResidue(rootDir, residuePath) {
  const relativePath = normalizeRepoRelativePath(path.relative(rootDir, residuePath));
  return LEGACY_RESIDUE_LABELS.get(relativePath) ?? relativePath.replace(/[/.]+/g, '_');
}

async function removePath(target, removedEntries, type) {
  await fs.rm(target, { recursive: true, force: true });
  removedEntries.push({
    type,
    path: target,
  });
}

async function purgeRepoDirectory(targetDir, relativeDir, trackedPaths, summary) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await listDirectorySafe(targetDir);
  for (const entry of entries) {
    const absolutePath = path.join(targetDir, entry.name);
    const relativePath = normalizeRepoRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (hasTrackedDescendants(relativePath, trackedPaths)) {
        await purgeRepoDirectory(absolutePath, relativePath, trackedPaths, summary);
        continue;
      }
      await removePath(absolutePath, summary.removedEntries, 'directory');
      continue;
    }
    if (trackedPaths.has(relativePath)) {
      summary.preservedEntries.push(relativePath);
      continue;
    }
    await removePath(absolutePath, summary.removedEntries, 'file');
  }
}

async function purgeExternalDirectory(targetDir, summary) {
  await fs.mkdir(targetDir, { recursive: true });
  const entries = await listDirectorySafe(targetDir);
  for (const entry of entries) {
    const absolutePath = path.join(targetDir, entry.name);
    await removePath(absolutePath, summary.removedEntries, entry.isDirectory() ? 'directory' : 'file');
  }
}

async function collectResidualRepoEntries(targetDir, relativeDir, trackedPaths, residuals = []) {
  const entries = await listDirectorySafe(targetDir);
  for (const entry of entries) {
    const absolutePath = path.join(targetDir, entry.name);
    const relativePath = normalizeRepoRelativePath(path.join(relativeDir, entry.name));
    if (entry.isDirectory()) {
      if (hasTrackedDescendants(relativePath, trackedPaths)) {
        await collectResidualRepoEntries(absolutePath, relativePath, trackedPaths, residuals);
        continue;
      }
      await collectResidualRepoEntries(absolutePath, relativePath, trackedPaths, residuals);
      continue;
    }
    if (!trackedPaths.has(relativePath)) {
      residuals.push(absolutePath);
    }
  }
  return residuals;
}

async function collectResidualExternalEntries(targetDir, residuals = []) {
  const entries = await listDirectorySafe(targetDir);
  for (const entry of entries) {
    const absolutePath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await collectResidualExternalEntries(absolutePath, residuals);
      continue;
    }
    residuals.push(absolutePath);
  }
  return residuals;
}

async function ensureDirectories(targets, recreatedEntries) {
  for (const target of targets) {
    await fs.mkdir(target, { recursive: true });
    recreatedEntries.push(target);
  }
}

export async function cleanRealTaskWaveState(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const trackedPaths = options.trackedPaths ?? loadProtectedRepoPaths(rootDir);
  const dotCodexRunRoot = path.resolve(rootDir, '.codex-run');
  const backendDataRoot = resolveBackendRuntimeRoot(rootDir);
  const externalPaths = options.externalPaths ?? DEFAULT_EXTERNAL_PATHS;
  const legacyResiduePaths = options.legacyResiduePaths ?? resolveKnownLegacyResiduePaths(rootDir);

  const summary = {
    generatedAt: new Date().toISOString(),
    rootDir,
    dotCodexRunRoot,
    backendDataRoot,
    externalPaths,
    cleanup: {
      dotCodexRun: {
        removedEntries: [],
        preservedEntries: [],
      },
      backendData: {
        removedEntries: [],
        preservedEntries: [],
      },
      external: externalPaths.map((target) => ({
        root: target,
        removedEntries: [],
      })),
      legacyResidue: [],
    },
    recreatedDirectories: [],
    residuals: {
      dotCodexRun: [],
      backendData: [],
      external: [],
    },
    ok: false,
  };

  await purgeRepoDirectory(dotCodexRunRoot, '.codex-run', trackedPaths, summary.cleanup.dotCodexRun);
  await purgeRepoDirectory(backendDataRoot, 'backend/data', trackedPaths, summary.cleanup.backendData);
  for (let index = 0; index < externalPaths.length; index += 1) {
    await purgeExternalDirectory(externalPaths[index], summary.cleanup.external[index]);
  }
  for (const legacyPath of legacyResiduePaths) {
    const relativePath = normalizeRepoRelativePath(path.relative(rootDir, legacyPath));
    if (!relativePath || relativePath === 'backend/data') {
      continue;
    }
    if (!hasTrackedDescendants(relativePath, trackedPaths)) {
      await removePath(legacyPath, summary.cleanup.legacyResidue, 'legacy');
      continue;
    }
    await purgeRepoDirectory(legacyPath, relativePath, trackedPaths, {
      removedEntries: summary.cleanup.legacyResidue,
      preservedEntries: summary.cleanup.backendData.preservedEntries,
    });
  }

  await ensureDirectories(
    [
      dotCodexRunRoot,
      ...DEFAULT_CODEX_RUN_DIRS.map((entry) => path.join(dotCodexRunRoot, entry)),
      backendDataRoot,
      ...DEFAULT_BACKEND_RUNTIME_DIRS.map((entry) => path.join(backendDataRoot, entry)),
      ...externalPaths,
    ],
    summary.recreatedDirectories,
  );

  summary.residuals.dotCodexRun = await collectResidualRepoEntries(dotCodexRunRoot, '.codex-run', trackedPaths);
  summary.residuals.backendData = await collectResidualRepoEntries(backendDataRoot, 'backend/data', trackedPaths);
  summary.residuals.external = [];
  for (const target of externalPaths) {
    summary.residuals.external.push({
      root: target,
      entries: await collectResidualExternalEntries(target),
    });
  }

  summary.cleanup.legacyResidue = summary.cleanup.legacyResidue.map((entry) => ({
    type: entry.type,
    label: describeLegacyResidue(rootDir, entry.path),
  }));

  summary.ok =
    summary.residuals.dotCodexRun.length === 0
    && summary.residuals.backendData.length === 0
    && summary.residuals.external.every((entry) => entry.entries.length === 0);

  return summary;
}

async function main() {
  const result = await cleanRealTaskWaveState();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
