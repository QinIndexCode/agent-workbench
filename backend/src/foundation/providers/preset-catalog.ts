import {
  ProviderAuthConfig,
  ProviderCapabilityMetadata,
  ProviderEndpointConfig,
  ProviderImplementationStatus,
  ProviderPresetCategory,
  ProviderTransport,
  ProviderVendor
} from './types';

export interface ProviderPresetDefinition {
  id: string;
  label: string;
  vendor: ProviderVendor;
  transport: ProviderTransport;
  baseUrl: string | null;
  auth: ProviderAuthConfig;
  endpoints: ProviderEndpointConfig;
  apiVersion?: string | null;
  defaultHeaders?: Record<string, string>;
  defaultModel: string;
  category: ProviderPresetCategory;
  envVarNames: string[];
  requiredConfigFields: string[];
  supportsQuickAdd: boolean;
  implementationStatus: ProviderImplementationStatus;
  capabilities: ProviderCapabilityMetadata;
  notes?: string;
}

const DEFAULT_ENDPOINTS: ProviderEndpointConfig = {
  chatCompletionsPath: '/chat/completions',
  messagesPath: '/messages'
};

const TEXT_CAPABILITY: ProviderCapabilityMetadata = {
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsVision: false,
  supportsFiles: false,
  supportedFileExtensions: []
};

const VISION_CAPABILITY: ProviderCapabilityMetadata = {
  inputModalities: ['text', 'image'],
  outputModalities: ['text'],
  supportsVision: true,
  supportsFiles: false,
  supportedFileExtensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif']
};

const LOCAL_TEXT_CAPABILITY: ProviderCapabilityMetadata = {
  ...TEXT_CAPABILITY
};

function bearer(): ProviderAuthConfig {
  return { scheme: 'bearer' };
}

function none(): ProviderAuthConfig {
  return { scheme: 'none' };
}

function apiKeyPreset(params: {
  id: string;
  label: string;
  vendor?: ProviderVendor;
  transport?: ProviderTransport;
  baseUrl: string | null;
  envVarNames: string[];
  defaultModel: string;
  supportsQuickAdd?: boolean;
  capabilities?: ProviderCapabilityMetadata;
  auth?: ProviderAuthConfig;
  endpoints?: ProviderEndpointConfig;
  apiVersion?: string | null;
  defaultHeaders?: Record<string, string>;
  implementationStatus?: ProviderImplementationStatus;
  requiredConfigFields?: string[];
  notes?: string;
}): ProviderPresetDefinition {
  return {
    id: params.id,
    label: params.label,
    vendor: params.vendor ?? params.id as ProviderVendor,
    transport: params.transport ?? 'openai-compatible',
    baseUrl: params.baseUrl,
    auth: params.auth ?? bearer(),
    endpoints: params.endpoints ?? DEFAULT_ENDPOINTS,
    apiVersion: params.apiVersion,
    defaultHeaders: params.defaultHeaders,
    defaultModel: params.defaultModel,
    category: 'api-key',
    envVarNames: params.envVarNames,
    requiredConfigFields: params.requiredConfigFields ?? [],
    supportsQuickAdd: params.supportsQuickAdd ?? (params.implementationStatus !== 'profile-only'),
    implementationStatus: params.implementationStatus ?? 'runnable',
    capabilities: params.capabilities ?? TEXT_CAPABILITY,
    notes: params.notes
  };
}

function enterprisePreset(params: {
  id: string;
  label: string;
  baseUrl: string | null;
  envVarNames: string[];
  defaultModel: string;
  requiredConfigFields: string[];
  capabilities?: ProviderCapabilityMetadata;
  notes?: string;
}): ProviderPresetDefinition {
  return {
    id: params.id,
    label: params.label,
    vendor: params.id as ProviderVendor,
    transport: 'enterprise-cloud',
    baseUrl: params.baseUrl,
    auth: bearer(),
    endpoints: DEFAULT_ENDPOINTS,
    defaultModel: params.defaultModel,
    category: 'enterprise-cloud',
    envVarNames: params.envVarNames,
    requiredConfigFields: params.requiredConfigFields,
    supportsQuickAdd: false,
    implementationStatus: 'external-auth-required',
    capabilities: params.capabilities ?? TEXT_CAPABILITY,
    notes: params.notes
  };
}

