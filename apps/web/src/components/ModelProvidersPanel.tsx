import { useEffect, useMemo, useState } from "react";
import type { ModelPreset, ModelProviderCreateRequest, ModelProviderPatchRequest, ModelProviderRecord, ProviderProtocol } from "@scc/shared";
import { CheckCircle2, Edit3, Plus, SlidersHorizontal, Trash2, X, type LucideIcon } from "lucide-react";
import { MODEL_PROVIDER_PRESETS, type ModelProviderPreset } from "../llm-presets.js";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

type ProviderDraft = {
  vendor: string;
  label: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  modelMode: "preset" | "custom";
  modelId: string;
  customModelId: string;
  customContextWindow: string;
  apiKey: string;
  enabled: boolean;
  makeActive: boolean;
};

export function ModelProvidersPanel({
  activeProviderId,
  currentModelLabel,
  language,
  providers,
  onCreate,
  onDelete,
  onUpdate
}: {
  activeProviderId?: string | null;
  currentModelLabel?: string | null;
  language?: string | null;
  providers: ModelProviderRecord[];
  onCreate: (input: ModelProviderCreateRequest) => Promise<void> | void;
  onDelete: (providerId: string) => Promise<void> | void;
  onUpdate: (providerId: string, input: ModelProviderPatchRequest) => Promise<void> | void;
}) {
  const text = getProviderCopy(language);
  const [editing, setEditing] = useState<ModelProviderRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProviderRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFromPreset(MODEL_PROVIDER_PRESETS[0]!));
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers.find((provider) => provider.enabled) ?? null;
  const selectedPreset = useMemo(() => MODEL_PROVIDER_PRESETS.find((preset) => preset.vendor === draft.vendor) ?? MODEL_PROVIDER_PRESETS[0]!, [draft.vendor]);
  const modelPresets = selectedPreset.models;
  const selectedModel = modelPresets.find((model) => model.id === draft.modelId) ?? modelPresets[0] ?? null;
  const contextLimit = draft.modelMode === "custom" ? Number(draft.customContextWindow) || 0 : selectedModel?.contextWindow ?? 0;

  useEffect(() => {
    if (!open) return;
    if (editing) setDraft(draftFromProvider(editing));
  }, [editing, open]);

  return (
    <section className="providersPanel">
      <header className="panelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button className="subtleButton iconText" type="button" onClick={() => startCreate()}>
          <Plus size={15} />
          {text.add}
        </button>
      </header>

      <section className="activeModelSummary">
        <ProviderIcon modelId={activeProvider?.defaultModelId ?? currentModelLabel ?? undefined} vendor={activeProvider?.vendor} />
        <div>
          <small>{text.currentModel}</small>
          <strong>{activeProvider?.defaultModelId ?? currentModelLabel ?? text.notConfigured}</strong>
          <span>{activeProvider ? `${activeProvider.label} · ${activeProvider.protocol.replace("_", " ")}` : currentModelLabel ? text.fromPreferences : text.addFirst}</span>
        </div>
      </section>

      <div className="providerRows">
        {providers.length === 0 ? <p className="muted">{text.empty}</p> : null}
        {providers.map((provider) => (
          <article className={provider.id === activeProviderId ? "providerRow active" : "providerRow"} key={provider.id}>
            <ProviderIcon modelId={provider.defaultModelId} vendor={provider.vendor} />
            <div className="providerMain">
              <strong>{provider.label}</strong>
              <span>{provider.defaultModelId}</span>
              <small>
                {provider.protocol.replace("_", " ")} · {provider.apiKeyRef?.last4 ? `•••• ${provider.apiKeyRef.last4}` : text.noKey}
              </small>
            </div>
            <div className="providerState">
              {provider.id === activeProviderId ? (
                <span className="activeProvider">
                  <CheckCircle2 size={14} />
                  {text.active}
                </span>
              ) : (
                <span>{provider.enabled ? text.enabled : text.disabled}</span>
              )}
            </div>
            <div className="rowIconActions">
              <button aria-label={text.edit} className="iconButton" type="button" onClick={() => startEdit(provider)}>
                <Edit3 size={15} />
              </button>
              <button aria-label={text.delete} className="iconButton dangerIcon" type="button" onClick={() => setDeleteTarget(provider)}>
                <Trash2 size={15} />
              </button>
            </div>
          </article>
        ))}
      </div>

      {open ? (
        <div className="modalOverlay" role="presentation">
          <form
            aria-label={editing ? text.edit : text.add}
            className="providerDialog"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="dialogHeader">
              <div>
                <h3>{editing ? text.edit : text.add}</h3>
                <p>{text.dialogHelp}</p>
              </div>
              <button className="iconButton" type="button" onClick={() => setOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="providerFormGrid">
              <label className="fieldStack">
                <span>{text.vendor}</span>
                <AccordionSelect
                  ariaLabel={text.vendor}
                  value={draft.vendor}
                  options={MODEL_PROVIDER_PRESETS.map((preset) => ({ value: preset.vendor, label: preset.label }))}
                  onChange={applyPreset}
                />
              </label>
              <label className="fieldStack">
                <span>{text.protocol}</span>
                <AccordionSelect
                  ariaLabel={text.protocol}
                  value={draft.protocol}
                  options={[
                    { value: "openai_compatible", label: "OpenAI-compatible" },
                    { value: "anthropic_messages", label: "Anthropic Messages" },
                    { value: "gemini", label: "Gemini" }
                  ]}
                  onChange={(value) => setDraft({ ...draft, protocol: value as ProviderProtocol })}
                />
              </label>
              <label className="fieldStack">
                <span>{text.label}</span>
                <input value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>{text.baseUrl}</span>
                <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
              </label>
              <label className="fieldStack">
                <span>{text.model}</span>
                <AccordionSelect
                  ariaLabel={text.model}
                  value={draft.modelMode === "custom" ? "__custom__" : draft.modelId}
                  options={[
                    ...modelPresets.map((model) => ({ value: model.id, label: model.id })),
                    { value: "__custom__", label: text.customModel }
                  ]}
                  onChange={selectModel}
                />
              </label>
              {draft.modelMode === "custom" ? (
                <>
                  <label className="fieldStack">
                    <span>{text.customModel}</span>
                    <input value={draft.customModelId} onChange={(event) => setDraft({ ...draft, customModelId: event.target.value })} />
                  </label>
                  <label className="fieldStack">
                    <span>{text.contextWindow}</span>
                    <input min={1} type="number" value={draft.customContextWindow} onChange={(event) => setDraft({ ...draft, customContextWindow: event.target.value })} />
                  </label>
                </>
              ) : (
                <label className="fieldStack">
                  <span>{text.contextWindow}</span>
                  <input disabled value={contextLimit ? String(contextLimit) : ""} />
                </label>
              )}
              <label className="fieldStack">
                <span>{text.apiKey}</span>
                <input autoComplete="off" placeholder={editing?.apiKeyRef?.last4 ? `•••• ${editing.apiKeyRef.last4}` : ""} type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
              </label>
              <label className={draft.enabled ? "toggleField enabled" : "toggleField"}>
                <span>{text.enabled}</span>
                <button className="switchControl" type="button" onClick={() => setDraft({ ...draft, enabled: !draft.enabled })} aria-pressed={draft.enabled} aria-label={text.enabled}>
                  <span aria-hidden="true" />
                </button>
              </label>
              <label className={draft.makeActive ? "toggleField enabled" : "toggleField"}>
                <span>{text.makeActive}</span>
                <button className="switchControl" type="button" onClick={() => setDraft({ ...draft, makeActive: !draft.makeActive })} aria-pressed={draft.makeActive} aria-label={text.makeActive}>
                  <span aria-hidden="true" />
                </button>
              </label>
            </div>
            <div className="dialogActions">
              <button className="textButton" type="button" onClick={() => setOpen(false)}>
                {text.cancel}
              </button>
              <button className="subtleButton" type="submit">
                {text.save}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.delete}
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (!deleteTarget) return;
          const providerId = deleteTarget.id;
          setDeleteTarget(null);
          void onDelete(providerId);
        }}
      >
        <p>{deleteTarget ? text.deleteBody(deleteTarget.label, deleteTarget.defaultModelId) : ""}</p>
      </ConfirmDialog>
    </section>
  );

  function startCreate() {
    setEditing(null);
    setDraft(draftFromPreset(MODEL_PROVIDER_PRESETS[0]!));
    setOpen(true);
  }

  function startEdit(provider: ModelProviderRecord) {
    setEditing(provider);
    setDraft(draftFromProvider(provider));
    setOpen(true);
  }

  function applyPreset(vendor: string) {
    const preset = MODEL_PROVIDER_PRESETS.find((item) => item.vendor === vendor) ?? MODEL_PROVIDER_PRESETS[0]!;
    setDraft(draftFromPreset(preset));
  }

  function selectModel(value: string) {
    if (value === "__custom__") {
      setDraft({ ...draft, modelMode: "custom", modelId: "", customModelId: "", customContextWindow: "" });
      return;
    }
    setDraft({ ...draft, modelMode: "preset", modelId: value });
  }

  async function save() {
    const model = buildModel(draft);
    const models = draft.modelMode === "preset" ? selectedPreset.models : [model];
    const payload = {
      vendor: draft.vendor,
      label: draft.label.trim() || draft.vendor,
      protocol: draft.protocol,
      baseUrl: draft.baseUrl.trim(),
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}),
      models,
      defaultModelId: model.id,
      enabled: draft.enabled,
      makeActive: draft.makeActive
    };
    if (editing) await onUpdate(editing.id, payload);
    else await onCreate(payload);
    setOpen(false);
  }
}

