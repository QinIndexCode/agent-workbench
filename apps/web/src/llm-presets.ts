export type ContextWindowKind = "total" | "input";

export interface ModelPreset {
  id: string;
  label: string;
  contextWindow: number;
  contextWindowKind?: ContextWindowKind | undefined;
  maxOutputTokens?: number | undefined;
  supportsTools: boolean;
  supportsThinking: boolean;
  docsUrl?: string | undefined;
}

export type ModelProviderProtocol = "openai_compatible" | "anthropic_messages" | "gemini";

export type ModelProviderPreset = {
  vendor: string;
  label: string;
  protocol: ModelProviderProtocol;
  baseUrl: string;
  docsUrl?: string | undefined;
  models: ModelPreset[];
};

const verifiedAt = "2026-05-07";

function preset(
  id: string,
  contextWindow: number,
  supportsTools: boolean,
  supportsThinking: boolean,
  docsUrl?: string,
  extras?: { maxOutputTokens?: number; contextWindowKind?: ContextWindowKind }
): ModelPreset {
  return {
    id,
    label: id,
    contextWindow,
    contextWindowKind: extras?.contextWindowKind ?? "total",
    maxOutputTokens: extras?.maxOutputTokens,
    supportsTools,
    supportsThinking,
    docsUrl
  };
}

export const CONTEXT_QUICK_PRESETS = ["32K", "128K", "200K", "256K", "512K", "1M", "2M"];

export function parseTokenAmount(value: string): number {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.endsWith("m")) {
    const num = parseFloat(trimmed.slice(0, -1));
    if (!Number.isFinite(num)) throw new Error("Invalid token amount");
    return Math.round(num * 1_000_000);
  }
  if (trimmed.endsWith("k")) {
    const num = parseFloat(trimmed.slice(0, -1));
    if (!Number.isFinite(num)) throw new Error("Invalid token amount");
    return Math.round(num * 1_000);
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) throw new Error("Invalid token amount");
  return Math.round(num);
}

