#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { ensurePortsFree, getPortStatus, DEFAULT_SERVICE_PORTS } from './lib/port-check.mjs';

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function normalizePath(value) {
  return value.replace(/\\/g, '/');
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRepoRoot(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  let previous = null;
  while (current !== previous) {
    const manifestPath = path.join(current, 'package.json');
    if (await exists(manifestPath)) {
      const raw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      if (manifest?.name === 'scc-batch') {
        return current;
      }
    }
    previous = current;
    current = path.dirname(current);
  }
  throw new Error('Could not find an SCC-Batch repository from the current working directory.');
}

function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'workspace';
}

function parseFrontMatter(markdown) {
  const normalized = markdown.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n')) {
    return { fields: {}, body: normalized.trim() };
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex < 0) {
    return { fields: {}, body: normalized.trim() };
  }
  const frontMatter = normalized.slice(4, closingIndex).split('\n');
  const body = normalized.slice(closingIndex + 5).trim();
  const fields = {};
  for (const line of frontMatter) {
    const match = line.match(/^\s*([a-z0-9_-]+)\s*:\s*(.+?)\s*$/i);
    if (match) {
      fields[match[1].trim().toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return { fields, body };
}

async function loadWorkspaceCommands(repoRoot) {
  const commandsDir = path.join(repoRoot, '.scc', 'commands');
  if (!await exists(commandsDir)) {
    return [];
  }
  const entries = await fs.readdir(commandsDir, { withFileTypes: true });
  const commands = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    const filePath = path.join(commandsDir, entry.name);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontMatter(raw);
    commands.push({
      name: entry.name.replace(/\.md$/i, ''),
      description: parsed.fields.description ?? null,
      args: parsed.fields.args ?? null,
      when: parsed.fields.when ?? null,
      template: parsed.body,
      filePath
    });
  }
  return commands.sort((left, right) => left.name.localeCompare(right.name));
}

function renderTemplate(template, args) {
  return template.replace(/\$\{args\}/g, args.join(' ').trim()).trim();
}

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith('--')) {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) {
        options[token.slice(2)] = true;
      } else {
        options[token.slice(2)] = next;
        index += 1;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, options };
}

function runInteractive(command, args, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, ...extraEnv }
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', reject);
  });
}

function runPiped(command, args, cwd, input, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: false,
      env: { ...process.env, ...extraEnv }
    });
    child.stdin.write(input);
    child.stdin.end();
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', reject);
  });
}

function userBinDir() {
  return process.platform === 'win32'
    ? path.join(os.homedir(), '.scc-batch', 'bin')
    : path.join(os.homedir(), '.scc-batch', 'bin');
}

function registryPath() {
  return path.join(os.homedir(), '.scc-batch', 'workspace-commands.json');
}

async function readRegistry() {
  const filePath = registryPath();
  if (!await exists(filePath)) {
    return [];
  }
  const raw = await fs.readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [];
}

async function writeRegistry(entries) {
  const filePath = registryPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf8');
}

function isBinDirOnPath(binDir) {
  const pathValue = process.env.PATH ?? process.env.Path ?? '';
  const parts = pathValue.split(path.delimiter).map((entry) => entry.trim().toLowerCase());
  return parts.includes(binDir.trim().toLowerCase());
}

