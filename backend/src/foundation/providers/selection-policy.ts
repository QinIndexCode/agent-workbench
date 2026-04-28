import { BackendNewConfig } from '../config/types';
import { ProviderRegistry } from './registry';
import { ProviderProfile, ProviderSelectionRequest } from './types';

function isLocalProvider(profile: ProviderProfile): boolean {
  if (profile.transport === 'local-stdio') {
    return true;
  }
  if (profile.vendor && ['ollama', 'huggingface', 'vllm', 'lmstudio', 'llama'].includes(profile.vendor)) {
    return true;
  }
  if (!profile.baseUrl) {
    return false;
  }
  return /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(profile.baseUrl);
}

function applyFilters(
  profiles: ProviderProfile[],
  config: BackendNewConfig,
  request: ProviderSelectionRequest
): ProviderProfile[] {
  const localAllowed = request.allowLocalModels ?? config.providers.allowLocalModels;
  return profiles.filter(profile => {
    if (request.requiredTransport && profile.transport !== request.requiredTransport) {
      return false;
    }
    if (!localAllowed && isLocalProvider(profile)) {
      return false;
    }
    return true;
  });
}

function pickById(profiles: ProviderProfile[], providerId: string | null | undefined): ProviderProfile | null {
  if (!providerId) {
    return null;
  }
  return profiles.find(profile => profile.id === providerId) ?? null;
}

export function selectProviderProfile(
  registry: ProviderRegistry,
  config: BackendNewConfig,
  request: ProviderSelectionRequest = {}
): ProviderProfile {
  const filtered = applyFilters(registry.list(), config, request);
  if (filtered.length === 0) {
    throw new Error('backend_new provider error: no provider matches the current selection policy.');
  }

  const preferred = pickById(filtered, request.preferredProviderId);
  if (preferred) {
    return preferred;
  }

  const configuredDefault = pickById(filtered, config.providers.defaultProviderId);
  if (configuredDefault) {
    return configuredDefault;
  }

  if (config.providers.preferLocalModels) {
    const local = filtered.find(profile => isLocalProvider(profile));
    if (local) {
      return local;
    }
  }

  return filtered[0];
}
