# Capability Matrix

This document captures the current `backend_new` convergence state against:

1. legacy platform capabilities
2. current `backend_new` final state after the March 25 convergence pass
3. `DigDeeper.md` target-engine ambitions

It is intentionally explicit about scope boundaries. `backend_new` is now the production mainline and the SCC-Batch terminal execution core is implemented. `DigDeeper` now remains primarily as the philosophy and optimization direction for further call-compression tuning, not as a separate execution-model roadmap.

The structural guardrails that keep this convergence from drifting are maintained in [27-architecture-invariants.md](./27-architecture-invariants.md).

## Delivery line

Current completion bar:

- `backend_new` is the only active backend line
- task runtime, command bus, interrupt/safe-point control, approval flow, queue, and runtime diagnostics are production-usable
- legacy platform resource surfaces are now exposed through stable REST and CLI interfaces:
  - providers
  - config
  - skills
  - channels
  - schedules
  - memories
  - statistics
  - system

## Matrix

| Legacy capability | `backend_new` current/final state | `DigDeeper` target state |
| --- | --- | --- |
| Task submit/list/detail | Implemented | Implemented |
| Task lifecycle actions | Implemented, plus command bus compatibility | Implemented |
| Operator messages during task execution | Implemented with pending operator input queue and planner-aware diagnostics | Implemented |
| Pause / resume / interrupt / cancel | Implemented with safe-point semantics and planner/batch-aware diagnostics | Implemented |
| Approval resolution | Implemented | Implemented |
| Task discussion/history view | Implemented through `/tasks/:id/discussion` | Implemented |
| Task tooling/traces/debug/recent-analysis | Implemented through dedicated diagnostics routes with planner/batch/consolidation traceability | Implemented |
| Recoverable task listing | Implemented | Implemented |
| Queue diagnostics and recovery | Implemented | Implemented |
| Provider list/get/update/delete | Implemented | Implemented |
| Provider default selection | Implemented | Implemented |
| Provider secret management | Implemented via secure secret repository with repository-backed summary listing | Implemented |
| Provider connectivity test | Implemented as client smoke completion | Implemented |
| Config read/update/reload/health | Implemented | Implemented |
| Skill list/refresh/import/invoke | Implemented | Implemented |
| Channels CRUD/test | Implemented | Implemented |
| Schedules CRUD/pause/resume | Implemented | Implemented |
| Memories CRUD/search | Implemented as platform memory resources distinct from runtime memory | Implemented |
| Statistics / system overview | Implemented as read-only views | Implemented |
| CLI operations surface | Implemented with modular command registry, workspace-first `chat`, task-centric `tasks chat`, and REST/WS-only behavior | Implemented |
| Strong unit contract fields (`taskScope`, `inputContract`, `exitCondition`, `permissionLevel`) | Implemented in runtime types, preflight validation, and prompt/runtime enforcement | Implemented |
| Dependency-aware context filtering | Implemented through explicit topology + permission-aware context selection, including structured `inputContract` field narrowing | Implemented |
| Structured memory selector | Implemented for scoped runtime memory selection by unit, kind, and global inclusion flag | Implemented |
| Explicit topology graph and preflight DAG validation | Implemented for contract-driven staged DAG runtime | Implemented |
| Planner-ready stage metadata | Implemented and consumed by planner turn diagnostics and stage-aware runtime execution | Implemented |
| Explicit `ExecutionPlan` and planner diagnostics summary | Implemented with planner turn, provider-batch summary, execution phase diagnostics, stage gating, and multi-unit stage execution | Implemented |
| Exit-condition-driven completion acceptance | Implemented for structured, machine-checkable rules | Implemented |
| Layered runtime memory and prompt budget telemetry | Implemented | Implemented |
| Planner turn / batched tool execution / consolidation turn | Implemented as the primary planner-aware stage execution path, including multi-unit stages | Implemented |
| Batch-aware semantic validator across planner batches | Implemented through stage semantic validation and consolidation-only acceptance | Implemented |
| 1-3 model calls for fixed complex graph benchmark | Implemented with fixed benchmark harness (`3` calls on planner path vs `12` on single-active baseline) | Implemented |
| Hard benchmark for calls / tokens / latency / fallback rate | Implemented through fixed synthetic benchmark plus realistic complex-DAG validation suite | Implemented |

