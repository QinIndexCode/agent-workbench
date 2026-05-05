import { useState } from "react";
import type { McpServerConfig, McpServerCreateRequest, McpServerStatus, McpToolSummary } from "@scc/shared";

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
  const [command, setCommand] = useState("");

  return (
    <section className="mcpPanel">
      <div className="panelHeader">
        <h2>MCP</h2>
        <small>{tools.length} tools</small>
      </div>

      <form
        className="memoryForm"
        onSubmit={(event) => {
          event.preventDefault();
          if (!label.trim() || !command.trim()) return;
          onCreate({ label: label.trim(), transport: "stdio", command: command.trim(), args: [], env: {}, enabled: true, toolRiskOverrides: {} });
          setLabel("");
          setCommand("");
        }}
      >
        <input aria-label="MCP server label" placeholder="Server label" value={label} onChange={(event) => setLabel(event.target.value)} />
        <input aria-label="MCP command" placeholder="stdio command" value={command} onChange={(event) => setCommand(event.target.value)} />
        <button className="subtleButton" type="submit">
          Add server
        </button>
      </form>

      <section className="compactList">
        <h3>Servers</h3>
        {servers.length === 0 ? <p className="muted">No MCP servers</p> : null}
        {servers.map((server) => (
          <div className="compactRow mcpServerRow" key={server.id}>
            <span>{server.label}</span>
            <small>
              {server.status.state} · {server.status.toolCount} tools
            </small>
            {server.status.lastError ? <small className="dangerText">{server.status.lastError}</small> : null}
            <div className="inlineActions">
              {server.status.connected ? (
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
        <h3>Tools</h3>
        {tools.length === 0 ? <p className="muted">Connect a server to discover tools.</p> : null}
        {tools.slice(0, 10).map((tool) => (
          <div className="compactRow" key={tool.id}>
            <span>{tool.displayName}</span>
            <small>
              {tool.serverId} · {tool.riskCategory.replace("_", " ")}
            </small>
          </div>
        ))}
      </section>
    </section>
  );
}
