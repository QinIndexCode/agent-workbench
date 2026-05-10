import { useState } from "react";
import type { IntegrationKind, IntegrationProviderConfig, IntegrationProviderCreateRequest, IntegrationProviderPatchRequest, TaskFolderRecord } from "@scc/shared";
import { Bot, Cable, MessageCircle, Pencil, Plus, Power, Trash2 } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

type IntegrationDraft = {
  kind: IntegrationKind;
  label: string;
  botToken: string;
  signingSecret: string;
  appId: string;
  appSecret: string;
  callbackUrl: string;
  defaultFolderId: string;
  defaultPermissionPreset: "ask" | "read_only" | "custom" | "all";
  enabled: boolean;
};

export function IntegrationsPanel({
  folders,
  integrations,
  language,
  onConnect,
  onCreate,
  onDelete,
  onDisconnect,
  onUpdate
}: {
  folders: TaskFolderRecord[];
  integrations: IntegrationProviderConfig[];
  language?: string | null;
  onConnect: (id: string) => Promise<void> | void;
  onCreate: (input: IntegrationProviderCreateRequest) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onDisconnect: (id: string) => Promise<void> | void;
  onUpdate: (id: string, input: IntegrationProviderPatchRequest) => Promise<void> | void;
}) {
  const text = copy(language);
  const [modal, setModal] = useState<{ mode: "create" | "edit"; provider?: IntegrationProviderConfig } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<IntegrationProviderConfig | null>(null);

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
      <div className="compactList">
        {integrations.length === 0 ? <p className="emptyState">{text.empty}</p> : null}
        {integrations.map((provider) => (
          <article className="providerRow" key={provider.id}>
            <span className="providerIcon">{provider.kind === "discord" ? <MessageCircle size={17} /> : <Bot size={17} />}</span>
            <div>
              <strong>{provider.label}</strong>
              <small>
                {[provider.kind, folderName(folders, provider.defaultFolderId), integrationSecretSummary(provider)].filter(Boolean).join(" · ")}
              </small>
              {provider.lastError ? <small className="dangerText">{provider.lastError}</small> : null}
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
        ))}
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
  onSave: (input: IntegrationProviderCreateRequest | IntegrationProviderPatchRequest) => Promise<void>;
}) {
  const text = copy(language);
  const [draft, setDraft] = useState<IntegrationDraft>({
    kind: provider?.kind ?? "discord",
    label: provider?.label ?? "",
    botToken: "",
    signingSecret: "",
    appId: provider?.appId ?? "",
    appSecret: "",
    callbackUrl: provider?.callbackUrl ?? "",
    defaultFolderId: provider?.defaultFolderId ?? "default",
    defaultPermissionPreset: provider?.defaultPermissionPreset ?? "ask",
    enabled: provider?.enabled ?? false
  });
  return (
    <div className="modalBackdrop stdBackdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form
        className="stdModal stdModalWide"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave({
            kind: draft.kind,
            label: draft.label.trim(),
            defaultFolderId: draft.defaultFolderId,
            defaultPermissionPreset: draft.defaultPermissionPreset,
            enabled: draft.enabled,
            ...(draft.botToken ? { botToken: draft.botToken } : {}),
            ...(draft.signingSecret ? { signingSecret: draft.signingSecret } : {}),
            ...(draft.appId ? { appId: draft.appId } : {}),
            ...(draft.appSecret ? { appSecret: draft.appSecret } : {}),
            ...(draft.callbackUrl ? { callbackUrl: draft.callbackUrl } : {})
          });
        }}
      >
        <div className="stdHeader">
          <h3>{provider ? text.editTitle : text.createTitle}</h3>
          <button className="stdClose" type="button" onClick={onClose}>×</button>
        </div>
        <div className="stdBody">
          <div className="stdFormGrid cols2">
            <div className="stdField">
              <span className="stdFieldLabel">{text.provider}</span>
              <AccordionSelect
                ariaLabel={text.provider}
                options={[
                  { value: "discord", label: "Discord", icon: <MessageCircle size={15} /> },
                  { value: "feishu", label: text.feishu, icon: <Bot size={15} /> }
                ]}
                value={draft.kind}
                onChange={(value) => setDraft({ ...draft, kind: value as IntegrationKind })}
              />
            </div>
            <div className="stdField">
              <span className="stdFieldLabel">{text.name}</span>
              <input className="stdInput" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} required />
            </div>
            <div className="stdField">
              <span className="stdFieldLabel">{text.botToken}</span>
              <input className="stdInput" value={draft.botToken} onChange={(event) => setDraft({ ...draft, botToken: event.target.value })} placeholder={provider?.botTokenRef?.last4 ? `•••• ${provider.botTokenRef.last4}` : ""} />
            </div>
            <div className="stdField">
              <span className="stdFieldLabel">{text.signingSecret}</span>
              <input className="stdInput" value={draft.signingSecret} onChange={(event) => setDraft({ ...draft, signingSecret: event.target.value })} />
            </div>
            {draft.kind === "feishu" ? (
              <>
                <div className="stdField">
                  <span className="stdFieldLabel">{text.appId}</span>
                  <input className="stdInput" value={draft.appId} onChange={(event) => setDraft({ ...draft, appId: event.target.value })} />
                </div>
                <div className="stdField">
                  <span className="stdFieldLabel">{text.appSecret}</span>
                  <input className="stdInput" value={draft.appSecret} onChange={(event) => setDraft({ ...draft, appSecret: event.target.value })} placeholder={provider?.appSecretRef?.last4 ? `•••• ${provider.appSecretRef.last4}` : ""} />
                </div>
                <div className="stdField wide">
                  <span className="stdFieldLabel">{text.callbackUrl}</span>
                  <input className="stdInput" value={draft.callbackUrl} onChange={(event) => setDraft({ ...draft, callbackUrl: event.target.value })} />
                </div>
              </>
            ) : null}
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
                onChange={(value) => setDraft({ ...draft, defaultPermissionPreset: value as IntegrationDraft["defaultPermissionPreset"] })}
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
        </div>
        <div className="stdFooter">
          <button className="stdCancelBtn" type="button" onClick={onClose}>{text.cancel}</button>
          <button className="primaryInlineButton" type="submit">{text.save}</button>
        </div>
      </form>
    </div>
  );
}

