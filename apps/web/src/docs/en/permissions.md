# Permissions

The Permissions page defines the **real tool boundary** for Agent Workbench. It is not about answer style; it is about which actions may run, which actions must stop, and which actions should remain tightly gated.

## The five approval modes

### Ask

The safest default. Agent Workbench asks before a risky tool action runs.

### Read only

Automatically allows host observation and workspace reads, while writes, shell, network, and destructive actions still stop for approval.

### Full access

Globally allows every risk class, including destructive actions. Use it only when the task boundary is clear and the workspace is recoverable.

### Custom

Lets you tune risk classes individually between read-only and full access.

### Auto approval

Automatically approves only the selected **non-destructive** classes. Destructive actions still remain outside this rule-based coverage.

When **LLM auto approval (experimental)** is also enabled, the order is:

1. Agent Workbench first checks risk metadata and the selected Auto approval classes.
2. If the rule does not cover the request, and the tool is still non-destructive, it sends one short LLM review.
3. The LLM review can only allow or deny the tool call. It does not receive the normal task tool inventory and must not claim the tool already ran.
4. Destructive actions are never approved by the LLM path and always require explicit human confirmation.

LLM review spends extra tokens. Agent Workbench keeps the review instructions stable and only places the necessary task need, tool name, risk category, arguments, and small risk metadata into the dynamic payload so auto approval does not damage the main task's prompt-cache hit rate.

## Risk classes

- **host_observation**: process lists, resource usage, and system-state reads
- **workspace_read**: file reads, directory listings, and code search
- **workspace_write**: creating or editing local files
- **shell**: shell commands
- **network**: outbound HTTP or API access
- **destructive**: delete, overwrite, process termination, and similar high-impact actions

## MCP approval mode and LLM auto approval

- **MCP approval mode** affects MCP tools only; it does not rewrite the risk boundary for built-in tools.
- **LLM auto approval** is experimental and only runs after rule auto approval does not cover a non-destructive request. It is not Full access and does not bypass destructive approvals.
