import { useMemo, useState } from "react";
import type {
  IntegrationKind,
  IntegrationProviderConfig,
  IntegrationProviderCreateRequest,
  IntegrationProviderPatchRequest,
  TaskFolderRecord
} from "@agent-workbench/shared";
import { Cable, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { IntegrationBrandIcon } from "./IntegrationBrandIcon.js";
import { SettingsEmptyStateCard, SettingsPrimer, describeActionError } from "./SettingsAssist.js";

type PermissionPreset = "ask" | "read_only" | "custom" | "all";
type ClearSecretFlag =
  | "clearBotToken"
  | "clearAppSecret"
  | "clearVerificationToken"
  | "clearEncryptKey"
  | "clearSigningSecret"
  | "clearSecretToken"
  | "clearWecomToken"
  | "clearWecomEncodingAesKey";

type IntegrationDraft = {
  kind: IntegrationKind;
  label: string;
  botToken: string;
  publicKey: string;
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey: string;
  signingSecret: string;
  secretToken: string;
  wecomToken: string;
  wecomEncodingAesKey: string;
  callbackUrl: string;
  defaultFolderId: string;
  defaultPermissionPreset: PermissionPreset;
  enabled: boolean;
};

type IntegrationFieldDescriptor = {
  key: keyof IntegrationDraft;
  clearFlag?: ClearSecretFlag;
  placeholder?: (provider?: IntegrationProviderConfig) => string;
  secretSummary?: (provider: IntegrationProviderConfig) => string | null;
};

const providerOrder: IntegrationKind[] = ["discord", "feishu", "slack", "telegram", "wecom"];

const providerFieldMap: Record<IntegrationKind, IntegrationFieldDescriptor[]> = {
  discord: [
    { key: "botToken", clearFlag: "clearBotToken", placeholder: (provider) => maskRef(provider?.botTokenRef?.last4) },
    { key: "publicKey" },
    { key: "appId" },
    { key: "callbackUrl" }
  ],
  feishu: [
    { key: "verificationToken", clearFlag: "clearVerificationToken", placeholder: (provider) => maskRef(provider?.verificationTokenRef?.last4) },
    { key: "appSecret", clearFlag: "clearAppSecret", placeholder: (provider) => maskRef(provider?.appSecretRef?.last4) },
    { key: "encryptKey", clearFlag: "clearEncryptKey", placeholder: (provider) => maskRef(provider?.encryptKeyRef?.last4) },
    { key: "callbackUrl" }
  ],
  slack: [
    { key: "signingSecret", clearFlag: "clearSigningSecret", placeholder: (provider) => maskRef(provider?.signingSecretRef?.last4) },
    { key: "callbackUrl" }
  ],
  telegram: [
    { key: "botToken", clearFlag: "clearBotToken", placeholder: (provider) => maskRef(provider?.botTokenRef?.last4) },
    { key: "secretToken", clearFlag: "clearSecretToken", placeholder: (provider) => maskRef(provider?.secretTokenRef?.last4) },
    { key: "callbackUrl" }
  ],
  wecom: [
    { key: "wecomToken", clearFlag: "clearWecomToken", placeholder: (provider) => maskRef(provider?.wecomTokenRef?.last4) },
    { key: "wecomEncodingAesKey", clearFlag: "clearWecomEncodingAesKey", placeholder: (provider) => maskRef(provider?.wecomEncodingAesKeyRef?.last4) },
    { key: "callbackUrl" }
  ]
};

export function IntegrationsPanel({
  folders,
  integrations,
  language,
  onOpenDocs,
  onConnect,
  onCreate,
  onDelete,
  onDisconnect,
  onUpdate
}: {
  folders: TaskFolderRecord[];
  integrations: IntegrationProviderConfig[];
  language?: string | null;
  onOpenDocs?: (() => void) | undefined;
  onConnect: (id: string) => Promise<void> | void;
  onCreate: (input: IntegrationProviderCreateRequest) => Promise<IntegrationProviderConfig | void> | IntegrationProviderConfig | void;
  onDelete: (id: string) => Promise<void> | void;
  onDisconnect: (id: string) => Promise<void> | void;
  onUpdate: (id: string, input: IntegrationProviderPatchRequest) => Promise<IntegrationProviderConfig | void> | IntegrationProviderConfig | void;
}) {
  const text = copy(language);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; provider?: IntegrationProviderConfig } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IntegrationProviderConfig | null>(null);
  const rows = useMemo(
    () =>
      [...integrations].sort(
        (left, right) =>
          providerOrder.indexOf(left.kind) - providerOrder.indexOf(right.kind) ||
          left.label.localeCompare(right.label)
      ),
    [integrations]
  );

  return (
    <section className="settingsCardList">
      <div className="panelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button className="primaryInlineButton" type="button" onClick={() => setModal({ mode: "create" })}>
          <Plus size={15} /> {text.add}
        </button>
      </div>
      <SettingsPrimer
        language={language}
        summary={text.primer.summary}
        focus={text.primer.focus}
        impact={text.primer.impact}
        nextStep={text.primer.nextStep}
        onOpenDocs={onOpenDocs}
      />
      <div className="inlineNotice">
        <span>{text.statusLegend}</span>
      </div>
      <div className="compactList">
        {rows.length === 0 ? (
          <SettingsEmptyStateCard
            language={language}
            title={text.emptyTitle}
            body={text.empty}
            hint={text.emptyHint}
            actionLabel={text.emptyAction}
            actionAriaLabel={text.emptyAction}
            onAction={() => setModal({ mode: "create" })}
          />
        ) : null}
        {rows.map((provider) => {
          const meta = getIntegrationMeta(provider.kind, language);
          return (
            <article className="providerRow" key={provider.id}>
              <span className="providerIcon">
                <IntegrationBrandIcon kind={provider.kind} size={18} />
              </span>
              <div>
                <strong>{provider.label}</strong>
                <small>
                  {[meta.label, folderName(folders, provider.defaultFolderId), meta.inbound, integrationSecretSummary(provider, language)].filter(Boolean).join(" · ")}
                </small>
                {provider.lastError ? <small className="dangerText">{provider.lastError}</small> : <small>{meta.setupNote}</small>}
              </div>
              <span className={provider.enabled ? "statusPill" : "statusPill muted"}>{text.status[provider.status] ?? provider.status}</span>
              <div className="rowIconActions">
                <button
                  aria-label={`${provider.enabled ? text.disconnect : text.connect} ${provider.label}`}
                  className="iconButton"
                  type="button"
                  onClick={() => void (provider.enabled ? onDisconnect(provider.id) : onConnect(provider.id))}
                >
                  <Power size={15} />
                </button>
                <button aria-label={`${text.edit} ${provider.label}`} className="iconButton" type="button" onClick={() => setModal({ mode: "edit", provider })}>
                  <Pencil size={15} />
                </button>
                <button aria-label={`${text.delete} ${provider.label}`} className="iconButton danger" type="button" onClick={() => setDeleteTarget(provider)}>
                  <Trash2 size={15} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      {modal ? (
        <IntegrationDialog
          folders={folders}
          language={language}
          provider={modal.provider}
          onClose={() => setModal(null)}
          onSave={async (input) => {
            if (modal.provider) await onUpdate(modal.provider.id, input);
            else await onCreate(input as IntegrationProviderCreateRequest);
            setModal(null);
          }}
        />
      ) : null}
      <ConfirmDialog
        cancelLabel={text.cancel}
        confirmLabel={text.delete}
        open={Boolean(deleteTarget)}
        title={text.deleteTitle}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void onDelete(deleteTarget.id);
          setDeleteTarget(null);
        }}
      >
        <p>{deleteTarget ? text.deleteBody(deleteTarget.label) : ""}</p>
      </ConfirmDialog>
    </section>
  );
}

function IntegrationDialog({
  folders,
  language,
  provider,
  onClose,
  onSave
}: {
  folders: TaskFolderRecord[];
  language?: string | null | undefined;
  provider?: IntegrationProviderConfig | undefined;
  onClose: () => void;
  onSave: (input: IntegrationProviderCreateRequest | IntegrationProviderPatchRequest) => Promise<unknown>;
}) {
  const text = copy(language);
  const [draft, setDraft] = useState<IntegrationDraft>({
    kind: provider?.kind ?? "discord",
    label: provider?.label ?? "",
    botToken: "",
    publicKey: provider?.publicKey ?? "",
    appId: provider?.appId ?? "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    signingSecret: "",
    secretToken: "",
    wecomToken: "",
    wecomEncodingAesKey: "",
    callbackUrl: provider?.callbackUrl ?? "",
    defaultFolderId: provider?.defaultFolderId ?? "default",
    defaultPermissionPreset: provider?.defaultPermissionPreset ?? "ask",
    enabled: provider?.enabled ?? false
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [clearFlags, setClearFlags] = useState<Partial<Record<ClearSecretFlag, boolean>>>({});
  const meta = getIntegrationMeta(draft.kind, language);
  const fields = providerFieldMap[draft.kind];

  return (
    <div className="modalBackdrop stdBackdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <form
        aria-label={provider ? text.editTitle : text.createTitle}
        className="stdModal stdModalWide"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="stdHeader">
          <h3>{provider ? text.editTitle : text.createTitle}</h3>
          <button className="stdClose" type="button" onClick={onClose}>×</button>
        </div>
        <div className="stdBody">
          <p className="inlineNotice">
            <span>{meta.dialogHint}</span>
          </p>
          <div className="settingsPrimerGrid">
            <article className="settingsPrimerCell">
              <span>{text.callbackTitle}</span>
              <p>{meta.callbackGuide}</p>
            </article>
            <article className="settingsPrimerCell">
              <span>{text.securityTitle}</span>
              <p>{meta.securityGuide}</p>
            </article>
            <article className="settingsPrimerCell">
              <span>{text.inboundTitle}</span>
              <p>{meta.inbound}</p>
            </article>
          </div>
          <div className="stdFormGrid cols2">
            <div className="stdField">
              <span className="stdFieldLabel">{text.provider}</span>
              <AccordionSelect
                ariaLabel={text.provider}
                options={providerOrder.map((kind) => ({
                  value: kind,
                  label: getIntegrationMeta(kind, language).label,
                  description: getIntegrationMeta(kind, language).inbound,
                  icon: <IntegrationBrandIcon kind={kind} size={15} />
                }))}
                value={draft.kind}
                onChange={(value) => {
                  setDraft({ ...draft, kind: value as IntegrationKind });
                  setClearFlags({});
                }}
              />
            </div>
            <div className="stdField">
              <span className="stdFieldLabel">{text.name}</span>
              <input aria-label={text.name} className="stdInput" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} required />
            </div>
            {fields.map((field) => (
              <FieldInput
                key={field.key}
                clearFlags={clearFlags}
                draft={draft}
                field={field}
                language={language}
                provider={provider}
                setClearFlags={setClearFlags}
                setDraft={setDraft}
              />
            ))}
            <div className="stdField">
              <span className="stdFieldLabel">{text.folder}</span>
              <AccordionSelect
                ariaLabel={text.folder}
                options={folders.map((folder) => ({ value: folder.id, label: folder.name, description: folder.rootPath, icon: <Cable size={15} /> }))}
                value={draft.defaultFolderId}
                onChange={(value) => setDraft({ ...draft, defaultFolderId: value })}
              />
            </div>
            <div className="stdField">
              <span className="stdFieldLabel">{text.permission}</span>
              <AccordionSelect
                ariaLabel={text.permission}
                options={[
                  { value: "ask", label: "Ask" },
                  { value: "read_only", label: "Read only" },
                  { value: "custom", label: "Custom" },
                  { value: "all", label: "All" }
                ]}
                value={draft.defaultPermissionPreset}
                onChange={(value) => setDraft({ ...draft, defaultPermissionPreset: value as PermissionPreset })}
              />
            </div>
          </div>
          <div className={draft.enabled ? "stdToggleRow enabled" : "stdToggleRow"}>
            <span>
              <strong>{text.enabled}</strong>
              <small>{text.enabledHint}</small>
            </span>
            <button className="switchControl" type="button" onClick={() => setDraft({ ...draft, enabled: !draft.enabled })} aria-pressed={draft.enabled} aria-label={text.enabled}>
              <span aria-hidden="true" />
            </button>
          </div>
          {formError ? <p className="formError" role="alert">{formError}</p> : null}
        </div>
        <div className="stdFooter">
          <button className="stdCancelBtn" type="button" onClick={onClose}>{text.cancel}</button>
          <button className="primaryInlineButton" type="submit">{text.save}</button>
        </div>
      </form>
    </div>
  );

  async function submit() {
    setFormError(null);
    try {
      const payload: IntegrationProviderCreateRequest | IntegrationProviderPatchRequest = {
        kind: draft.kind,
        label: draft.label.trim(),
        defaultFolderId: draft.defaultFolderId,
        defaultPermissionPreset: draft.defaultPermissionPreset,
        enabled: draft.enabled,
        ...optionalValue("botToken", draft.botToken, clearFlags.clearBotToken),
        ...optionalValue("publicKey", draft.publicKey),
        ...optionalValue("appId", draft.appId),
        ...optionalValue("appSecret", draft.appSecret, clearFlags.clearAppSecret),
        ...optionalValue("verificationToken", draft.verificationToken, clearFlags.clearVerificationToken),
        ...optionalValue("encryptKey", draft.encryptKey, clearFlags.clearEncryptKey),
        ...optionalValue("signingSecret", draft.signingSecret, clearFlags.clearSigningSecret),
        ...optionalValue("secretToken", draft.secretToken, clearFlags.clearSecretToken),
        ...optionalValue("wecomToken", draft.wecomToken, clearFlags.clearWecomToken),
        ...optionalValue("wecomEncodingAesKey", draft.wecomEncodingAesKey, clearFlags.clearWecomEncodingAesKey),
        ...optionalValue("callbackUrl", draft.callbackUrl)
      };
      await onSave(payload);
    } catch (error) {
      setFormError(describeActionError(error));
    }
  }
}

function FieldInput({
  clearFlags,
  draft,
  field,
  language,
  provider,
  setClearFlags,
  setDraft
}: {
  clearFlags: Partial<Record<ClearSecretFlag, boolean>>;
  draft: IntegrationDraft;
  field: IntegrationFieldDescriptor;
  language?: string | null | undefined;
  provider?: IntegrationProviderConfig | undefined;
  setClearFlags: React.Dispatch<React.SetStateAction<Partial<Record<ClearSecretFlag, boolean>>>>;
  setDraft: React.Dispatch<React.SetStateAction<IntegrationDraft>>;
}) {
  const text = copy(language);
  const label = text.fieldLabels[field.key] ?? String(field.key);
  const isWide = field.key === "callbackUrl";
  const clearFlag = field.clearFlag;
  const checked = clearFlag ? clearFlags[clearFlag] === true : false;
  const currentValue = String(draft[field.key] ?? "");
  const placeholder = field.placeholder?.(provider) ?? "";
  const existingConfigured = Boolean(clearFlag && hasSecretRef(provider, clearFlag));
  return (
    <div className={isWide ? "stdField wide" : "stdField"}>
      <span className="stdFieldLabel">{label}</span>
      <input
        aria-label={label}
        autoComplete="off"
        className="stdInput"
        type={clearFlag ? "password" : "text"}
        value={currentValue}
        placeholder={placeholder}
        onChange={(event) => {
          const value = event.target.value;
          setDraft({ ...draft, [field.key]: value });
          if (clearFlag && value.trim()) {
            setClearFlags((current) => ({ ...current, [clearFlag]: false }));
          }
        }}
      />
      {clearFlag && existingConfigured ? (
        <label className="fieldHint">
          <input
            checked={checked}
            type="checkbox"
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setClearFlags((current) => ({ ...current, [clearFlag]: next }));
              if (next) setDraft({ ...draft, [field.key]: "" });
            }}
          />
          {text.clearStored(label)}
        </label>
      ) : null}
    </div>
  );
}

function optionalValue(key: keyof IntegrationProviderCreateRequest, value: string, clear = false): Partial<IntegrationProviderPatchRequest> {
  const trimmed = value.trim();
  if (trimmed) return { [key]: trimmed } satisfies Partial<IntegrationProviderPatchRequest>;
  if (!clear) return {};
  const clearKey = `clear${key.charAt(0).toUpperCase()}${key.slice(1)}` as ClearSecretFlag;
  return { [clearKey]: true } satisfies Partial<IntegrationProviderPatchRequest>;
}

function folderName(folders: TaskFolderRecord[], folderId: string): string {
  return folders.find((folder) => folder.id === folderId)?.name ?? folderId;
}

function maskRef(last4?: string): string {
  return last4 ? `•••• ${last4}` : "";
}

function integrationSecretSummary(provider: IntegrationProviderConfig, language?: string | null): string {
  const zh = language === "zh-CN";
  const parts: string[] = [];
  if (provider.publicKey) parts.push(zh ? "public key 已配置" : "public key set");
  if (provider.botTokenRef?.last4) parts.push(`${zh ? "bot token" : "bot token"} ••••${provider.botTokenRef.last4}`);
  if (provider.verificationTokenRef?.last4) parts.push(`${zh ? "verification token" : "verification token"} ••••${provider.verificationTokenRef.last4}`);
  if (provider.appSecretRef?.last4) parts.push(`${zh ? "app secret" : "app secret"} ••••${provider.appSecretRef.last4}`);
  if (provider.encryptKeyRef?.last4) parts.push(`${zh ? "encrypt key" : "encrypt key"} ••••${provider.encryptKeyRef.last4}`);
  if (provider.signingSecretRef?.last4) parts.push(`${zh ? "signing secret" : "signing secret"} ••••${provider.signingSecretRef.last4}`);
  if (provider.secretTokenRef?.last4) parts.push(`${zh ? "secret token" : "secret token"} ••••${provider.secretTokenRef.last4}`);
  if (provider.wecomTokenRef?.last4) parts.push(`${zh ? "callback token" : "callback token"} ••••${provider.wecomTokenRef.last4}`);
  if (provider.wecomEncodingAesKeyRef?.last4) parts.push(`${zh ? "encoding key" : "encoding key"} ••••${provider.wecomEncodingAesKeyRef.last4}`);
  return parts.join(", ");
}

function getIntegrationMeta(kind: IntegrationKind, language?: string | null) {
  const zh = language === "zh-CN";
  const common = {
    discord: {
      label: "Discord",
      inbound: zh ? "Slash command / interaction 入站" : "Slash command and interaction ingress",
      setupNote: zh ? "使用 Public Key 验签；Bot Token 仅在需要额外机器人 API 时配置。" : "Uses a Public Key for verification. Bot token is optional unless you need extra bot API calls.",
      dialogHint: zh ? "Discord 需要可公开访问的 interaction callback；Public Key 必须与 Discord Developer Portal 中的应用一致。" : "Discord needs a publicly reachable interaction callback. The public key must match the Discord Developer Portal app.",
      callbackGuide: zh ? "把 Interaction Endpoint URL 指向这里。URL 必须能被 Discord 访问，并回到当前集成的 callback 地址。" : "Point the Interaction Endpoint URL here. The URL must be reachable by Discord and match this integration's callback.",
      securityGuide: zh ? "入站请求使用 X-Signature-Ed25519 与时间戳验签；错误公钥会直接导致 401。" : "Inbound requests are verified with X-Signature-Ed25519 plus the timestamp. A wrong public key will cause 401 responses."
    },
    feishu: {
      label: zh ? "飞书 / Lark" : "Feishu / Lark",
      inbound: zh ? "飞书消息事件 / challenge 验证" : "Feishu message events and challenge verification",
      setupNote: zh ? "Verification Token 必填；App Secret 与 Encrypt Key 按你的机器人配置补齐。" : "Verification token is required. App secret and encrypt key depend on your bot configuration.",
      dialogHint: zh ? "飞书先会发送 challenge，再推送消息事件。缺少 verification token 时状态会停留在待配置。" : "Feishu sends a challenge first, then message events. Missing verification token keeps the integration in setup needed.",
      callbackGuide: zh ? "把事件订阅地址配置到这里，并确认机器人具备读取消息事件的权限。" : "Configure this as the event subscription URL and ensure the app can receive message events.",
      securityGuide: zh ? "优先使用 verification token 校验来源；如果启用了加密回调，再补充 encrypt key 与 app secret。" : "Use the verification token to validate source requests. Add encrypt key and app secret if encrypted callbacks are enabled."
    },
    slack: {
      label: "Slack",
      inbound: zh ? "Events API / URL verification" : "Events API and URL verification",
      setupNote: zh ? "Signing Secret 和 callback URL 缺一不可；Slack 首次会先做 challenge 验证。" : "Slack needs both a signing secret and callback URL. The first request is usually a challenge verification.",
      dialogHint: zh ? "Slack 本轮支持 message 事件和 URL verification。把 Events Request URL 指向当前 callback。" : "This round supports Slack message events and URL verification. Point the Events Request URL to this callback.",
      callbackGuide: zh ? "Slack Events API 的 Request URL 应直接填这里。保存后先在测试 workspace 里完成 challenge。" : "Set the Slack Events API Request URL to this callback. Validate the challenge in a test workspace first.",
      securityGuide: zh ? "服务端使用 Signing Secret 校验 X-Slack-Signature 与时间戳，防止伪造请求。" : "The server verifies X-Slack-Signature and timestamp using the Signing Secret to reject forged requests."
    },
    telegram: {
      label: "Telegram",
      inbound: zh ? "Bot updates webhook" : "Bot update webhook",
      setupNote: zh ? "Telegram 需要 Bot Token、Secret Token 和 webhook callback URL。" : "Telegram needs a bot token, secret token, and webhook callback URL.",
      dialogHint: zh ? "把 webhook 指向当前 callback，并在 Bot API 设置相同的 secret token。" : "Point the webhook to this callback and set the same secret token in the Bot API.",
      callbackGuide: zh ? "Telegram 会把 bot 更新直接 POST 到这里；请确保公网可访问并已在 BotFather / Bot API 中配置。" : "Telegram posts bot updates here directly. Make sure the URL is public and configured through BotFather or the Bot API.",
      securityGuide: zh ? "服务端校验 X-Telegram-Bot-Api-Secret-Token。Bot Token 仍应保密，不直接暴露给浏览器。" : "The server verifies X-Telegram-Bot-Api-Secret-Token. Keep the bot token secret and never expose it to the browser."
    },
    wecom: {
      label: "WeCom",
      inbound: zh ? "企业微信回调 / echo 握手" : "WeCom callbacks and echo handshake",
      setupNote: zh ? "WeCom 需要 callback token、EncodingAESKey 和 callback URL。" : "WeCom needs a callback token, EncodingAESKey, and callback URL.",
      dialogHint: zh ? "企业微信会先进行 GET 回调握手，再推送加密 XML 事件。三项安全字段必须成组配置。" : "WeCom performs a GET handshake first, then sends encrypted XML events. All three security settings must be configured together.",
      callbackGuide: zh ? "把企业微信回调地址指到这里，并在管理后台填入相同的 token 与 EncodingAESKey。" : "Point the WeCom callback URL here and use the same token and EncodingAESKey in the admin console.",
      securityGuide: zh ? "服务端会校验 msg_signature，并用 EncodingAESKey 解密 XML 内容；任一字段错误都会握手失败。" : "The server validates msg_signature and decrypts XML with the EncodingAESKey. A wrong field will fail the handshake."
    }
  } satisfies Record<IntegrationKind, { label: string; inbound: string; setupNote: string; dialogHint: string; callbackGuide: string; securityGuide: string }>;
  return common[kind];
}

function hasSecretRef(provider: IntegrationProviderConfig | undefined, flag: ClearSecretFlag): boolean {
  if (!provider) return false;
  switch (flag) {
    case "clearBotToken":
      return Boolean(provider.botTokenRef);
    case "clearAppSecret":
      return Boolean(provider.appSecretRef);
    case "clearVerificationToken":
      return Boolean(provider.verificationTokenRef);
    case "clearEncryptKey":
      return Boolean(provider.encryptKeyRef);
    case "clearSigningSecret":
      return Boolean(provider.signingSecretRef);
    case "clearSecretToken":
      return Boolean(provider.secretTokenRef);
    case "clearWecomToken":
      return Boolean(provider.wecomTokenRef);
    case "clearWecomEncodingAesKey":
      return Boolean(provider.wecomEncodingAesKeyRef);
  }
}

function copy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "第三方集成" : "Integrations",
    subtitle: zh ? "把 Discord、飞书、Slack、Telegram 和 WeCom 消息接入 Agent Workbench，并继续走相同的权限、文件夹与任务链。" : "Bring Discord, Feishu, Slack, Telegram, and WeCom into Agent Workbench while keeping the same task, permission, and folder flow.",
    add: zh ? "添加集成" : "Add integration",
    emptyTitle: zh ? "还没有外部入口" : "No external channels yet",
    empty: zh ? "添加聊天平台后，外部消息会变成普通 Agent Workbench 任务，而不是绕过审批和工作区边界的隐蔽入口。" : "Once configured, inbound chat messages become normal Agent Workbench tasks instead of bypassing approvals or workspace boundaries.",
    emptyHint: zh ? "建议先用测试频道验证 challenge、签名和默认文件夹，再决定是否长期启用。" : "Validate the challenge, signature, and default folder in a test channel before turning a provider on long term.",
    emptyAction: zh ? "添加第一个平台" : "Add your first provider",
    connect: zh ? "连接" : "Connect",
    disconnect: zh ? "断开" : "Disconnect",
    edit: zh ? "编辑集成" : "Edit integration",
    delete: zh ? "删除" : "Delete",
    cancel: zh ? "取消" : "Cancel",
    save: zh ? "保存" : "Save",
    deleteTitle: zh ? "删除集成？" : "Delete integration?",
    deleteBody: (name: string) => zh ? `将删除“${name}”的配置和本地密钥。已有任务历史会保留。` : `This removes ${name} and its local secrets. Existing task history is preserved.`,
    createTitle: zh ? "添加集成" : "Add integration",
    editTitle: zh ? "编辑集成" : "Edit integration",
    provider: zh ? "平台" : "Provider",
    name: zh ? "名称" : "Name",
    folder: zh ? "默认工作文件夹" : "Default work folder",
    permission: zh ? "默认权限" : "Default permission",
    enabled: zh ? "允许接收消息" : "Can receive messages",
    enabledHint: zh ? "暂停后保留配置和密钥，但不会继续从这个平台创建新任务。" : "Pausing keeps the configuration and secrets, but new inbound messages will not create tasks.",
    callbackTitle: zh ? "回调地址如何配置" : "Callback setup",
    securityTitle: zh ? "安全边界" : "Security boundary",
    inboundTitle: zh ? "支持的入站类型" : "Supported inbound flow",
    statusLegend: zh ? "状态说明：待配置表示关键字段缺失；已连接表示当前字段组合已满足入站校验；异常表示最近一次校验或事件处理失败。" : "Status guide: setup needed means required fields are missing, connected means the current setup is sufficient for inbound verification, and error means the most recent verification or inbound handling failed.",
    clearStored: (label: string) => zh ? `清除已保存的 ${label}` : `Clear stored ${label}`,
    fieldLabels: {
      botToken: zh ? "Bot Token" : "Bot token",
      publicKey: zh ? "Public Key" : "Public key",
      appId: zh ? "App ID" : "App ID",
      appSecret: zh ? "App Secret" : "App secret",
      verificationToken: zh ? "Verification Token" : "Verification token",
      encryptKey: zh ? "Encrypt Key" : "Encrypt key",
      signingSecret: zh ? "Signing Secret" : "Signing secret",
      secretToken: zh ? "Secret Token" : "Secret token",
      wecomToken: zh ? "Callback Token" : "Callback token",
      wecomEncodingAesKey: zh ? "EncodingAESKey" : "EncodingAESKey",
      callbackUrl: zh ? "回调地址" : "Callback URL"
    } as Record<keyof IntegrationDraft, string>,
    status: {
      disabled: zh ? "已暂停" : "Paused",
      setup_pending: zh ? "待配置" : "Setup needed",
      connecting: zh ? "连接中" : "Connecting",
      connected: zh ? "已连接" : "Connected",
      error: zh ? "异常" : "Error"
    } as Record<string, string>,
    primer: {
      summary: zh ? "这里负责把外部聊天平台接入 Agent Workbench，让消息以普通任务的形式进入同一条审批和执行链。" : "This page connects chat platforms into Agent Workbench so external messages enter the same approval and execution loop as normal tasks.",
      focus: zh ? "配置平台密钥、回调地址、默认文件夹和默认权限，不让外部入口绕过当前边界。" : "Configure provider secrets, callback URLs, default folder routing, and permission presets without creating a side door around current safeguards.",
      impact: zh ? "会影响外部消息是否能成功创建任务、任务落在哪个文件夹，以及连接失败时错误如何暴露给你。" : "Changes affect whether inbound messages can create tasks, which folder they land in, and how failures are surfaced back to you.",
      nextStep: zh ? "先在测试频道、测试群或测试 bot 上跑通 challenge 和一条真实消息，再决定是否长期开启。" : "Validate the challenge and a real inbound message in a test channel, group, or bot before leaving the integration enabled."
    }
  };
}
