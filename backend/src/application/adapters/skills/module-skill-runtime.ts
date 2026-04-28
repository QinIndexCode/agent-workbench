import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { SkillInvocationRequest, SkillInvocationResult, SkillRuntime } from '../../../foundation/skills/types';

interface SkillModule {
  invoke?: (input: Record<string, unknown>, context: SkillInvocationRequest['context']) => Promise<unknown> | unknown;
}

type SkillRuntimeErrorKind =
  | 'RESOLVE'
  | 'LOAD'
  | 'CONTRACT'
  | 'INVOCATION'
  | 'UNKNOWN';

function normalizeOutput(output: unknown): Record<string, unknown> {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    return output as Record<string, unknown>;
  }
  return {
    value: output ?? null
  };
}

export class ModuleSkillRuntime implements SkillRuntime {
  async invoke(request: SkillInvocationRequest): Promise<SkillInvocationResult> {
    let entryFile = request.skill.entryFile?.trim()
      ? path.resolve(request.skill.rootDir, request.skill.entryFile)
      : path.resolve(request.skill.rootDir, 'index.js');
    try {
      entryFile = resolveSkillEntryFile(request.skill.rootDir, request.skill.entryFile);
      const module = await loadSkillModule(entryFile);
      if (typeof module.invoke !== 'function') {
        return {
          ok: false,
          output: null,
          error: `backend_new skill error: "${request.skill.id}" does not export invoke().`,
          metadata: {
            entryFile,
            runtimeType: 'module',
            errorKind: 'CONTRACT'
          }
        };
      }
      const output = await module.invoke(request.input, request.context);
      return {
        ok: true,
        output: normalizeOutput(output),
        error: null,
        metadata: {
          entryFile,
          runtimeType: 'module'
        }
      };
    } catch (error) {
      const normalized = normalizeSkillRuntimeError(error);
      return {
        ok: false,
        output: null,
        error: normalized.message,
        metadata: {
          entryFile,
          runtimeType: 'module',
          errorKind: normalized.kind
        }
      };
    }
  }
}

function resolveSkillEntryFile(rootDir: string, entryFile?: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const candidate = entryFile?.trim()
    ? path.resolve(resolvedRoot, entryFile)
    : path.resolve(resolvedRoot, 'index.js');
  const normalizedCandidate = path.normalize(candidate);
  if (!normalizedCandidate.startsWith(`${resolvedRoot}${path.sep}`) && normalizedCandidate !== resolvedRoot) {
    throw new Error('backend_new skill error: entry file must stay inside skill root.');
  }
  if (!/\.(cjs|js|mjs)$/i.test(normalizedCandidate)) {
    throw new Error('backend_new skill error: entry file must be .js, .cjs, or .mjs.');
  }
  return normalizedCandidate;
}

async function loadSkillModule(entryFile: string): Promise<SkillModule> {
  if (/\.(cjs|js)$/i.test(entryFile)) {
    const localRequire = createRequire(entryFile);
    return localRequire(entryFile) as SkillModule;
  }
  return import(pathToFileURL(entryFile).href) as Promise<SkillModule>;
}

function normalizeSkillRuntimeError(error: unknown): {
  message: string;
  kind: SkillRuntimeErrorKind;
} {
  if (error instanceof Error) {
    const message = error.message;
    if (/entry file/i.test(message) || /inside skill root/i.test(message)) {
      return {
        message,
        kind: 'RESOLVE'
      };
    }
    if (/Cannot find module/i.test(message) || /ERR_MODULE_NOT_FOUND/i.test(message)) {
      return {
        message,
        kind: 'LOAD'
      };
    }
    return {
      message,
      kind: 'INVOCATION'
    };
  }
  return {
    message: 'Unknown skill runtime failure.',
    kind: 'UNKNOWN'
  };
}
