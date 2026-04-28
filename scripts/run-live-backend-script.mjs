import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';
import { buildXiaomiMimoFlashLiveEnv, resolveXiaomiMimoFlashDocPath } from './lib/xiaomi-mimo-live-provider.mjs';

const rootDir = process.cwd();
const reportEnabledScripts = new Set([
  'live-provider-scenarios',
  'practical-live-task-acceptance',
  'practical-live-manual-audit'
]);

function resolveReportPath(backendScript) {
  if (!reportEnabledScripts.has(backendScript)) {
    return null;
  }
  const scorecardProfile = process.env.SCORECARD_PROFILE?.trim() || 'default';
  const reportFileName = scorecardProfile === 'default'
    ? `${backendScript}.json`
    : `${backendScript}.${scorecardProfile}.json`;
  return path.resolve(rootDir, '.codex-run', 'logs', reportFileName);
}

function parseFirstJsonBlock(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error('No JSON payload found in command output.');
  }

  const extractBalancedJson = (source, start) => {
    const opener = source[start];
    const closer = opener === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === '\\') {
          escaped = true;
          continue;
        }
        if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === opener) {
        depth += 1;
        continue;
      }
      if (char === closer) {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, index + 1);
        }
      }
    }
    return null;
  };

  for (let start = 0; start < trimmed.length; start += 1) {
    const char = trimmed[start];
    if (char !== '{' && char !== '[') {
      continue;
    }
    const candidate = extractBalancedJson(trimmed, start);
    if (!candidate) {
      continue;
    }
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  return JSON.parse(trimmed);
}

async function persistJsonReport(backendScript, stdout) {
  const reportPath = resolveReportPath(backendScript);
  if (!reportPath) {
    return null;
  }
  const parsed = parseFirstJsonBlock(stdout);
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return reportPath;
}

function runNpmCommand(args, env) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], {
      cwd: rootDir,
      stdio: 'pipe',
      shell: false,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    })
    : spawnSync('npm', args, {
      cwd: rootDir,
      stdio: 'pipe',
      shell: false,
      env,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024
    });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result;
}

async function main() {
  const [backendScript, ...backendArgs] = process.argv.slice(2);
  if (!backendScript) {
    throw new Error('Provide a backend npm script to run, for example: node scripts/run-live-backend-script.mjs live-provider-scenarios -- --json');
  }

  await assertLiveCostGuard({
    rootDir,
    env: process.env,
    label: backendScript
  });

  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir);
  const npmArgs = ['run', backendScript, '-w', 'backend'];
  if (backendArgs.length > 0) {
    npmArgs.push('--', ...backendArgs);
  }

  const result = runNpmCommand(npmArgs, {
    ...process.env,
    ...liveEnv,
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });

  const requestedJsonOutput = backendArgs.includes('--json');
  if ((result.status ?? 1) === 0 && requestedJsonOutput && result.stdout?.trim()) {
    try {
      const reportPath = await persistJsonReport(backendScript, result.stdout);
      if (reportPath) {
        process.stderr.write(`[live-report] wrote ${reportPath}\n`);
      }
    } catch (error) {
      process.stderr.write(`[live-report] failed to persist ${backendScript}: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
