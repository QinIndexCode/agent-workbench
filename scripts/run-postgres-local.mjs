import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const rootDir = process.cwd();
const envFilePath = path.resolve(rootDir, '.env.postgres.local');

function parseEnvFile(content) {
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
}

async function loadLocalEnv() {
  try {
    const content = await fs.readFile(envFilePath, 'utf8');
    return parseEnvFile(content);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
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
      env,
    })
    : spawnSync('npm', args, {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env,
    });

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const localEnv = await loadLocalEnv();
  const npmArgs = process.argv.slice(2);
  if (npmArgs.length === 0) {
    throw new Error('Provide an npm script to run, for example: node scripts/run-postgres-local.mjs test:postgres -w backend');
  }

  runNpmCommand(['run', ...npmArgs], {
    ...process.env,
    ...localEnv,
    SCORECARD_PROFILE: process.env.SCORECARD_PROFILE?.trim() || 'local-postgres',
  });
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
