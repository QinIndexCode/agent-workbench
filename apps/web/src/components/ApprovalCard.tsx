import { AlertTriangle, ShieldAlert } from "lucide-react";
import type { ApprovalDecision, ToolApproval } from "@agent-workbench/shared";

export function ApprovalCard({
  approval,
  language,
  onDecision
}: {
  approval: ToolApproval;
  language?: string | null;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const text = getApprovalCopy(language);
  const metadata = approval.metadata ?? {};
  const command = readMeta(metadata, "command") ?? String(approval.toolCall.args["command"] ?? "");
  const cwd = readMeta(metadata, "cwd") ?? String(approval.toolCall.args["cwd"] ?? "");
  const workRoot = readMeta(metadata, "workRoot");
  const resolvedCwd = readMeta(metadata, "resolvedCwd") ?? cwd;
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
          <small>{text.risks[approval.riskCategory] ?? approval.riskCategory.replace("_", " ")}</small>
          <h2>{displayName}</h2>
        </div>
      </div>
      <p>{approval.reason}</p>
      <dl className="approvalMeta">
        {serverId ? (
          <div>
            <dt>{text.server}</dt>
            <dd>{serverId}</dd>
          </div>
        ) : null}
        <div>
          <dt>{text.tool}</dt>
          <dd>{toolName}</dd>
        </div>
        {workRoot ? (
          <div>
            <dt>{text.folder}</dt>
            <dd title={workRoot}>{workRoot}</dd>
          </div>
        ) : null}
        {resolvedCwd ? (
          <div>
            <dt>{text.cwd}</dt>
            <dd title={resolvedCwd}>{resolvedCwd}</dd>
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
        <p className="dangerText">{text.destructiveGlobal}</p>
      ) : null}
      <div className="approvalActions">
        <button onClick={() => onDecision("allow_once")}>{text.allowOnce}</button>
        <button onClick={() => onDecision("allow_for_task")}>{text.allowTask}</button>
        <button className={isDestructive ? "dangerButton" : undefined} onClick={() => onDecision("allow_globally")}>
          {text.allowGlobal}
        </button>
        <button onClick={() => onDecision("deny")}>{text.deny}</button>
      </div>
    </section>
  );
}

function readMeta(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function getApprovalCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    server: zh ? "服务" : "Server",
    tool: zh ? "工具" : "Tool",
    folder: zh ? "工作文件夹" : "Work folder",
    cwd: zh ? "目录" : "CWD",
    destructiveGlobal: zh ? "全局允许后，该高风险类别后续不会再弹出审批。" : "Global approval will allow this destructive risk category without future prompts.",
    allowOnce: zh ? "允许一次" : "Allow once",
    allowTask: zh ? "本任务允许" : "Allow for this task",
    allowGlobal: zh ? "全局允许" : "Allow globally",
    deny: zh ? "拒绝" : "Deny",
    risks: {
      host_observation: zh ? "主机观察" : "Host observation",
      workspace_read: zh ? "读取文件" : "Read files",
      workspace_write: zh ? "修改文件" : "Change files",
      shell: zh ? "运行命令" : "Shell command",
      network: zh ? "网络访问" : "Network access",
      destructive: zh ? "高风险操作" : "Destructive action"
    } as Record<string, string>
  };
}
