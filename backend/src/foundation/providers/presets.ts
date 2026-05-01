import {
  ProviderAuthConfig,
  ProviderEndpointConfig,
  ProviderProfile,
  ResolvedProviderProfile,
  ProviderTransport,
  ProviderVendor
} from './types';
import {
  findProviderPresetDefinition,
  listProviderPresetDefinitions,
  ProviderPresetDefinition
} from './preset-catalog';

export interface ProviderPreset {
  vendor: ProviderVendor;
  transport: ProviderTransport;
  baseUrl: string | null;
  auth: ProviderAuthConfig;
  endpoints: ProviderEndpointConfig;
  apiVersion?: string | null;
  defaultHeaders?: Record<string, string>;
}

const CUSTOM_PRESET = listProviderPresetDefinitions()
  .find((preset) => preset.id === 'custom') as ProviderPresetDefinition;

export function getProviderPreset(vendor: ProviderVendor | undefined): ProviderPreset {
  const preset = findProviderPresetDefinition(vendor) ?? CUSTOM_PRESET;
  return {
    vendor: preset.vendor,
    transport: preset.transport,
    baseUrl: preset.baseUrl,
    auth: { ...preset.auth },
    endpoints: { ...preset.endpoints },
    apiVersion: preset.apiVersion ?? null,
    defaultHeaders: preset.defaultHeaders ? { ...preset.defaultHeaders } : undefined
  };
}

export function normalizeProviderProfile(profile: ProviderProfile): ProviderProfile {
  const preset = getProviderPreset(profile.vendor);
  return {
    ...profile,
    vendor: profile.vendor ?? preset.vendor,
    transport: profile.transport ?? preset.transport,
    baseUrl: profile.baseUrl ?? preset.baseUrl ?? undefined,
    auth: {
      ...preset.auth,
      ...(profile.auth ?? {})
    },
    endpoints: {
      ...preset.endpoints,
      ...(profile.endpoints ?? {})
    },
    apiVersion: profile.apiVersion ?? preset.apiVersion ?? null,
    organization: profile.organization ?? null,
    project: profile.project ?? null,
    headers: {
      ...(preset.defaultHeaders ?? {}),
      ...(profile.headers ?? {})
    }
  };
}

export function normalizeResolvedProviderProfile(profile: ProviderProfile): ResolvedProviderProfile {
  return normalizeProviderProfile(profile) as ResolvedProviderProfile;
}
