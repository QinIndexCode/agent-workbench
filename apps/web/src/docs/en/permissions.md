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

## Risk classes

- **host_observation**: process lists, resource usage, and system-state reads
- **workspace_read**: file reads, directory listings, and code search
- **workspace_write**: creating or editing local files
- **shell**: shell commands
- **network**: outbound HTTP or API access
- **destructive**: delete, overwrite, process termination, and similar high-impact actions
