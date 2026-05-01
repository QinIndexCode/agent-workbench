export type ProviderTransport =
  | 'openai-compatible'
  | 'deepseek-compatible'
  | 'anthropic-compatible'
  | 'native-cohere'
  | 'native-ai21'
  | 'native-replicate'
  | 'native-perplexity-agent'
  | 'enterprise-cloud'
  | 'profile-only'
  | 'local-stdio';

export type ProviderVendor =
  | 'ai21'
  | 'anthropic'
  | 'aws_bedrock_openai'
  | 'azure_openai'
  | 'cerebras'
  | 'chatgpt'
  | 'cloudflare_ai_gateway'
  | 'cloudflare_workers_ai'
  | 'cohere'
  | 'custom'
  | 'dashscope_cn'
  | 'dashscope_intl'
  | 'dashscope_us'
  | 'deepinfra'
  | 'deepseek'
  | 'fireworks'
  | 'gemini'
  | 'google_gemini'
  | 'glm'
  | 'grok'
  | 'groq'
  | 'heroku_inference'
  | 'huggingface'
  | 'hyperbolic'
  | 'ibm_watsonx_gateway'
  | 'kimi'
  | 'llama'
  | 'llama_api'
  | 'llama_cpp'
  | 'lmstudio'
  | 'localai'
  | 'meta'
  | 'minimax'
  | 'minimax_cn'
  | 'mistral'
  | 'moonshot'
  | 'novita'
  | 'nvidia_nim'
  | 'ollama'
  | 'openai'
  | 'openrouter'
  | 'perplexity'
  | 'perplexity_agent'
  | 'qianfan'
  | 'replicate'
  | 'sambanova'
  | 'siliconflow'
  | 'siliconflow_cn'
  | 'stepfun_cn'
  | 'stepfun_global'
  | 'stepfun_plan'
  | 'tencent_hunyuan'
  | 'together'
  | 'vertex_ai_openai'
  | 'vercel_ai_gateway'
  | 'vllm'
  | 'volcengine_ark'
  | 'xai'
  | 'zhipu'
  | 'zhipu_coding';

export type ProviderPresetCategory =
  | 'api-key'
  | 'enterprise-cloud'
  | 'local';

export type ProviderImplementationStatus =
  | 'runnable'
  | 'profile-only'
  | 'external-auth-required';

export type ProviderModality =
  | 'text'
  | 'image'
  | 'audio'
  | 'file';

export interface ProviderCapabilityMetadata {
  inputModalities: ProviderModality[];
  outputModalities: ProviderModality[];
  supportsVision: boolean;
  supportsFiles: boolean;
  supportedFileExtensions: string[];
}

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
