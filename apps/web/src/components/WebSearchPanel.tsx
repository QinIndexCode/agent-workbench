import { useState } from "react";
import type { WebSearchProviderConfig, WebSearchProviderCreateRequest, WebSearchProviderPatchRequest } from "@scc/shared";
import { Compass, Globe2, KeyRound, Pencil, Plus, Search, ShieldQuestion, Trash2 } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";

export function WebSearchPanel({
  language,
  providers,
  onCreate,
  onDelete,
  onUpdate
}: {
  language?: string | null | undefined;
  providers: WebSearchProviderConfig[];
  onCreate: (input: WebSearchProviderCreateRequest) => Promise<void> | void;
  onDelete: (providerId: string) => Promise<void> | void;
  onUpdate: (providerId: string, input: WebSearchProviderPatchRequest) => Promise<void> | void;
}) {
  const zh = language === "zh-CN";
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<WebSearchProviderConfig | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  return (
    <>
    <section className="settingsCardList">
      <div className="panelHero">
        <div>
          <h2>{zh ? "网络搜索" : "Web search"}</h2>
          <p>{zh ? "配置搜索来源；Agent 会通过内置 web_search 工具按需联网，仍统一走 network 权限。" : "Configure search sources. The agent uses SCC's built-in web_search tool when needed, with network permission still enforced."}</p>
        </div>
        <button className="primaryInlineButton" type="button" onClick={() => setCreating(true)}>
          <Plus size={15} /> {zh ? "添加" : "Add"}
        </button>
      </div>
      <article className="searchCapabilityCard">
        <span className="providerIcon">
          <Globe2 size={17} aria-hidden="true" />
        </span>
        <div>
          <strong>{zh ? "内置工具：web_search" : "Built-in tool: web_search"}</strong>
          <p>
            {zh
              ? "SCC 已内置统一的网络搜索工具。这里添加的是搜索 Provider；Agent 可以选择搜索、不搜索，或在你拒绝 network 权限后改用本地证据。"
              : "SCC includes a unified web_search tool. Providers added here are search sources; the agent may search, skip search, or fall back to local evidence if network permission is denied."}
          </p>
          <small>{zh ? "搜索结果会作为工具证据进入线程，不会变成任务质量判定脚本。" : "Search results enter the thread as tool evidence, not as a task-quality judge."}</small>
        </div>
      </article>
      <div className="compactList">
        {providers.length === 0 ? <p className="emptyState">{zh ? "还没有搜索 Provider。" : "No search providers yet."}</p> : null}
        {providers.map((provider) => (
          <article className="providerRow" key={provider.id}>
            <span className="providerIcon"><Globe2 size={17} /></span>
            <div>
              <strong>{provider.label}</strong>
              <small>
                {provider.kind} · {provider.apiKeyRef?.last4 ? `••••${provider.apiKeyRef.last4}` : (zh ? "无密钥" : "no key")}
              </small>
            </div>
            <span className={provider.enabled ? "statusPill" : "statusPill muted"}>{provider.enabled ? (zh ? "可用" : "Available") : (zh ? "暂停" : "Paused")}</span>
            <div className="rowIconActions">
              <button className="iconButton" type="button" onClick={() => setEditing(provider)}><Pencil size={15} /></button>
              <button className="iconButton danger" type="button" onClick={() => setConfirmDeleteId(provider.id)}><Trash2 size={15} /></button>
            </div>
          </article>
        ))}
      </div>
      {(creating || editing) ? (
        <SearchProviderDialog
          language={language}
          provider={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSave={async (input) => {
            if (editing) await onUpdate(editing.id, input);
            else await onCreate(input as WebSearchProviderCreateRequest);
            setCreating(false);
            setEditing(null);
          }}
        />
      ) : null}
    </section>
    <ConfirmDialog
      open={confirmDeleteId !== null}
      title={zh ? "删除搜索 Provider" : "Delete search provider"}
      confirmLabel={zh ? "删除" : "Delete"}
      cancelLabel={zh ? "取消" : "Cancel"}
      onCancel={() => setConfirmDeleteId(null)}
      onConfirm={() => {
        if (confirmDeleteId) void onDelete(confirmDeleteId);
        setConfirmDeleteId(null);
      }}
    >
      <p>{zh ? "删除后该搜索 Provider 的 API Key 和配置将一并清除。" : "Deleting removes the search provider's API key and configuration."}</p>
    </ConfirmDialog>
    </>
  );
}

function SearchProviderDialog({
  language,
  provider,
  onClose,
  onSave
}: {
  language?: string | null | undefined;
  provider: WebSearchProviderConfig | null;
  onClose: () => void;
  onSave: (input: WebSearchProviderCreateRequest | WebSearchProviderPatchRequest) => Promise<void>;
}) {
  const zh = language === "zh-CN";
  const [label, setLabel] = useState(provider?.label ?? "DuckDuckGo");
  const [kind, setKind] = useState<WebSearchProviderConfig["kind"]>(provider?.kind ?? "duckduckgo");
  const [endpoint, setEndpoint] = useState(provider?.endpoint ?? "");
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  return (
    <div className="modalBackdrop stdBackdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="stdModal stdModalNarrow" onSubmit={(event) => {
        event.preventDefault();
        void onSave({ label, kind, endpoint: endpoint || undefined, apiKey: apiKey || undefined, enabled });
      }}>
        <div className="stdHeader">
          <h3>{provider ? (zh ? "编辑搜索 Provider" : "Edit search provider") : (zh ? "添加搜索 Provider" : "Add search provider")}</h3>
          <button className="stdClose" type="button" onClick={onClose}>×</button>
        </div>
        <div className="stdBody">
          <div className="stdFormGrid cols2">
            <div className="stdField">
              <span className="stdFieldLabel">{zh ? "名称" : "Label"}</span>
              <input className="stdInput" value={label} onChange={(event) => setLabel(event.target.value)} required />
            </div>
            <div className="stdField">
              <span className="stdFieldLabel">{zh ? "类型" : "Kind"}</span>
              <AccordionSelect
                ariaLabel={zh ? "选择搜索类型" : "Select search provider kind"}
                options={[
                  {
                    value: "duckduckgo",
                    label: "DuckDuckGo",
                    description: zh ? "无需密钥的轻量搜索" : "Lightweight search without an API key",
                    icon: <Search size={15} />
                  },
                  {
                    value: "brave",
                    label: "Brave",
                    description: zh ? "需要 API Key，适合正式联网证据" : "Requires an API key; useful for production search",
                    icon: <Compass size={15} />
                  },
                  {
                    value: "serpapi",
                    label: "SerpAPI",
                    description: zh ? "Google 结果聚合，需 API Key" : "Google result aggregation with an API key",
                    icon: <KeyRound size={15} />
                  },
                  {
                    value: "custom",
                    label: zh ? "自定义" : "Custom",
                    description: zh ? "使用 {query} 和 {limit} 模板" : "Use {query} and {limit} URL templates",
                    icon: <ShieldQuestion size={15} />
                  }
                ]}
                value={kind}
                onChange={(value) => setKind(value as WebSearchProviderConfig["kind"])}
              />
            </div>
            {kind === "custom" ? (
              <div className="stdField wide">
                <span className="stdFieldLabel">Endpoint</span>
                <input className="stdInput" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://example.com/search?q={query}&limit={limit}" />
              </div>
            ) : null}
            {kind !== "duckduckgo" ? (
              <div className="stdField wide">
                <span className="stdFieldLabel">{zh ? "API Key" : "API key"}</span>
                <input className="stdInput" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider?.apiKeyRef?.last4 ? `••••${provider.apiKeyRef.last4}` : ""} />
              </div>
            ) : null}
          </div>
          <div className={enabled ? "stdToggleRow enabled" : "stdToggleRow"}>
            <span>
              <strong>{zh ? "可用于搜索" : "Available for search"}</strong>
              <small>{zh ? "暂停后保留配置和密钥，但 Agent 不会选择该来源。" : "When paused, the configuration and key remain stored but the agent will not use this source."}</small>
            </span>
            <button className="switchControl" type="button" onClick={() => setEnabled(!enabled)} aria-pressed={enabled} aria-label={zh ? "可用于搜索" : "Available for search"}>
              <span aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="stdFooter">
          <button className="stdCancelBtn" type="button" onClick={onClose}>{zh ? "取消" : "Cancel"}</button>
          <button className="primaryInlineButton" type="submit">{zh ? "保存" : "Save"}</button>
        </div>
      </form>
    </div>
  );
}
