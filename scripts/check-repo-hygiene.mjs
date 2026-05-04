import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { buildSecretHygieneAudit } from './check-secret-hygiene.mjs';

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

const coreBoundaryPaths = [
  'backend/src/domain',
  'backend/src/application/tasks',
  'backend/src/application/runtime',
  'backend/src/foundation/tools'
];

const coreBoundaryForbiddenPatterns = [
  'database-lab',
  'database_near_mysql',
  'XIAOMI_MIMO',
  'xiaomi-mimo'
];

const reviewScriptExpectations = [
  {
    scriptName: 'review:frontend:mainline',
    requiredFragment: 'scripts/run-frontend-mainline-review-stack.mjs',
    forbiddenFragments: ['scripts/run-frontend-live-review-stack.mjs', 'scripts/run-frontend-delegation-live-review-stack.mjs'],
    plane: 'harness'
  },
  {
    scriptName: 'review:frontend:live',
    requiredFragment: 'scripts/run-frontend-live-review-stack.mjs',
    forbiddenFragments: ['scripts/run-frontend-mainline-review-stack.mjs'],
    plane: 'harness'
  },
  {
    scriptName: 'e2e:frontend',
    requiredFragment: 'scripts/run-frontend-e2e-stack.mjs',
    forbiddenFragments: ['scripts/run-frontend-live-review-stack.mjs', 'scripts/run-frontend-mainline-review-stack.mjs'],
    plane: 'harness'
  }
];

const workspaceReviewScriptExpectations = [
  {
    packagePath: 'frontend/package.json',
    scriptName: 'mainline-review',
    requiredFragment: 'scripts/mainline-task-review.mjs',
    forbiddenFragments: ['scripts/live-task-review.mjs', 'scripts/delegation-live-review.mjs'],
    plane: 'harness'
  },
  {
    packagePath: 'frontend/package.json',
    scriptName: 'live-review',
    requiredFragment: 'scripts/live-task-review.mjs',
    forbiddenFragments: ['scripts/mainline-task-review.mjs'],
    plane: 'harness'
  },
  {
    packagePath: 'frontend/package.json',
    scriptName: 'e2e',
    requiredFragment: 'scripts/task-e2e-validate.mjs',
    forbiddenFragments: ['scripts/live-task-review.mjs', 'scripts/mainline-task-review.mjs', 'scripts/delegation-live-review.mjs'],
    plane: 'harness'
  }
];

const stackRuntimeIsolationExpectations = [
  'scripts/run-frontend-mainline-review-stack.mjs',
  'scripts/run-frontend-live-review-stack.mjs',
  'scripts/run-frontend-smoke-stack.mjs',
  'scripts/run-frontend-e2e-stack.mjs',
  'scripts/run-frontend-delegation-live-review-stack.mjs',
  'scripts/run-ordinary-interaction-live-check.mjs',
  'scripts/run-agent-cli-live-task-check.mjs'
].map((scriptPath) => ({
  scriptPath,
  requiredFragments: ['BACKEND_NEW_ROOT_DIR', 'BACKEND_NEW_WORKSPACE_CWD', 'createIsolatedBackendRuntimeRoot'],
  plane: 'harness'
}));

