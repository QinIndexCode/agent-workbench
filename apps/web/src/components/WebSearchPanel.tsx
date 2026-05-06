import { useState } from "react";
import type { WebSearchProviderConfig, WebSearchProviderCreateRequest, WebSearchProviderPatchRequest } from "@scc/shared";
import { Compass, Globe2, KeyRound, Pencil, Plus, Search, ShieldQuestion, Trash2 } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";

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
  return (
    <section className="settingsCardList">
      <div className="panelHero">
        <div>
          <h2>{zh ? "网络搜索" : "Web search"}</h2>
          <p>{zh ? "Agent 需要联网证据时才会请求 web_search，并统一走 network 权限。" : "The agent requests web_search only when external evidence is needed; network permission still applies."}</p>
        </div>
        <button className="primaryInlineButton" type="button" onClick={() => setCreating(true)}>
          <Plus size={15} /> {zh ? "添加" : "Add"}
        </button>
      </div>
      <div className="compactList">
        {providers.length === 0 ? <p className="emptyState">{zh ? "还没有搜索 Provider。" : "No search providers yet."}</p> : null}
        {providers.map((provider) => (
          <article className="providerRow" key={provider.id}>
            <span className="providerIcon"><Globe2 size={17} /></span>
            <div>
              <strong>{provider.label}</strong>
              <small>{provider.kind} · {provider.enabled ? (zh ? "启用" : "enabled") : (zh ? "暂停" : "disabled")} · {provider.apiKeyRef?.last4 ? `••••${provider.apiKeyRef.last4}` : (zh ? "无密钥" : "no key")}</small>
            </div>
            <button className="iconButton" type="button" onClick={() => setEditing(provider)}><Pencil size={15} /></button>
            <button className="iconButton danger" type="button" onClick={() => void onDelete(provider.id)}><Trash2 size={15} /></button>
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
    <div className="modalBackdrop">
      <form className="modalCard settingsModal" onSubmit={(event) => {
        event.preventDefault();
        void onSave({ label, kind, endpoint: endpoint || undefined, apiKey: apiKey || undefined, enabled });
      }}>
        <header>
          <h3>{provider ? (zh ? "编辑搜索 Provider" : "Edit search provider") : (zh ? "添加搜索 Provider" : "Add search provider")}</h3>
          <button type="button" onClick={onClose}>×</button>
        </header>
        <label>{zh ? "名称" : "Label"}<input value={label} onChange={(event) => setLabel(event.target.value)} required /></label>
        <label>
          {zh ? "类型" : "Kind"}
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
        </label>
        <label>{zh ? "Endpoint" : "Endpoint"}<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder={kind === "custom" ? "https://example.com/search?q={query}&limit={limit}" : ""} /></label>
        <label>{zh ? "API Key" : "API key"}<input value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider?.apiKeyRef?.last4 ? `••••${provider.apiKeyRef.last4}` : ""} /></label>
        <label className="checkRow"><input checked={enabled} type="checkbox" onChange={(event) => setEnabled(event.target.checked)} /> {zh ? "启用" : "Enabled"}</label>
        <footer><button type="button" onClick={onClose}>{zh ? "取消" : "Cancel"}</button><button className="primaryInlineButton" type="submit">{zh ? "保存" : "Save"}</button></footer>
      </form>
    </div>
  );
}