function localPreset(params: {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  capabilities?: ProviderCapabilityMetadata;
}): ProviderPresetDefinition {
  return {
    id: params.id,
    label: params.label,
    vendor: params.id as ProviderVendor,
    transport: 'openai-compatible',
    baseUrl: params.baseUrl,
    auth: none(),
    endpoints: DEFAULT_ENDPOINTS,
    defaultModel: params.defaultModel,
    category: 'local',
    envVarNames: [],
    requiredConfigFields: [],
    supportsQuickAdd: true,
    implementationStatus: 'runnable',
    capabilities: params.capabilities ?? LOCAL_TEXT_CAPABILITY
  };
}

export const PROVIDER_PRESET_CATALOG: ProviderPresetDefinition[] = [
  apiKeyPreset({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    envVarNames: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-5.4',
    capabilities: VISION_CAPABILITY
  }),
  apiKeyPreset({
    id: 'chatgpt',
    label: 'ChatGPT / OpenAI',
    vendor: 'chatgpt',
    baseUrl: 'https://api.openai.com/v1',
    envVarNames: ['OPENAI_API_KEY'],
    defaultModel: 'gpt-5.4',
    supportsQuickAdd: false,
    capabilities: VISION_CAPABILITY
  }),
  apiKeyPreset({
    id: 'xai',
    label: 'xAI / Grok',
    baseUrl: 'https://api.x.ai/v1',
    envVarNames: ['XAI_API_KEY'],
    defaultModel: 'grok-4'
  }),
  apiKeyPreset({
    id: 'grok',
    label: 'Grok / xAI',
    vendor: 'grok',
    baseUrl: 'https://api.x.ai/v1',
    envVarNames: ['XAI_API_KEY'],
    defaultModel: 'grok-4',
    supportsQuickAdd: false
  }),
  apiKeyPreset({
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'deepseek-compatible',
    baseUrl: 'https://api.deepseek.com',
    envVarNames: ['DEEPSEEK_API_KEY'],
    defaultModel: 'deepseek-chat'
  }),
  apiKeyPreset({
    id: 'anthropic',
    label: 'Anthropic / Claude',
    transport: 'anthropic-compatible',
    baseUrl: 'https://api.anthropic.com',
    envVarNames: ['ANTHROPIC_API_KEY'],
    defaultModel: 'claude-sonnet-4.5',
    auth: { scheme: 'x-api-key' },
    apiVersion: '2023-06-01',
    defaultHeaders: { 'anthropic-version': '2023-06-01' },
    endpoints: {
      ...DEFAULT_ENDPOINTS,
      messagesPath: '/v1/messages'
    },
    capabilities: VISION_CAPABILITY,
    notes: 'Uses the native Anthropic messages API via the Anthropic-compatible adapter.'
  }),
  apiKeyPreset({
    id: 'google_gemini',
    label: 'Google Gemini API',
    vendor: 'google_gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVarNames: ['GEMINI_API_KEY'],
    defaultModel: 'gemini-2.5-pro',
    capabilities: VISION_CAPABILITY
  }),
  apiKeyPreset({
    id: 'gemini',
    label: 'Gemini OpenAI-compatible',
    vendor: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    envVarNames: ['GEMINI_API_KEY'],
    defaultModel: 'gemini-2.5-pro',
    supportsQuickAdd: false,
    capabilities: VISION_CAPABILITY
  }),
  apiKeyPreset({
    id: 'mistral',
    label: 'Mistral AI',
    baseUrl: 'https://api.mistral.ai/v1',
    envVarNames: ['MISTRAL_API_KEY'],
    defaultModel: 'mistral-large-latest'
  }),
  apiKeyPreset({
    id: 'cohere',
    label: 'Cohere',
    transport: 'native-cohere',
    baseUrl: 'https://api.cohere.com/v2',
    envVarNames: ['COHERE_API_KEY'],
    defaultModel: 'command-a-03-2025',
    implementationStatus: 'profile-only',
    notes: 'Native Cohere v2 chat adapter is not registered in this release.'
  }),
  apiKeyPreset({
    id: 'groq',
    label: 'GroqCloud',
    baseUrl: 'https://api.groq.com/openai/v1',
    envVarNames: ['GROQ_API_KEY'],
    defaultModel: 'llama-3.3-70b-versatile'
  }),
  apiKeyPreset({
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    envVarNames: ['FIREWORKS_API_KEY'],
    defaultModel: 'accounts/fireworks/models/llama-v3p1-70b-instruct'
  }),
  apiKeyPreset({
    id: 'cerebras',
    label: 'Cerebras Cloud',
    baseUrl: 'https://api.cerebras.ai/v1',
    envVarNames: ['CEREBRAS_API_KEY'],
    defaultModel: 'llama3.1-70b'
  }),
  apiKeyPreset({
    id: 'sambanova',
    label: 'SambaNova Cloud',
    baseUrl: 'https://api.sambanova.ai/v1',
    envVarNames: ['SAMBANOVA_API_KEY'],
    defaultModel: 'Meta-Llama-3.1-70B-Instruct'
  }),
  apiKeyPreset({
    id: 'together',
    label: 'Together AI',
    baseUrl: 'https://api.together.ai/v1',
    envVarNames: ['TOGETHER_API_KEY'],
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo'
  }),
  apiKeyPreset({
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envVarNames: ['OPENROUTER_API_KEY'],
    defaultModel: 'openai/gpt-4o-mini'
  }),
  apiKeyPreset({
    id: 'perplexity',
    label: 'Perplexity Sonar',
    baseUrl: 'https://api.perplexity.ai',
    envVarNames: ['PERPLEXITY_API_KEY'],
    defaultModel: 'sonar-pro'
  }),
  apiKeyPreset({
    id: 'perplexity_agent',
    label: 'Perplexity Agent API',
    transport: 'native-perplexity-agent',
    baseUrl: 'https://api.perplexity.ai/v1',
    envVarNames: ['PERPLEXITY_API_KEY'],
    defaultModel: 'sonar-pro',
    implementationStatus: 'profile-only',
    notes: 'Perplexity Agent API is cataloged separately from Sonar chat completions.'
  }),
  apiKeyPreset({
    id: 'huggingface',
    label: 'Hugging Face Inference Providers',
    baseUrl: 'https://router.huggingface.co/v1',
    envVarNames: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'],
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct'
  }),
  apiKeyPreset({
    id: 'nvidia_nim',
    label: 'NVIDIA NIM',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    envVarNames: ['NVIDIA_API_KEY'],
    defaultModel: 'meta/llama-3.1-70b-instruct'
  }),
  apiKeyPreset({
    id: 'ai21',
    label: 'AI21 Studio',
    transport: 'native-ai21',
    baseUrl: 'https://api.ai21.com/studio/v1',
    envVarNames: ['AI21_API_KEY'],
    defaultModel: 'jamba-large',
    implementationStatus: 'profile-only'
  }),
  apiKeyPreset({
    id: 'replicate',
    label: 'Replicate',
    transport: 'native-replicate',
    baseUrl: 'https://api.replicate.com/v1',
    envVarNames: ['REPLICATE_API_TOKEN'],
    defaultModel: 'meta/meta-llama-3-70b-instruct',
    implementationStatus: 'profile-only'
  }),
  apiKeyPreset({
    id: 'dashscope_intl',
    label: 'Alibaba DashScope / Qwen Intl',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    envVarNames: ['DASHSCOPE_API_KEY'],
    defaultModel: 'qwen-plus'
  }),
  apiKeyPreset({
    id: 'dashscope_us',
    label: 'Alibaba DashScope / Qwen US',
    baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
    envVarNames: ['DASHSCOPE_API_KEY'],
    defaultModel: 'qwen-plus'
  }),
  apiKeyPreset({
    id: 'dashscope_cn',
    label: '阿里百炼 / 通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    envVarNames: ['DASHSCOPE_API_KEY'],
    defaultModel: 'qwen-plus'
  }),
  apiKeyPreset({
    id: 'zhipu',
    label: 'Zhipu GLM / BigModel',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envVarNames: ['ZHIPU_API_KEY'],
    defaultModel: 'glm-4.5'
  }),
  apiKeyPreset({
    id: 'glm',
    label: 'GLM / BigModel',
    vendor: 'glm',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    envVarNames: ['ZHIPU_API_KEY'],
    defaultModel: 'glm-4.5',
    supportsQuickAdd: false
  }),
  apiKeyPreset({
    id: 'zhipu_coding',
    label: 'Zhipu Coding Plan',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    envVarNames: ['ZHIPU_API_KEY'],
    defaultModel: 'glm-4.5'
  }),
  apiKeyPreset({
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    envVarNames: ['MOONSHOT_API_KEY'],
    defaultModel: 'moonshot-v1-8k'
  }),
  apiKeyPreset({
    id: 'kimi',
    label: 'Kimi / Moonshot',
    vendor: 'kimi',
    baseUrl: 'https://api.moonshot.ai/v1',
    envVarNames: ['MOONSHOT_API_KEY'],
    defaultModel: 'moonshot-v1-8k',
    supportsQuickAdd: false
  }),
  apiKeyPreset({
    id: 'minimax',
    label: 'MiniMax Global',
    baseUrl: 'https://api.minimax.io/v1',
    envVarNames: ['MINIMAX_API_KEY'],
    defaultModel: 'MiniMax-M1'
  }),
  apiKeyPreset({
    id: 'minimax_cn',
    label: 'MiniMax 中国区',
    baseUrl: 'https://api.minimaxi.com/v1',
    envVarNames: ['MINIMAX_API_KEY'],
    defaultModel: 'MiniMax-M1'
  }),
  apiKeyPreset({
    id: 'siliconflow',
    label: 'SiliconFlow Global',
    baseUrl: 'https://api.siliconflow.com/v1',
    envVarNames: ['SILICONFLOW_API_KEY'],
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct'
  }),
  apiKeyPreset({
    id: 'siliconflow_cn',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    envVarNames: ['SILICONFLOW_API_KEY'],
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct'
  }),
  apiKeyPreset({
    id: 'qianfan',
    label: '百度千帆',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    envVarNames: ['QIANFAN_API_KEY'],
    defaultModel: 'ernie-4.0-turbo-8k'
  }),
  apiKeyPreset({
    id: 'stepfun_global',
    label: 'StepFun Global',
    baseUrl: 'https://api.stepfun.ai/v1',
    envVarNames: ['STEPFUN_API_KEY'],
    defaultModel: 'step-2-16k'
  }),
  apiKeyPreset({
    id: 'stepfun_cn',
    label: '阶跃星辰 StepFun',
    baseUrl: 'https://api.stepfun.com/v1',
    envVarNames: ['STEPFUN_API_KEY'],
    defaultModel: 'step-2-16k'
  }),
  apiKeyPreset({
    id: 'stepfun_plan',
    label: 'StepFun Step Plan',
    baseUrl: 'https://api.stepfun.com/step_plan/v1',
    envVarNames: ['STEPFUN_API_KEY'],
    defaultModel: 'step-code'
  }),
  apiKeyPreset({
    id: 'deepinfra',
    label: 'DeepInfra',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    envVarNames: ['DEEPINFRA_API_KEY'],
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct'
  }),
  apiKeyPreset({
    id: 'hyperbolic',
    label: 'Hyperbolic',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    envVarNames: ['HYPERBOLIC_API_KEY'],
    defaultModel: 'meta-llama/Meta-Llama-3.1-70B-Instruct'
  }),
  apiKeyPreset({
    id: 'novita',
    label: 'Novita AI',
    baseUrl: 'https://api.novita.ai/openai',
    envVarNames: ['NOVITA_API_KEY'],
    defaultModel: 'meta-llama/llama-3.1-70b-instruct'
  }),
  apiKeyPreset({
    id: 'llama_api',
    label: 'Meta Llama API',
    baseUrl: 'https://api.llama.com',
    envVarNames: ['LLAMA_API_KEY'],
    defaultModel: 'Llama-4-Maverick-17B-128E-Instruct-FP8'
  }),
  apiKeyPreset({
    id: 'meta',
    label: 'Meta Llama API',
    vendor: 'meta',
    baseUrl: 'https://api.llama.com',
    envVarNames: ['LLAMA_API_KEY'],
    defaultModel: 'Llama-4-Maverick-17B-128E-Instruct-FP8',
    supportsQuickAdd: false
  }),
  apiKeyPreset({
    id: 'vercel_ai_gateway',
    label: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    envVarNames: ['VERCEL_AI_GATEWAY_API_KEY'],
    defaultModel: 'openai/gpt-4o-mini'
  }),
  apiKeyPreset({
    id: 'heroku_inference',
    label: 'Heroku Managed Inference',
    baseUrl: null,
    envVarNames: ['INFERENCE_KEY'],
    defaultModel: 'claude-3-5-sonnet',
    supportsQuickAdd: false,
    requiredConfigFields: ['INFERENCE_URL'],
    notes: 'Set baseUrl from INFERENCE_URL; Heroku exposes an OpenAI-compatible endpoint.'
  }),
  enterprisePreset({
    id: 'azure_openai',
    label: 'Azure OpenAI',
    baseUrl: null,
    envVarNames: ['AZURE_OPENAI_API_KEY'],
    defaultModel: 'deployment-name',
    requiredConfigFields: ['resource', 'deployment', 'api_version'],
    capabilities: VISION_CAPABILITY,
    notes: 'Deployment name is used as the model; auth and endpoint shape are Azure-resource specific.'
  }),
  enterprisePreset({
    id: 'vertex_ai_openai',
    label: 'Google Vertex AI OpenAI-compatible',
    baseUrl: null,
    envVarNames: ['GOOGLE_APPLICATION_CREDENTIALS'],
    defaultModel: 'google/model-name',
    requiredConfigFields: ['project_id', 'location', 'oauth_token']
  }),
  enterprisePreset({
    id: 'aws_bedrock_openai',
    label: 'AWS Bedrock OpenAI-compatible',
    baseUrl: null,
    envVarNames: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN'],
    defaultModel: 'bedrock-model-id',
    requiredConfigFields: ['region', 'aws_credentials']
  }),
  enterprisePreset({
    id: 'cloudflare_workers_ai',
    label: 'Cloudflare Workers AI',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1',
    envVarNames: ['CLOUDFLARE_API_TOKEN'],
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    requiredConfigFields: ['account_id']
  }),
  enterprisePreset({
    id: 'cloudflare_ai_gateway',
    label: 'Cloudflare AI Gateway',
    baseUrl: 'https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/openai',
    envVarNames: ['CLOUDFLARE_API_TOKEN'],
    defaultModel: 'openai/gpt-4o-mini',
    requiredConfigFields: ['account_id', 'gateway_id', 'provider_key']
  }),
  enterprisePreset({
    id: 'ibm_watsonx_gateway',
    label: 'IBM watsonx.ai Model Gateway',
    baseUrl: null,
    envVarNames: ['IBM_CLOUD_API_KEY', 'WATSONX_BEARER_TOKEN'],
    defaultModel: 'ibm/granite-3-8b-instruct',
    requiredConfigFields: ['project_id_or_space_id', 'bearer_token']
  }),
  enterprisePreset({
    id: 'volcengine_ark',
    label: 'Volcengine Ark / Doubao',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envVarNames: ['ARK_API_KEY', 'VOLCENGINE_API_KEY'],
    defaultModel: 'doubao-model-endpoint',
    requiredConfigFields: ['endpoint_or_model_id', 'region']
  }),
  enterprisePreset({
    id: 'tencent_hunyuan',
    label: 'Tencent Hunyuan',
    baseUrl: null,
    envVarNames: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY', 'HUNYUAN_API_KEY'],
    defaultModel: 'hunyuan-model',
    requiredConfigFields: ['region', 'secret_id_or_gateway_token']
  }),
  localPreset({
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1'
  }),
  localPreset({
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    defaultModel: 'local-model'
  }),
  localPreset({
    id: 'vllm',
    label: 'vLLM OpenAI Server',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'served-model'
  }),
  localPreset({
    id: 'localai',
    label: 'LocalAI',
    baseUrl: 'http://localhost:8080/v1',
    defaultModel: 'local-model'
  }),
  localPreset({
    id: 'llama_cpp',
    label: 'llama.cpp OpenAI Server',
    baseUrl: 'http://localhost:8000/v1',
    defaultModel: 'local-model'
  }),
  {
    id: 'llama',
    label: 'Legacy Local Llama',
    vendor: 'llama',
    transport: 'local-stdio',
    baseUrl: null,
    auth: none(),
    endpoints: DEFAULT_ENDPOINTS,
    defaultModel: 'local-model',
    category: 'local',
    envVarNames: [],
    requiredConfigFields: [],
    supportsQuickAdd: false,
    implementationStatus: 'profile-only',
    capabilities: LOCAL_TEXT_CAPABILITY,
    notes: 'Legacy local-stdio placeholder retained for existing manifests.'
  },
  apiKeyPreset({
    id: 'custom-openai-compatible',
    label: 'Custom OpenAI-compatible',
    vendor: 'custom',
    baseUrl: null,
    envVarNames: [],
    defaultModel: '',
    supportsQuickAdd: false,
    implementationStatus: 'runnable',
    notes: 'Use this when the endpoint follows OpenAI chat completions but is not in the preset catalog.'
  }),
  apiKeyPreset({
    id: 'custom',
    label: 'Custom Provider',
    vendor: 'custom',
    baseUrl: null,
    envVarNames: [],
    defaultModel: '',
    supportsQuickAdd: false,
    implementationStatus: 'runnable'
  })
];

export function listProviderPresetDefinitions(): ProviderPresetDefinition[] {
  return PROVIDER_PRESET_CATALOG.map((preset) => ({
    ...preset,
    auth: { ...preset.auth },
    endpoints: { ...preset.endpoints },
    defaultHeaders: preset.defaultHeaders ? { ...preset.defaultHeaders } : undefined,
    envVarNames: [...preset.envVarNames],
    requiredConfigFields: [...preset.requiredConfigFields],
    capabilities: {
      inputModalities: [...preset.capabilities.inputModalities],
      outputModalities: [...preset.capabilities.outputModalities],
      supportsVision: preset.capabilities.supportsVision,
      supportsFiles: preset.capabilities.supportsFiles,
      supportedFileExtensions: [...preset.capabilities.supportedFileExtensions]
    }
  }));
}

export function findProviderPresetDefinition(idOrVendor: string | undefined | null): ProviderPresetDefinition | null {
  const normalized = idOrVendor?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  const presets = listProviderPresetDefinitions();
  return presets.find((preset) => preset.id === normalized)
    ?? presets.find((preset) => preset.vendor === normalized)
    ?? null;
}