function folderName(folders: TaskFolderRecord[], folderId: string): string {
  return folders.find((folder) => folder.id === folderId)?.name ?? folderId;
}

function integrationSecretSummary(provider: IntegrationProviderConfig): string {
  return [
    provider.botTokenRef?.last4 ? `bot token ••••${provider.botTokenRef.last4}` : "",
    provider.signingSecretRef?.last4 ? `signing secret ••••${provider.signingSecretRef.last4}` : "",
    provider.appSecretRef?.last4 ? `app secret ••••${provider.appSecretRef.last4}` : ""
  ].filter(Boolean).join(", ");
}

function copy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "第三方集成" : "Integrations",
    subtitle: zh ? "Discord 和飞书消息会创建普通 SCC 任务，仍走权限、模型和工作文件夹。" : "Discord and Feishu messages create normal SCC tasks with the same permissions, model, and work folder.",
    add: zh ? "添加集成" : "Add integration",
    empty: zh ? "还没有集成。" : "No integrations yet.",
    connect: zh ? "连接" : "Connect",
    disconnect: zh ? "断开" : "Disconnect",
    edit: zh ? "编辑集成" : "Edit integration",
    delete: zh ? "删除" : "Delete",
    cancel: zh ? "取消" : "Cancel",
    save: zh ? "保存" : "Save",
    deleteTitle: zh ? "删除集成？" : "Delete integration?",
    deleteBody: (name: string) => zh ? `将删除“${name}”的配置和本地密钥。已有任务历史会保留。` : `This removes ${name} and its local secrets. Existing task history is kept.`,
    createTitle: zh ? "添加集成" : "Add integration",
    editTitle: zh ? "编辑集成" : "Edit integration",
    provider: zh ? "平台" : "Provider",
    feishu: zh ? "飞书 / Lark" : "Feishu / Lark",
    name: zh ? "名称" : "Name",
    botToken: zh ? "Bot Token" : "Bot token",
    signingSecret: zh ? "签名密钥" : "Signing secret",
    appId: zh ? "App ID" : "App ID",
    appSecret: zh ? "App Secret" : "App secret",
    callbackUrl: zh ? "回调地址" : "Callback URL",
    folder: zh ? "默认工作文件夹" : "Default work folder",
    permission: zh ? "默认权限" : "Default permission",
    enabled: zh ? "可接收消息" : "Can receive messages",
    enabledHint: zh ? "暂停后保留配置和密钥，但不会从该平台创建新任务。" : "When paused, credentials remain stored but this platform will not create new tasks.",
    status: {
      disabled: zh ? "已暂停" : "Paused",
      setup_pending: zh ? "待配置" : "Setup needed",
      connecting: zh ? "连接中" : "Connecting",
      connected: zh ? "已连接" : "Connected",
      error: zh ? "异常" : "Error"
    } as Record<string, string>
  };
}
