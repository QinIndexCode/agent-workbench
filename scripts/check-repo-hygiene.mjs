import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const rootDir = process.cwd();

const requiredPaths = [
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'SECURITY.md',
  '.scc/project.md',
  '.scc/docs.json',
  '.scc/commands'
];

const requiredGitignoreEntries = [
  '.codex-run/*',
  'backend/data/*',
  '!backend/data/.gitignore',
  '!backend/data/providers/manifest.json',
  'backend/backend_new_data/',
  'backend/backend/',
  '.env.live-provider.local',
  '.env.postgres.local',
  'secrets/',
  'config-snapshots/'
];

const forbiddenRuntimeResiduePaths = [
  'nul',
  'backend/backend',
  'backend/backend_new_data',
  'backend_new_data'
];

const forbiddenPatterns = [
  `legacy${'/'}`,
  `legacy${'\\'}`,
  `legacy${'/'}transition`,
  `legacy${'\\'}transition`,
  `backend_new_${'residual'}`,
  ['Describe repository goals', ', coding rules, and operator expectations here.'].join(''),
  ['"sources": [', ']'].join('')
];

const includedPaths = [
  'README.md',
  'package.json',
  '.gitignore',
  '.scc',
  'scripts',
  'backend/docs'
];

async function exists(targetPath) {
  const resolved = path.resolve(rootDir, targetPath);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved);
  try {
    const entries = await fs.readdir(parent);
    if (!entries.some((entry) => entry.toLowerCase() === base.toLowerCase())) {
      return false;
    }
  } catch {
    return false;
  }
  try {
    await fs.access(resolved);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(targetPath) {
  const absolutePath = path.resolve(rootDir, targetPath);
  const stats = await fs.stat(absolutePath);
  if (stats.isFile()) {
    return [absolutePath];
  }

  const entries = await fs.readdir(absolutePath, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const child = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      return collectFiles(path.relative(rootDir, child));
    }
    return [child];
  }));
  return nested.flat();
}

function normalizeForSearch(content) {
  return content.replace(/\r\n/g, '\n');
}

async function main() {
  const issues = [];
  const runtimeResidueWarnings = [];

  for (const requiredPath of requiredPaths) {
    if (!await exists(requiredPath)) {
      issues.push({
        kind: 'missing_required_path',
        path: requiredPath,
        message: `required public repository path is missing: ${requiredPath}`
      });
    }
  }

  const gitignoreContent = await fs.readFile(path.resolve(rootDir, '.gitignore'), 'utf8');
  for (const entry of requiredGitignoreEntries) {
    if (!gitignoreContent.includes(entry)) {
      issues.push({
        kind: 'gitignore_gap',
        path: '.gitignore',
        message: `missing required ignore entry: ${entry}`
      });
    }
  }

  for (const residuePath of forbiddenRuntimeResiduePaths) {
    if (await exists(residuePath)) {
      const warning = {
        kind: 'runtime_residue_path',
        path: residuePath,
        message: `legacy runtime or generated residue path is still present: ${residuePath}`
      };
      runtimeResidueWarnings.push(warning);
      if (process.env.SCC_HYGIENE_STRICT_RUNTIME_RESIDUE === '1') {
        issues.push(warning);
      }
    }
  }

  const files = (await Promise.all(includedPaths.map((target) => collectFiles(target)))).flat();
  for (const file of files) {
    const content = normalizeForSearch(await fs.readFile(file, 'utf8'));
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = forbiddenPatterns.find((pattern) => line.includes(pattern));
      if (!matched) {
        continue;
      }
      issues.push({
        kind: 'forbidden_pattern',
        file: path.relative(rootDir, file).replace(/\\/g, '/'),
        line: index + 1,
        pattern: matched,
        text: line.trim()
      });
    }
  }

  const report = {
    status: issues.length === 0 ? 'achieved' : 'open_gap',
    checkedPaths: includedPaths,
    checkedFileCount: files.length,
    requiredPaths,
    requiredGitignoreEntries,
    forbiddenRuntimeResiduePaths,
    runtimeResidueWarnings,
    forbiddenPatterns,
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
