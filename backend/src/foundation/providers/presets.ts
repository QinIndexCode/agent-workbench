import {
  ProviderAuthConfig,
  ProviderEndpointConfig,
  ProviderProfile,
  ResolvedProviderProfile,
  ProviderTransport,
  ProviderVendor
} from './types';

interface ProviderPreset {
  vendor: ProviderVendor;
  transport: ProviderTransport;
  baseUrl: string | null;
  auth: ProviderAuthConfig;
  endpoints: ProviderEndpointConfig;
  apiVersion?: string | null;
  defaultHeaders?: Record<string, string>;
}

const DEFAULT_ENDPOINTS: ProviderEndpointConfig = {
  chatCompletionsPath: '/chat/completions',
  messagesPath: '/messages'
};

const PROVIDER_PRESETS: Record<ProviderVendor, ProviderPreset> = {
  openai: {
    vendor: 'openai',
    transport: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  chatgpt: {
    vendor: 'chatgpt',
    transport: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  anthropic: {
    vendor: 'anthropic',
    transport: 'anthropic-compatible',
    baseUrl: 'https://api.anthropic.com/v1',
    auth: { scheme: 'x-api-key' },
    endpoints: DEFAULT_ENDPOINTS,
    apiVersion: '2023-06-01',
    defaultHeaders: {
      'anthropic-version': '2023-06-01'
    }
  },
  meta: {
    vendor: 'meta',
    transport: 'openai-compatible',
    baseUrl: null,
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  llama: {
    vendor: 'llama',
    transport: 'local-stdio',
    baseUrl: null,
    auth: { scheme: 'none' },
    endpoints: DEFAULT_ENDPOINTS
  },
  grok: {
    vendor: 'grok',
    transport: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  xai: {
    vendor: 'xai',
    transport: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  gemini: {
    vendor: 'gemini',
    transport: 'openai-compatible',
    baseUrl: null,
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  huggingface: {
    vendor: 'huggingface',
    transport: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8080/v1',
    auth: { scheme: 'none' },
    endpoints: DEFAULT_ENDPOINTS
  },
  deepseek: {
    vendor: 'deepseek',
    transport: 'deepseek-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  minimax: {
    vendor: 'minimax',
    transport: 'openai-compatible',
    baseUrl: 'https://api.minimax.chat/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  zhipu: {
    vendor: 'zhipu',
    transport: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  glm: {
    vendor: 'glm',
    transport: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  kimi: {
    vendor: 'kimi',
    transport: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  moonshot: {
    vendor: 'moonshot',
    transport: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  },
  ollama: {
    vendor: 'ollama',
    transport: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    auth: { scheme: 'none' },
    endpoints: DEFAULT_ENDPOINTS
  },
  vllm: {
    vendor: 'vllm',
    transport: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:8000/v1',
    auth: { scheme: 'none' },
    endpoints: DEFAULT_ENDPOINTS
  },
  lmstudio: {
    vendor: 'lmstudio',
    transport: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    auth: { scheme: 'none' },
    endpoints: DEFAULT_ENDPOINTS
  },
  custom: {
    vendor: 'custom',
    transport: 'openai-compatible',
    baseUrl: null,
    auth: { scheme: 'bearer' },
    endpoints: DEFAULT_ENDPOINTS
  }
};

export function getProviderPreset(vendor: ProviderVendor | undefined): ProviderPreset {
  return PROVIDER_PRESETS[vendor ?? 'custom'] ?? PROVIDER_PRESETS.custom;
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
