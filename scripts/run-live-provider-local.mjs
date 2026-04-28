import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { buildXiaomiMimoFlashLiveEnv, resolveXiaomiMimoFlashDocPath } from './lib/xiaomi-mimo-live-provider.mjs';
import { assertLiveCostGuard } from './lib/live-cost-guard.mjs';

const rootDir = process.cwd();

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
  const localEnv = await buildXiaomiMimoFlashLiveEnv(rootDir);
  const npmArgs = process.argv.slice(2);
  if (npmArgs.length === 0) {
    throw new Error('Provide an npm script to run, for example: node scripts/run-live-provider-local.mjs live-provider-scenarios -- --json');
  }

  await assertLiveCostGuard({
    rootDir,
    env: process.env,
    label: `run-live-provider-local:${npmArgs[0]}`
  });

  runNpmCommand(['run', ...npmArgs], {
    ...process.env,
    ...localEnv,
    SCORECARD_PROFILE: 'local-live-provider',
    SCC_LIVE_PROVIDER_SOURCE: resolveXiaomiMimoFlashDocPath(rootDir),
  });
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exit(1);
});
