# REST API Reference

This document is the consumer-facing REST contract for `backend_new`.

## General rules

| Rule | Value |
| --- | --- |
| Fact source | REST responses are the source of truth |
| Content type | `application/json` |
| Control-plane access | loopback-first browser workbench; non-loopback automation/integration access can use `Authorization: Bearer <BACKEND_NEW_CONTROL_API_TOKEN>` |
| Task events query | `GET /tasks/:id/events?afterEventId=<eventId>` |
| SSE fallback | `GET /tasks/:id/events/stream` |
| Error shape | `{ "error": "..." }` |

## Memory

### `GET /memory/profile`

Returns the durable user preference profile inferred from prior task execution.

## Platform action envelope

Platform write routes return a stable action envelope:

```json
{
  "resourceType": "CHANNEL",
  "resourceId": "channel_123",
  "action": "UPSERT",
  "commandId": "pcmd_123",
  "auditId": "paudit_123",
  "appliedAt": 1774420000000,
  "resource": {
    "channelId": "channel_123",
    "name": "Ops",
    "kind": "webhook"
  }
}
```

## Health and readiness

### `GET /health`

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `boolean` | Process is serving requests |
| `storageDriver` | `"file" \| "postgres"` | Active storage driver |
| `databaseHealthy` | `boolean \| null` | Database probe result |
| `queueEnabled` | `boolean` | Queue service configured |
| `workerEnabled` | `boolean` | Worker service configured |

Example:

```json
{
  "ok": true,
  "storageDriver": "postgres",
  "databaseHealthy": true,
  "queueEnabled": true,
  "workerEnabled": true
}
```

### `GET /ready`

| Field | Type | Meaning |
| --- | --- | --- |
| `ok` | `boolean` | Readiness result |
| `databaseReady` | `boolean \| null` | Database readiness |
| `queueReady` | `boolean \| null` | Queue readiness. `true` only when queue processing is enabled and a worker is enabled; `null` when queueing is disabled. |

## Tasks

### `POST /tasks`

Submit a task definition.

| Request field | Type | Meaning |
| --- | --- | --- |
| `taskId` | `string?` | Optional caller-supplied task id |
| `title` | `string` | Human title |
| `intent` | `string` | Task objective |
| `units` | `AgentUnit[]` | Contract-driven staged DAG definition |
| `preferredProviderId` | `string \| null` | Preferred provider |
| `metadata` | `object?` | Opaque task metadata |

Response: `TaskActionResponse`

### `GET /tasks`

Returns `TaskSummaryResponse[]`.

| Response field | Type | Meaning |
| --- | --- | --- |
| `taskId` | `string` | Task id |
| `title` | `string` | Title |
| `intent` | `string` | Intent |
| `lifecycleStatus` | `string` | Current lifecycle status |
| `currentUnitId` | `string \| null` | Active unit |
| `updatedAt` | `number` | Last update time |
| `queueState` | `string \| null` | Queue state snapshot |
| `pendingApprovalCount` | `number` | Open approval count |
| `lastError` | `string \| null` | Last error summary |

### `GET /tasks/:id`

Returns `TaskQueryResponse`.

Important sections:

| Section | Meaning |
| --- | --- |
| `definition` | Submitted task definition |
| `runtime` | Current runtime state plus planner/batch/consolidation/context diagnostics |
| `projection` | Query-optimized projection |
| `queue` | Queue item snapshot |
| `conversations` | Full user-visible conversation |
| `commands` | Persisted operator command history |
| `operatorMessages` | Persisted queued and consumed operator messages |
| `interrupts` | Interrupt request records |
| `pendingApprovals` | Latest pending approvals |
| `toolInvocations` | Recorded tool invocations |
| `events` | Runtime event history |
| `diagnostics` | Explainability helpers such as last error and provider failure |

`runtime` is the primary diagnostics authority. High-value fields include:

| `runtime` field | Meaning |
| --- | --- |
| `planner.planVersion` | Active execution-plan version |
| `planner.executionPhase` | Planner/batch/consolidation execution phase |
| `planner.currentStageIndex` | Active planner stage index |
| `planner.providerBatchCount` | Provider batch count for the current plan |
| `planner.providerBatchHints` | Provider-batch hint summaries |
| `planner.batchGroupingHints` | Planner grouping hints by stage |
| `planner.blockingReason` | Stable planner/batch/consolidation blocking reason |
| `planner.fallbackReasons` | Explicit fallback reasons when planner path downgrades |
| `activeStage` | Active stage summary with unit ids and batch hint |
| `pendingToolBatches` | Pending and executed tool-batch summaries |
| `consolidationState` | Consolidation status, last result, and issue codes |
| `compressionPolicy` | Active context-compression mode and preservation reasons |
| `compressionDowngraded` | Whether guardrails forced conservative compression |
| `batchAdmissionDecisions` | Batch admission and rejection summaries |
| `unsafeBatchRejectedCount` | Count of rejected unsafe batches |
| `promptSectionAttribution` | Prompt section size attribution |
| `stageMemorySummary` | Stage memory virtualization summary |
| `capabilitySelectionSummary` | Stage capability selection summary |
| `retrievalSelectionSummary` | Retrieval relevance and filtering summary |
| `contractDiagnostics` | Topology, contract, memory selector, and exit-condition diagnostics |
| `lastError` | Runtime-level last error summary |

