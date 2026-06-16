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
  apiKeyLabel?: string | undefined;
  setupNotes?: string[] | undefined;
  models: ModelPreset[];
};

const verifiedAt = "2026-06-16";

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
      preset("gpt-5.5", 1_000_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.5", { maxOutputTokens: 128_000 }),
      preset("gpt-5.5-pro", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.5-pro", { maxOutputTokens: 128_000 }),
      preset("gpt-5.4", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.4"),
      preset("gpt-5.4-mini", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.4-mini"),
      preset("gpt-5.4-nano", 1_050_000, true, true, "https://developers.openai.com/api/docs/models/gpt-5.4-nano"),
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
      preset("claude-fable-5", 1_000_000, true, true, "https://docs.anthropic.com/en/docs/about-claude/models", { maxOutputTokens: 128_000 }),
      preset("claude-opus-4-8", 1_000_000, true, true, "https://docs.anthropic.com/en/docs/about-claude/models/whats-new-claude-4-8", { maxOutputTokens: 128_000 }),
      preset("claude-opus-4-7", 1_000_000, true, true, "https://platform.claude.com/docs/en/build-with-claude/context-windows"),
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
      preset("gemini-3.5-flash", 1_000_000, true, true, "https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash", { contextWindowKind: "input" }),
      preset("gemini-3.1-pro-preview", 2_000_000, true, true, "https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview", { maxOutputTokens: 65_536, contextWindowKind: "input" }),
      preset("gemini-3-flash-preview", 1_000_000, true, true, "https://ai.google.dev/gemini-api/docs/models/gemini-3-flash-preview", { contextWindowKind: "input" }),
      preset("gemini-2.5-pro", 1_048_576, true, true, "https://ai.google.dev/gemini-api/docs/models", { maxOutputTokens: 65_536, contextWindowKind: "input" }),
      preset("gemini-2.5-flash", 1_048_576, true, true, "https://ai.google.dev/gemini-api/docs/models", { contextWindowKind: "input" }),
      preset("gemini-2.5-flash-lite", 1_048_576, true, true, "https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite", { contextWindowKind: "input" })
    ]
  },
  {
    vendor: "xai",
    label: "xAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.x.ai/v1",
    docsUrl: "https://docs.x.ai/docs/models",
    models: [
      preset("grok-4.3", 1_000_000, true, true, "https://docs.x.ai/docs/models/grok-3"),
      preset("grok-4.3-latest", 1_000_000, true, true, "https://docs.x.ai/docs/models/grok-3"),
      preset("grok-4-1-fast", 1_000_000, true, false, "https://docs.x.ai/docs/models"),
      preset("grok-4-fast", 1_310_720, true, false, "https://docs.x.ai/docs/models")
    ]
  },
  {
    vendor: "deepseek",
    label: "DeepSeek",
    protocol: "openai_compatible",
    baseUrl: "https://api.deepseek.com",
    docsUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    setupNotes: [
      "DeepSeek V4 uses the OpenAI-compatible base URL https://api.deepseek.com; Anthropic-compatible clients must use https://api.deepseek.com/anthropic instead.",
      "deepseek-v4-flash and deepseek-v4-pro both support thinking/non-thinking mode; provider-specific reasoning controls are not the same as OpenAI reasoning.effort."
    ],
    models: [
      preset("deepseek-v4-flash", 1_000_000, true, true, "https://api-docs.deepseek.com/quick_start/pricing", { maxOutputTokens: 384_000 }),
      preset("deepseek-v4-pro", 1_000_000, true, true, "https://api-docs.deepseek.com/quick_start/pricing", { maxOutputTokens: 384_000 }),
      preset("deepseek-chat", 131_072, true, false, "https://api-docs.deepseek.com/quick_start/pricing"),
      preset("deepseek-reasoner", 131_072, true, true, "https://api-docs.deepseek.com/quick_start/pricing")
    ]
  },
  {
    vendor: "qwen",
    label: "Qwen",
    protocol: "openai_compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    docsUrl: "https://help.aliyun.com/zh/model-studio/text-generation-model/",
    setupNotes: [
      "Qwen OpenAI-compatible Chat Completions supports Qwen3.7, Qwen3.6, Qwen3.5 and related model families through DashScope compatible mode.",
      "Hybrid thinking controls such as enable_thinking are provider-specific extra_body fields; the current Workbench preset keeps the request OpenAI-compatible and does not force those non-standard fields.",
      "DashScope token plans, resource packages and batch discounts are billing features, not interchangeable API key formats like MiMo Token Plan."
    ],
    models: [
      preset("qwen3.7-max", 1_000_000, true, true, "https://help.aliyun.com/zh/model-studio/deep-thinking"),
      preset("qwen3.7-plus", 1_000_000, true, true, "https://help.aliyun.com/zh/model-studio/text-generation-model/"),
      preset("qwen3.6-flash", 1_000_000, true, true, "https://help.aliyun.com/zh/model-studio/text-generation-model/"),
      preset("qwen3.6-plus", 1_000_000, true, true, "https://help.aliyun.com/zh/model-studio/deep-thinking"),
      preset("qwen3.5-plus", 256_000, true, true, "https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions"),
      preset("qwen3.5-flash", 256_000, true, true, "https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions"),
      preset("qwen3-coder", 131_072, true, true, "https://help.aliyun.com/zh/model-studio/partial-mode")
    ]
  },
  {
    vendor: "kimi",
    label: "Kimi",
    protocol: "openai_compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    docsUrl: "https://platform.kimi.com/docs/api/chat",
    setupNotes: [
      "Kimi Code Plan requires a stable prompt_cache_key to improve cache hit rate; Agent Workbench sends one automatically for official Kimi endpoints in auto prompt-cache mode.",
      "kimi-k2.7-code keeps thinking enabled by design; older Kimi models may expose different thinking behavior."
    ],
    models: [
      preset("kimi-k2.7-code", 256_000, true, true, "https://platform.kimi.com/docs/api/chat"),
      preset("kimi-k2.7-code-highspeed", 256_000, true, true, "https://platform.kimi.com/docs/api/chat"),
      preset("kimi-k2.6", 256_000, true, true, "https://platform.kimi.com/docs/api/chat"),
      preset("kimi-k2.5", 256_000, true, true, "https://platform.kimi.com/docs/api/chat"),
      preset("moonshot-v1", 128_000, true, false, "https://platform.kimi.com/docs/api/chat"),
      preset("moonshot-v1-128k", 128_000, true, false, "https://platform.kimi.com/docs/api/chat")
    ]
  },
  {
    vendor: "mistral",
    label: "Mistral AI",
    protocol: "openai_compatible",
    baseUrl: "https://api.mistral.ai/v1",
    docsUrl: "https://docs.mistral.ai/models/overview",
    models: [
      preset("mistral-medium-3.5", 256_000, true, true, "https://docs.mistral.ai/models/overview"),
      preset("mistral-small-4", 256_000, true, true, "https://docs.mistral.ai/models/overview"),
      preset("mistral-large-3", 256_000, true, true, "https://docs.mistral.ai/models/overview"),
      preset("devstral-2", 256_000, true, true, "https://docs.mistral.ai/models/overview"),
      preset("codestral-latest", 256_000, true, false, "https://docs.mistral.ai/models/overview")
    ]
  },
  {
    vendor: "minimax",
    label: "MiniMax",
    protocol: "openai_compatible",
    baseUrl: "https://api.minimax.chat/v1",
    docsUrl: "https://platform.minimax.io/docs/guides/models-intro",
    models: [
      preset("MiniMax-M3", 1_000_000, true, true, "https://platform.minimax.io/docs/guides/models-intro"),
      preset("MiniMax-M2.7", 200_000, true, true, "https://platform.minimax.io/docs/guides/models-intro"),
      preset("MiniMax-M2.7-highspeed", 200_000, true, true, "https://platform.minimax.io/docs/guides/models-intro"),
      preset("MiniMax-M2.5", 200_000, true, true, "https://platform.minimax.io/docs/guides/models-intro"),
      preset("MiniMax-M2.5-highspeed", 200_000, true, true, "https://platform.minimax.io/docs/guides/models-intro"),
      preset("MiniMax-M2", 200_000, true, true, "https://platform.minimax.io/docs/guides/models-intro")
    ]
  },
  {
    vendor: "mimo",
    label: "Xiaomi MiMo",
    protocol: "openai_compatible",
    baseUrl: "https://api.xiaomimimo.com/v1",
    docsUrl: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/quick-access",
    apiKeyLabel: "Pay-as-you-go API Key",
    setupNotes: [
      "Pay-as-you-go MiMo API keys use sk-* and the ordinary OpenAI-compatible base URL https://api.xiaomimimo.com/v1.",
      "MiMo Token Plan keys use tp-* and cannot be mixed with pay-as-you-go keys; choose a Token Plan preset when using a subscription package.",
      "V2 legacy model names are near retirement or auto-forwarding in Token Plan docs, so the preset only promotes V2.5 chat models."
    ],
    models: [
      preset("mimo-v2.5-pro", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription"),
      preset("mimo-v2.5", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription")
    ]
  },
  {
    vendor: "mimo-token-plan-cn",
    label: "Xiaomi MiMo Token Plan · China",
    protocol: "openai_compatible",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    docsUrl: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
    apiKeyLabel: "Token Plan API Key",
    setupNotes: [
      "Use the Token Plan API key from the Token Plan page; the documented format is tp-* and it is independent from sk-* pay-as-you-go keys.",
      "This preset uses the OpenAI-compatible China cluster. Anthropic-compatible tools must use the /anthropic endpoint, which is a different protocol shape.",
      "Token Plan is documented for AI programming tools and package quotas; do not use this preset for unrelated pay-as-you-go backend traffic."
    ],
    models: [
      preset("mimo-v2.5-pro", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription"),
      preset("mimo-v2.5", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription")
    ]
  },
  {
    vendor: "mimo-token-plan-sgp",
    label: "Xiaomi MiMo Token Plan · Singapore",
    protocol: "openai_compatible",
    baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
    docsUrl: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
    apiKeyLabel: "Token Plan API Key",
    setupNotes: [
      "Use the Token Plan API key from the Token Plan page; the documented format is tp-* and it is independent from sk-* pay-as-you-go keys.",
      "This preset uses the OpenAI-compatible Singapore cluster. Anthropic-compatible tools must use the /anthropic endpoint, which is a different protocol shape.",
      "Token Plan is documented for AI programming tools and package quotas; do not use this preset for unrelated pay-as-you-go backend traffic."
    ],
    models: [
      preset("mimo-v2.5-pro", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription"),
      preset("mimo-v2.5", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription")
    ]
  },
  {
    vendor: "mimo-token-plan-ams",
    label: "Xiaomi MiMo Token Plan · Europe",
    protocol: "openai_compatible",
    baseUrl: "https://token-plan-ams.xiaomimimo.com/v1",
    docsUrl: "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription",
    apiKeyLabel: "Token Plan API Key",
    setupNotes: [
      "Use the Token Plan API key from the Token Plan page; the documented format is tp-* and it is independent from sk-* pay-as-you-go keys.",
      "This preset uses the OpenAI-compatible Europe cluster. Anthropic-compatible tools must use the /anthropic endpoint, which is a different protocol shape.",
      "Token Plan is documented for AI programming tools and package quotas; do not use this preset for unrelated pay-as-you-go backend traffic."
    ],
    models: [
      preset("mimo-v2.5-pro", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription"),
      preset("mimo-v2.5", 1_048_576, true, true, "https://mimo.mi.com/docs/en-US/tokenplan/Token%20Plan/subscription")
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
    setupNotes: [
      "Volcengine Ark model IDs may be endpoint-specific; if a console deployment exposes a different endpoint model name, switch to Custom model and keep this base URL.",
      "Doubao Seed 2.0 model IDs use hyphenated endpoint-style names in model-list docs and dotted family names in pricing docs; prefer the exact ID shown by the Ark console for production."
    ],
    models: [
      preset("doubao-seed-2-0-pro-260428", 256_000, true, true, "https://www.volcengine.com/docs/82379/1330310"),
      preset("doubao-seed-2-0-mini-260428", 256_000, true, true, "https://www.volcengine.com/docs/82379/1330310"),
      preset("doubao-seed-2-0-lite-260428", 256_000, true, false, "https://www.volcengine.com/docs/82379/1330310"),
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
    setupNotes: [
      "OpenRouter routes upstream model IDs; availability and exact IDs can change faster than provider-native docs. Use OpenRouter's model page when a routed model fails.",
      "Prompt-cache support is provider-routed. Keep AGENT_WORKBENCH_PROMPT_CACHE_MODE=auto unless OpenRouter documents prompt_cache_key support for the selected route."
    ],
    models: [
      preset("openai/gpt-5.5", 1_000_000, true, true, "https://openrouter.ai/docs/models", { maxOutputTokens: 128_000 }),
      preset("anthropic/claude-fable-5", 1_000_000, true, true, "https://openrouter.ai/docs/models", { maxOutputTokens: 128_000 }),
      preset("google/gemini-3.5-flash", 1_000_000, true, true, "https://openrouter.ai/docs/models"),
      preset("deepseek/deepseek-v4-flash", 1_000_000, true, true, "https://openrouter.ai/docs/models", { maxOutputTokens: 384_000 }),
      preset("qwen/qwen3.7-plus", 1_000_000, true, true, "https://openrouter.ai/docs/models"),
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
