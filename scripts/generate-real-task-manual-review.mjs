import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  getRealTaskScenarioPackId,
} from './lib/real-task-scenario-packs.mjs';

const rootDir = process.cwd();
const defaultReportPath = path.resolve(rootDir, '.codex-run', 'logs', 'real-task-wave-report.json');
const defaultJsonPath = path.resolve(rootDir, '.codex-run', 'logs', 'real-task-manual-review.json');
const defaultMarkdownPath = path.resolve(rootDir, '.codex-run', 'logs', 'real-task-manual-review.md');
const defaultArtifactBundleRoot = path.resolve(rootDir, '.codex-run', 'logs', 'real-task-manual-review-artifacts');

function parseArgs(argv) {
  const options = {
    reportPath: defaultReportPath,
    jsonPath: defaultJsonPath,
    markdownPath: defaultMarkdownPath,
    artifactBundleRoot: defaultArtifactBundleRoot,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
    } else if (arg === '--report') {
      options.reportPath = path.resolve(rootDir, argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--out-json') {
      options.jsonPath = path.resolve(rootDir, argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--out-md') {
      options.markdownPath = path.resolve(rootDir, argv[index + 1] ?? '');
      index += 1;
    } else if (arg === '--artifact-bundle-root') {
      options.artifactBundleRoot = path.resolve(rootDir, argv[index + 1] ?? '');
      index += 1;
    }
  }
  return options;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function getScenarioVerdicts(scenario) {
  const artifactAudit = scenario.artifactAudit ?? null;
  return {
    lifecycleStatus: scenario.lifecycleStatus ?? null,
    classification: scenario.classification ?? null,
    acceptance: scenario.acceptanceVerdict ?? scenario.acceptance?.deterministic?.verdict ?? null,
    quality: scenario.qualityVerdict ?? scenario.acceptance?.quality?.verdict ?? artifactAudit?.notes?.sharedQuality?.verdict ?? null,
    artifactAudit: artifactAudit?.pass === true ? 'passed' : artifactAudit?.pass === false ? 'failed' : 'unknown',
    surfaceChecks: scenario.surfaceChecks?.passed === true ? 'passed' : scenario.surfaceChecks?.passed === false ? 'failed' : 'unknown',
  };
}

function getArtifactPointers(scenario) {
  const pointers = [];
  if (scenario.workspaceDir) {
    pointers.push({ kind: 'workspace', path: scenario.workspaceDir });
  }
  if (scenario.auditEvidenceRoot) {
    pointers.push({ kind: 'auditEvidenceRoot', path: scenario.auditEvidenceRoot });
  }
  for (const file of asArray(scenario.artifactAudit?.externalRelativeFiles)) {
    pointers.push({ kind: 'externalArtifact', path: file });
  }
  const artifactPathState = scenario.artifactPathState;
  if (artifactPathState && typeof artifactPathState === 'object') {
    for (const [key, value] of Object.entries(artifactPathState)) {
      if (typeof value === 'string' && value.length > 0) {
        pointers.push({ kind: `artifactPathState.${key}`, path: value });
      }
    }
  }
  return pointers;
}

function getChecklistForPack(packId) {
  switch (packId) {
    case 'web':
    case 'web_creation':
      return [
        'Open the delivered page in a browser and verify visual quality, layout, responsiveness, and interaction behavior.',
        'Confirm copy is specific to the user request and not template placeholder content.',
        'Confirm files landed in the requested external path when one was specified.',
      ];
    case 'docs-normalize':
    case 'docs_normalize':
      return [
        'Compare several source snippets with normalized output and confirm source wording was preserved.',
        'Confirm filenames, headings, index links, and cross-references are consistent.',
        'Confirm trace JSON maps outputs to real source snippets, not broad paraphrases.',
      ];
    case 'docs-synthesize':
    case 'docs_synthesize':
      return [
        'Check each summary or decision claim against its cited source file.',
        'Confirm handbook/index/summary/decision-log are useful to a human reader, not generic enterprise prose.',
        'Confirm trace JSON claimText appears in the output and is grounded in source snippets.',
      ];
    case 'system-audit':
    case 'system_audit':
    case 'desktop-observation':
    case 'desktop_observation':
      return [
        'Compare reported CPU, memory, disk, process, or window facts against cited run_command output.',
        'Confirm recommendations are derived from observed host facts, not invented environment assumptions.',
        'Confirm failures or unsupported desktop actions are described explicitly.',
      ];
    case 'database-design':
    case 'database_design':
    case 'database-verify':
    case 'database_verify':
      return [
        'Inspect design docs for storage, indexes, transactions, WAL/recovery, buffer/cache, SQL scope, and benchmark plan.',
        'Run the prototype dry-run benchmark manually if needed and confirm stdout is machine-readable JSON.',
        'Confirm the report separates implemented prototype behavior from unproven MySQL-nearness claims.',
      ];
    default:
      return [
        'Inspect produced artifacts against the original user-facing task intent.',
        'Confirm tool evidence proves the claimed work happened.',
        'Confirm unresolved blockers are explicit and not wrapped as success.',
      ];
  }
}

function sanitizePathSegment(value) {
  return String(value ?? 'unknown')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'unknown';
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isCopyableArtifactPointer(pointer) {
  if (!pointer || typeof pointer.path !== 'string' || pointer.path.length === 0) {
    return false;
  }
  return pointer.kind === 'workspace'
    || pointer.kind === 'auditEvidenceRoot'
    || path.isAbsolute(pointer.path);
}

async function copyArtifactReviewBundle(review, artifactBundleRoot) {
  if (!artifactBundleRoot) {
    return null;
  }
  await fs.rm(artifactBundleRoot, { recursive: true, force: true });
  await fs.mkdir(artifactBundleRoot, { recursive: true });
  for (const scenario of review.scenarios) {
    const scenarioRoot = path.join(artifactBundleRoot, sanitizePathSegment(scenario.id));
    await fs.mkdir(scenarioRoot, { recursive: true });
    scenario.artifactCopies = [];
    for (const pointer of scenario.artifactPointers) {
      if (!isCopyableArtifactPointer(pointer)) {
        scenario.artifactCopies.push({
          kind: pointer.kind,
          sourcePath: pointer.path,
          copied: false,
          reason: 'not_copyable',
        });
        continue;
      }
      if (!(await pathExists(pointer.path))) {
        scenario.artifactCopies.push({
          kind: pointer.kind,
          sourcePath: pointer.path,
          copied: false,
          reason: 'missing_source',
        });
        continue;
      }
      const bundleName = sanitizePathSegment(pointer.kind);
      const bundlePath = path.join(scenarioRoot, bundleName);
      await fs.rm(bundlePath, { recursive: true, force: true });
      await fs.cp(pointer.path, bundlePath, { recursive: true, force: true });
      scenario.artifactCopies.push({
        kind: pointer.kind,
        sourcePath: pointer.path,
        copied: true,
        bundlePath,
      });
    }
  }
  review.artifactBundleRoot = artifactBundleRoot;
  return artifactBundleRoot;
}

function buildManualReview(report) {
  const scenarios = asArray(report.scenarios).map((scenario) => {
    const packId = getRealTaskScenarioPackId(scenario.id) ?? 'unknown';
    return {
      id: scenario.id,
      title: scenario.title ?? scenario.id,
      taskId: scenario.taskId ?? null,
      packId,
      verificationMode: scenario.verificationMode ?? report.verificationMode ?? 'automated_wave',
      verdicts: getScenarioVerdicts(scenario),
      providerFailure: scenario.providerFailureSummary ?? scenario.providerFailure ?? null,
      nextAction: scenario.nextAction ?? null,
      artifactPointers: getArtifactPointers(scenario),
      artifactCopies: [],
      checklist: getChecklistForPack(packId),
      manualReview: {
        required: true,
        verdict: null,
        reviewer: null,
        reviewedAt: null,
        notes: null,
      },
    };
  });
  return {
    status: 'manual_review_required',
    generatedAt: new Date().toISOString(),
    sourceReportPath: report.paths?.reportJsonPath ?? defaultReportPath,
    artifactBundleRoot: null,
    guidance: [
      'This report is a human sign-off bundle. Script verdicts are evidence, not final product-quality authority.',
      'Do not mark a scenario passed unless the produced artifacts satisfy the ordinary user request and the tool evidence supports the claims.',
      'If runtime acceptance/quality failed, record whether it is a product defect, a checker defect, or an environment blocker before rerunning.',
    ],
    scenarios,
    totals: {
      total: scenarios.length,
      scriptPassed: scenarios.filter((scenario) => scenario.verdicts.classification === 'passed').length,
      scriptFailed: scenarios.filter((scenario) => scenario.verdicts.classification !== 'passed').length,
      manualReviewRequired: scenarios.length,
    },
  };
}

function formatMarkdown(review) {
  const lines = [
    '# Real Task Manual Review',
    '',
    `Generated: ${review.generatedAt}`,
    `Source report: ${review.sourceReportPath}`,
    '',
    'This file is intentionally a human sign-off checklist. Runtime acceptance, quality, and artifact audit are evidence, not a replacement for product review.',
    '',
    '## Summary',
    '',
    `- Scenarios: ${review.totals.total}`,
    `- Script passed: ${review.totals.scriptPassed}`,
    `- Script failed: ${review.totals.scriptFailed}`,
    `- Manual review required: ${review.totals.manualReviewRequired}`,
    `- Artifact bundle root: ${review.artifactBundleRoot ?? 'none'}`,
    '',
  ];
  for (const scenario of review.scenarios) {
    lines.push(`## ${scenario.id}`);
    lines.push('');
    lines.push(`- Title: ${scenario.title}`);
    lines.push(`- Task ID: ${scenario.taskId ?? 'unknown'}`);
    lines.push(`- Pack: ${scenario.packId}`);
    lines.push(`- Verification mode: ${scenario.verificationMode}`);
    lines.push(`- Lifecycle: ${scenario.verdicts.lifecycleStatus ?? 'unknown'}`);
    lines.push(`- Script classification: ${scenario.verdicts.classification ?? 'unknown'}`);
    lines.push(`- Acceptance: ${scenario.verdicts.acceptance ?? 'unknown'}`);
    lines.push(`- Quality: ${scenario.verdicts.quality ?? 'unknown'}`);
    lines.push(`- Artifact audit: ${scenario.verdicts.artifactAudit}`);
    if (scenario.providerFailure) {
      lines.push(`- Provider failure: ${scenario.providerFailure}`);
    }
    if (scenario.nextAction) {
      lines.push(`- Next action: ${scenario.nextAction}`);
    }
    lines.push('');
    lines.push('Artifact pointers:');
    for (const pointer of scenario.artifactPointers) {
      lines.push(`- ${pointer.kind}: ${pointer.path}`);
    }
    if (scenario.artifactPointers.length === 0) {
      lines.push('- none recorded');
    }
    if (scenario.artifactCopies.length > 0) {
      lines.push('');
      lines.push('Artifact copies:');
      for (const copy of scenario.artifactCopies) {
        if (copy.copied) {
          lines.push(`- ${copy.kind}: ${copy.bundlePath}`);
        } else {
          lines.push(`- ${copy.kind}: not copied (${copy.reason})`);
        }
      }
    }
    lines.push('');
    lines.push('Human checklist:');
    for (const item of scenario.checklist) {
      lines.push(`- [ ] ${item}`);
    }
    lines.push('');
    lines.push('Manual sign-off:');
    lines.push('- Verdict: pending');
    lines.push('- Reviewer:');
    lines.push('- Notes:');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export async function generateRealTaskManualReview(options = {}) {
  const reportPath = options.reportPath ?? defaultReportPath;
  const jsonPath = options.jsonPath ?? defaultJsonPath;
  const markdownPath = options.markdownPath ?? defaultMarkdownPath;
  const artifactBundleRoot = options.artifactBundleRoot ?? defaultArtifactBundleRoot;
  const report = await readJson(reportPath);
  const review = buildManualReview(report);
  await copyArtifactReviewBundle(review, artifactBundleRoot);
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.mkdir(path.dirname(markdownPath), { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(review, null, 2));
  await fs.writeFile(markdownPath, formatMarkdown(review));
  return { review, jsonPath, markdownPath, artifactBundleRoot };
}

const isDirectRun = (() => {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  generateRealTaskManualReview(options)
    .then((result) => {
      if (options.json) {
        process.stdout.write(`${JSON.stringify({
          status: result.review.status,
          jsonPath: result.jsonPath,
          markdownPath: result.markdownPath,
          artifactBundleRoot: result.artifactBundleRoot,
          totals: result.review.totals,
        }, null, 2)}\n`);
      } else {
        process.stdout.write(`Manual review bundle written:\n${result.markdownPath}\n${result.jsonPath}\n`);
      }
    })
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exit(1);
    });
}