### `GET /tasks/:id/commands`

Returns the persisted operator command history for this task.

### `GET /tasks/:id/operator-messages`

Returns the persisted operator message history for this task, including queued and consumed states.

### Task diagnostics routes

| Route | Meaning |
| --- | --- |
| `GET /tasks/:id/discussion` | User-visible conversation plus operator messages |
| `GET /tasks/:id/tooling` | Latest approvals and tool invocations |
| `GET /tasks/:id/traces` | Runtime trace envelopes |
| `GET /tasks/:id/debug` | Composite runtime/projection/metadata debug payload |
| `GET /tasks/:id/recent-analysis` | Recent event analysis view |
| `GET /tasks/diagnostics` | Aggregate task diagnostics summary |
| `GET /tasks/recoverable` | Tasks currently recoverable by operator action |

### `GET /tasks/:id/events`

Returns `TaskEventsQueryResponse`.

Query:

| Query | Meaning |
| --- | --- |
| `afterEventId` | Replay cursor; only events after this id are returned |

### `GET /tasks/:id/events/stream`

SSE fallback stream. This is a compatibility transport, not the primary real-time protocol.

Each event uses:

```text
id: <eventId>
event: <eventType>
data: <RuntimeEventRecord JSON>
```

## Task lifecycle actions

All lifecycle actions return `TaskActionResponse`.

| Route | Method | Purpose |
| --- | --- | --- |
| `/tasks/:id/start` | `POST` | Start a submitted task |
| `/tasks/:id/continue` | `POST` | Continue a paused or waiting task |
| `/tasks/:id/pause` | `POST` | Pause execution |
| `/tasks/:id/resume` | `POST` | Resume execution |
| `/tasks/:id/restart` | `POST` | Reset runtime and restart |

Optional request body:

```json
{
  "userMessage": "optional operator message"
}
```

## Command bus

### `POST /tasks/:id/commands`

Submit a task-level operator command. This is the preferred integration surface for new clients.

| Request field | Type | Meaning |
| --- | --- | --- |
| `type` | command enum | Command to apply |
| `message` | `string \| null` | Optional operator message payload |
| `actor` | `string \| null` | Operator identity |
| `reason` | `string \| null` | Human reason |
| `metadata` | `object?` | Opaque extra metadata |
| `invocationId` | `string \| null` | Approval target when resolving approval |
| `approvalStatus` | approval status \| `null` | Approval resolution value for `RESOLVE_APPROVAL` |

Supported command values:

- `START_TASK`
- `CONTINUE_TASK`
- `PAUSE_TASK`
- `RESUME_TASK`
- `RESTART_TASK`
- `SEND_OPERATOR_MESSAGE`
- `RESOLVE_APPROVAL`
- `INTERRUPT_TASK`
- `CANCEL_TASK`

Response: `TaskActionResponse`

Notes:

- `RESOLVE_APPROVAL` reads `invocationId` and `approvalStatus` from the command body.
- Approval actor identity for the dedicated approval route uses `POST /tasks/:id/approvals/resolve` and `grantedBy`; the command bus does not read `grantedBy`.

## Approvals

### `POST /tasks/:id/approvals/resolve`

Resolve a tool approval.

| Request field | Type | Meaning |
| --- | --- | --- |
| `invocationId` | `string` | Tool invocation id |
| `status` | `"APPROVED" \| "REJECTED" \| "EXPIRED"` | Approval resolution |
| `grantedBy` | `string \| null` | Operator identity |
| `reason` | `string \| null` | Human explanation |
| `metadata` | `object?` | Extra metadata |

## Queue operations

### `GET /queue/active`

Returns `QueueActiveResponse`.

### `GET /queue/dead-letters`

Returns `QueueDeadLetterResponse`.

### `POST /queue/recover-expired`

Returns `QueueRecoverExpiredResponse`.

Example:

```json
{
  "recovered": 1
}
```

### `POST /queue/dead-letters/:taskId/requeue`

Returns `QueueRequeueResponse`.

Example:

```json
{
  "ok": true
}
```

## Platform surfaces

### Capability hub and workspace workflow

