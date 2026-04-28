import process from 'node:process';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const legacyPrefix = ['lega', 'cy'].join('');
const allowedTrackedRuntimePaths = new Set([
  'backend/data/.gitignore',
  'backend/data/providers/manifest.json'
]);
const forbiddenTrackedPrefixes = [
  '.codex-run/',
  'config-snapshots/',
  'secrets/'
];
const forbiddenTrackedEnvFiles = [
  '.env.live-provider.local',
  '.env.postgres.local'
];
const forbiddenPackPatterns = [
  '.codex-run/',
  'backend/backend_new_data/',
  'backend/backend/',
  'config-snapshots/',
  'secrets/',
  '.env.'
];

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function runCommand(command, args) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', command, ...args], {
      cwd: rootDir,
      encoding: 'utf8',
      shell: false
    });
  }
  return spawnSync(command, args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false
  });
}

function runGit(args) {
  if (process.platform === 'win32') {
    return spawnSync('cmd.exe', ['/d', '/s', '/c', 'git', ...args], {
      cwd: rootDir,
      encoding: 'utf8',
      shell: false
    });
  }
  return spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false
  });
}

function listTrackedFiles(prefix) {
  const result = runGit(['ls-files', `${prefix}*`]);
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || `git ls-files failed for ${prefix}`);
  }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listAllTrackedFiles() {
  const result = runGit(['ls-files']);
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || 'git ls-files failed');
  }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function runPackDryRun() {
  const result = runCommand(npmCommand(), ['pack', '--dry-run', '--json']);
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || 'npm pack --dry-run failed');
  }
  const parsed = JSON.parse(result.stdout || '[]');
  return Array.isArray(parsed) ? parsed[0] ?? null : parsed;
}

async function main() {
  const issues = [];
  const trackedRuntimeFiles = listTrackedFiles('backend/data/');
  const disallowedRuntimeFiles = trackedRuntimeFiles.filter((file) => !allowedTrackedRuntimePaths.has(file));
  if (disallowedRuntimeFiles.length > 0) {
    issues.push({
      kind: 'tracked_runtime_state',
      message: 'tracked runtime files are still present under backend/data',
      files: disallowedRuntimeFiles
    });
  }

  const trackedLegacyFiles = listTrackedFiles(`${legacyPrefix}/`);
  if (trackedLegacyFiles.length > 0) {
    issues.push({
      kind: 'legacy_residue',
      message: 'legacy files are still tracked in the repository',
      files: trackedLegacyFiles
    });
  }

  const trackedFiles = listAllTrackedFiles();
  const trackedForbiddenFiles = trackedFiles.filter((file) => (
    forbiddenTrackedPrefixes.some((prefix) => file.startsWith(prefix))
    || forbiddenTrackedEnvFiles.includes(file)
  ));
  if (trackedForbiddenFiles.length > 0) {
    issues.push({
      kind: 'tracked_local_state',
      message: 'local-only env, runtime, or secret-like paths are still tracked',
      files: trackedForbiddenFiles
    });
  }

  const packResult = runPackDryRun();
  const packedFiles = Array.isArray(packResult?.files)
    ? packResult.files
      .map((entry) => (entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : null))
      .filter((entry) => Boolean(entry))
    : [];
  const forbiddenPackedFiles = packedFiles.filter((file) => forbiddenPackPatterns.some((pattern) => String(file).includes(pattern)));
  if (forbiddenPackedFiles.length > 0) {
    issues.push({
      kind: 'packaging_leak',
      message: 'npm pack --dry-run still includes local-only or runtime-state files',
      files: forbiddenPackedFiles
    });
  }

  const report = {
    status: issues.length === 0 ? 'achieved' : 'open_gap',
    allowedTrackedRuntimePaths: [...allowedTrackedRuntimePaths],
    checked: {
      trackedRuntimeFiles: trackedRuntimeFiles.length,
      trackedLegacyFiles: trackedLegacyFiles.length,
      trackedFiles: trackedFiles.length,
      packedFiles: packedFiles.length
    },
    packResult: packResult
      ? {
        name: packResult.name ?? null,
        version: packResult.version ?? null,
        filename: packResult.filename ?? null
      }
      : null,
    issues
  };

  console.log(JSON.stringify(report, null, 2));
  if (issues.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.stack ?? String(error));
  process.exit(1);
});
