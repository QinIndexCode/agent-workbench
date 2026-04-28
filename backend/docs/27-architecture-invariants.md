# Architecture Invariants

This document lists the hard invariants for the current `backend_new` mainline. It is not a roadmap document.

## Grouped Facade

`BackendNewRuntime` exposes grouped facade surfaces only:

- `runtime.tasks`
- `runtime.platform`
- `runtime.analysis`
- `runtime.extensions`
- `runtime.worker`

Top-level action passthrough methods must not be reintroduced. Internal application services, repositories, registries, and event hubs must not be public runtime fields.

## Config Authority

- Config facts are owned by config snapshots plus controlled reload semantics.
- `defaultProviderId` belongs to config authority, not provider-side side effects.
- Services must not mutate the active config object to pretend a restart-only change has already applied.

## Platform Command And Audit

Platform writes must follow an append-only fact model:

1. validate input
2. record platform command
3. apply current-state projection
4. record applied or rejected platform audit

Current-state platform repositories are projections, not the root fact source.

## Skill Reconcile

- Skill authority comes from configured roots plus the persisted import manifest.
- Refresh is a reconcile operation, not an append-only in-memory register.
- The runtime extension registry is a projection, not the authority source.

## Interface Boundary

- HTTP, WebSocket, and CLI consume grouped runtime surfaces and documented public facts only. Interactive CLI flows such as `tasks chat` and workspace-first `chat` are still transport adapters, not alternate runtime entry points.
- Frontend operator views also consume documented public REST and WebSocket facts only. They must not become a parallel runtime contract or infer task truth from transport-specific event payload quirks.
- Interface adapters must not reach into internal application objects or foundation repositories.
- workspace chat state remains CLI-local. Backend runtime, application, and domain layers must not grow a persistent workspace session fact model for terminal UX.
- CLI TUI behaviors such as pane focus, recent-task navigation, approval selection, and raw drill-down remain `interfaces/cli` concerns only; they must never become backend facts.
- Runtime diagnostics must stay semantically aligned across REST task detail, CLI diagnostics, and frontend operator views.

## Contract And Topology Boundary

- `UnitContract`, topology construction, and preflight DAG validation belong to `domain`.
- `ExecutionPlan` construction and planner validation belong to `domain`.
- planner turn rule construction belongs to `domain/planning`; `application/tasks` may only orchestrate and persist the result.
- `TaskPlannerService` belongs to `application/tasks` and may orchestrate planner calls, but must not redefine planner rules inline.
- structured `inputContract` interpretation and field-level narrowing belong to `domain`, not interface or application glue.
- memory selector interpretation belongs to `domain`, not interface or application glue.
- context policy belongs to `domain/runtime/context-policy.ts`; `context-selection.ts` is only a thin adapter.
- context compression policy belongs to `domain/runtime/context-compression-policy.ts`; prompt builders may render the result, but must not decide compression policy.
- stage memory virtualization and stage relevance filtering belong to `domain/runtime`; prompt builders may render the result, but must not invent or suppress selection rules inline.
- stage semantic validation belongs to `domain/validation`; consolidation may consume it, but must not re-implement it inline.
- batch admission policy belongs to `domain/validation` or `domain/planning`; tool batch executors may consume it, but must not redefine risk rules inline.
- `application/tasks` may invoke those models, but must not redefine contract semantics inline.
- `task-turn-runner` may consume acceptance results, but must not become the primary contract or topology rule engine.
- `task-turn-runner` must remain orchestration glue only. Context assembly, provider execution, and persistence belong in focused helper modules.
- command dispatch belongs in focused `application/tasks/commands` handlers instead of one giant executor file.
- lifecycle entrypoints belong in `application/tasks/lifecycle`.
- planner orchestration belongs in `application/tasks/planning`.
- tool orchestration belongs in `application/tasks/tools`.
- runtime control and operator control belong in `application/tasks/control`.
- turn persistence belongs in focused `application/tasks/persistence` helpers instead of one giant persistence file.
- turn phase helpers belong in `application/tasks/turns` instead of a flat directory spill.
- `application/tasks/index.ts` is a narrow façade export, not an internal catch-all barrel.
- `task-turn-runner` must not generate execution plans; it may only consume planner-aware runtime state and diagnostics.
- `task-turn-runner` may orchestrate planner turn, batch execution, and consolidation, but must not implement planner rules, batch policy rules, or validator rules inline.
- batch execution belongs to `application/tasks`; interfaces must not drive tool batches directly.
- consolidation is the only stage-level acceptance entry point for planner-aware execution.
- provider-batch summaries are planner diagnostics, not an interface-defined execution mode.
- `prompt-builder` renders selected context and must not implement contract policy.
- prompt slimming must remain truth-preserving:
  - section titles stay visible
  - raw vs compact summary vs omitted status must be explainable
  - prompt rendering must not silently hide capability, memory, or retrieval scope in a way that misleads the model
- compatibility fallback is allowed only as an explicit compatibility path, and its use must surface in diagnostics.
- planner/batch/consolidation execution is the primary stage-aware runtime path. Single-active fallback may remain only as an explicit, diagnosable safety path.
- benchmark-only forced fallback is allowed, but only as an internal diagnostic/measurement path.

## DigDeeper Boundary

The current line now claims:

- planner/batch/consolidation is the primary execution kernel
- fixed benchmark harness validates `1-3` call execution for the shipped complex DAG benchmark
- synthetic and realistic benchmark suites are engineering validation surfaces, not alternate execution modes

What remains outside the invariant set is further call-compression optimization, not execution-model completion.
