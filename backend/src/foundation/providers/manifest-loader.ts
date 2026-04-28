import { BackendNewConfig } from '../config/types';
import { StorageAdapter } from '../storage/types';
import { ProviderRegistry } from './registry';
import { ProviderProfile } from './types';

export async function loadProviderManifest(
  config: BackendNewConfig,
  storage: StorageAdapter,
  registry: ProviderRegistry
): Promise<void> {
  if (!await storage.exists(config.providers.manifestFile)) {
    return;
  }

  const parsed = await storage.readJson<{ providers?: ProviderProfile[] }>(
    config.providers.manifestFile,
    config.storage.encoding
  );

  const providers = Array.isArray(parsed.providers) ? parsed.providers : [];
  for (const profile of providers) {
    registry.register(profile);
  }
}
