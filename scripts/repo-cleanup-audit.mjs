import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPORT_DIR = path.join('.codex-run', 'logs');
const PRESERVED_AUDIT_REPORTS = new Set([
  'benchmark.json',
  'frontend-e2e-report.json',
  'frontend-smoke-report.json',
  'live-cost-probe.json',
  'live-provider-scenarios.json',
  'practical-live-manual-audit.json',
  'practical-live-task-acceptance.json',
  'release-scorecard.json'
]);

const ACTIVE_SOURCE_PATHS = [
  'README.md',
  'package.json',
  '.scc',
  'backend/package.json',
  'backend/src',
  'backend/tests',
  'backend/docs',
  'frontend/package.json',
  'frontend/src',
  'frontend/tests',
  'scripts',
  'docs',
  'docs(knowlage)'
];

const GENERATED_RUNTIME_PATHS = [
  '.codex-run',
  'backend/data',
  'backend/dist',
  'frontend/dist',
  'node_modules',
  'backend/node_modules',
  'frontend/node_modules'
];

const LEGACY_ARCHIVE_PATHS = [
  'backend/backend',
  'legacy',
  'docs/archive',
  'docs/research'
];

const DELETE_CANDIDATE_PATHS = [
  'nul',
  'backend/backend_new_data',
  'backend_new_data',
  'config',
  'config-snapshots',
  'platform',
  'secrets',
  'workspace'
];

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

async function pathInfo(rootDir, relativePath) {
  const absolutePath = path.resolve(rootDir, relativePath);
  const parentPath = path.dirname(absolutePath);
  const baseName = path.basename(absolutePath);
  try {
    const entries = await fs.readdir(parentPath);
    if (!entries.some((entry) => entry.toLowerCase() === baseName.toLowerCase())) {
      throw Object.assign(new Error('Path is not present as a real directory entry.'), { code: 'ENOENT' });
    }
    const stat = await fs.stat(absolutePath);
    return {
      path: normalizePath(relativePath),
      absolutePath,
      exists: true,
      kind: stat.isDirectory() ? 'directory' : 'file',
      sizeBytes: stat.isFile() ? stat.size : null,
      modifiedAt: stat.mtimeMs
    };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        path: normalizePath(relativePath),
        absolutePath,
        exists: false,
        kind: 'missing',
        sizeBytes: null,
        modifiedAt: null
      };
    }
    throw error;
  }
}

function runGit(rootDir, args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true
  });
  if ((result.status ?? 1) !== 0) {
    return [];
  }
  return (result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(normalizePath);
}

function classifyTrackedFile(filePath) {
  if (filePath === 'backend/data/.gitignore' || filePath === 'backend/data/providers/manifest.json') {
    return 'runtime_baseline';
  }
  if (filePath.startsWith('backend/data/')) {
    return 'generated_runtime';
  }
  if (filePath.startsWith('.codex-run/')) {
    return 'generated_runtime';
  }
  if (filePath.startsWith('backend/backend/') || filePath.startsWith('backend/backend_new_data/') || filePath.startsWith('backend_new_data/')) {
    return 'legacy_residue';
  }
  return 'active_source';
}

async function collectPreservedAuditEvidence(rootDir) {
  const logsDir = path.resolve(rootDir, DEFAULT_REPORT_DIR);
  const entries = await fs.readdir(logsDir, { withFileTypes: true }).catch(() => []);
  const evidence = [];
  for (const entry of entries) {
    if (!entry.isFile() || !PRESERVED_AUDIT_REPORTS.has(entry.name)) {
      continue;
    }
    const relativePath = normalizePath(path.join(DEFAULT_REPORT_DIR, entry.name));
    evidence.push({
      ...(await pathInfo(rootDir, relativePath)),
      reason: 'preserved final validation or audit evidence'
    });
  }
  return evidence.sort((left, right) => left.path.localeCompare(right.path));
}

async function mapPaths(rootDir, paths, reason) {
  return Promise.all(paths.map(async (relativePath) => ({
    ...(await pathInfo(rootDir, relativePath)),
    reason
  })));
}

