import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  resolveBackendRuntimeRoot,
  resolveKnownLegacyResiduePaths,
} from './lib/backend-runtime-paths.mjs';

const rootDir = process.cwd();
const runtimeRoot = resolveBackendRuntimeRoot(rootDir);

const runtimeDirs = [
  'approvals',
  'checkpoints',
  'config-snapshots',
  'conversations',
  'events',
  'logs',
  'platform',
  'projections',
  'secrets',
  'sessions',
  'tasks',
  'tool-invocations',
  'traces',
  'validated-outputs',
  'workspace'
];

const runtimeFiles = [
  'user-preferences.json'
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

async function removePath(target) {
  await fs.rm(target, { recursive: true, force: true });
}

async function ensureDir(target) {
  await fs.mkdir(target, { recursive: true });
}

function describeLegacyResidue(target) {
  const relativePath = path.relative(rootDir, target).split(path.sep).join('/');
  return LEGACY_RESIDUE_LABELS.get(relativePath) ?? relativePath.replace(/[/.]+/g, '_');
}

async function main() {
  const removed = {
    directories: [],
    files: [],
    legacyResidue: [],
  };

  for (const relativeDir of runtimeDirs) {
    const absoluteDir = path.join(runtimeRoot, relativeDir);
    await removePath(absoluteDir);
    await ensureDir(absoluteDir);
    removed.directories.push(relativeDir);
  }

  for (const relativeFile of runtimeFiles) {
    const absoluteFile = path.join(runtimeRoot, relativeFile);
    await removePath(absoluteFile);
    removed.files.push(relativeFile);
  }

  for (const legacyPath of resolveKnownLegacyResiduePaths(rootDir)) {
    if (legacyPath === runtimeRoot) {
      continue;
    }
    await removePath(legacyPath);
    removed.legacyResidue.push(describeLegacyResidue(legacyPath));
  }

  console.log(JSON.stringify({
    runtimeRoot,
    removed
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
