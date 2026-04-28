# Frontend API Handoff

This is the short handoff doc for the current `backend_new` frontend integration surface.

## Base addresses

- REST base: `http://127.0.0.1:3011`
- WebSocket base: `ws://127.0.0.1:3011/ws`
- SSE fallback: `GET /tasks/:id/events/stream`
- user preference profile: `GET /memory/profile`

## Required screens and endpoints

### Dashboard

- `GET /health`
- `GET /ready`
- `GET /tasks`
- `GET /queue/active`
- `GET /queue/dead-letters`

Recommended cards:

- service health
- readiness
- task counts by `lifecycleStatus`
- active queue size
- dead-letter count

### Tasks list

- `GET /tasks`

Render at least:

- `taskId`
- `title`
- `intent`
- `lifecycleStatus`
- `currentUnitId`
- `updatedAt`
- `queueState`
- `pendingApprovalCount`
- `lastError`

### Task detail

- `GET /tasks/:id`
- `GET /tasks/:id/commands`
- `GET /tasks/:id/operator-messages`
- `GET /tasks/:id/events?afterEventId=<lastSeen>`
- `WS /ws?taskId=<id>&replay=true&afterEventId=<lastSeen>`

Render at least these sections from `GET /tasks/:id`:

- `definition`
- `runtime`
- `projection`
- `queue`
- `conversations`
- `pendingApprovals`
- `toolInvocations`
- `events`
- `diagnostics`

Important runtime fields to surface:

- `runtime.memory.latestUserIntent`
- `runtime.memory.keyMilestones`
- `runtime.memory.importantDecisions`
- `runtime.memory.userPreferenceSnapshot`
- `runtime.interrupt.pauseRequested`
- `runtime.interrupt.interruptRequested`
- `runtime.interrupt.cancelRequested`
- `runtime.executionLease.phase`
- `runtime.safePoint.stage`
- `runtime.promptBudget.estimatedPromptCharacters`
- `runtime.promptBudget.estimatedBaselineCharacters`
- `runtime.promptBudget.estimatedReductionRatio`
- `runtime.promptBudget.cacheablePrefixChars`
- `runtime.promptBudget.retrievedContextCount`
- `runtime.promptBudget.policyFilteredOutputCount`
- `runtime.promptBudget.operatorInputCount`
- `runtime.contextCompressionCount`

### Operator actions

- `POST /tasks`
- `POST /tasks/:id/commands`
- `POST /tasks/:id/start`
- `POST /tasks/:id/continue`
- `POST /tasks/:id/pause`
- `POST /tasks/:id/resume`
- `POST /tasks/:id/restart`
- `POST /tasks/:id/approvals/resolve`

Preferred command bus body:

```json
{
  "type": "SEND_OPERATOR_MESSAGE",
  "userMessage": "Please stop after the current safe point.",
  "actor": "frontend-user",
  "reason": "operator request",
  "metadata": {}
}
```

Supported command types:

- `START_TASK`
- `CONTINUE_TASK`
- `PAUSE_TASK`
- `RESUME_TASK`
- `RESTART_TASK`
- `SEND_OPERATOR_MESSAGE`
- `RESOLVE_APPROVAL`
- `INTERRUPT_TASK`
- `CANCEL_TASK`

Compatibility lifecycle body:

```json
{
  "userMessage": "optional operator message"
}
```

Approval body:

```json
{
  "invocationId": "tool-call-id",
  "status": "APPROVED",
  "grantedBy": "frontend-user",
  "reason": "optional note",
  "metadata": {}
}
```

### Recommended frontend primitives

All pages can be composed from the same backend facts:

- `CommandComposer`: submit `POST /tasks/:id/commands`
- `EventTimeline`: render `events`
- `StateProjection`: render `runtime`, `projection`, `queue`
- `ApprovalPanel`: render `pendingApprovals`
- `OperatorMessages`: render `GET /tasks/:id/operator-messages`

Suggested page mapping:

- `Dashboard`: global health, readiness, task list, queue views
- `Tasks`: task list + task state projection
- `Discussion`: conversations + operator messages + event timeline
- `Configuration`: `GET /memory/profile`, health, readiness, provider/queue capability snapshots

## Task submit contract

`POST /tasks`

```json
{
  "taskId": "optional-custom-id",
  "title": "Summarize customer issue",
  "intent": "Review the uploaded issue and produce an action summary.",
  "preferredProviderId": "ollama-cloud",
  "metadata": {},
  "units": [
    {
      "id": "AGENT-001",
      "role": "Operator",
      "goal": "Review the uploaded issue and produce an action summary.",
      "outputContract": "{\"summary\":\"string\",\"details\":\"string\"}",
      "dependencies": []
    }
  ]
}
```

## Realtime contract

WebSocket query params:

- `taskId`
- `replay`
- `afterEventId`

Client subscribe message:

```json
{
  "type": "subscribe",
  "taskId": "task_123",
  "replay": true,
  "afterEventId": "evt_10"
}
```

Client command message:

```json
{
  "type": "command",
  "taskId": "task_123",
  "command": {
    "type": "PAUSE_TASK",
    "actor": "frontend-user",
    "reason": "Need to inspect current checkpoint."
  }
}
```

Server envelope kinds:

- `ready`
- `subscribed`
- `unsubscribed`
- `runtime_event`
- `heartbeat`
- `error`

New runtime event types now worth handling explicitly:

- `COMMAND_ACCEPTED`
- `COMMAND_APPLIED`
- `COMMAND_REJECTED`
- `OPERATOR_MESSAGE_QUEUED`
- `INTERRUPT_REQUESTED`
- `SAFE_POINT_REACHED`

## Error contract

All REST errors currently return:

```json
{
  "error": "Human readable message"
}
```

## Integration rules

- REST is the source of truth.
- WebSocket is incremental only.
- On reconnect, first try `afterEventId`; if state is uncertain, replay from `GET /tasks/:id/events`.
- `conversations` is the canonical user-visible history surface.
- Queue endpoints can be empty when queue mode is disabled; frontend should treat empty arrays as valid.

## Durable memory files

These are not required for the first frontend cut, but they now exist and are safe to read if needed:

- global user preference snapshot: `backend/data/user-preferences.json`
- per-task metadata snapshot: `backend/data/tasks/<taskId>.metadata.json`

The per-task metadata file mirrors the latest `memory` and `promptEfficiency` snapshot written by the runtime.
