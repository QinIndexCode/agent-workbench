# WebSocket Protocol Reference

WebSocket is the primary real-time transport for `backend_new`.

## Connection

Default path:

```text
/ws
```

Supported query parameters:

| Query | Type | Meaning |
| --- | --- | --- |
| `taskId` | `string?` | Optional task to auto-subscribe |
| `replay` | `boolean?` | Defaults to `true` |
| `afterEventId` | `string?` | Replay cursor |

Example:

```text
ws://127.0.0.1:3011/ws?taskId=task_123&replay=true&afterEventId=evt_10
```

## Client messages

### `subscribe`

```json
{
  "type": "subscribe",
  "taskId": "task_123",
  "replay": true,
  "afterEventId": "evt_10"
}
```

### `unsubscribe`

```json
{
  "type": "unsubscribe",
  "taskId": "task_123"
}
```

### `ping`

```json
{
  "type": "ping",
  "timestamp": 1710000000000
}
```

## Server envelopes

The server uses a single `RuntimeWebSocketEnvelope` contract.

| `kind` | Meaning |
| --- | --- |
| `ready` | Connection is ready |
| `subscribed` | Task subscription established |
| `unsubscribed` | Task subscription removed |
| `runtime_event` | Runtime event delivered |
| `heartbeat` | Connection heartbeat |
| `error` | Structured protocol error |

### `ready`

```json
{
  "kind": "ready",
  "timestamp": 1710000000000
}
```

### `subscribed`

```json
{
  "kind": "subscribed",
  "taskId": "task_123",
  "latestEventId": "evt_10"
}
```

### `runtime_event`

```json
{
  "kind": "runtime_event",
  "taskId": "task_123",
  "event": "TASK_CANCELLED",
  "data": {
    "eventId": "evt_11",
    "taskId": "task_123",
    "type": "TASK_CANCELLED"
  }
}
```

### `heartbeat`

```json
{
  "kind": "heartbeat",
  "timestamp": 1710000000000
}
```

### `error`

```json
{
  "kind": "error",
  "code": "missing_task_id",
  "error": "taskId is required."
}
```

## Error codes

| Code | Meaning |
| --- | --- |
| `missing_task_id` | Task id missing or empty |
| `invalid_payload` | Invalid JSON payload |
| `unsupported_message_type` | Unknown message type |
| `subscribe_failed` | Subscription setup failed |

## Replay and reconnect

- WebSocket is for low-latency updates, not the sole source of truth.
- Runtime detail, planner diagnostics, batch state, and prompt explainability remain REST facts.
- `afterEventId` is the replay cursor.
- On reconnect:
  1. Reconnect with `afterEventId`, or
  2. Read `/tasks/:id/events?afterEventId=<lastSeen>` via REST
- Initial page state should come from REST.
- WebSocket only adds incremental updates on top of that fact surface.

## Compensation strategy

Recommended client pattern:

1. `GET /tasks/:id`
2. Open WebSocket
3. `subscribe` with `afterEventId`
4. On disconnect, reconnect with last event id
5. If replay is uncertain, use REST events query as compensation