type ProviderIconMeta = { label: string; mark?: string; Icon?: LucideIcon };

const providerIconMeta = {
  mimo: { label: "Mimo", mark: "M" },
  openai: { label: "OpenAI", mark: "AI" },
  anthropic: { label: "Anthropic", mark: "A" },
  gemini: { label: "Gemini", mark: "G" },
  deepseek: { label: "DeepSeek", mark: "DS" },
  qwen: { label: "Qwen", mark: "Q" },
  kimi: { label: "Kimi", mark: "K" },
  openrouter: { label: "OpenRouter", mark: "OR" },
  custom: { label: "Custom model", Icon: SlidersHorizontal }
} satisfies Record<string, ProviderIconMeta>;

type ProviderIconKind = keyof typeof providerIconMeta;

function ProviderIcon({ vendor, modelId }: { vendor: string | null | undefined; modelId: string | null | undefined }) {
  const kind = resolveProviderIconKind(vendor, modelId);
  const meta: ProviderIconMeta = providerIconMeta[kind];
  const Icon = meta.Icon;
  return (
    <span aria-label={meta.label} className={`providerBadge providerLogo-${kind}`} role="img" title={meta.label}>
      {Icon ? <Icon size={16} aria-hidden="true" /> : <span className="providerLogoText">{meta.mark ?? ""}</span>}
    </span>
  );
}

