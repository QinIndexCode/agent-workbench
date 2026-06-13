import { lstat, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export async function canonicalizeExistingDirectory(root: string): Promise<string> {
  const resolved = resolve(root);
  const info = await stat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`Folder path must exist and be a directory: ${resolved}`);
  const actual = await realpath(resolved).catch(() => resolved);
  return resolve(actual);
}

export async function resolveWorkspacePathStrict(root: string, input: string): Promise<string> {
  if (!input.trim()) throw new Error("Missing path.");
  const canonicalRoot = await canonicalizeExistingDirectory(root);
  const lexicalTarget = resolve(canonicalRoot, input);
  assertPathInsideWorkspace(canonicalRoot, lexicalTarget, input);

  const targetInfo = await lstat(lexicalTarget).catch(() => null);
  if (targetInfo) {
    const actualTarget = await realpath(lexicalTarget).catch(() => lexicalTarget);
    assertPathInsideWorkspace(canonicalRoot, actualTarget, input);
    return resolve(actualTarget);
  }

  const existingAncestor = await findNearestExistingAncestor(lexicalTarget);
  const actualAncestor = await realpath(existingAncestor).catch(() => existingAncestor);
  assertPathInsideWorkspace(canonicalRoot, actualAncestor, input);
  const relativeSuffix = relative(existingAncestor, lexicalTarget);
  const canonicalTarget = relativeSuffix ? resolve(actualAncestor, relativeSuffix) : actualAncestor;
  assertPathInsideWorkspace(canonicalRoot, canonicalTarget, input);
  return resolve(canonicalTarget);
}

async function findNearestExistingAncestor(target: string): Promise<string> {
  let current = resolve(target);
  while (true) {
    const info = await lstat(current).catch(() => null);
    if (info) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function assertPathInsideWorkspace(root: string, target: string, input: string): void {
  const compareRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const compareTarget = process.platform === "win32" ? target.toLowerCase() : target;
  if (compareTarget !== compareRoot && !compareTarget.startsWith(compareRoot + sep)) {
    throw new Error(`Path is outside the workspace: ${input}`);
  }
}
