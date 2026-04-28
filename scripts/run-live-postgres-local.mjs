import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { buildXiaomiMimoFlashLiveEnv, resolveXiaomiMimoFlashDocPath } from './lib/xiaomi-mimo-live-provider.mjs';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';

const rootDir = process.cwd();
const postgresEnvFilePath = path.resolve(rootDir, '.env.postgres.local');
const combinedProfile = 'local-live-provider-postgres';

async function loadRequiredEnv(envFilePath) {
  const fs = await import('node:fs/promises');
  try {
    const content = await fs.readFile(envFilePath, 'utf8');
    const env = {};
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) {
        continue;
      }
      const separator = line.indexOf('=');
      if (separator <= 0) {
        continue;
      }
      const key = line.slice(0, separator).trim();
      const value = line.slice(separator + 1).trim().replace(/^"(.*)"$/, '$1');
      env[key] = value;
    }
    return env;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Missing ${path.basename(envFilePath)}. Create the local Postgres env file before running the combined live+postgres helper.`);
    }
    throw error;
  }
}

function runNpmCommand(args, env) {
  const result = process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd', ...args], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env
    })
    : spawnSync('npm', args, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env
    });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const liveEnv = await buildXiaomiMimoFlashLiveEnv(rootDir);
  const postgresEnv = await loadRequiredEnv(postgresEnvFilePath);
  const npmArgs = process.argv.slice(2);
  if (npmArgs.length === 0) {
    throw new Error('Provide an npm script to run, for example: node scripts/run-live-postgres-local.mjs release:scorecard');
  }

  await assertLiveCostGuard({
    rootDir,
    env: process.env,
    label: `run-live-postgres-local:${npmArgs[0]}`
  });

  runNpmCommand(['run', ...npmArgs], {
    ...process.env,
    ...liveEnv,
    ...postgresEnv,
    SCORECARD_PROFILE: combinedProfile,
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
