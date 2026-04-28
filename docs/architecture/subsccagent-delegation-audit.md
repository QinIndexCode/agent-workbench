# SubSccAgent Delegation Audit

## Scope

This audit locks `SubSccAgent` v1 to a controlled delegated child-task model that extends the existing SCC-Batch task backbone without introducing a second orchestration system.

## Hard Constraints

- Delegation stays on the existing `task / unit / planner / query truth` path.
- Delegated work is represented as a normal task with `metadata.delegation`.
- Delegation depth is fixed to `1`.
- A delegated child task cannot delegate again.
- A parent task can have at most one active child at a time.
- Delegated child tasks do not appear in the top-level `Tasks / Dashboard / Queue` surfaces.
- Child tasks do not own final project delivery.
- Child tasks are restricted to workspace-only artifacts.
- Child tool scopes must remain inside the parent permission boundary; approval-gated child scopes are rejected instead of silently creating child approvals.
- Final delivery remains parent-owned and is surfaced on the parent result truth.

## Architectural Decisions

### No second lifecycle

Child work reuses the existing task definition, runtime state, lifecycle commands, query layer, and validated output flow. We do not add a parallel agent runtime or a separate child-task repository model.

### No recursive delegation

`delegate_subtask` is only exposed to eligible parent implement units. Child tasks carry `metadata.delegation.depth = 1`, and delegation tooling is filtered out for them at both prompt and execution boundaries.

### Query truth remains centralized

Delegation state is surfaced through shared read models:

- `delegationSummary`
- `primaryAction`
- `nextActionSummary`
- `completionSummary`
- `visibleToolActivities`

Web, Human CLI, and Agent CLI must all consume these shared truth surfaces instead of inferring delegation state independently.

### Parent owns final delivery

Child tasks may write artifacts inside their task workspace. They do not perform final project apply or delivery. Parent tasks remain responsible for final delivery decisions, artifact routing, and explicit user-facing delivery truth.

## Guardrails

- If adding delegation would require a second lifecycle, top-level child list, or child-owned delivery, the feature must be narrowed instead of broadening the architecture.
- v1 remains serial and conservative by design.
