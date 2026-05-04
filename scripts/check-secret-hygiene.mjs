import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const defaultRootDir = process.cwd();

const highConfidenceSecretPatterns = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/
  },
  {
    kind: 'openai_api_key',
    pattern: /(^|[^A-Za-z0-9_-])sk-(?:proj-)?[A-Za-z0-9_-]{32,}([^A-Za-z0-9_-]|$)/
  },
  {
    kind: 'anthropic_api_key',
    pattern: /(^|[^A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{32,}([^A-Za-z0-9_-]|$)/
  },
  {
    kind: 'github_token',
    pattern: /(^|[^A-Za-z0-9_])(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}([^A-Za-z0-9_]|$)/
  },
  {
    kind: 'github_fine_grained_token',
    pattern: /(^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}_[A-Za-z0-9_]{40,}([^A-Za-z0-9_]|$)/
  },
  {
    kind: 'aws_access_key_id',
    pattern: /(^|[^A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}([^A-Z0-9]|$)/
  },
  {
    kind: 'google_api_key',
    pattern: /(^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}([^A-Za-z0-9_-]|$)/
  },
  {
    kind: 'slack_token',
    pattern: /(^|[^A-Za-z0-9-])xox[baprs]-[A-Za-z0-9-]{20,}([^A-Za-z0-9-]|$)/
  }
];

const genericCredentialAssignmentPattern = /\b(api[_-]?key|secret|token|password)\b\s*[:=]\s*['"]([^'"\r\n]{16,})['"]/ig;

const placeholderValuePattern = /^(?:test|demo|dummy|example|placeholder|redacted|secret|token|password|provider-key|secret-value|sk-secret|sk-live|sk-rest|sk-provider|your[_-].*|<.*>)$/i;

function normalizePath(filePath) {
  return filePath.replace(/\\/g, '/');
}

function isAllowedTrackedLocalPath(relativeFile) {
  return relativeFile === 'backend/data/.gitignore'
    || relativeFile === 'backend/data/providers/manifest.json';
}

function isForbiddenTrackedLocalPath(relativeFile) {
  const normalized = normalizePath(relativeFile);
  if (isAllowedTrackedLocalPath(normalized)) {
    return false;
  }
  if (normalized === '.env.example' || normalized === '.env.sample' || normalized === '.env.template') {
    return false;
  }
  return normalized === '.codex-run'
    || normalized.startsWith('.codex-run/')
    || normalized === 'backend/data'
    || normalized.startsWith('backend/data/')
    || normalized === 'secrets'
    || normalized.startsWith('secrets/')
    || normalized === 'config-snapshots'
    || normalized.startsWith('config-snapshots/')
    || normalized === 'frontend/dist'
    || normalized.startsWith('frontend/dist/')
    || normalized === 'node_modules'
    || normalized.startsWith('node_modules/')
    || /^\.env(?:\.|$)/.test(normalized);
}

function looksLikePlaceholder(value) {
  const normalized = value.trim();
  if (placeholderValuePattern.test(normalized)) {
    return true;
  }
  return /^(?:x+|0+|1+|a+|z+|-+|_+)$/.test(normalized);
}

function hasCredentialEntropy(value) {
  const trimmed = value.trim();
  if (trimmed.length < 24) {
    return false;
  }
  const hasLetter = /[A-Za-z]/.test(trimmed);
  const hasDigit = /[0-9]/.test(trimmed);
  const hasSymbol = /[_+/=-]/.test(trimmed);
  return trimmed.length >= 40 || (hasLetter && hasDigit && hasSymbol);
}

function getTrackedFiles(rootDir) {
  const output = execFileSync('git', ['ls-files', '-z'], {
    cwd: rootDir
  });
  return output.toString('utf8').split('\0').filter(Boolean).map(normalizePath);
}

async function readTextFile(rootDir, relativeFile) {
  const absoluteFile = path.resolve(rootDir, relativeFile);
  let content;
  try {
    content = await fs.readFile(absoluteFile);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
  if (content.includes(0)) {
    return null;
  }
  return content.toString('utf8').replace(/\r\n/g, '\n');
}

export async function buildSecretHygieneAudit(options = {}) {
  const rootDir = options.rootDir ?? defaultRootDir;
  const trackedFiles = getTrackedFiles(rootDir);
  const issues = [];
  const highConfidenceFindings = [];
  const credentialAssignmentWarnings = [];
  let checkedTextFileCount = 0;
  let missingTrackedFileCount = 0;

  for (const relativeFile of trackedFiles) {
    if (isForbiddenTrackedLocalPath(relativeFile)) {
      issues.push({
        kind: 'tracked_local_secret_or_runtime_path',
        file: relativeFile,
        message: `local secret/runtime path must not be tracked: ${relativeFile}`
      });
    }

    const content = await readTextFile(rootDir, relativeFile);
    if (content === undefined) {
      missingTrackedFileCount += 1;
      continue;
    }
    if (content === null) {
      continue;
    }
    checkedTextFileCount += 1;
    const lines = content.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const secretPattern of highConfidenceSecretPatterns) {
        if (!secretPattern.pattern.test(line)) {
          continue;
        }
        const finding = {
          kind: 'high_confidence_secret',
          secretKind: secretPattern.kind,
          file: relativeFile,
          line: index + 1,
          message: `high-confidence secret pattern found in tracked file: ${relativeFile}:${index + 1}`
        };
        highConfidenceFindings.push(finding);
        issues.push(finding);
      }

      genericCredentialAssignmentPattern.lastIndex = 0;
      let match = genericCredentialAssignmentPattern.exec(line);
      while (match) {
        const value = match[2] ?? '';
        if (!looksLikePlaceholder(value) && hasCredentialEntropy(value)) {
          credentialAssignmentWarnings.push({
            kind: 'credential_assignment_review',
            credentialName: match[1],
            file: relativeFile,
            line: index + 1,
            valueLength: value.length,
            message: `credential-like assignment should be reviewed: ${relativeFile}:${index + 1}`
          });
        }
        match = genericCredentialAssignmentPattern.exec(line);
      }
    }
  }

  return {
    status: issues.length === 0 ? 'achieved' : 'open_gap',
    trackedFileCount: trackedFiles.length,
    checkedTextFileCount,
    missingTrackedFileCount,
    highConfidenceSecretPatterns: highConfidenceSecretPatterns.map((entry) => entry.kind),
    highConfidenceFindings,
    credentialAssignmentWarnings,
    issues
  };
}

async function main() {
  const report = await buildSecretHygieneAudit({ rootDir: defaultRootDir });
  console.log(JSON.stringify(report, null, 2));
  if (report.issues.length > 0) {
    process.exit(1);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    console.error(error.stack ?? String(error));
    process.exit(1);
  });
}
