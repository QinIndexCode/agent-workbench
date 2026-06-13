import { SlidersHorizontal } from "lucide-react";
import anthropicIcon from "@lobehub/icons-static-svg/icons/anthropic.svg";
import baiduIcon from "@lobehub/icons-static-svg/icons/baidu-color.svg";
import cohereIcon from "@lobehub/icons-static-svg/icons/cohere-color.svg";
import deepSeekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import doubaoIcon from "@lobehub/icons-static-svg/icons/doubao-color.svg";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi.svg";
import metaIcon from "@lobehub/icons-static-svg/icons/meta-color.svg";
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import nvidiaIcon from "@lobehub/icons-static-svg/icons/nvidia-color.svg";
import openAiIcon from "@lobehub/icons-static-svg/icons/openai.svg";
import openRouterIcon from "@lobehub/icons-static-svg/icons/openrouter.svg";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import sparkIcon from "@lobehub/icons-static-svg/icons/spark-color.svg";
import stepfunIcon from "@lobehub/icons-static-svg/icons/stepfun-color.svg";
import wenxinIcon from "@lobehub/icons-static-svg/icons/wenxin-color.svg";
import xaiIcon from "@lobehub/icons-static-svg/icons/xai.svg";
import xiaomiMimoIcon from "@lobehub/icons-static-svg/icons/xiaomimimo.svg";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import { MODEL_PROVIDER_PRESETS } from "../llm-presets.js";

type ProviderIconMeta = {
  label: string;
  src?: string;
};

const providerIconMeta = {
  openai: { label: "OpenAI", src: openAiIcon },
  anthropic: { label: "Anthropic", src: anthropicIcon },
  gemini: { label: "Gemini", src: geminiIcon },
  deepseek: { label: "DeepSeek", src: deepSeekIcon },
  qwen: { label: "Qwen", src: qwenIcon },
  kimi: { label: "Kimi / Moonshot", src: kimiIcon },
  mistral: { label: "Mistral", src: mistralIcon },
  openrouter: { label: "OpenRouter", src: openRouterIcon },
  mimo: { label: "Mimo", src: xiaomiMimoIcon },
  xai: { label: "xAI", src: xaiIcon },
  zhipu: { label: "Zhipu AI", src: zhipuIcon },
  doubao: { label: "Doubao", src: doubaoIcon },
  baidu: { label: "Baidu", src: baiduIcon },
  wenxin: { label: "Wenxin", src: wenxinIcon },
  meta: { label: "Meta", src: metaIcon },
  nvidia: { label: "NVIDIA", src: nvidiaIcon },
  minimax: { label: "MiniMax", src: minimaxIcon },
  cohere: { label: "Cohere", src: cohereIcon },
  stepfun: { label: "Stepfun", src: stepfunIcon },
  spark: { label: "iFlytek Spark", src: sparkIcon },
  custom: { label: "Custom model" }
} satisfies Record<string, ProviderIconMeta>;

type ProviderIconKind = keyof typeof providerIconMeta;

export function ProviderBrandIcon({
  className = "",
  modelId,
  vendor
}: {
  className?: string;
  modelId?: string | null | undefined;
  vendor?: string | null | undefined;
}) {
  const kind = resolveProviderIconKind(vendor, modelId);
  const meta: ProviderIconMeta = providerIconMeta[kind];
  return (
    <span aria-label={meta.label} className={`providerBadge providerLogo-${kind} ${className}`.trim()} role="img" title={meta.label}>
      {meta.src ? <img alt="" className="providerBrandIcon" src={meta.src} /> : <SlidersHorizontal className="providerBrandIcon" size={17} />}
    </span>
  );
}

function resolveProviderIconKind(vendor?: string | null, modelId?: string | null): ProviderIconKind {
  const normalizedVendor = vendor?.trim().toLowerCase();
  const normalizedModel = modelId?.trim();
  const vendorPreset = normalizedVendor ? MODEL_PROVIDER_PRESETS.find((preset) => preset.vendor === normalizedVendor) : null;
  if (vendorPreset?.vendor && vendorPreset.vendor !== "custom") {
    return asProviderIconKind(vendorPreset.vendor);
  }
  if (normalizedModel) {
    const inferredPreset = MODEL_PROVIDER_PRESETS.find((preset) => preset.vendor !== "custom" && preset.models.some((model) => model.id === normalizedModel));
    if (inferredPreset) return asProviderIconKind(inferredPreset.vendor);
  }
  return "custom";
}

function asProviderIconKind(value: string): ProviderIconKind {
  return value in providerIconMeta ? (value as ProviderIconKind) : "custom";
}
