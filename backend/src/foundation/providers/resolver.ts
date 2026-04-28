import { ApiKeySecretRepository } from '../repository';
import { normalizeResolvedProviderProfile } from './presets';
import { ProviderRegistry } from './registry';
import { ProviderProfile, ResolvedProviderProfile } from './types';

function assertProviderProfile(profile: ProviderProfile): void {
  if (!profile.label.trim()) {
    throw new Error(`backend_new provider error: provider "${profile.id}" label must not be empty.`);
  }

  if (!profile.model.trim()) {
    throw new Error(`backend_new provider error: provider "${profile.id}" model must not be empty.`);
  }

  if (!profile.transport) {
    throw new Error(`backend_new provider error: provider "${profile.id}" transport must not be empty.`);
  }

  if (profile.transport !== 'local-stdio' && !profile.baseUrl?.trim()) {
    throw new Error(
      `backend_new provider error: provider "${profile.id}" requires baseUrl for transport "${profile.transport}".`
    );
  }
}

export async function resolveProviderProfile(
  registry: ProviderRegistry,
  secrets: ApiKeySecretRepository,
  providerId: string
): Promise<ResolvedProviderProfile> {
  const profile = registry.get(providerId);
  if (!profile) {
    throw new Error(`backend_new provider error: unknown provider "${providerId}".`);
  }

  const normalized = normalizeResolvedProviderProfile(profile);
  assertProviderProfile(normalized);

  if (!normalized.apiKeySecretId) {
    return normalized;
  }

  const secret = await secrets.get(normalized.apiKeySecretId);
  if (!secret) {
    throw new Error(
      `backend_new provider error: missing api key secret "${normalized.apiKeySecretId}" for provider "${providerId}".`
    );
  }

  return {
    ...normalized,
    apiKey: secret.apiKey
  };
}