## What is now considered complete

- Backend structure is split by layer and resource domain instead of growing more monolithic.
- HTTP routing is modularized under route modules.
- CLI is modularized into command modules and still only consumes public REST/WS surfaces.
- CLI now exposes both workspace-first interactive chat and task-centric agent-compatible chat without introducing backend session facts.
- Frontend operator workspace now consumes the same planner/batch/consolidation/compression diagnostics contract as REST task detail and CLI diagnostics views.
- File and Postgres storage both cover the newly introduced platform resource types:
  - channels
  - schedules
  - memories
- File and Postgres now both act as runtime-detail parity surfaces:
  - task detail query
  - runtime diagnostics shape
  - event replay
  - queue recovery semantics
- Platform resource writes now have independent append-only command and audit logs:
  - channels
  - schedules
  - memories
  - provider/config mutations
- Operator command, operator message, interrupt, queue, approval, conversation, projection, event, and runtime chains stay append-only / replay-friendly.
- Unit contracts are normalized before runtime use, and task topology is validated before runtime state is created.
- Context policy is split from prompt rendering, so selection rules live in `domain` and `prompt-builder` stays render-only.
- Runtime diagnostics now expose memory selector scope, topology stage metadata, and exit-condition failure category.
- Runtime diagnostics now also expose planner summary fields:
  - `planVersion`
  - `executionPhase`
  - `currentStageIndex`
  - `readyStageUnitIds`
  - `providerBatchCount`
  - `providerBatchHints`
  - `batchGroupingHints`
  - `blockingReason`
- Runtime execution now emits planner/batch/consolidation lifecycle events:
  - `PLAN_CREATED`
  - `PLAN_VALIDATED`
  - `TOOL_BATCH_PLANNED`
  - `TOOL_BATCH_EXECUTED`
  - `CONSOLIDATION_STARTED`
  - `CONSOLIDATION_COMPLETED`
- Compatibility fallback is now downgraded to an explicit diagnostic path, with contract source and fallback usage visible through runtime contract diagnostics.
- `task-turn-runner` no longer owns prompt build, provider call, and persistence details directly; those are split into focused application modules.
- Planner-first convergence is now implemented through `ExecutionPlan`, `TaskPlannerService`, planner turn orchestration, provider batching, batch execution, consolidation, and stage semantic validation, with multi-unit stage execution on the planner path and legacy single-active runtime retained only as internal fallback.
- Fixed benchmark harness now measures:
  - API call count
  - prompt and completion token usage
  - end-to-end latency
  - stage count
  - batch count
  - fallback count
- Realistic benchmark suite now additionally validates:
  - approval-blocked tool batches
  - consolidation correction loops
  - planner fallback diagnostics
  - compatibility fallback visibility
  - conservative compression downgrade visibility
  - unsafe batch rejection visibility
  - correction loop rate and planner fallback rate
- Provider-facing context now exposes prompt explainers instead of silent omission:
  - `promptSectionAttribution`
  - `stageMemorySummary`
  - `capabilitySelectionSummary`
  - `retrievalSelectionSummary`
  - explicit section-level “raw / compact summary / omitted from provider-facing context” behavior

- Operator-facing diagnostics are aligned across REST task detail, CLI diagnostics views, and the frontend task workspace.

## What remains optimization, not missing implementation

These are intentionally **not** blocked for current production use:

- further call-compression tuning beyond the synthetic plus realistic benchmark suite

Those are optimization work, not execution-model gaps in the current convergence bar.
