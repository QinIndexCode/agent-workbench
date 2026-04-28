# Frontend Integration Guide

This guide describes how frontend clients should consume `backend_new`.

## Core rule

- REST is the fact source.
- WebSocket is the primary real-time transport.
- SSE is compatibility fallback only.

## Task list page

Recommended flow:

1. `GET /tasks`
2. Render `TaskSummaryResponse[]`
3. Use periodic refresh only as a safety net, not as the primary real-time source

Key fields for list rendering:

- `lifecycleStatus`
- `currentUnitId`
- `queueState`
- `pendingApprovalCount`
- `lastError`

## Task detail page

Recommended flow:

1. `GET /tasks/:id`
2. Render:
   - `definition`
   - `runtime`
   - `projection`
   - `queue`
   - `conversations`
   - `pendingApprovals`
   - `toolInvocations`
   - `events`
   - `diagnostics`
3. Open WebSocket subscription for incremental updates

## Event subscription and reconnect

Recommended pattern:

1. Store the latest `eventId`
2. Subscribe over WebSocket
3. On disconnect:
   - reconnect with `afterEventId`, or
   - call `GET /tasks/:id/events?afterEventId=<lastSeen>`
4. If WebSocket is unavailable, optionally use SSE fallback

## Approvals

Frontend approval UI should:

1. Read pending approvals from `GET /tasks/:id`
2. Resolve through `POST /tasks/:id/approvals/resolve`
3. Refresh detail state from REST or accept WebSocket updates

## Queue and diagnostics

Operational views should use:

| Endpoint | Purpose |
| --- | --- |
| `GET /queue/active` | Active queue snapshot |
| `GET /queue/dead-letters` | Dead-letter queue |
| `POST /queue/recover-expired` | Lease recovery |
| `POST /queue/dead-letters/:taskId/requeue` | Requeue dead-letter task |

Task diagnostics come from `GET /tasks/:id`:

- `diagnostics.lastError`
- `diagnostics.providerFailure`

## Compression and display rules

- Provider-facing context can be compressed internally.
- User-visible `conversations` are not compressed.
- Frontend must render `conversations` as the canonical history surface.

## Suggested UI model

| UI responsibility | Source |
| --- | --- |
| Initial page load | REST |
| Realtime updates | WebSocket |
| Reconnect compensation | REST events query |
| Legacy compatibility | SSE |