const includedPaths = [
  'README.md',
  'package.json',
  '.gitignore',
  '.scc',
  'scripts',
  'backend/docs',
  'docs'
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

function normalizeScriptCommand(command) {
  return typeof command === 'string' ? command.replace(/\\/g, '/') : '';
}

async function main() {
  const issues = [];
  const runtimeResidueWarnings = [];
  const coreBoundaryIssues = [];
  const reviewScriptIssues = [];
  const stackRuntimeIsolationIssues = [];

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

  const reviewScriptPackageChecks = [
    ...reviewScriptExpectations.map((expectation) => ({
      packagePath: 'package.json',
      ...expectation
    })),
    ...workspaceReviewScriptExpectations
  ];
  for (const expectation of reviewScriptPackageChecks) {
    const packageJson = JSON.parse(await fs.readFile(path.resolve(rootDir, expectation.packagePath), 'utf8'));
    const packageScripts = packageJson && typeof packageJson === 'object' && packageJson.scripts && typeof packageJson.scripts === 'object'
      ? packageJson.scripts
      : {};
    const command = normalizeScriptCommand(packageScripts[expectation.scriptName]);
    const missingRequired = !command.includes(expectation.requiredFragment);
    const forbiddenMatch = expectation.forbiddenFragments.find((fragment) => command.includes(fragment)) ?? null;
    if (!missingRequired && !forbiddenMatch) {
      continue;
    }
    const issue = {
      kind: 'review_script_drift',
      path: expectation.packagePath,
      scriptName: expectation.scriptName,
      plane: expectation.plane,
      expected: expectation.requiredFragment,
      forbidden: forbiddenMatch,
      actual: command,
      message: `${expectation.packagePath}:${expectation.scriptName} must run ${expectation.requiredFragment} without crossing into a different review stack.`
    };
    reviewScriptIssues.push(issue);
    issues.push(issue);
  }

  for (const expectation of stackRuntimeIsolationExpectations) {
    const scriptContent = normalizeForSearch(await fs.readFile(path.resolve(rootDir, expectation.scriptPath), 'utf8'));
    const missingFragments = expectation.requiredFragments.filter((fragment) => !scriptContent.includes(fragment));
    if (missingFragments.length === 0) {
      continue;
    }
    const issue = {
      kind: 'stack_runtime_isolation_missing',
      path: expectation.scriptPath,
      plane: expectation.plane,
      missingFragments,
      message: `${expectation.scriptPath} must run backend stacks against an isolated BACKEND_NEW_ROOT_DIR.`
    };
    stackRuntimeIsolationIssues.push(issue);
    issues.push(issue);
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
    const relativeFile = path.relative(rootDir, file).replace(/\\/g, '/');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = forbiddenPatterns.find((pattern) => line.includes(pattern));
      if (!matched) {
        continue;
      }
      issues.push({
        kind: 'forbidden_pattern',
        file: relativeFile,
        line: index + 1,
        pattern: matched,
        text: line.trim()
      });
    }
  }

  const coreBoundaryFiles = (await Promise.all(coreBoundaryPaths.map((target) => collectFiles(target)))).flat();
  for (const file of coreBoundaryFiles) {
    const content = normalizeForSearch(await fs.readFile(file, 'utf8'));
    const lines = content.split('\n');
    const relativeFile = path.relative(rootDir, file).replace(/\\/g, '/');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const matched = coreBoundaryForbiddenPatterns.find((pattern) => line.includes(pattern));
      if (!matched) {
        continue;
      }
      const issue = {
        kind: 'core_boundary_specialization',
        file: relativeFile,
        line: index + 1,
        pattern: matched,
        text: line.trim()
      };
      coreBoundaryIssues.push(issue);
      issues.push(issue);
    }
  }

  const secretHygiene = await buildSecretHygieneAudit({ rootDir });
  for (const issue of secretHygiene.issues) {
    issues.push({
      ...issue,
      kind: `secret_hygiene_${issue.kind}`
    });
  }

  const report = {
    status: issues.length === 0 ? 'achieved' : 'open_gap',
    checkedPaths: includedPaths,
    checkedFileCount: files.length,
    requiredPaths,
    requiredGitignoreEntries,
    forbiddenRuntimeResiduePaths,
    runtimeResidueWarnings,
    coreBoundaryIssues,
    reviewScriptIssues,
    stackRuntimeIsolationIssues,
    reviewScriptExpectations,
    workspaceReviewScriptExpectations,
    stackRuntimeIsolationExpectations,
    forbiddenPatterns,
    coreBoundaryPaths,
    coreBoundaryForbiddenPatterns,
    secretHygiene,
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
