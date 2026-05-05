import type { ApprovalDecision, ToolApproval } from "@scc/shared";

export function ApprovalCard({
  approval,
  onDecision
}: {
  approval: ToolApproval;
  onDecision: (decision: ApprovalDecision) => void;
}) {
  const command = String(approval.toolCall.args["command"] ?? JSON.stringify(approval.toolCall.args, null, 2));
  const isDestructive = approval.riskCategory === "destructive";

  return (
    <section className={isDestructive ? "approvalCard destructive" : "approvalCard"}>
      <div>
        <small>{approval.riskCategory.replace("_", " ")}</small>
        <h2>{approval.toolCall.toolName}</h2>
      </div>
      <p>{approval.reason}</p>
      {isDestructive ? <p className="dangerText">Global approval will allow this destructive risk category without future prompts.</p> : null}
      <pre>{command}</pre>
      <div className="approvalActions">
        <button onClick={() => onDecision("allow_once")}>Allow once</button>
        <button onClick={() => onDecision("allow_for_task")}>Allow for this task</button>
        <button onClick={() => onDecision("allow_globally")}>Allow globally</button>
        <button onClick={() => onDecision("deny")}>Deny</button>
      </div>
    </section>
  );
}
