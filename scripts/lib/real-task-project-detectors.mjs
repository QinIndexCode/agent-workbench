import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_DEPTH = 5;

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

async function listFilesRecursive(root, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) ? options.maxDepth : DEFAULT_MAX_DEPTH;
  const files = [];

  async function walk(currentDir, depth) {
    if (depth > maxDepth) {
      return;
    }
    let entries = [];
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') {
        continue;
      }
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath, depth + 1);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  }

  await walk(root, 0);
  return files;
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function createProject(params) {
  return {
    kind: params.kind,
    root: params.root,
    markerPath: params.markerPath,
    markerRelativePath: normalizeSlashes(path.relative(params.root, params.markerPath)),
    confidence: params.confidence ?? 'high',
    installCommand: params.installCommand ?? null,
    buildCommand: params.buildCommand ?? null,
    testCommand: params.testCommand ?? null,
    verifyCommand: params.verifyCommand ?? params.testCommand ?? params.buildCommand ?? null,
    evidencePaths: params.evidencePaths ?? [params.markerPath],
  };
}

async function createNodeProject(markerPath) {
  const root = path.dirname(markerPath);
  const packageJson = await readJsonSafe(markerPath);
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
    ? packageJson.scripts
    : {};
  return createProject({
    kind: 'node',
    root,
    markerPath,
    installCommand: 'npm install',
    buildCommand: typeof scripts.build === 'string' ? 'npm run build' : null,
    testCommand: typeof scripts.test === 'string' ? 'npm test' : null,
    verifyCommand:
      typeof scripts.test === 'string' ? 'npm test'
        : typeof scripts.build === 'string' ? 'npm run build'
          : null,
  });
}

function createPythonProject(markerPath) {
  const root = path.dirname(markerPath);
  const name = path.basename(markerPath).toLowerCase();
  return createProject({
    kind: 'python',
    root,
    markerPath,
    installCommand: name === 'requirements.txt' ? 'python -m pip install -r requirements.txt' : null,
    buildCommand: name === 'pyproject.toml' ? 'python -m build' : null,
    testCommand: 'python -m pytest',
  });
}

function createRustProject(markerPath) {
  return createProject({
    kind: 'rust',
    root: path.dirname(markerPath),
    markerPath,
    buildCommand: 'cargo build',
    testCommand: 'cargo test',
  });
}

function createGoProject(markerPath) {
  return createProject({
    kind: 'go',
    root: path.dirname(markerPath),
    markerPath,
    buildCommand: 'go build ./...',
    testCommand: 'go test ./...',
  });
}

function createDotnetProject(markerPath) {
  return createProject({
    kind: 'dotnet',
    root: path.dirname(markerPath),
    markerPath,
    buildCommand: 'dotnet build',
    testCommand: 'dotnet test',
  });
}

function createJavaProject(markerPath) {
  const basename = path.basename(markerPath).toLowerCase();
  const isGradle = basename === 'build.gradle' || basename === 'build.gradle.kts';
  return createProject({
    kind: 'java',
    root: path.dirname(markerPath),
    markerPath,
    buildCommand: isGradle ? 'gradle build' : 'mvn test',
    testCommand: isGradle ? 'gradle test' : 'mvn test',
  });
}

function createStaticSiteProject(markerPath) {
  return createProject({
    kind: 'static_site',
    root: path.dirname(markerPath),
    markerPath,
    verifyCommand: null,
  });
}

function createDocsProject(root, markdownFiles) {
  return {
    kind: 'docs',
    root,
    markerPath: markdownFiles[0] ?? root,
    markerRelativePath: markdownFiles[0] ? normalizeSlashes(path.relative(root, markdownFiles[0])) : '.',
    confidence: markdownFiles.length >= 3 ? 'medium' : 'low',
    installCommand: null,
    buildCommand: null,
    testCommand: null,
    verifyCommand: null,
    evidencePaths: markdownFiles,
  };
}

function isNestedUnderExistingProject(projects, candidateRoot) {
  return projects.some((project) => {
    const relative = path.relative(project.root, candidateRoot);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

export async function detectWorkspaceProjects(root, options = {}) {
  const absoluteRoot = path.resolve(root);
  if (!fsSync.existsSync(absoluteRoot)) {
    return [];
  }
  const files = await listFilesRecursive(absoluteRoot, { maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH });
  const projects = [];
  const markdownFiles = [];

  for (const filePath of files) {
    const basename = path.basename(filePath).toLowerCase();
    if (basename.endsWith('.md')) {
      markdownFiles.push(filePath);
    }
    if (basename === 'package.json') {
      projects.push(await createNodeProject(filePath));
    } else if (basename === 'pyproject.toml' || basename === 'requirements.txt' || basename === 'setup.py') {
      projects.push(createPythonProject(filePath));
    } else if (basename === 'cargo.toml') {
      projects.push(createRustProject(filePath));
    } else if (basename === 'go.mod') {
      projects.push(createGoProject(filePath));
    } else if (basename.endsWith('.csproj') || basename.endsWith('.fsproj') || basename.endsWith('.sln')) {
      projects.push(createDotnetProject(filePath));
    } else if (basename === 'pom.xml' || basename === 'build.gradle' || basename === 'build.gradle.kts') {
      projects.push(createJavaProject(filePath));
    } else if (basename === 'index.html') {
      projects.push(createStaticSiteProject(filePath));
    }
  }

  if (projects.length === 0 && markdownFiles.length > 0) {
    projects.push(createDocsProject(absoluteRoot, markdownFiles));
  }

  const deduped = [];
  const seen = new Set();
  for (const project of projects.sort((left, right) => {
    const depthDiff = left.root.split(path.sep).length - right.root.split(path.sep).length;
    return depthDiff || left.kind.localeCompare(right.kind) || left.root.localeCompare(right.root);
  })) {
    const key = `${project.kind}:${project.root}`;
    if (seen.has(key)) {
      continue;
    }
    if (project.kind === 'static_site' && isNestedUnderExistingProject(deduped, project.root)) {
      continue;
    }
    seen.add(key);
    deduped.push(project);
  }

  return deduped;
}

export function selectPrimaryProject(projects, options = {}) {
  const preferredKinds = Array.isArray(options.preferredKinds) && options.preferredKinds.length > 0
    ? options.preferredKinds
    : ['node', 'python', 'go', 'rust', 'dotnet', 'java', 'static_site', 'docs'];
  const rank = new Map(preferredKinds.map((kind, index) => [kind, index]));
  return [...(projects ?? [])]
    .sort((left, right) => {
      const rankDiff = (rank.get(left.kind) ?? 999) - (rank.get(right.kind) ?? 999);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return left.root.localeCompare(right.root);
    })[0] ?? null;
}

