import { useEffect, useMemo, useState } from "react";
import type { ModelPreset, ModelProviderCreateRequest, ModelProviderPatchRequest, ModelProviderRecord, PreferencesPatch, ProviderProtocol, UserPreferences } from "@scc/shared";
import { CheckCircle2, Edit3, Plus, Trash2, X } from "lucide-react";
import { CONTEXT_QUICK_PRESETS, MODEL_PROVIDER_PRESETS, formatTokenAmount, parseTokenAmount, type ModelProviderPreset } from "../llm-presets.js";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { ProviderBrandIcon } from "./ProviderBrandIcon.js";

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
  preferences,
  providers,
  onCreate,
  onDelete,
  onPreference,
  onUpdate
}: {
  activeProviderId?: string | null;
  currentModelLabel?: string | null;
  language?: string | null;
  preferences?: UserPreferences | null;
  providers: ModelProviderRecord[];
  onCreate: (input: ModelProviderCreateRequest) => Promise<void> | void;
  onDelete: (providerId: string) => Promise<void> | void;
  onPreference?: (patch: PreferencesPatch) => Promise<void> | void;
  onUpdate: (providerId: string, input: ModelProviderPatchRequest) => Promise<void> | void;
}) {
  const text = getProviderCopy(language);
  const [editing, setEditing] = useState<ModelProviderRecord | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelProviderRecord | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(() => draftFromPreset(MODEL_PROVIDER_PRESETS[0]!));
  const [formError, setFormError] = useState<string | null>(null);
  const activeProvider = providers.find((provider) => provider.id === activeProviderId) ?? providers.find((provider) => provider.enabled) ?? null;
  const selectedPreset = useMemo(() => MODEL_PROVIDER_PRESETS.find((preset) => preset.vendor === draft.vendor) ?? MODEL_PROVIDER_PRESETS[0]!, [draft.vendor]);
  const modelPresets = selectedPreset.models;
  const selectedModel = modelPresets.find((model) => model.id === draft.modelId) ?? modelPresets[0] ?? null;
  const customContextResult = useMemo(() => {
    if (draft.modelMode !== "custom" || !draft.customContextWindow.trim()) return null;
    try {
      return { ok: true as const, value: parseTokenAmount(draft.customContextWindow) };
    } catch {
      return { ok: false as const, value: 0 };
    }
  }, [draft.customContextWindow, draft.modelMode]);
  const contextLimit = draft.modelMode === "custom" ? customContextResult?.value ?? 0 : selectedModel?.contextWindow ?? 0;

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
        <ProviderBrandIcon modelId={activeProvider?.defaultModelId ?? currentModelLabel ?? null} vendor={activeProvider?.vendor ?? null} />
        <div>
          <small>{text.currentModel}</small>
          <strong>{activeProvider?.defaultModelId ?? currentModelLabel ?? text.notConfigured}</strong>
          <span>{activeProvider ? `${activeProvider.label} · ${activeProvider.protocol.replace("_", " ")}` : currentModelLabel ? text.fromPreferences : text.addFirst}</span>
        </div>
      </section>

      {providers.length > 1 ? (
        <section className="modelRouteCard">
          <div>
            <h3>{text.routing}</h3>
            <p>{text.routingHelp}</p>
          </div>
          <div className="routeFallbackRows">
            {providers.filter((provider) => provider.id !== activeProvider?.id).map((provider) => {
              const enabled = Boolean(preferences?.modelRoute?.fallbackProviderIds?.includes(provider.id));
              return (
                <ToggleSettingRow
                  key={provider.id}
                  label={provider.label}
                  description={`${provider.defaultModelId} · ${provider.protocol.replace("_", " ")}`}
                  value={enabled}
                  onChange={(nextEnabled) => {
                    const currentRoute = preferences?.modelRoute ?? { fallbackProviderIds: [] };
                    const current = new Set(currentRoute.fallbackProviderIds ?? []);
                    if (nextEnabled) current.add(provider.id);
                    else current.delete(provider.id);
                    void onPreference?.({
                      modelRoute: {
                        ...currentRoute,
                        mainProviderId: activeProvider?.id,
                        fallbackProviderIds: [...current]
                      }
                    });
                  }}
                />
              );
            })}
          </div>
        </section>
      ) : null}

      <div className="providerRows">
        {providers.length === 0 ? <p className="muted">{text.empty}</p> : null}
        {providers.map((provider) => (
          <article className={provider.id === activeProviderId ? "providerRow active" : "providerRow"} key={provider.id}>
            <ProviderBrandIcon modelId={provider.defaultModelId} vendor={provider.vendor} />
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
                <span className={provider.enabled ? "statusPill" : "statusPill muted"}>{provider.enabled ? text.available : text.paused}</span>
              )}
            </div>
            <div className="rowIconActions">
              {provider.id !== activeProviderId ? (
                <button
                  aria-label={text.makeCurrent(provider.defaultModelId)}
                  className="iconButton"
                  title={text.makeCurrent(provider.defaultModelId)}
                  type="button"
                  onClick={() => void onUpdate(provider.id, { enabled: true, makeActive: true })}
                >
                  <CheckCircle2 size={15} />
                </button>
              ) : null}
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
        <div className="modalBackdrop stdBackdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <form
            aria-label={editing ? text.edit : text.add}
            className="stdModal stdModalXWide"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="stdHeader">
              <h3>{editing ? text.edit : text.add}</h3>
              <button className="stdClose" type="button" onClick={() => setOpen(false)}>×</button>
            </div>
            <div className="stdBody">
              <p className="stdDialogHelp">{text.dialogHelp}</p>
              <div className="stdFormGrid cols2">
                <div className="stdField">
                  <span className="stdFieldLabel">{text.vendor}</span>
                  <AccordionSelect
                    ariaLabel={text.vendor}
                    value={draft.vendor}
                    options={MODEL_PROVIDER_PRESETS.map((preset) => ({
                      value: preset.vendor,
                      label: preset.label,
                      icon: <ProviderBrandIcon className="providerBadgeInline" modelId={preset.models[0]?.id} vendor={preset.vendor} />
                    }))}
                    onChange={applyPreset}
                  />
                </div>
                <div className="stdField">
                  <span className="stdFieldLabel">{text.protocol}</span>
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
                </div>
                <div className="stdField wide">
                  <span className="stdFieldLabel">{text.label}</span>
                  <input className="stdInput" aria-label={text.label} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
                </div>
                <div className="stdField wide">
                  <span className="stdFieldLabel">{text.baseUrl}</span>
                  <input className="stdInput" aria-label={text.baseUrl} value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
                </div>
                <div className="stdField modelField">
                  <span className="stdFieldLabel">{text.model}</span>
                  {draft.modelMode === "custom" ? (
                    <div className="inlineEdit">
                      <input
                        className="stdInput"
                        aria-label={text.customModel}
                        placeholder={text.customModelPlaceholder}
                        value={draft.customModelId}
                        onChange={(event) => setDraft({ ...draft, customModelId: event.target.value })}
                      />
                      <button
                        className="inlineEditToggle"
                        title={text.backToPreset}
                        type="button"
                        onClick={() => {
                          const firstModel = modelPresets[0];
                          setDraft({
                            ...draft,
                            modelMode: "preset",
                            modelId: firstModel?.id ?? "",
                            customModelId: ""
                          });
                        }}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <AccordionSelect
                      ariaLabel={text.model}
                      value={draft.modelId}
                      options={[
                        ...modelPresets.map((m) => ({
                          value: m.id,
                          label: m.id,
                          icon: <ProviderBrandIcon className="providerBadgeInline" modelId={m.id} vendor={draft.vendor} />
                        })),
                        { value: "__custom__", label: text.customModel, icon: <ProviderBrandIcon className="providerBadgeInline" vendor="custom" /> }
                      ]}
                      onChange={selectModel}
                    />
                  )}
                </div>
                <div className="stdField">
                  <span className="stdFieldLabel">{text.contextWindow}</span>
                  {draft.modelMode === "custom" ? (
                    <>
                      <input
                        className="stdInput"
                        aria-label={text.contextWindow}
                        aria-invalid={customContextResult?.ok === false}
                        placeholder="128K / 1M"
                        value={draft.customContextWindow}
                        onChange={(event) => {
                          setFormError(null);
                          setDraft({ ...draft, customContextWindow: event.target.value });
                        }}
                      />
                      <div className="contextQuickChips" aria-label={text.contextQuickPresets}>
                        {CONTEXT_QUICK_PRESETS.map((value) => (
                          <button key={value} type="button" onClick={() => setDraft({ ...draft, customContextWindow: value })}>
                            {value}
                          </button>
                        ))}
                      </div>
                      {customContextResult?.ok === false ? <small className="fieldError">{text.invalidContext}</small> : null}
                    </>
                  ) : (
                    <>
                      <input className="stdInput" disabled value={contextLimit ? formatTokenAmount(contextLimit) : ""} />
                      {selectedModel ? (
                        <small className="fieldHint">
                          {selectedModel.contextWindowKind === "input" ? text.inputWindow : text.totalWindow}
                          {selectedModel.maxOutputTokens ? ` · ${text.maxOutput}: ${formatTokenAmount(selectedModel.maxOutputTokens)}` : ""}
                          {selectedModel.docsUrl ? (
                            <>
                              {" · "}
                              <a href={selectedModel.docsUrl} rel="noreferrer" target="_blank">
                                {text.source}
                              </a>
                            </>
                          ) : null}
                        </small>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="stdField wide">
                  <span className="stdFieldLabel">{text.apiKey}</span>
                  <input
                    className="stdInput"
                    aria-label={text.apiKey}
                    autoComplete="off"
                    placeholder={editing?.apiKeyRef?.last4 ? `•••• ${editing.apiKeyRef.last4}` : ""}
                    type="password"
                    value={draft.apiKey}
                    onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
                  />
                </div>
              </div>
              {formError ? <p className="formError">{formError}</p> : null}
              <div className="stdOptionRows">
                <ToggleSettingRow
                  label={text.availableForTasks}
                  description={text.availableForTasksHint}
                  value={draft.enabled}
                  onChange={(enabled) => setDraft({ ...draft, enabled })}
                />
                <ToggleSettingRow
                  label={text.makeActive}
                  description={text.makeActiveHint}
                  value={draft.makeActive}
                  onChange={(makeActive) => setDraft({ ...draft, makeActive })}
                />
              </div>
            </div>
            <div className="stdFooter">
              <button className="stdCancelBtn" type="button" onClick={() => setOpen(false)}>
                {text.cancel}
              </button>
              <button className="primaryInlineButton" type="submit">
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
    setFormError(null);
    setOpen(true);
  }

  function startEdit(provider: ModelProviderRecord) {
    setEditing(provider);
    setDraft(draftFromProvider(provider));
    setFormError(null);
    setOpen(true);
  }

  function applyPreset(vendor: string) {
    const preset = MODEL_PROVIDER_PRESETS.find((item) => item.vendor === vendor) ?? MODEL_PROVIDER_PRESETS[0]!;
    setFormError(null);
    setDraft(draftFromPreset(preset));
  }

  function selectModel(value: string) {
    setFormError(null);
    if (value === "__custom__") {
      setDraft({ ...draft, modelMode: "custom", modelId: "", customModelId: "", customContextWindow: "" });
      return;
    }
    setDraft({ ...draft, modelMode: "preset", modelId: value });
  }

  async function save() {
    let model: ModelPreset;
    try {
      model = buildModel(draft);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
      return;
    }
    if (!model.id) {
      setFormError(text.modelRequired);
      return;
    }
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

function ToggleSettingRow({
  description,
  label,
  value,
  onChange
}: {
  description: string;
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className={value ? "stdToggleRow enabled settingToggleRow" : "stdToggleRow settingToggleRow"}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <button className="switchControl" type="button" onClick={() => onChange(!value)} aria-label={label} aria-pressed={value}>
        <span aria-hidden="true" />
      </button>
    </div>
  );
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
    contextWindow: parseTokenAmount(draft.customContextWindow),
    supportsTools: true,
    supportsThinking: false
  };
}

function getProviderCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "模型配置" : "Model configuration",
    subtitle: zh ? "从预设厂商或自定义接口添加模型。API Key 只保存在本机，运行时使用当前激活模型。" : "Add models from presets or custom endpoints. API keys stay local; the active model is used at runtime.",
    routing: zh ? "模型路由" : "Model routing",
    routingHelp: zh ? "选择主模型失败时可尝试的备用模型。认证失败和权限拒绝不会自动切换。" : "Choose fallback models for provider errors. Auth failures and permission denials do not fallback.",
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
    available: zh ? "可用" : "Available",
    paused: zh ? "暂停" : "Paused",
    noKey: zh ? "未保存密钥" : "No key",
    dialogHelp: zh ? "选择预设模型厂商，或选择 Custom 手动填写接口与上下文窗口。" : "Choose a preset vendor, or choose Custom and enter the endpoint and context window manually.",
    vendor: zh ? "预设厂商" : "Preset vendor",
    protocol: zh ? "协议" : "Protocol",
    label: zh ? "显示名称" : "Display name",
    baseUrl: "Base URL",
    model: zh ? "模型" : "Model",
    customModel: zh ? "自定义模型" : "Custom model",
    customModelPlaceholder: zh ? "输入模型 ID" : "Enter model ID",
    backToPreset: zh ? "切换回预设模型" : "Switch back to preset",
    contextWindow: zh ? "上下文窗口" : "Context window",
    contextQuickPresets: zh ? "上下文快捷选项" : "Context quick presets",
    invalidContext: zh ? "请输入类似 128K、1M 或 1048576 的上下文大小。" : "Enter a context size like 128K, 1M, or 1048576.",
    modelRequired: zh ? "请填写模型名称。" : "Enter a model name.",
    totalWindow: zh ? "总窗口" : "Total window",
    inputWindow: zh ? "输入窗口" : "Input window",
    maxOutput: zh ? "最大输出" : "Max output",
    source: zh ? "来源" : "Source",
    apiKey: "API Key",
    makeActive: zh ? "设为当前模型" : "Make active",
    makeActiveHint: zh ? "保存后立即切换到这个模型配置。" : "Use this model configuration immediately after saving.",
    makeCurrent: (modelId: string) => zh ? `切换到 ${modelId}` : `Switch to ${modelId}`,
    availableForTasks: zh ? "允许任务使用" : "Available to tasks",
    availableForTasksHint: zh ? "关闭后保留配置和密钥，但不会被任务选择。" : "Keep this configuration and key, but exclude it from task selection.",
    cancel: zh ? "取消" : "Cancel",
    save: zh ? "保存" : "Save"
  };
}
