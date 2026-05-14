import { useState } from "react";
import type { McpServerConfig, McpServerCreateRequest, McpServerPatchRequest, McpServerStatus, McpToolSummary, McpTransportKind, RiskCategory } from "@agent-workbench/shared";
import { Edit3, Plug, Plus, Search, Server, Trash2, Unplug, Wrench } from "lucide-react";
import { AccordionSelect } from "./AccordionSelect.js";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { SettingsEmptyStateCard, SettingsPrimer, describeActionError } from "./SettingsAssist.js";

const riskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];

type McpServerWithStatus = McpServerConfig & { status: McpServerStatus };

type McpDraft = {
  label: string;
  transport: McpTransportKind;
  command: string;
  argsText: string;
  cwd: string;
  url: string;
  enabled: boolean;
  overrideTool: string;
  overrideRisk: RiskCategory;
};

export function McpPanel({
  language,
  onOpenDocs,
  servers,
  tools,
  onCreate,
  onUpdate,
  onConnect,
  onDisconnect,
  onDelete
}: {
  language?: string | null;
  onOpenDocs?: (() => void) | undefined;
  servers: McpServerWithStatus[];
  tools: McpToolSummary[];
  onCreate: (input: McpServerCreateRequest) => Promise<McpServerConfig | void> | McpServerConfig | void;
  onUpdate: (serverId: string, input: McpServerPatchRequest) => Promise<McpServerConfig | void> | McpServerConfig | void;
  onConnect: (serverId: string) => void;
  onDisconnect: (serverId: string) => void;
  onDelete: (serverId: string) => void;
}) {
  const text = getMcpCopy(language);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerWithStatus | null>(null);
  const [draft, setDraft] = useState<McpDraft>(() => emptyDraft());
  const [toolFilter, setToolFilter] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const safeServers = Array.isArray(servers) ? servers : [];
  const safeTools = Array.isArray(tools) ? tools : [];
  const visibleTools = safeTools.filter((tool) =>
    [tool.displayName, tool.name, tool.serverId, tool.riskCategory].filter(Boolean).join(" ").toLowerCase().includes(toolFilter.trim().toLowerCase())
  );
  const canSubmit = Boolean(draft.label.trim() && (draft.transport === "stdio" ? draft.command.trim() : draft.url.trim()));

  return (
    <>
    <section className="mcpPanel">
      <header className="panelHero">
        <div>
          <h2>{text.title}</h2>
          <p>{text.subtitle}</p>
        </div>
        <button className="subtleButton iconText" type="button" onClick={startCreate}>
          <Plus size={15} aria-hidden="true" />
          {text.add}
        </button>
      </header>

      <SettingsPrimer
        language={language}
        summary={text.primer.summary}
        focus={text.primer.focus}
        impact={text.primer.impact}
        nextStep={text.primer.nextStep}
        onOpenDocs={onOpenDocs}
      />

      <section className="mcpListPanel">
        <div className="panelHeader">
          <div>
            <h3>{text.servers}</h3>
            <p>{text.serverHint}</p>
          </div>
          <small>{safeServers.length}</small>
        </div>
        <div className="mcpRows">
          {safeServers.length === 0 ? (
          <SettingsEmptyStateCard
            language={language}
            title={text.emptyServersTitle}
            body={text.emptyServers}
            hint={text.emptyServersHint}
            actionLabel={text.emptyServersAction}
            actionAriaLabel={text.emptyServersAction}
            onAction={startCreate}
          />
          ) : null}
          {safeServers.map((server) => (
            <article className={server.status?.connected ? "mcpServerListRow connected" : "mcpServerListRow"} key={server.id}>
              <span className="providerBadge">
                <Server size={16} aria-hidden="true" />
              </span>
              <div className="providerMain">
                <strong>{server.label ?? server.id}</strong>
                <span>{formatTransport(server.transport)} · {server.status?.toolCount ?? 0} {text.tools}</span>
                {server.status?.lastError ? <small className="dangerText">{server.status.lastError}</small> : <small>{server.command ?? server.url ?? text.noEndpoint}</small>}
              </div>
              <span className={server.status?.connected ? "mcpState connected" : "mcpState"}>
                {server.status?.state ?? "disconnected"}
              </span>
              <div className="rowIconActions">
                {server.status?.connected ? (
                  <button aria-label={text.disconnect} className="iconButton" type="button" onClick={() => onDisconnect(server.id)}>
                    <Unplug size={15} aria-hidden="true" />
                  </button>
                ) : (
                  <button aria-label={text.connect} className="iconButton" type="button" onClick={() => onConnect(server.id)}>
                    <Plug size={15} aria-hidden="true" />
                  </button>
                )}
                <button aria-label={text.editServer(server.label ?? server.id)} className="iconButton" type="button" onClick={() => startEdit(server)}>
                  <Edit3 size={15} aria-hidden="true" />
                </button>
                <button aria-label={text.deleteServer(server.label ?? server.id)} className="iconButton dangerIcon" type="button" onClick={() => setConfirmDeleteId(server.id)}>
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="mcpListPanel">
        <div className="panelHeader">
          <div>
            <h3>{text.discoveredTools}</h3>
            <p>{text.toolHint}</p>
          </div>
          <label className="searchField compactToolSearch">
            <Search size={14} aria-hidden="true" />
            <input aria-label={text.filterTools} placeholder={text.filter} value={toolFilter} onChange={(event) => setToolFilter(event.target.value)} />
          </label>
        </div>
        <p className="inlineNotice">
          <span>{text.overrideHint}</span>
        </p>
        <div className="mcpToolRows">
          {safeTools.length === 0 ? (
            <div className="emptyState">
              <Wrench size={18} aria-hidden="true" />
              <span>{text.emptyTools}</span>
            </div>
          ) : null}
          {visibleTools.slice(0, 14).map((tool) => (
            <article className="mcpToolRow" key={tool.id}>
              <span className="toolGlyph">
                <Wrench size={14} aria-hidden="true" />
              </span>
              <div>
                <strong>{tool.displayName ?? tool.name ?? tool.id}</strong>
                <small>{tool.serverId ?? text.unknownServer}</small>
              </div>
              <span className="permissionStatus">{formatRisk(tool.riskCategory)}</span>
            </article>
          ))}
        </div>
      </section>

      {dialogOpen ? (
        <div className="modalBackdrop stdBackdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) setDialogOpen(false); }}>
          <form aria-label={editing ? text.edit : text.add} className="stdModal" onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) void save();
          }}>
            <div className="stdHeader">
              <h3>{editing ? text.edit : text.add}</h3>
              <button className="stdClose" type="button" onClick={() => setDialogOpen(false)}>×</button>
            </div>
            <div className="stdBody">
              <p className="stdDialogHelp">{text.dialogHelp}</p>
              <div className="stdFormGrid cols2">
                <div className="stdField">
                  <span className="stdFieldLabel">{text.label}</span>
                  <input className="stdInput" aria-label={text.label} value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
                </div>
                <div className="stdField">
                  <span className="stdFieldLabel">{text.transport}</span>
                  <AccordionSelect
                    ariaLabel={text.transport}
                    value={draft.transport}
                    options={[
                      { value: "stdio", label: "stdio" },
                      { value: "streamable_http", label: "streamable http" }
                    ]}
                    onChange={(value) => setDraft({ ...draft, transport: value as McpTransportKind })}
                  />
                </div>
                {draft.transport === "stdio" ? (
                  <>
                    <div className="stdField wide">
                      <span className="stdFieldLabel">{text.command}</span>
                      <input className="stdInput" aria-label={text.command} value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} />
                    </div>
                    <div className="stdField">
                      <span className="stdFieldLabel">{text.args}</span>
                      <input className="stdInput" aria-label={text.args} value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} />
                    </div>
                    <div className="stdField">
                      <span className="stdFieldLabel">{text.cwd}</span>
                      <input className="stdInput" aria-label={text.cwd} value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} />
                    </div>
                  </>
                ) : (
                  <div className="stdField wide">
                    <span className="stdFieldLabel">{text.url}</span>
                    <input className="stdInput" aria-label={text.url} value={draft.url} onChange={(event) => setDraft({ ...draft, url: event.target.value })} />
                  </div>
                )}
                <div className="stdField">
                  <span className="stdFieldLabel">{text.overrideTool}</span>
                  <input className="stdInput" aria-label={text.overrideTool} value={draft.overrideTool} onChange={(event) => setDraft({ ...draft, overrideTool: event.target.value })} />
                </div>
                <div className="stdField">
                  <span className="stdFieldLabel">{text.overrideRisk}</span>
                  <AccordionSelect
                    ariaLabel={text.overrideRisk}
                    value={draft.overrideRisk}
                    options={riskCategories.map((risk) => ({ value: risk, label: formatRisk(risk) }))}
                    onChange={(value) => setDraft({ ...draft, overrideRisk: value as RiskCategory })}
                  />
                </div>
              </div>
              <div className={draft.enabled ? "stdToggleRow enabled" : "stdToggleRow"}>
                <span>
                  <strong>{text.enabled}</strong>
                  <small>{text.enabledHint}</small>
                </span>
                <button className="switchControl" type="button" aria-label={text.enabled} aria-pressed={draft.enabled} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })}>
                  <span aria-hidden="true" />
                </button>
              </div>
              {formError ? <p className="formError" role="alert">{formError}</p> : null}
            </div>
            <div className="stdFooter">
              <button className="stdCancelBtn" type="button" onClick={() => setDialogOpen(false)}>
                {text.cancel}
              </button>
              <button className="primaryInlineButton" type="submit" disabled={!canSubmit}>
                {text.save}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
    <ConfirmDialog
      open={confirmDeleteId !== null}
      title={text.deleteTitle}
      confirmLabel={text.deleteAction}
      cancelLabel={text.cancel}
      onCancel={() => setConfirmDeleteId(null)}
      onConfirm={() => {
        if (confirmDeleteId) onDelete(confirmDeleteId);
        setConfirmDeleteId(null);
      }}
    >
      <p>{text.deleteWarning}</p>
    </ConfirmDialog>
    </>
  );

  function startCreate() {
    setEditing(null);
    setDraft(emptyDraft());
    setFormError(null);
    setDialogOpen(true);
  }

  function startEdit(server: McpServerWithStatus) {
    setEditing(server);
    setDraft(draftFromServer(server));
    setFormError(null);
    setDialogOpen(true);
  }

  async function save() {
    setFormError(null);
    const toolRiskOverrides = draft.overrideTool.trim() ? { [draft.overrideTool.trim()]: draft.overrideRisk } : {};
    const base = {
      label: draft.label.trim(),
      transport: draft.transport,
      args: parseArgs(draft.argsText),
      env: {},
      enabled: draft.enabled,
      toolRiskOverrides,
      ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {})
    };
    const input =
      draft.transport === "stdio"
        ? { ...base, command: draft.command.trim(), url: undefined }
        : { ...base, url: draft.url.trim(), command: undefined };
    try {
      if (editing) await onUpdate(editing.id, input);
      else await onCreate(input);
      setDialogOpen(false);
    } catch (error) {
      setFormError(describeActionError(error));
    }
  }
}

