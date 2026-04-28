# Architecture Compliance Report

This report is the Phase 1 architecture checkpoint for the active runtime line against:

- `10-architecture-principles.md`
- `26-capability-matrix.md`
- `27-architecture-invariants.md`

## Gate Result

Current status: **passing with targeted hardening still required**

Verified on April 1, 2026 by:

- `npm run typecheck`
- `node --test backend/tests/docs-consistency.test.cjs`
- `npm run build`

## Compliance Matrix

| Invariant | Expected source of truth | Current evidence | Status |
| --- | --- | --- | --- |
| Composition root remains facade-only | `foundation/bootstrap`, `application/create-runtime.ts` | `docs-consistency.test.cjs` asserts `create-runtime` does not absorb turn orchestration | Pass |
| Grouped runtime facades remain authoritative | `runtime.tasks`, `runtime.platform`, `runtime.analysis`, `runtime.extensions`, `runtime.worker` | current `create-runtime.ts` composes grouped services instead of exporting raw action soup | Pass |
| Layer boundaries remain explicit | `foundation -> domain -> application -> interfaces` | source tree and runtime tests still follow split ownership across contracts, prompt, orchestration, and transports | Pass |
| Public interfaces consume public facts only | REST, WebSocket, CLI, frontend | `cli-interface`, `task-runtime-and-http`, and current frontend API integration all route through runtime services | Pass |
| Config/platform authority stays singular | config snapshots, provider registry, platform mutation recorder | append-only config/platform writes remain behind platform services and persistence adapters | Pass |
| Diagnostics stay transport-aligned | backend query/debug, CLI envelopes, frontend task facts | workflow and benchmark summaries surface the same execution summary / context-gating model | Pass |

## Confirmed Compliant Areas

- composition root remains in `backend/src/foundation/bootstrap` and `backend/src/application/create-runtime.ts`
- domain continues to own contract parsing, prompt budgeting, context selection, validation, and state transitions
- application continues to own task lifecycle, command dispatch, turn orchestration, worker control, and persistence coordination
- interfaces remain transport adapters for HTTP, CLI, and WebSocket
- runtime diagnostics stay aligned across `getTaskDebug`, workflow scenarios, breadth scenarios, and benchmark output

## Violations Cleared During This Phase

- breadth-task validation was added as a first-class benchmark surface instead of living as ad hoc manual checks
- frontend operator validation now has a reproducible browser smoke runner instead of informal manual inspection only
- root workspace testing now includes a defined frontend `test` script so the repo-level test contract is no longer partial

## Remaining Risk Areas

- provider retry/timeout/failure policy is still functional rather than fully production-hardened
- Postgres integration remains environment-gated, so database-backed evidence is not always-on in local CI
- recovery and queue churn should still be stressed harder under repeated restarts and failure storms

## Enforcement Mechanisms

- `backend/tests/docs-consistency.test.cjs`
- `backend/tests/runtime-integration.test.cjs`
- `backend/tests/task-runtime-and-http.test.cjs`
- `backend/tests/workflow-scenarios.test.cjs`
- `backend/tests/runtime-benchmark.test.cjs`
- `backend/tests/breadth-scenarios.test.cjs`

## Next Compliance Actions

1. Keep new engine work inside the existing layer split.
2. Use breadth/workflow/benchmark evidence before changing execution strategy.
3. Promote database-backed and provider-stress evidence from optional to routine where feasible.