async function installWorkspaceCommands(repoRoot, commandName = null) {
  const commands = await loadWorkspaceCommands(repoRoot);
  const selected = commandName ? commands.filter((command) => command.name === commandName) : commands;
  if (selected.length === 0) {
    throw new Error(commandName ? `No workspace command named "${commandName}" was found.` : 'No workspace commands were found.');
  }
  const binDir = userBinDir();
  await fs.mkdir(binDir, { recursive: true });
  const workspaceSlug = slugify(path.basename(repoRoot));
  const registry = await readRegistry();
  const nextRegistry = registry.filter((entry) => entry.repoRoot !== repoRoot || !selected.some((command) => command.name === entry.commandName));

  for (const command of selected) {
    const shimName = `sccw-${workspaceSlug}-${slugify(command.name)}`;
    const shimPath = process.platform === 'win32'
      ? path.join(binDir, `${shimName}.cmd`)
      : path.join(binDir, shimName);
    const commandLine = `scc-batch workspace commands run --repo "${repoRoot}" --name "${command.name}" %*`;
    const posixLine = `#!/usr/bin/env sh\nscc-batch workspace commands run --repo "${repoRoot}" --name "${command.name}" "$@"\n`;
    await fs.writeFile(
      shimPath,
      process.platform === 'win32'
        ? `@echo off\r\n${commandLine}\r\n`
        : posixLine,
      'utf8'
    );
    if (process.platform !== 'win32') {
      await fs.chmod(shimPath, 0o755);
    }
    nextRegistry.push({
      repoRoot,
      workspaceSlug,
      commandName: command.name,
      shimName,
      shimPath,
      installedAt: Date.now()
    });
  }

  await writeRegistry(nextRegistry);
  console.log(`Installed ${selected.length} workspace command shim(s) into ${binDir}.`);
  for (const command of selected) {
    console.log(`- sccw-${workspaceSlug}-${slugify(command.name)}`);
  }
  if (!isBinDirOnPath(binDir)) {
    console.log(`Add ${binDir} to PATH to use the installed shims globally.`);
  }
  return 0;
}

async function uninstallWorkspaceCommands(repoRoot, commandName = null) {
  const registry = await readRegistry();
  const selected = registry.filter((entry) => entry.repoRoot === repoRoot && (!commandName || entry.commandName === commandName));
  if (selected.length === 0) {
    throw new Error(commandName ? `No installed shim for "${commandName}" was found in this repo.` : 'No installed workspace command shims were found for this repo.');
  }
  for (const entry of selected) {
    if (await exists(entry.shimPath)) {
      await fs.unlink(entry.shimPath);
    }
  }
  await writeRegistry(registry.filter((entry) => !selected.includes(entry)));
  console.log(`Removed ${selected.length} workspace command shim(s).`);
  return 0;
}

async function runWorkspaceCommand(repoRoot, commandName, args) {
  const commands = await loadWorkspaceCommands(repoRoot);
  const command = commands.find((entry) => entry.name === commandName);
  if (!command) {
    throw new Error(`No workspace command named "${commandName}" was found.`);
  }
  const rendered = renderTemplate(command.template, args);
  if (!rendered) {
    throw new Error(`Workspace command "${commandName}" rendered an empty prompt.`);
  }
  const backendStatus = await getPortStatus(DEFAULT_SERVICE_PORTS.backend, 'backend');
  if (!backendStatus.occupied) {
    throw new Error('The backend is not running on port 3011. Start `scc-batch dev` or `scc-batch backend` first.');
  }
  return runPiped(
    npmCommand(),
    ['run', 'cli', '-w', 'backend', '--', 'chat', '--format', 'human'],
    repoRoot,
    `${rendered}\n`
  );
}

async function runPortCheck() {
  const statuses = [
    await getPortStatus(DEFAULT_SERVICE_PORTS.backend, 'backend'),
    await getPortStatus(DEFAULT_SERVICE_PORTS.frontend, 'frontend')
  ];
  console.log(JSON.stringify(statuses, null, 2));
  return statuses.some((status) => status.occupied) ? 1 : 0;
}

async function runDoctor(repoRoot) {
  const commands = await loadWorkspaceCommands(repoRoot);
  const portStatuses = [
    await getPortStatus(DEFAULT_SERVICE_PORTS.backend, 'backend'),
    await getPortStatus(DEFAULT_SERVICE_PORTS.frontend, 'frontend')
  ];
  const binDir = userBinDir();
  console.log(JSON.stringify({
    repoRoot: normalizePath(repoRoot),
    node: process.version,
    workspaceCommands: commands.map((command) => command.name),
    workspaceCommandBinDir: normalizePath(binDir),
    workspaceCommandBinDirOnPath: isBinDirOnPath(binDir),
    workspaceCommandRegistry: normalizePath(registryPath()),
    ports: portStatuses
  }, null, 2));
  return 0;
}