function emptyDraft(): McpDraft {
  return {
    label: "",
    transport: "stdio",
    command: "",
    argsText: "",
    cwd: "",
    url: "",
    enabled: true,
    overrideTool: "",
    overrideRisk: "shell"
  };
}

function draftFromServer(server: McpServerConfig): McpDraft {
  const firstOverride = Object.entries(server.toolRiskOverrides ?? {})[0];
  return {
    label: server.label ?? server.id,
    transport: server.transport,
    command: server.command ?? "",
    argsText: (server.args ?? []).join(" "),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    enabled: server.enabled,
    overrideTool: firstOverride?.[0] ?? "",
    overrideRisk: firstOverride?.[1] ?? "shell"
  };
}

function formatTransport(value: McpTransportKind | undefined): string {
  return (value ?? "stdio").replace("_", " ");
}

function formatRisk(value: RiskCategory | undefined): string {
  return (value ?? "shell").replace("_", " ");
}

function parseArgs(value: string): string[] {
  return value
    .match(/(?:[^\s"]+|"[^"]*")+/g)
    ?.map((part) => part.replace(/^"|"$/g, ""))
    .filter(Boolean) ?? [];
}

function getMcpCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: "MCP",
    subtitle: zh ? "连接外部工具服务器。工具调用仍会经过 Agent Workbench 的同一套权限审批。" : "Connect external tool servers. Tool calls still go through Agent Workbench permissions.",
    add: zh ? "添加服务器" : "Add server",
    edit: zh ? "编辑服务器" : "Edit server",
    dialogHelp: zh ? "添加 stdio 或 streamable HTTP MCP 服务器；风险覆盖只影响指定工具。" : "Add a stdio or streamable HTTP MCP server. Risk overrides apply only to named tools.",
    servers: zh ? "服务器" : "Servers",
    serverHint: zh ? "连接状态、工具数量和最近错误集中展示。" : "Connection state, tool count, and latest errors in one list.",
    tools: zh ? "tools" : "tools",
    discoveredTools: zh ? "已发现工具" : "Discovered tools",
    toolHint: zh ? "工具被 Agent 使用时会作为普通工具证据进入时间线。" : "When the agent uses these tools, results appear as normal tool evidence.",
    emptyServersTitle: zh ? "还没有 MCP 服务器" : "No MCP servers yet",
    emptyServers: zh ? "先添加一个本地 stdio 或 streamable HTTP 服务，连接后才会发现工具列表。" : "Add a local stdio server or a streamable HTTP endpoint before Agent Workbench can discover tools.",
    emptyServersHint: zh ? "第一次接入建议先用一个最小测试服务，确认连接、断开和工具发现都正常。" : "For the first setup, use a minimal test server so you can verify connect, disconnect, and tool discovery quickly.",
    emptyServersAction: zh ? "添加第一个服务器" : "Add your first server",
    emptyTools: zh ? "连接服务器后会显示工具。" : "Connect a server to discover tools.",
    noEndpoint: zh ? "未配置入口" : "No endpoint",
    unknownServer: zh ? "未知服务器" : "unknown server",
    filter: zh ? "筛选工具" : "filter tools",
    filterTools: zh ? "筛选 MCP 工具" : "Filter MCP tools",
    overrideHint: zh ? "风险覆盖只影响你点名的单个工具，不会把整台 MCP 服务器统一降级成更低风险。" : "Risk overrides apply only to the named tool. They do not downgrade every tool from the same MCP server.",
    connect: zh ? "连接服务器" : "Connect server",
    disconnect: zh ? "断开连接" : "Disconnect server",
    editServer: (label: string) => (zh ? `编辑 ${label}` : `Edit ${label}`),
    deleteServer: (label: string) => (zh ? `删除 ${label}` : `Delete ${label}`),
    label: zh ? "服务器名称" : "Server label",
    transport: zh ? "传输方式" : "Transport",
    command: zh ? "命令" : "Command",
    args: zh ? "参数" : "Arguments",
    cwd: zh ? "工作目录（可选）" : "Working directory (optional)",
    url: "URL",
    overrideTool: zh ? "工具风险覆盖（可选）" : "Tool risk override (optional)",
    overrideRisk: zh ? "覆盖风险" : "Override risk",
    enabled: zh ? "可供 Agent 使用" : "Available to agent",
    enabledHint: zh ? "暂停后保留配置，但 Agent 不会发现或调用该服务器。" : "When paused, the configuration is kept but the agent will not discover or call this server.",
    cancel: zh ? "取消" : "Cancel",
    save: zh ? "保存" : "Save",
    deleteTitle: zh ? "删除服务器" : "Delete server",
    deleteAction: zh ? "删除" : "Delete",
    deleteWarning: zh ? "删除后该服务器的连接状态和自定义风险覆盖将一并清除。" : "Deleting removes the server connection state and any custom risk overrides.",
    primer: {
      summary: zh ? "MCP 把外部工具接到 Agent Workbench 里，但它们仍然要经过同一套风险审批和时间线记录。" : "MCP connects external tools into Agent Workbench, but they still pass through the same approval flow and timeline evidence.",
      focus: zh ? "配置服务入口、连接状态和工具发现；必要时只为个别工具重标风险。" : "Configure server entrypoints, connection state, and tool discovery; override risk only for specific tools when needed.",
      impact: zh ? "会影响 Agent 是否能发现外部工具、这些工具的风险分类，以及断线后的可用性反馈。" : "Changes affect whether the agent can discover external tools, how their risk is classified, and how outages show up in the UI.",
      nextStep: zh ? "先接入一个简单服务验证连通性，再逐步增加真正要给 Agent 使用的工具。" : "Connect one simple server first, confirm discovery works, then add the real tools you want the agent to use."
    }
  };
}
