import path from 'node:path';

export const BACKEND_RUNTIME_ROOT_DIRNAME = 'data';
export const LEGACY_BACKEND_RUNTIME_ROOT_DIRNAME = 'backend_new_data';

export function resolveBackendRuntimeRoot(rootDir) {
  return path.resolve(rootDir, 'backend', BACKEND_RUNTIME_ROOT_DIRNAME);
}

export function resolveBackendRuntimeManifestPath(rootDir) {
  return path.join(resolveBackendRuntimeRoot(rootDir), 'providers', 'manifest.json');
}

export function resolveLegacyBackendRuntimeRoot(rootDir) {
  return path.resolve(rootDir, 'backend', LEGACY_BACKEND_RUNTIME_ROOT_DIRNAME);
}

export function resolveTopLevelLegacyRuntimeRoot(rootDir) {
  return path.resolve(rootDir, LEGACY_BACKEND_RUNTIME_ROOT_DIRNAME);
}

export function resolveKnownLegacyResiduePaths(rootDir) {
  return [
    path.resolve(rootDir, 'backend', 'backend'),
    path.resolve(rootDir, 'backend', 'config'),
    path.resolve(rootDir, 'backend', 'workspace'),
    resolveLegacyBackendRuntimeRoot(rootDir),
    resolveTopLevelLegacyRuntimeRoot(rootDir),
    path.resolve(rootDir, 'config'),
    path.resolve(rootDir, 'config-snapshots'),
    path.resolve(rootDir, 'platform'),
    path.resolve(rootDir, 'secrets'),
    path.resolve(rootDir, 'workspace'),
    path.resolve(rootDir, 'real-task-wave-run.log'),
  ];
}
