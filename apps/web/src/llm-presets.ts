import type { ModelPreset, ProviderProtocol, PreferencesPatch, UserPreferences } from "@scc/shared";

export type LlmProviderId = UserPreferences["llmProvider"];

export interface LlmModelPreset {
  id: string;
  label: string;
  contextWindow: number;
}

export interface LlmProviderPreset {
  id: LlmProviderId;
  label: string;
  description: string;
  baseUrl: string;
  models: LlmModelPreset[];
  requiresManualContext?: boolean;
}

export interface ModelProviderPreset {
  vendor: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  models: ModelPreset[];
}

export const MODEL_PROVIDER_PRESETS: ModelProviderPreset[] = [
  {
    vendor: "mimo",
    label: "Mimo",
    protocol: "openai_compatible",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    models: [
      { id: "mimo-v2.5", label: "mimo-v2.5", contextWindow: 128000, supportsTools: true, supportsThinking: true },
      { id: "mimo-v2.5-pro", label: "mimo-v2.5-pro", contextWindow: 200000, supportsTools: true, supportsThinking: true }
    ]
  },
  {
    vendor: "openai",
    label: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-4.1", label: "gpt-4.1", contextWindow: 1047576, supportsTools: true, supportsThinking: false },
      { id: "gpt-4.1-mini", label: "gpt-4.1-mini", contextWindow: 1047576, supportsTools: true, supportsThinking: false },
      { id: "o4-mini", label: "o4-mini", contextWindow: 200000, supportsTools: true, supportsThinking: true }
    ]
  },
  {
    vendor: "anthropic",
    label: "Anthropic",
    protocol: "anthropic_messages",
    baseUrl: "https://api.anthropic.com",
    models: [
      { id: "claude-3-5-sonnet-latest", label: "claude-3-5-sonnet-latest", contextWindow: 200000, supportsTools: true, supportsThinking: false },
      { id: "claude-3-5-haiku-latest", label: "claude-3-5-haiku-latest", contextWindow: 200000, supportsTools: true, supportsThinking: false }
    ]
  },
  {
    vendor: "gemini",
    label: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    models: [
      { id: "gemini-1.5-pro", label: "gemini-1.5-pro", contextWindow: 2000000, supportsTools: true, supportsThinking: false },
      { id: "gemini-1.5-flash", label: "gemini-1.5-flash", contextWindow: 1000000, supportsTools: true, supportsThinking: false }
    ]
  },
  {
    vendor: "openrouter",
    label: "OpenRouter",
    protocol: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [
      { id: "openai/gpt-4.1", label: "openai/gpt-4.1", contextWindow: 1047576, supportsTools: true, supportsThinking: false },
      { id: "anthropic/claude-3.5-sonnet", label: "anthropic/claude-3.5-sonnet", contextWindow: 200000, supportsTools: true, supportsThinking: false }
    ]
  },
  {
    vendor: "custom",
    label: "Custom",
    protocol: "openai_compatible",
    baseUrl: "",
    models: []
  }
];

export const LLM_PROVIDERS: LlmProviderPreset[] = [
  {
    id: "mimo",
    label: "Mimo",
    description: "Preferred local API-key document provider.",
    baseUrl: "",
    models: [
      { id: "mimo-v2.5", label: "Mimo v2.5", contextWindow: 128000 },
      { id: "mimo-v2.5-pro", label: "Mimo v2.5 Pro", contextWindow: 200000 }
    ]
  },
  {
    id: "openai",
    label: "OpenAI",
    description: "OpenAI-compatible default models.",
    baseUrl: "https://api.openai.com/v1",
    models: [
      { id: "gpt-5.4-mini", label: "GPT-5.4 Mini", contextWindow: 128000 },
      { id: "gpt-5.4", label: "GPT-5.4", contextWindow: 128000 },
      { id: "gpt-5.5", label: "GPT-5.5", contextWindow: 256000 }
    ]
  },
  {
    id: "openai_compatible",
    label: "OpenAI compatible",
    description: "Use a custom base URL with a known model preset.",
    baseUrl: "",
    models: [
      { id: "qwen-max", label: "Qwen Max", contextWindow: 128000 },
      { id: "deepseek-chat", label: "DeepSeek Chat", contextWindow: 64000 },
      { id: "claude-sonnet-compatible", label: "Claude Sonnet compatible", contextWindow: 200000 }
    ]
  },
  {
    id: "custom",
    label: "Custom",
    description: "Manually enter model id, base URL, and context window.",
    baseUrl: "",
    models: [],
    requiresManualContext: true
  }
];

export function providerById(id?: string | null): LlmProviderPreset {
  return LLM_PROVIDERS.find((provider) => provider.id === id) ?? LLM_PROVIDERS[0]!;
}

export function defaultModelForProvider(providerId: LlmProviderId): LlmModelPreset | null {
  return providerById(providerId).models[0] ?? null;
}

export function getModelContextLimit(preferences: UserPreferences | null): number {
  if (!preferences) return 128000;
  if (preferences.llmProvider === "custom") return Math.max(1, preferences.customModelContextWindow ?? preferences.maxTokensPerRequest ?? 1);
  const provider = providerById(preferences.llmProvider);
  return provider.models.find((model) => model.id === preferences.defaultModel)?.contextWindow ?? 128000;
}

export function normalizeContextPatch(current: UserPreferences | null, patch: PreferencesPatch): PreferencesPatch {
  const next = { ...(current ?? {}), ...patch } as UserPreferences;
  const provider = providerById(next.llmProvider);
  const forcedManual = provider.requiresManualContext || next.llmProvider === "custom";
  const contextMode = forcedManual ? "manual" : next.contextMode ?? "auto";
  const limit = getModelContextLimit({ ...next, contextMode });
  const maxTokens = contextMode === "auto" ? limit : Math.min(Math.max(1, next.maxTokensPerRequest || limit), limit);
  return {
    ...patch,
    contextMode,
    maxTokensPerRequest: maxTokens,
    ...(next.llmProvider === "custom" ? { customModelContextWindow: limit } : {})
  };
}