export function formatTokenAmount(value: number): string {
  if (value >= 1_000_000 && value % 1_000_000 === 0) {
    return `${value / 1_000_000}M tokens`;
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(2)}M tokens`;
  }
  if (value >= 1_000 && value % 1_000 === 0) {
    return `${value / 1_000}K tokens`;
  }
  return `${value.toLocaleString()} tokens`;
}

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    vendor: "openai",
    label: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    docsUrl: "https://developers.openai.com/api/docs/models",
    models: [
      preset("gpt-5.4", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.4"),
      preset("gpt-5.4-mini", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.4-mini"),
      preset("gpt-5.4-pro", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.4-pro"),
      preset("gpt-4.1", 1_047_576, true, false, "https://developers.openai.com/api/docs/models"),
      preset("gpt-4.1-mini", 1_047_576, true, false, "https://developers.openai.com/api/docs/models"),
      preset("o3", 200_000, true, true, "https://developers.openai.com/api/docs/models"),
      preset("o3-pro", 200_000, true, true, "https://developers.openai.com/api/docs/models"),
      preset("o4-mini", 200_000, true, true, "https://developers.openai.com/api/docs/models")
    ]
  },
  {
    vendor: "anthropic",
    label: "Anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    docsUrl: "https://platform.claude.com/docs/en/build-with-claude/context-windows",
    models: [
      preset("claude-opus-4-7", 1_000_000, true, true, "https://platform.claude.com/docs/en/build-with-claude/context-windows"),
      preset("claude-opus-4-6", 1_000_000, true, true, "https://platform.claude.com/docs/en/build-with-claude/context-windows"),
      preset("claude-sonnet-4-6", 1_000_000, true, true, "https://platform.claude.com/docs/en/build-with-claude/context-windows"),
      preset("claude-sonnet-4-5", 200_000, true, true, "https://platform.claude.com/docs/en/build-with-claude/context-windows"),
      preset("claude-haiku-4-5", 200_000, true, true, "https://platform.claude.com/docs/en/build-with-claude/context-windows")
    ]
  },
  {
    vendor: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    docsUrl: "https://ai.google.dev/gemini-api/docs/models",
    models: [
      preset("gemini-3.1-pro-preview", 2_000_000, true, true, "https://ai.google.dev/gemini-api/docs/models", { maxOutputTokens: 65_536, contextWindowKind: "input" }),
      preset("gemini-2.5-pro", 1_048_576, true, true, "https://ai.google.dev/gemini-api/docs/models", { maxOutputTokens: 65_536, contextWindowKind: "input" }),
      preset("gemini-2.5-flash", 1_048_576, true, true, "https://ai.google.dev/gemini-api/docs/models", { contextWindowKind: "input" }),
      preset("gemini-3-flash", 1_000_000, true, false, "https://ai.google.dev/gemini-api/docs/models", { contextWindowKind: "input" }),
      preset("gemini-2.0-flash", 1_048_576, true, false, "https://ai.google.dev/gemini-api/docs/models", { contextWindowKind: "input" })
    ]
  },
  {
    vendor: "xai",
    label: "xAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://docs.x.ai/docs/models",
    models: [
      preset("grok-4-1-fast", 1_500_000, true, false, "https://docs.x.ai/docs/models"),
      preset("grok-4-1", 1_500_000, true, true, "https://docs.x.ai/docs/models"),
      preset("grok-4-1-thinking", 1_500_000, true, true, "https://docs.x.ai/docs/models"),
      preset("grok-4-fast", 1_310_720, true, false, "https://docs.x.ai/docs/models")
    ]
  },
  {
    vendor: "deepseek",
    label: "DeepSeek",
    protocol: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://platform.deepseek.com/api-docs",
    models: [
      preset("deepseek-chat", 131_072, true, false, "https://platform.deepseek.com/api-docs"),
      preset("deepseek-reasoner", 131_072, true, true, "https://platform.deepseek.com/api-docs")
    ]
  },
  {
    vendor: "qwen",
    label: "Qwen",
    protocol: "openai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/zh/model-studio/user-guide/models",
    models: [
      preset("qwen3.6-plus", 500_000, true, true, "https://help.aliyun.com/zh/model-studio/user-guide/models"),
      preset("qwen3.5-plus", 256_000, true, true, "https://help.aliyun.com/zh/model-studio/user-guide/models"),
      preset("qwen3-max", 131_072, true, true, "https://help.aliyun.com/zh/model-studio/user-guide/models"),
      preset("qwen3-235b-a22b", 131_072, true, true, "https://help.aliyun.com/zh/model-studio/user-guide/models"),
      preset("qwen3-coder", 131_072, true, true, "https://help.aliyun.com/zh/model-studio/user-guide/models"),
      preset("qwen3.5-0.8b", 131_072, true, false, "https://help.aliyun.com/zh/model-studio/user-guide/models")
    ]
  },
  {
    vendor: "kimi",
    label: "Kimi",
    protocol: "openai_compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.moonshot.cn/docs",
    models: [
      preset("kimi-k2.6", 256_000, true, true, "https://platform.moonshot.cn/docs"),
      preset("kimi-k2.5", 256_000, true, true, "https://platform.moonshot.cn/docs"),
      preset("kimi-k2-thinking", 128_000, true, true, "https://platform.moonshot.cn/docs"),
      preset("moonshot-v1-32k", 32_000, true, false, "https://platform.moonshot.cn/docs"),
      preset("moonshot-v1-128k", 128_000, true, false, "https://platform.moonshot.cn/docs")
    ]
  },
  {
    vendor: "mistral",
    label: "Mistral AI",
    protocol: "openai_compatible",
    baseUrl: "https://api.mistral.ai/v1",
    docsUrl: "https://docs.mistral.ai/getting-started/models/",
    models: [
      preset("mistral-medium-3.5", 256_000, true, true, "https://docs.mistral.ai/getting-started/models/"),
      preset("mistral-large-3", 256_000, true, true, "https://docs.mistral.ai/getting-started/models/"),
      preset("mistral-small-4", 256_000, true, true, "https://docs.mistral.ai/getting-started/models/"),
      preset("codestral-latest", 256_000, true, false, "https://docs.mistral.ai/getting-started/models/")
    ]
  },
  {
    vendor: "minimax",
    label: "MiniMax",
    protocol: "openai_compatible",
    baseUrl: "https://api.minimax.chat/v1",
    docsUrl: "https://platform.minimaxi.com/document/Models",
    models: [
      preset("MiniMax-M2.7", 1_000_000, true, true, "https://platform.minimaxi.com/document/Models"),
      preset("MiniMax-M1", 456_000, true, true, "https://platform.minimaxi.com/document/Models"),
      preset("MiniMax-M1-40k", 40_000, true, false, "https://platform.minimaxi.com/document/Models")
    ]
  },
  {
    vendor: "mimo",
    label: "Xiaomi MiMo",
    protocol: "openai_compatible",
    baseUrl: "https://api.xiaomi.com/v1",
    docsUrl: "https://dev.mi.com/platform/doc?p=/doc/m/mimo",
    models: [
      preset("MiMo-V2.5-Pro", 131_072, true, true, "https://dev.mi.com/platform/doc?p=/doc/m/mimo"),
      preset("MiMo-V2.5", 131_072, true, true, "https://dev.mi.com/platform/doc?p=/doc/m/mimo"),
      preset("MiMo-V2-Flash", 131_072, true, false, "https://dev.mi.com/platform/doc?p=/doc/m/mimo")
    ]
  },
  {
    vendor: "zhipu",
    label: "Zhipu AI",
    protocol: "openai_compatible",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    docsUrl: "https://bigmodel.cn/dev/howuse/introduction",
    models: [
      preset("GLM-5.1", 200_000, true, true, "https://bigmodel.cn/dev/howuse/introduction"),
      preset("GLM-5", 200_000, true, true, "https://bigmodel.cn/dev/howuse/introduction"),
      preset("GLM-4.7", 128_000, true, true, "https://bigmodel.cn/dev/howuse/introduction"),
      preset("GLM-4.7-flash", 128_000, true, false, "https://bigmodel.cn/dev/howuse/introduction")
    ]
  },
  {
    vendor: "doubao",
    label: "Doubao",
    protocol: "openai_compatible",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    docsUrl: "https://www.volcengine.com/docs/82379",
    models: [
      preset("doubao-seed-1-6-pro", 256_000, true, true, "https://www.volcengine.com/docs/82379"),
      preset("doubao-seed-1-6", 256_000, true, true, "https://www.volcengine.com/docs/82379"),
      preset("doubao-seed-1-6-lite", 128_000, true, false, "https://www.volcengine.com/docs/82379")
    ]
  },
  {
    vendor: "baidu",
    label: "Baidu",
    protocol: "openai_compatible",
    baseUrl: "https://aip.baidubce.com/rpc/2.0/ai_custom/v1/wenxinworkshop",
    docsUrl: "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7",
    models: [
      preset("ernie-5.0", 200_000, true, true, "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7"),
      preset("ernie-4.5-turbo-128k", 128_000, true, false, "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7"),
      preset("ernie-speed-128k", 128_000, true, false, "https://cloud.baidu.com/doc/WENXINWORKSHOP/s/hlrk4akp7")
    ]
  },
  {
    vendor: "meta",
    label: "Meta",
    protocol: "openai_compatible",
    baseUrl: "https://api.together.xyz/v1",
    docsUrl: "https://llama.meta.com/docs/model-cards-and-prompt-formats/llama4/",
    models: [
      preset("Llama-4-Maverick-17B-128E-Instruct", 1_000_000, true, true, "https://llama.meta.com/docs/model-cards-and-prompt-formats/llama4/"),
      preset("Llama-4-Scout-17B-16E-Instruct", 10_000_000, true, false, "https://llama.meta.com/docs/model-cards-and-prompt-formats/llama4/"),
      preset("Meta-Llama-3.3-70B-Instruct", 131_072, true, false, "https://llama.meta.com/docs/model-cards-and-prompt-formats/llama3/")
    ]
  },
  {
    vendor: "nvidia",
    label: "NVIDIA",
    protocol: "openai_compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    docsUrl: "https://build.nvidia.com/docs/models",
    models: [
      preset("nvidia/Nemotron-3-49B-v1", 131_072, true, true, "https://build.nvidia.com/docs/models"),
      preset("nvidia/Llama-Nemotron-Super-49B-v1", 131_072, true, true, "https://build.nvidia.com/docs/models"),
      preset("nvidia/Nemotron-Ultra-253B-v1", 128_000, true, true, "https://build.nvidia.com/docs/models")
    ]
  },
  {
    vendor: "cohere",
    label: "Cohere",
    protocol: "openai_compatible",
    baseUrl: "https://api.cohere.com/v2",
    docsUrl: "https://docs.cohere.com/docs/command-r-plus",
    models: [
      preset("command-a", 256_000, true, false, "https://docs.cohere.com/docs/command-r-plus"),
      preset("command-r-plus-08-2024", 128_000, true, false, "https://docs.cohere.com/docs/command-r-plus"),
      preset("command-r", 128_000, true, false, "https://docs.cohere.com/docs/command-r")
    ]
  },
  {
    vendor: "stepfun",
    label: "Stepfun",
    protocol: "openai_compatible",
    baseUrl: "https://api.stepfun.com/v1",
    docsUrl: "https://platform.stepfun.com/docs/llm-overview",
    models: [
      preset("step-2-16k-exp", 16_000, true, true, "https://platform.stepfun.com/docs/llm-overview"),
      preset("step-2-16k", 16_000, true, false, "https://platform.stepfun.com/docs/llm-overview")
    ]
  },
  {
    vendor: "spark",
    label: "iFlytek Spark",
    protocol: "openai_compatible",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    docsUrl: "https://www.xfyun.cn/doc/spark/",
    models: [
      preset("spark-x1.5", 256_000, true, true, "https://www.xfyun.cn/doc/spark/"),
      preset("spark-4.0-ultra", 128_000, true, false, "https://www.xfyun.cn/doc/spark/"),
      preset("spark-max", 8_192, true, false, "https://www.xfyun.cn/doc/spark/")
    ]
  },
  {
    vendor: "openrouter",
    label: "OpenRouter",
    protocol: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    docsUrl: "https://openrouter.ai/docs/overview",
    models: [
      preset("openai/gpt-5.4", 1_050_000, true, true, "https://openrouter.ai/docs/models"),
      preset("anthropic/claude-opus-4-6", 1_000_000, true, true, "https://openrouter.ai/docs/models"),
      preset("google/gemini-2.5-pro", 1_048_576, true, true, "https://openrouter.ai/docs/models", { maxOutputTokens: 65_536 }),
      preset("deepseek/deepseek-chat", 131_072, true, false, "https://openrouter.ai/docs/models"),
      preset("qwen/qwen3-max", 131_072, true, true, "https://openrouter.ai/docs/models"),
      preset("mistralai/mistral-large-3", 256_000, true, true, "https://openrouter.ai/docs/models")
    ]
  },
  {
    vendor: "custom",
    label: "自定义端点",
    protocol: "openai_compatible",
    baseUrl: "",
    models: [
      preset("custom-model", 128_000, false, false, undefined, { maxOutputTokens: 4_096 })
    ]
  }
];

export const MODEL_PROVIDER_PRESET_MAP = Object.fromEntries(
  MODEL_PROVIDER_PRESETS.map((entry) => [entry.vendor, entry])
) as Record<string, ModelProviderPreset>;

export const MODEL_PROVIDER_PRESET_INDEX = new Map(
  MODEL_PROVIDER_PRESETS.map((entry) => [entry.vendor.toLowerCase(), entry])
);

export function findModelPreset(vendorId: string, modelId: string): ModelPreset | null {
  const provider = MODEL_PROVIDER_PRESET_INDEX.get(vendorId.toLowerCase());
  return provider?.models.find((m) => m.id === modelId) ?? null;
}

export function getProviderPreset(vendorId: string): ModelProviderPreset | null {
  return MODEL_PROVIDER_PRESET_INDEX.get(vendorId.toLowerCase()) ?? null;
}

export function providerById(id: string | null | undefined): ModelProviderPreset {
  const found = getProviderPreset(id ?? "");
  return found ?? MODEL_PROVIDER_PRESETS[0] ?? { vendor: "openai", label: "OpenAI", protocol: "openai_compatible", baseUrl: "https://api.openai.com/v1", models: [] };
}

export function normalizeContextPatch<T>(target: T, patch: Partial<T>): T {
  return { ...target, ...patch };
}

export function resolveProviderIdFromAny(value: string): string | null {
  const source = (value ?? "").toLowerCase().trim();
  if (!source) {
    return null;
  }

  for (const entry of MODEL_PROVIDER_PRESETS) {
    const vendor = entry.vendor.toLowerCase();
    const label = entry.label.toLowerCase();

    if (source === vendor || source === label) {
      return entry.vendor;
    }

    if (source.includes(vendor) || source.includes(label)) {
      return entry.vendor;
    }
  }

  return null;
}

export function resolveModelId(modelId: string, providerId: string): string {
  const provider = getProviderPreset(providerId);
  if (!provider) {
    return modelId;
  }
  const model = provider.models.find((item) => item.id === modelId);
  return model?.id ?? provider.models[0]?.id ?? modelId;
}

export function listModelOptions(providerId: string): ModelPreset[] {
  return getProviderPreset(providerId)?.models ?? [];
}

export { verifiedAt };
