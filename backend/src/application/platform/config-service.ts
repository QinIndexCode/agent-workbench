import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { loadBackendNewConfig } from '../../foundation/config/load-config';
import {
  createConfigFingerprint,
  createConfigSnapshotRecord,
  shouldReloadConfig
} from '../../foundation/config/reload-policy';
import {
  ConfigReloadResult,
  ConfigStateView,
  ConfigUpdateInput,
  PlatformActionResult
} from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';

function mergeConfig(
  current: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (
      value
      && typeof value === 'object'
      && !Array.isArray(value)
      && typeof next[key] === 'object'
      && next[key] !== null
      && !Array.isArray(next[key])
    ) {
      next[key] = mergeConfig(next[key] as Record<string, unknown>, value as Record<string, unknown>);
      continue;
    }
    next[key] = value;
  }
  return next;
}

export class ConfigService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(private readonly foundation: BackendNewFoundation) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async getState(): Promise<ConfigStateView> {
    const activeSnapshot = await this.foundation.configSnapshots.getActive();
    const effectiveFingerprint = createConfigFingerprint(this.foundation.config);
    const reloadApplied = activeSnapshot
      ? activeSnapshot.fingerprint === effectiveFingerprint
      : true;
    const snapshotConfig = activeSnapshot?.config as Record<string, unknown> | undefined;
    const snapshotProviders = snapshotConfig?.providers;
    const savedDefaultProviderId = (
      snapshotProviders
      && typeof snapshotProviders === 'object'
      && !Array.isArray(snapshotProviders)
      && typeof (snapshotProviders as Record<string, unknown>).defaultProviderId === 'string'
    )
      ? ((snapshotProviders as Record<string, unknown>).defaultProviderId as string).trim() || null
      : null;
    return {
      current: this.foundation.config as unknown as Record<string, unknown>,
      savedDefaultProviderId,
      activeSnapshot: activeSnapshot ? {
        version: activeSnapshot.version,
        fingerprint: activeSnapshot.fingerprint,
        createdAt: activeSnapshot.createdAt
      } : null,
      activeSnapshotVersion: activeSnapshot?.version ?? null,
      reloadApplied,
      restartRequired: !reloadApplied,
      effectiveFingerprint
    };
  }

  async update(patch: ConfigUpdateInput): Promise<PlatformActionResult<ConfigStateView>> {
    const activeSnapshot = await this.foundation.configSnapshots.getActive();
    const baseConfig = this.foundation.config as unknown as Record<string, unknown>;
    const merged = mergeConfig(baseConfig, patch as unknown as Record<string, unknown>);
    const validated = loadBackendNewConfig(merged as ConfigUpdateInput, {
      cwd: this.foundation.config.paths.rootDir,
      env: {}
    });

    const snapshot = createConfigSnapshotRecord(validated);
    const command = await this.recorder.recordCommand({
      resourceType: 'CONFIG',
      resourceId: 'active',
      action: 'UPDATE',
      input: patch as Record<string, unknown>,
    });
    try {
      const reload = await this.applyControlledReload(validated, activeSnapshot?.fingerprint ?? null);
      await this.foundation.configSnapshots.save(snapshot);
      const state = await this.getState();
      return await this.recorder.recordApplied(command, {
        ...state,
        activeSnapshotVersion: snapshot.version,
        reloadApplied: reload.reloadApplied,
        restartRequired: reload.restartRequired
      }, {
        changedPaths: reload.changedPaths
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async reload(): Promise<PlatformActionResult<ConfigStateView>> {
    const activeSnapshot = await this.foundation.configSnapshots.getActive();
    let reload: ConfigReloadResult & { changedPaths: string[] } = {
      reloadApplied: false,
      restartRequired: false,
      activeSnapshotVersion: activeSnapshot?.version ?? null,
      changedPaths: []
    };
    if (activeSnapshot) {
      const validated = loadBackendNewConfig(activeSnapshot.config as ConfigUpdateInput, {
        cwd: this.foundation.config.paths.rootDir,
        env: {}
      });
      reload = await this.applyControlledReload(validated, activeSnapshot.fingerprint);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'CONFIG',
      resourceId: 'active',
      action: 'RELOAD',
    });
    try {
      const state = await this.getState();
      return await this.recorder.recordApplied(command, {
        ...state,
        reloadApplied: reload.reloadApplied,
        restartRequired: reload.restartRequired,
        activeSnapshotVersion: reload.activeSnapshotVersion
      }, {
        changedPaths: reload.changedPaths
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async setDefaultProvider(providerId: string | null): Promise<PlatformActionResult<ConfigStateView>> {
    return this.update({
      providers: {
        defaultProviderId: providerId
      }
    });
  }

  async health() {
    return {
      ok: true,
      storageDriver: this.foundation.config.storage.driver,
      databaseHealthy: this.foundation.database ? await this.foundation.database.ping() : null,
      queueEnabled: Boolean(this.foundation.queue),
      workerEnabled: this.foundation.config.worker.enabled
    };
  }

  async detailedHealth() {
    return {
      ...(await this.health()),
      providers: this.foundation.providers.list().length,
      skills: this.foundation.extensions.snapshot().skills.length,
      channels: (await this.foundation.channels.list()).length,
      schedules: (await this.foundation.schedules.list()).length,
      memories: (await this.foundation.memories.list()).length
    };
  }

  private async applyControlledReload(
    nextConfig: typeof this.foundation.config,
    activeSnapshotFingerprint: string | null
  ): Promise<ConfigReloadResult & { changedPaths: string[] }> {
    const currentFingerprint = createConfigFingerprint(this.foundation.config);
    const referenceFingerprint = activeSnapshotFingerprint ?? currentFingerprint;
    if (!shouldReloadConfig({ fingerprint: referenceFingerprint }, nextConfig)) {
      return {
        reloadApplied: false,
        restartRequired: false,
        activeSnapshotVersion: (await this.foundation.configSnapshots.getActive())?.version ?? null,
        changedPaths: []
      };
    }

    const changedPaths = collectChangedPaths(
      this.foundation.config as unknown as Record<string, unknown>,
      nextConfig as unknown as Record<string, unknown>
    );
    const reloadApplied = changedPaths.every(path => isHotReloadSafePath(path));

    if (reloadApplied) {
      this.foundation.config.logging = { ...nextConfig.logging };
      this.foundation.config.runtime = { ...nextConfig.runtime };
      this.foundation.config.tools = {
        ...this.foundation.config.tools,
        permissionMode: nextConfig.tools.permissionMode
      };
      this.foundation.config.providers = {
        ...this.foundation.config.providers,
        defaultProviderId: nextConfig.providers.defaultProviderId
      };
      this.foundation.config.server = {
        ...this.foundation.config.server,
        enableSseFallback: nextConfig.server.enableSseFallback
      };
    }

    return {
      reloadApplied,
      restartRequired: !reloadApplied,
      activeSnapshotVersion: (await this.foundation.configSnapshots.getActive())?.version ?? null,
      changedPaths
    };
  }
}

function collectChangedPaths(
  current: Record<string, unknown>,
  next: Record<string, unknown>,
  prefix = ''
): string[] {
  const keys = new Set([...Object.keys(current), ...Object.keys(next)]);
  const changed: string[] = [];
  for (const key of keys) {
    const currentValue = current[key];
    const nextValue = next[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(currentValue) && isPlainObject(nextValue)) {
      changed.push(...collectChangedPaths(currentValue, nextValue, path));
      continue;
    }
    if (JSON.stringify(currentValue) !== JSON.stringify(nextValue)) {
      changed.push(path);
    }
  }
  return changed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isHotReloadSafePath(path: string): boolean {
  return path.startsWith('logging.')
    || path.startsWith('runtime.')
    || path === 'tools.permissionMode'
    || path === 'providers.defaultProviderId'
    || path === 'server.enableSseFallback';
}