function usage() {
  return [
    'scc-batch experimental launcher',
    '',
    'Usage:',
    '  scc-batch dev',
    '  scc-batch backend',
    '  scc-batch worker',
    '  scc-batch frontend',
    '  scc-batch cli [args...]',
    '  scc-batch doctor',
    '  scc-batch port-check',
    '  scc-batch workspace commands list [--repo <path>]',
    '  scc-batch workspace commands install [--repo <path>] [--name <command>]',
    '  scc-batch workspace commands uninstall [--repo <path>] [--name <command>]',
    '  scc-batch workspace commands run [--repo <path>] --name <command> [-- arg1 arg2]',
  ].join('\n');
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command, subcommand, subsubcommand, ...rest] = positionals;
  if (!command || command === 'help' || command === '--help') {
    console.log(usage());
    return 0;
  }

  if (command === 'port-check') {
    return runPortCheck();
  }

  const repoRoot = await resolveRepoRoot(typeof options.repo === 'string' ? options.repo : process.cwd());

  switch (command) {
    case 'dev':
      await ensurePortsFree([
        { service: 'backend', port: DEFAULT_SERVICE_PORTS.backend },
        { service: 'frontend', port: DEFAULT_SERVICE_PORTS.frontend }
      ]);
      return runInteractive(process.execPath, [path.join(repoRoot, 'scripts', 'dev.mjs')], repoRoot);
    case 'backend':
      await ensurePortsFree([{ service: 'backend', port: DEFAULT_SERVICE_PORTS.backend }]);
      return runInteractive(npmCommand(), ['run', 'start', '-w', 'backend'], repoRoot);
    case 'worker':
      return runInteractive(npmCommand(), ['run', 'start:worker', '-w', 'backend'], repoRoot);
    case 'frontend':
      await ensurePortsFree([{ service: 'frontend', port: DEFAULT_SERVICE_PORTS.frontend }]);
      return runInteractive(npmCommand(), ['run', 'dev', '-w', 'frontend'], repoRoot, {
        FRONTEND_DEV_PORT: String(DEFAULT_SERVICE_PORTS.frontend)
      });
    case 'cli':
      return runInteractive(npmCommand(), ['run', 'cli', '-w', 'backend', '--', ...[subcommand, subsubcommand, ...rest].filter(Boolean)], repoRoot);
    case 'doctor':
      return runDoctor(repoRoot);
    case 'workspace':
      if (subcommand !== 'commands') {
        throw new Error('Supported workspace subcommands: commands list|install|uninstall|run');
      }
      if (subsubcommand === 'list') {
        const commands = await loadWorkspaceCommands(repoRoot);
        console.log(JSON.stringify(commands.map((entry) => ({
          name: entry.name,
          description: entry.description,
          args: entry.args,
          when: entry.when
        })), null, 2));
        return 0;
      }
      if (subsubcommand === 'install') {
        return installWorkspaceCommands(repoRoot, typeof options.name === 'string' ? options.name : null);
      }
      if (subsubcommand === 'uninstall') {
        return uninstallWorkspaceCommands(repoRoot, typeof options.name === 'string' ? options.name : null);
      }
      if (subsubcommand === 'run') {
        if (typeof options.name !== 'string' || !options.name.trim()) {
          throw new Error('workspace commands run requires --name <command>.');
        }
        return runWorkspaceCommand(repoRoot, options.name.trim(), rest);
      }
      throw new Error('Supported workspace command actions: list, install, uninstall, run');
    default:
      throw new Error(`Unknown command "${command}".`);
  }
}

main()
  .then((code) => {
    if (typeof code === 'number' && code !== 0) {
      process.exitCode = code;
    }
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