function resolveProviderIconKind(vendor?: string | null, modelId?: string | null): ProviderIconKind {
  const normalizedVendor = vendor?.trim().toLowerCase();
  const normalizedModel = modelId?.trim();
  const vendorPreset = normalizedVendor ? MODEL_PROVIDER_PRESETS.find((preset) => preset.vendor === normalizedVendor) : null;
  if (vendorPreset?.vendor && vendorPreset.vendor !== "custom") {
    if (!normalizedModel || vendorPreset.models.some((model) => model.id === normalizedModel)) {
      return asProviderIconKind(vendorPreset.vendor);
    }
    return "custom";
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

function draftFromPreset(preset: ModelProviderPreset): ProviderDraft {
  const model = preset.models[0];
  return {
    vendor: preset.vendor,
    label: preset.label,
    protocol: preset.protocol,
    baseUrl: preset.baseUrl,
    modelMode: model ? "preset" : "custom",
    modelId: model?.id ?? "",
    customModelId: "",
    customContextWindow: "",
    apiKey: "",
    enabled: true,
    makeActive: true
  };
}

function draftFromProvider(provider: ModelProviderRecord): ProviderDraft {
  const preset = MODEL_PROVIDER_PRESETS.find((item) => item.vendor === provider.vendor);
  const presetModel = preset?.models.find((model) => model.id === provider.defaultModelId);
  const configuredModel = provider.models.find((model) => model.id === provider.defaultModelId) ?? provider.models[0];
  return {
    vendor: provider.vendor,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelMode: presetModel ? "preset" : "custom",
    modelId: presetModel?.id ?? "",
    customModelId: presetModel ? "" : provider.defaultModelId,
    customContextWindow: String(configuredModel?.contextWindow ?? ""),
    apiKey: "",
    enabled: provider.enabled,
    makeActive: false
  };
}

function buildModel(draft: ProviderDraft): ModelPreset {
  if (draft.modelMode === "preset") {
    const preset = MODEL_PROVIDER_PRESETS.find((item) => item.vendor === draft.vendor);
    const model = preset?.models.find((item) => item.id === draft.modelId) ?? preset?.models[0];
    if (model) return model;
  }
  return {
    id: draft.customModelId.trim(),
    label: draft.customModelId.trim(),
    contextWindow: Math.max(1, Number(draft.customContextWindow) || 1),
    supportsTools: true,
    supportsThinking: false
  };
}

function getProviderCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "模型配置" : "Model configuration",
    subtitle: zh ? "从预设厂商或自定义接口添加模型。API Key 只保存在本机，运行时使用当前激活模型。" : "Add models from presets or custom endpoints. API keys stay local; the active model is used at runtime.",
    add: zh ? "添加模型" : "Add model",
    edit: zh ? "编辑模型" : "Edit model",
    delete: zh ? "删除模型" : "Delete model",
    deleteTitle: zh ? "删除模型配置" : "Delete model configuration",
    deleteBody: (label: string, modelId: string) =>
      zh
        ? `将删除 ${label}（${modelId}）的配置和本地保存的密钥。已创建的任务记录不会被删除。`
        : `This removes ${label} (${modelId}) and its locally stored key. Existing task history is kept.`,
    empty: zh ? "还没有添加模型。" : "No models added yet.",
    currentModel: zh ? "当前使用模型" : "Current model",
    notConfigured: zh ? "未配置" : "Not configured",
    addFirst: zh ? "添加一个模型后即可运行 Agent。" : "Add a model before running the agent.",
    fromPreferences: zh ? "来自当前偏好；添加模型配置后可管理密钥、上下文和预设。" : "From current preferences; add a model configuration to manage keys, context, and presets.",
    active: zh ? "当前使用" : "Active",
    enabled: zh ? "启用" : "Enabled",
    disabled: zh ? "停用" : "Disabled",
    noKey: zh ? "未保存密钥" : "No key",
    dialogHelp: zh ? "选择预设模型厂商，或选择 Custom 手动填写接口与上下文窗口。" : "Choose a preset vendor, or choose Custom and enter the endpoint and context window manually.",
    vendor: zh ? "预设厂商" : "Preset vendor",
    protocol: zh ? "协议" : "Protocol",
    label: zh ? "显示名称" : "Display name",
    baseUrl: "Base URL",
    model: zh ? "模型" : "Model",
    customModel: zh ? "自定义模型" : "Custom model",
    contextWindow: zh ? "上下文窗口" : "Context window",
    apiKey: "API Key",
    makeActive: zh ? "设为当前模型" : "Make active",
    on: zh ? "开启" : "On",
    off: zh ? "关闭" : "Off",
    cancel: zh ? "取消" : "Cancel",
    save: zh ? "保存" : "Save"
  };
}
