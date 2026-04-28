import fs from 'node:fs/promises';
import path from 'node:path';

export interface WorkspaceCommandDefinition {
  name: string;
  description: string | null;
  args: string | null;
  when: string | null;
  template: string;
  filePath: string;
}

export interface WorkspaceRuleDefinition {
  name: string;
  summary: string | null;
  paths: string[];
  content: string;
  filePath: string;
}

export interface WorkspaceHookDefinition {
  event: string;
  command: string;
  description: string | null;
  timeoutMs: number | null;
}

export interface WorkspaceAgentDefinition {
  name: string;
  description: string | null;
  prompt: string;
  filePath: string;
}

export interface WorkspaceDocsSourceDefinition {
  path: string;
  title: string | null;
  tags: string[];
}

export interface WorkspaceDocsManifest {
  sources: WorkspaceDocsSourceDefinition[];
}

export interface WorkspaceWorkflowSnapshot {
  workspaceRoot: string | null;
  sccDir: string | null;
  projectInstructionsPath: string | null;
  projectInstructionsPresent: boolean;
  projectInstructions: string | null;
  commands: WorkspaceCommandDefinition[];
  rules: WorkspaceRuleDefinition[];
  hooks: WorkspaceHookDefinition[];
  agents: WorkspaceAgentDefinition[];
  docsManifest: WorkspaceDocsManifest;
}

function normalizeText(value: string): string {
  return value.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
}

function normalizeWorkspaceRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').trim();
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function parseFrontMatter(markdown: string): { fields: Record<string, string>; body: string } {
  const normalized = markdown.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---\n')) {
    return {
      fields: {},
      body: normalizeText(normalized)
    };
  }
  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex < 0) {
    return {
      fields: {},
      body: normalizeText(normalized)
    };
  }
  const frontMatter = normalized.slice(4, closingIndex).split('\n');
  const body = normalized.slice(closingIndex + 5);
  const fields: Record<string, string> = {};
  for (const line of frontMatter) {
    const match = line.match(/^\s*([a-z0-9_-]+)\s*:\s*(.+?)\s*$/i);
    if (match) {
      fields[match[1].trim().toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
    }
  }
  return {
    fields,
    body: normalizeText(body)
  };
}

async function readWorkspaceCommands(commandsDir: string): Promise<WorkspaceCommandDefinition[]> {
  if (!await exists(commandsDir)) {
    return [];
  }
  const entries = await fs.readdir(commandsDir, { withFileTypes: true });
  const commands: WorkspaceCommandDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    const filePath = path.join(commandsDir, entry.name);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontMatter(raw);
    const name = entry.name.replace(/\.md$/i, '').trim();
    if (!name || !parsed.body) {
      continue;
    }
    commands.push({
      name,
      description: parsed.fields.description ?? null,
      args: parsed.fields.args ?? null,
      when: parsed.fields.when ?? null,
      template: parsed.body,
      filePath
    });
  }
  commands.sort((left, right) => left.name.localeCompare(right.name));
  return commands;
}

async function readMarkdownDefinitionDirectory<T>(
  directoryPath: string,
  mapEntry: (entry: {
    name: string;
    filePath: string;
    body: string;
    fields: Record<string, string>;
  }) => T | null
): Promise<T[]> {
  if (!await exists(directoryPath)) {
    return [];
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const definitions: T[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
      continue;
    }
    const filePath = path.join(directoryPath, entry.name);
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = parseFrontMatter(raw);
    const definition = mapEntry({
      name: entry.name.replace(/\.md$/i, '').trim(),
      filePath,
      body: parsed.body,
      fields: parsed.fields
    });
    if (definition) {
      definitions.push(definition);
    }
  }
  return definitions;
}

async function readWorkspaceRules(rulesDir: string): Promise<WorkspaceRuleDefinition[]> {
  const rules = await readMarkdownDefinitionDirectory(rulesDir, ({ name, filePath, body, fields }) => {
    if (!name || !body) {
      return null;
    }
    const paths = typeof fields.paths === 'string'
      ? fields.paths
        .split(',')
        .map((value) => normalizeWorkspaceRelativePath(value))
        .filter(Boolean)
      : [];
    return {
      name,
      summary: fields.description ?? fields.summary ?? null,
      paths,
      content: body,
      filePath
    };
  });
  rules.sort((left, right) => left.name.localeCompare(right.name));
  return rules;
}

async function readWorkspaceAgents(agentsDir: string): Promise<WorkspaceAgentDefinition[]> {
  const agents = await readMarkdownDefinitionDirectory(agentsDir, ({ name, filePath, body, fields }) => {
    if (!name || !body) {
      return null;
    }
    return {
      name,
      description: fields.description ?? null,
      prompt: body,
      filePath
    };
  });
  agents.sort((left, right) => left.name.localeCompare(right.name));
  return agents;
}

