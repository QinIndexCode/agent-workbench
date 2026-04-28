import crypto from 'node:crypto';
import { BackendNewConfig } from './types';

export interface ConfigSnapshotRecord {
  version: string;
  fingerprint: string;
  createdAt: number;
  config: BackendNewConfig;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export function createConfigFingerprint(config: BackendNewConfig): string {
  return crypto
    .createHash('sha256')
    .update(stableStringify(config))
    .digest('hex');
}

export function createConfigSnapshotRecord(
  config: BackendNewConfig,
  timestamp = Date.now()
): ConfigSnapshotRecord {
  const fingerprint = createConfigFingerprint(config);
  return {
    version: `cfg_${timestamp}_${fingerprint.slice(0, 12)}`,
    fingerprint,
    createdAt: timestamp,
    config
  };
}

export function shouldReloadConfig(
  current: { fingerprint: string } | null,
  nextConfig: BackendNewConfig
): boolean {
  if (!current) {
    return true;
  }
  return current.fingerprint !== createConfigFingerprint(nextConfig);
}
