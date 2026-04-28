export type ProviderTransport =
  | 'openai-compatible'
  | 'deepseek-compatible'
  | 'anthropic-compatible'
  | 'local-stdio';

export type ProviderVendor =
  | 'openai'
  | 'chatgpt'
  | 'anthropic'
  | 'meta'
  | 'llama'
  | 'grok'
  | 'xai'
  | 'gemini'
  | 'huggingface'
  | 'deepseek'
  | 'minimax'
  | 'zhipu'
  | 'glm'
  | 'kimi'
  | 'moonshot'
  | 'ollama'
  | 'vllm'
  | 'lmstudio'
  | 'custom';

export interface ProviderAuthConfig {
  scheme: 'bearer' | 'x-api-key' | 'none';
  headerName?: string;
  prefix?: string;
}

export interface ProviderEndpointConfig {
  chatCompletionsPath?: string;
  messagesPath?: string;
}

export interface ProviderProfile {
  id: string;
  label: string;
  transport?: ProviderTransport;
  vendor?: ProviderVendor;
  baseUrl?: string;
  model: string;
  apiKeySecretId?: string;
  headers?: Record<string, string>;
  auth?: ProviderAuthConfig;
  endpoints?: ProviderEndpointConfig;
  apiVersion?: string | null;
  organization?: string | null;
  project?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ResolvedProviderProfile extends ProviderProfile {
  transport: ProviderTransport;
  vendor: ProviderVendor;
  auth: ProviderAuthConfig;
  endpoints: ProviderEndpointConfig;
  apiVersion: string | null;
  organization: string | null;
  project: string | null;
  apiKey?: string;
}

export interface ProviderSelectionRequest {
  preferredProviderId?: string | null;
  requiredTransport?: ProviderTransport;
  allowLocalModels?: boolean;
}