function parseHooksManifest(content: string): WorkspaceHookDefinition[] {
  const parsed = JSON.parse(content) as { hooks?: Array<Record<string, unknown>> };
  const hooks = Array.isArray(parsed.hooks) ? parsed.hooks : [];
  return hooks
    .map((hook) => {
      const event = typeof hook.event === 'string' ? hook.event.trim() : '';
      const command = typeof hook.command === 'string' ? hook.command.trim() : '';
      if (!event || !command) {
        return null;
      }
      return {
        event,
        command,
        description: typeof hook.description === 'string' && hook.description.trim() ? hook.description.trim() : null,
        timeoutMs: typeof hook.timeoutMs === 'number' && Number.isFinite(hook.timeoutMs) && hook.timeoutMs > 0 ? hook.timeoutMs : null
      };
    })
    .filter((hook): hook is WorkspaceHookDefinition => Boolean(hook));
}

function parseDocsManifest(content: string): WorkspaceDocsManifest {
  const parsed = JSON.parse(content) as { sources?: Array<Record<string, unknown>> };
  const rawSources = Array.isArray(parsed.sources) ? parsed.sources : [];
  return {
    sources: rawSources
      .map((source) => {
        const sourcePath = typeof source.path === 'string' ? normalizeWorkspaceRelativePath(source.path) : '';
        if (!sourcePath) {
          return null;
        }
        return {
          path: sourcePath,
          title: typeof source.title === 'string' && source.title.trim() ? source.title.trim() : null,
          tags: Array.isArray(source.tags)
            ? source.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).map((tag) => tag.trim())
            : []
        };
      })
      .filter((source): source is WorkspaceDocsSourceDefinition => Boolean(source))
  };
}

export class WorkspaceWorkflowLoader {
  constructor(private readonly cwd: string) {}

  async discover(): Promise<WorkspaceWorkflowSnapshot> {
    let currentDir = path.resolve(this.cwd);
    let previousDir: string | null = null;
    while (currentDir !== previousDir) {
      const sccDir = path.join(currentDir, '.scc');
      if (await exists(sccDir)) {
        return this.readSnapshot(currentDir, sccDir);
      }
      previousDir = currentDir;
      currentDir = path.dirname(currentDir);
    }
    return {
      workspaceRoot: null,
      sccDir: null,
      projectInstructionsPath: null,
      projectInstructionsPresent: false,
      projectInstructions: null,
      commands: [],
      rules: [],
      hooks: [],
      agents: [],
      docsManifest: { sources: [] }
    };
  }

  async readSnapshot(workspaceRoot: string, sccDir: string): Promise<WorkspaceWorkflowSnapshot> {
    const projectInstructionsPath = path.join(sccDir, 'project.md');
    const commandsDir = path.join(sccDir, 'commands');
    const rulesDir = path.join(sccDir, 'rules');
    const agentsDir = path.join(sccDir, 'agents');
    const docsPath = path.join(sccDir, 'docs.json');
    const hooksPath = path.join(sccDir, 'hooks.json');
    const [projectInstructionsExists, docsExists, hooksExists] = await Promise.all([
      exists(projectInstructionsPath),
      exists(docsPath),
      exists(hooksPath)
    ]);

    const [projectInstructionsRaw, commands, rules, agents, docsRaw, hooksRaw] = await Promise.all([
      projectInstructionsExists ? fs.readFile(projectInstructionsPath, 'utf8') : Promise.resolve<string | null>(null),
      readWorkspaceCommands(commandsDir),
      readWorkspaceRules(rulesDir),
      readWorkspaceAgents(agentsDir),
      docsExists ? fs.readFile(docsPath, 'utf8') : Promise.resolve<string | null>(null)
      ,
      hooksExists ? fs.readFile(hooksPath, 'utf8') : Promise.resolve<string | null>(null)
    ]);

    return {
      workspaceRoot,
      sccDir,
      projectInstructionsPath: projectInstructionsExists ? projectInstructionsPath : null,
      projectInstructionsPresent: Boolean(projectInstructionsRaw && normalizeText(projectInstructionsRaw)),
      projectInstructions: projectInstructionsRaw ? normalizeText(projectInstructionsRaw) : null,
      commands,
      rules,
      hooks: hooksRaw ? parseHooksManifest(hooksRaw) : [],
      agents,
      docsManifest: docsRaw ? parseDocsManifest(docsRaw) : { sources: [] }
    };
  }
}
