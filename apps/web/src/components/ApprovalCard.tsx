import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { ApprovalDecision, ToolApproval } from "@scc/shared";

export function ApprovalCard({
  approval,
  onDecision
}: {
  approval: ToolApproval;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const metadata = approval.metadata ?? {};
  const command = readMeta(metadata, "command") ?? String(approval.toolCall.args["command"] ?? "");
  const cwd = readMeta(metadata, "cwd") ?? String(approval.toolCall.args["cwd"] ?? "");
  const serverId = readMeta(metadata, "serverId");
  const toolName = readMeta(metadata, "toolName") ?? approval.toolCall.toolName;
  const displayName = readMeta(metadata, "displayName") ?? toolName;
  const argsPreview = readMeta(metadata, "argsPreview") ?? JSON.stringify(approval.toolCall.args, null, 2);
  const isDestructive = approval.riskCategory === "destructive";
  const Icon = isDestructive ? AlertTriangle : ShieldAlert;

  return (
    <section className={isDestructive ? "approvalCard destructive" : "approvalCard"}>
      <div className="approvalHeader">
        <span className={isDestructive ? "approvalIcon destructive" : "approvalIcon"}>
          <Icon aria-hidden="true" size={18} strokeWidth={2.2} />
        </span>
        <div className="approvalTitle">
          <small>{approval.riskCategory.replace("_", " ")}</small>
          <h2>{displayName}</h2>
        </div>
      </div>
      <p>{approval.reason}</p>
      <dl className="approvalMeta">
        {serverId ? (
          <div>
            <dt>Server</dt>
            <dd>{serverId}</dd>
          </div>
        ) : null}
        <div>
          <dt>Tool</dt>
          <dd>{toolName}</dd>
        </div>
        {cwd ? (
          <div>
            <dt>CWD</dt>
            <dd>{cwd}</dd>
          </div>
        ) : null}
      </dl>
      {command ? (
        <pre className="argsPreview" aria-label="Command preview">
          {command}
        </pre>
      ) : (
        <pre className="argsPreview" aria-label="Arguments preview">
          {argsPreview}
        </pre>
      )}
      {isDestructive ? (
        <p className="dangerText">Global approval will allow this destructive risk category without future prompts.</p>
      ) : null}
      <div className="approvalActions">
        <button onClick={() => onDecision("allow_once")}>Allow once</button>
        <button onClick={() => onDecision("allow_for_task")}>Allow for this task</button>
        <button className={isDestructive ? "dangerButton" : undefined} onClick={() => onDecision("allow_globally")}>
          Allow globally
        </button>
        <button onClick={() => onDecision("deny")}>Deny</button>
      </div>
    </section>
  );
}

function readMeta(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}