export async function buildRepoCleanupAudit(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const trackedFiles = options.trackedFiles
    ? options.trackedFiles.map(normalizePath)
    : runGit(rootDir, ['ls-files']);
  const trackedByCategory = {
    activeSource: 0,
    runtimeBaseline: 0,
    generatedRuntime: 0,
    legacyResidue: 0
  };
  for (const filePath of trackedFiles) {
    const category = classifyTrackedFile(filePath);
    if (category === 'runtime_baseline') {
      trackedByCategory.runtimeBaseline += 1;
    } else if (category === 'generated_runtime') {
      trackedByCategory.generatedRuntime += 1;
    } else if (category === 'legacy_residue') {
      trackedByCategory.legacyResidue += 1;
    } else {
      trackedByCategory.activeSource += 1;
    }
  }

  const activeSource = await mapPaths(rootDir, ACTIVE_SOURCE_PATHS, 'current source, documentation, or workspace configuration');
  const generatedRuntime = await mapPaths(rootDir, GENERATED_RUNTIME_PATHS, 'generated runtime, dependency, or build output');
  const preservedAuditEvidence = await collectPreservedAuditEvidence(rootDir);
  const legacyArchive = await mapPaths(rootDir, LEGACY_ARCHIVE_PATHS, 'legacy, archive, or research material; not an active runtime root');
  const deleteCandidates = await mapPaths(rootDir, DELETE_CANDIDATE_PATHS, 'historical runtime residue or local-only temporary path');
  const activeLegacyResidue = deleteCandidates
    .filter((entry) => entry.exists)
    .map((entry) => entry.path);

  return {
    generatedAt: new Date().toISOString(),
    rootDir,
    policy: {
      activeRuntimeRoot: 'backend/data',
      preservedAuditRoot: DEFAULT_REPORT_DIR,
      cleanupStrategy: 'layered-archive',
      note: 'Generic harness observes, audits, reports, and cleans; task-family rules stay inside validation harnesses.'
    },
    trackedByCategory,
    activeSource,
    generatedRuntime,
    preservedAuditEvidence,
    legacyArchive,
    deleteCandidates,
    checks: {
      backendDataIsRuntimeRoot: true,
      backendNewDataHasNoActiveRole: !activeLegacyResidue.includes('backend/backend_new_data') && !activeLegacyResidue.includes('backend_new_data'),
      nestedBackendHasNoActiveRole: !activeLegacyResidue.includes('backend/backend'),
      trackedRuntimeFilesLimited: trackedByCategory.generatedRuntime === 0,
      trackedLegacyResidue: trackedByCategory.legacyResidue
    },
    recommendations: [
      'Keep backend/data/.gitignore and backend/data/providers/manifest.json as the only baseline runtime files.',
      'Use scripts/clean-test-artifacts.mjs before live validation runs.',
      'Preserve final JSON/MD validation reports under .codex-run/logs or move curated reports into docs/reports.',
      'Do not add task-family-specific phase logic to product runtime scripts.'
    ]
  };
}

function renderMarkdown(manifest) {
  const section = (title, entries) => [
    `## ${title}`,
    '',
    entries.length
      ? entries.map((entry) => `- \`${entry.path}\` - ${entry.exists ? entry.kind : 'missing'}; ${entry.reason}`).join('\n')
      : '- None detected.',
    ''
  ].join('\n');
  return [
    '# Repo Cleanup Report',
    '',
    `Generated: ${manifest.generatedAt}`,
    `Runtime root: \`${manifest.policy.activeRuntimeRoot}\``,
    `Preserved audit root: \`${manifest.policy.preservedAuditRoot}\``,
    '',
    '## Summary',
    '',
    `- Active source tracked files: ${manifest.trackedByCategory.activeSource}`,
    `- Runtime baseline tracked files: ${manifest.trackedByCategory.runtimeBaseline}`,
    `- Generated runtime tracked files: ${manifest.trackedByCategory.generatedRuntime}`,
    `- Legacy residue tracked files: ${manifest.trackedByCategory.legacyResidue}`,
    `- Preserved audit reports: ${manifest.preservedAuditEvidence.length}`,
    '',
    section('Active Source', manifest.activeSource),
    section('Generated Runtime', manifest.generatedRuntime),
    section('Preserved Audit Evidence', manifest.preservedAuditEvidence),
    section('Legacy Archive', manifest.legacyArchive),
    section('Delete Candidates', manifest.deleteCandidates),
    '## Recommendations',
    '',
    manifest.recommendations.map((entry) => `- ${entry}`).join('\n'),
    ''
  ].join('\n');
}

export async function writeRepoCleanupReports(options = {}) {
  const rootDir = path.resolve(options.rootDir ?? process.cwd());
  const outputDir = path.resolve(rootDir, options.outputDir ?? DEFAULT_REPORT_DIR);
  const manifest = await buildRepoCleanupAudit({ rootDir });
  await fs.mkdir(outputDir, { recursive: true });
  const manifestPath = path.join(outputDir, 'repo-cleanup-manifest.json');
  const reportPath = path.join(outputDir, 'repo-cleanup-report.md');
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.writeFile(reportPath, renderMarkdown(manifest), 'utf8');
  return {
    manifest,
    manifestPath,
    reportPath
  };
}

async function main() {
  const result = await writeRepoCleanupReports();
  console.log(JSON.stringify({
    status: 'generated',
    manifestPath: result.manifestPath,
    reportPath: result.reportPath,
    checks: result.manifest.checks
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