| Route | Method | Meaning |
| --- | --- | --- |
| `/capabilities` | `GET` | Unified capability hub view across providers, MCP, skills, and workspace workflow |
| `/workspace/workflow` | `GET` | Current workspace workflow snapshot |
| `/workspace/workflow/init` | `POST` | Initialize `.scc` workflow scaffolding for the current workspace |
| `/workspace/workflow/docs/import` | `POST` | Import workspace docs into memory |

### Providers

| Route | Method | Meaning |
| --- | --- | --- |
| `/providers` | `GET` | List provider views |
| `/providers/:id` | `GET` | Get provider view |
| `/providers/:id` | `PUT` | Upsert provider profile |
| `/providers/:id` | `DELETE` | Delete provider profile |
| `/providers/:id/test` | `POST` | Run provider connectivity smoke test |
| `/providers/:id/default` | `POST` | Set default provider |
| `/providers/secrets` | `GET` | List provider secret summaries |
| `/providers/secrets` | `POST` | Create or update a provider secret |

### Config

| Route | Method | Meaning |
| --- | --- | --- |
| `/config` | `GET` | Read current config state and active snapshot |
| `/config` | `PATCH` | Partial config update |
| `/config/reload` | `POST` | Reload active config snapshot |
| `/config/health` | `GET` | Detailed configuration health |

`GET /config`, `PATCH /config`, and `POST /config/reload` expose these state fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `activeSnapshotVersion` | `string \| null` | Active config snapshot version |
| `reloadApplied` | `boolean` | Whether the current in-memory runtime reflects the active snapshot |
| `restartRequired` | `boolean` | Whether the latest config change requires restart instead of safe hot reload |

### Skills

| Route | Method | Meaning |
| --- | --- | --- |
| `/skills` | `GET` | List skills and runtime capability registration state |
| `/skills/:id` | `GET` | Get an individual skill view |
| `/skills/:id/status` | `GET` | Get an individual skill status view |
| `/skills/refresh` | `POST` | Refresh skill placeholders from configured roots |
| `/skills/import` | `POST` | Import/register a skill placeholder |
| `/skills/import-marketplace` | `POST` | Import Claude/OpenCode-style marketplace skill bundles into the SCC registry |

### MCP

| Route | Method | Meaning |
| --- | --- | --- |
| `/mcp` | `GET` | List MCP server views |
| `/mcp/:id` | `GET` | Get MCP server view |
| `/mcp/:id` | `PUT` | Upsert MCP server definition |
| `/mcp/:id` | `DELETE` | Delete MCP server definition |
| `/mcp/:id/test` | `POST` | Run MCP connectivity and capability smoke test |

### Channels

| Route | Method | Meaning |
| --- | --- | --- |
| `/channels` | `GET` | List channels |
| `/channels` | `POST` | Create channel |
| `/channels/:id` | `GET` | Get channel |
| `/channels/:id` | `PUT` | Update channel |
| `/channels/:id` | `DELETE` | Delete channel |
| `/channels/:id/test` | `POST` | Run channel connectivity/config test |

### Schedules

| Route | Method | Meaning |
| --- | --- | --- |
| `/schedules` | `GET` | List schedules |
| `/schedules` | `POST` | Create schedule |
| `/schedules/:id` | `GET` | Get schedule |
| `/schedules/:id` | `PUT` | Update schedule |
| `/schedules/:id` | `DELETE` | Delete schedule |
| `/schedules/:id/pause` | `POST` | Pause schedule |
| `/schedules/:id/resume` | `POST` | Resume schedule |

### Memories

| Route | Method | Meaning |
| --- | --- | --- |
| `/memories` | `GET` | List/search platform memories. Query `q` is optional |
| `/memories` | `POST` | Create memory entry |
| `/memories/:id` | `GET` | Get memory entry |
| `/memories/:id` | `PUT` | Update memory entry |
| `/memories/:id` | `DELETE` | Delete memory entry |

### Statistics and system

| Route | Method | Meaning |
| --- | --- | --- |
| `/statistics` | `GET` | Aggregate platform statistics |
| `/statistics/metrics` | `GET` | Runtime metrics summary |
| `/system/startup` | `GET` | System startup view |
| `/system/metrics` | `GET` | System metrics summary |

### Platform audit

| Route | Method | Meaning |
| --- | --- | --- |
| `/platform/audit/:resourceType/:resourceId` | `GET` | Append-only command and audit trail for a platform resource |

Response: `PlatformAuditTrailResponse`

## Error semantics

| Status | Meaning |
| --- | --- |
| `400` | Invalid request |
| `404` | Route not found or SSE disabled |
| `500` | Unhandled server error |

The wire error shape remains:

```json
{
  "error": "Human readable message"
}
```
