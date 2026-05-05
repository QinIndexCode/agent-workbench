import { useEffect, useMemo, useState } from "react";
import type { ModelPreset, ModelProviderCreateRequest, ModelProviderPatchRequest, ModelProviderRecord, ProviderProtocol } from "@scc/shared";
import { CheckCircle2, Edit3, KeyRound, Plus, Trash2, X } from "lucide-react";
import { MODEL_PROVIDER_PRESETS, type ModelProviderPreset } from "../llm-presets.js";

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
  language,
  providers,
  onCreate,
  onDelete,
  onUpdate
}: {
  activeProviderId?: string | null;
  language?: string | null;
  providers: ModelProviderRecord[];
  onCreate: (input: ModelProviderCreateRequest) => Promise<void> | void;
  onDelete: (providerId: string) => Promise<void> | void;
  onUpdate: (providerId: string, input: ModelProviderPatchRequest) => Promise<void> | void;
}) {
  const text = getProviderCopy(language);
  const [editing, setEditing] = useState<ModelProviderRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFromPreset(MODEL_PROVIDER_PRESETS[0]!));
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

      <div className="providerRows">
        {providers.length === 0 ? <p className="muted">{text.empty}</p> : null}
        {providers.map((provider) => (
          <article className={provider.id === activeProviderId ? "providerRow active" : "providerRow"} key={provider.id}>
            <div className="providerBadge">
              <KeyRound size={16} />
            </div>
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
              <button aria-label={text.delete} className="iconButton dangerIcon" type="button" onClick={() => void onDelete(provider.id)}>
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
                <select value={draft.vendor} onChange={(event) => applyPreset(event.target.value)}>
                  {MODEL_PROVIDER_PRESETS.map((preset) => (
                    <option key={preset.vendor} value={preset.vendor}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="fieldStack">
                <span>{text.protocol}</span>
                <select value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as ProviderProtocol })}>
                  <option value="openai_compatible">OpenAI-compatible</option>
                  <option value="anthropic_messages">Anthropic Messages</option>
                  <option value="gemini">Gemini</option>
                </select>
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
                <select value={draft.modelMode === "custom" ? "__custom__" : draft.modelId} onChange={(event) => selectModel(event.target.value)}>
                  {modelPresets.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                  <option value="__custom__">{text.customModel}</option>
                </select>
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
              <label className="toggleField enabled">
                <span>{text.enabled}</span>
                <button type="button" onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>
                  {draft.enabled ? text.on : text.off}
                </button>
              </label>
              <label className="toggleField enabled">
                <span>{text.makeActive}</span>
                <button type="button" onClick={() => setDraft({ ...draft, makeActive: !draft.makeActive })}>
                  {draft.makeActive ? text.on : text.off}
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
    title: zh ? "模型服务商" : "Model providers",
    subtitle: zh ? "以列表管理厂商、模型和本地加密密钥。运行时会使用当前激活的 Provider。" : "Manage vendors, models, and encrypted local API keys. The active provider is used at runtime.",
    add: zh ? "添加 Provider" : "Add provider",
    edit: zh ? "编辑 Provider" : "Edit provider",
    delete: zh ? "删除 Provider" : "Delete provider",
    empty: zh ? "还没有模型 Provider。" : "No model providers yet.",
    active: zh ? "当前使用" : "Active",
    enabled: zh ? "启用" : "Enabled",
    disabled: zh ? "停用" : "Disabled",
    noKey: zh ? "未保存密钥" : "No key",
    dialogHelp: zh ? "选择预设或自定义模型。API Key 只会加密保存在本机。" : "Choose a preset or custom model. API keys are encrypted locally.",
    vendor: zh ? "厂商" : "Vendor",
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
