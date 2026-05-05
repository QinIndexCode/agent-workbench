import { useState } from "react";
import type { McpServerConfig, McpServerCreateRequest, McpServerStatus, McpToolSummary, McpTransportKind, RiskCategory } from "@scc/shared";

const riskCategories: RiskCategory[] = ["host_observation", "workspace_read", "workspace_write", "shell", "network", "destructive"];

export function McpPanel({
  servers,
  tools,
  onCreate,
  onConnect,
  onDisconnect,
  onDelete
}: {
  servers: Array<McpServerConfig & { status: McpServerStatus }>;
  tools: McpToolSummary[];
  onCreate: (input: McpServerCreateRequest) => void;
  onConnect: (serverId: string) => void;
  onDisconnect: (serverId: string) => void;
  onDelete: (serverId: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<McpTransportKind>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [cwd, setCwd] = useState("");
  const [url, setUrl] = useState("");
  const [overrideTool, setOverrideTool] = useState("");
  const [overrideRisk, setOverrideRisk] = useState<RiskCategory>("shell");
  const [toolFilter, setToolFilter] = useState("");
  const safeServers = Array.isArray(servers) ? servers : [];
  const safeTools = Array.isArray(tools) ? tools : [];
  const visibleTools = safeTools.filter((tool) =>
    [tool.displayName, tool.name, tool.serverId, tool.riskCategory].filter(Boolean).join(" ").toLowerCase().includes(toolFilter.trim().toLowerCase())
  );
  const canSubmit = Boolean(label.trim() && (transport === "stdio" ? command.trim() : url.trim()));

  return (
    <section className="mcpPanel">
      <div className="panelHeader">
        <h2>MCP</h2>
        <small>{safeTools.length} tools</small>
      </div>

      <form
        className="memoryForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          const toolRiskOverrides = overrideTool.trim() ? { [overrideTool.trim()]: overrideRisk } : {};
          const base = {
            label: label.trim(),
            transport,
            args: parseArgs(argsText),
            env: {},
            enabled: true,
            toolRiskOverrides,
            ...(cwd.trim() ? { cwd: cwd.trim() } : {})
          };
          const input: McpServerCreateRequest =
            transport === "stdio"
              ? { ...base, transport, command: command.trim() }
              : { ...base, transport, url: url.trim() };
          onCreate(input);
          setLabel("");
          setCommand("");
          setArgsText("");
          setCwd("");
          setUrl("");
          setOverrideTool("");
        }}
      >
        <input aria-label="MCP server label" placeholder="Server label" value={label} onChange={(event) => setLabel(event.target.value)} />
        <select aria-label="MCP transport" value={transport} onChange={(event) => setTransport(event.target.value as McpTransportKind)}>
          <option value="stdio">stdio</option>
          <option value="streamable_http">streamable http</option>
        </select>
        {transport === "stdio" ? (
          <>
            <input aria-label="MCP command" placeholder="stdio command" value={command} onChange={(event) => setCommand(event.target.value)} />
            <input aria-label="MCP args" placeholder="args, e.g. server.mjs --flag" value={argsText} onChange={(event) => setArgsText(event.target.value)} />
            <input aria-label="MCP cwd" placeholder="cwd (optional)" value={cwd} onChange={(event) => setCwd(event.target.value)} />
          </>
        ) : (
          <input aria-label="MCP url" placeholder="https://host.example/mcp" value={url} onChange={(event) => setUrl(event.target.value)} />
        )}
        <div className="riskOverrideRow">
          <input
            aria-label="MCP risk override tool"
            placeholder="tool risk override (optional)"
            value={overrideTool}
            onChange={(event) => setOverrideTool(event.target.value)}
          />
          <select aria-label="MCP risk override category" value={overrideRisk} onChange={(event) => setOverrideRisk(event.target.value as RiskCategory)}>
            {riskCategories.map((risk) => (
              <option key={risk} value={risk}>
                {risk.replace("_", " ")}
              </option>
            ))}
          </select>
        </div>
        <button className="subtleButton" type="submit" disabled={!canSubmit}>
          Add server
        </button>
      </form>

      <section className="compactList">
        <h3>Servers</h3>
        {safeServers.length === 0 ? <p className="muted">No MCP servers</p> : null}
        {safeServers.map((server) => (
          <div className="compactRow mcpServerRow" key={server.id}>
            <span>{server.label ?? server.id}</span>
            <small>
              {formatTransport(server.transport)} · {server.status?.state ?? "disconnected"} · {server.status?.toolCount ?? 0} tools
            </small>
            {server.status?.lastError ? <small className="dangerText">{server.status.lastError}</small> : null}
            <div className="inlineActions">
              {server.status?.connected ? (
                <button className="textButton" type="button" onClick={() => onDisconnect(server.id)}>
                  Disconnect
                </button>
              ) : (
                <button className="textButton" type="button" onClick={() => onConnect(server.id)}>
                  Connect
                </button>
              )}
              <button className="textButton" type="button" onClick={() => onDelete(server.id)}>
                Delete
              </button>
            </div>
          </div>
        ))}
      </section>

      <section className="compactList">
        <div className="panelHeader">
          <h3>Tools</h3>
          <input
            aria-label="MCP tool filter"
            className="compactSearch"
            placeholder="filter"
            value={toolFilter}
            onChange={(event) => setToolFilter(event.target.value)}
          />
        </div>
        {safeTools.length === 0 ? <p className="muted">Connect a server to discover tools.</p> : null}
        {visibleTools.slice(0, 12).map((tool) => (
          <div className="compactRow" key={tool.id}>
            <span>{tool.displayName ?? tool.name ?? tool.id}</span>
            <small>
              {tool.serverId ?? "unknown server"} · {formatRisk(tool.riskCategory)}
            </small>
          </div>
        ))}
      </section>
    </section>
  );
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
