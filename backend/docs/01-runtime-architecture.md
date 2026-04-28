# Runtime Architecture

This document describes the current `backend_new` runtime architecture as implemented. It is a structural authority document, not a feature wish list.

For the non-negotiable invariants that guard this shape over time, see [27-architecture-invariants.md](./27-architecture-invariants.md).

## 1. Layering model

`backend_new` keeps a strict layered split:

1. `foundation`
   Responsible for config, storage, database, repositories, registries, queue adapters, and logging primitives.
2. `domain`
   Responsible for stable runtime contracts, parser behavior, validation, prompt/context policy, and state transition rules.
3. `application`
   Responsible for use-case orchestration, task lifecycle, platform services, runtime analysis services, worker services, and grouped facades.
4. `interfaces`
  Responsible for HTTP, WebSocket, CLI, and other transport adapters.

The dependency direction is one-way:

```text
interfaces -> application -> domain -> foundation
```

Lower layers must not depend on higher ones.

## 2. Composition root and facade

There are exactly two composition roots:

- `src/foundation/bootstrap/create-foundation.ts`
- `src/application/create-runtime.ts`

`create-runtime.ts` is allowed to:

- assemble the foundation
- register runtime adapters
- create grouped application surfaces
- expose a stable public facade

`create-runtime.ts` must not:

- build prompts directly
- parse LLM output directly
- apply runtime state transitions directly
- absorb worker, server, protocol, or state-machine business rules

## 3. Runtime public surfaces

The runtime surface is intentionally grouped to avoid service-locator drift:

- `runtime.tasks`
- `runtime.platform`
- `runtime.analysis`
- `runtime.extensions`
- `runtime.worker`

New capability must be added through grouped surfaces instead of top-level method sprawl. HTTP, WebSocket, CLI, and tests are expected to consume grouped surfaces directly. This includes the interactive `tasks chat` and workspace-first `chat` CLI session modes, which remain clients of REST and event surfaces rather than special execution paths.

## 4. Stable runtime core

The runtime core remains centered on three stable domain/application seams:

- `PromptBuilder`
- `ContextManager`
- `StateTransitionApplier`

Supporting runtime execution can grow around those seams, but logic must not collapse back into `task-turn-runner` or `create-runtime.ts`.

Inside `application/tasks`, the main orchestration hot paths are now split into focused assembly modules:

- `lifecycle/`
  - task application facade, lifecycle service, and command executor facade
- `planning/`
  - task planner service
- `tools/`
  - tool batch executor and tool dispatch orchestration
- `control/`
  - interrupt handling, operator command recording, and turn runtime control
- `commands/`
  - command dispatcher plus focused handlers
- `persistence/`
  - provider failure, successful turn, validated output, and projection persistence helpers
- `turns/`
  - planner, batch, consolidation, context, provider, and runner-side glue helpers

These modules stay at the application layer. They assemble and persist outcomes, but they do not redefine planner, topology, or validation rules.

## 5. Execution flow

Current task execution follows this shape:

```text
Task action or operator command
  -> task application / command executor
  -> command-dispatcher and focused command handlers
  -> task turn runner
  -> turn-planner-execution
  -> turn-context-assembly
  -> turn-provider-execution
  -> parser
  -> turn-batch-execution
  -> turn-consolidation
  -> turn-runtime-state-builder
  -> turn-result-persistence
  -> provider-failure-persistence / successful-turn-persistence / task-projection-persistence / validated-output-persistence
  -> realtime emission
```

Platform resource writes follow a separate path:

```text
HTTP / CLI write request
  -> platform service
  -> append platform command
  -> update current-state projection
  -> append platform audit record
  -> return action envelope
```

Platform audit is intentionally independent from the task runtime event stream, but it must remain append-only and replayable.

Task detail query is also a compatibility authority surface:

- `GET /tasks/:id` and all CLI/frontend detail consumers must tolerate historical runtime records that predate newer planner/batch/consolidation/context diagnostics fields
- compatibility normalization may fill required empty-state shapes for reading
- compatibility normalization must not invent nonexistent live semantics for terminal tasks or missing current-unit context

## 6. Authority boundaries

The key authority rules are:

- config authority -> config snapshots plus controlled reload semantics
- default provider authority -> config, not provider service side effects
- task runtime authority -> runtime repositories and checkpoints
- user-visible conversation authority -> conversation repository
- provider-facing context authority -> prompt/context assembly from runtime state
- skill registration authority -> declared config roots plus persisted import manifest
- extension registry -> runtime projection, not the root fact source

No operational fact should have two competing authorities.

Postgres is a parity storage surface, not an optional reduced-capability path. Runtime detail query, diagnostics, event replay, queue semantics, and platform audit must behave the same under file and Postgres storage, aside from environment-gated test execution.

## 7. Conversation versus provider context

The system explicitly separates two tracks:

- user-visible conversation
  - append-only
  - complete
  - never mutated by prompt compression
- provider-facing context
  - budgeted
  - filtered by topology, permission level, and input contract
  - may include task memory, preference profile, and retrieval results

This separation is part of the core philosophy and must remain intact.

## 8. Skill registration model

Skills are reconciled from declared authority sources:

- configured skill roots
- persisted import manifest

Refresh is a reconcile operation:

- add newly declared skills
- update changed skills
- remove stale skills that are no longer declared

Runtime code must not treat the in-memory registry as the ultimate fact source.

## 10. Contract-driven planner/batch DAG runtime

The current line is now explicitly contract-driven, topology-aware, and planner-first:

- each unit is normalized into a runtime `UnitContract`
- task definitions are preflight-validated before runtime state is created
- dependency order is represented as an explicit topology graph, not only ad hoc array scans
- `inputContract` and `permissionLevel` constrain provider-facing context visibility
- structured `inputContract` may additionally apply field narrowing per upstream unit
- structured `inputContract` may also apply an explicit memory selector:
  - `memoryUnits`
  - `memoryKinds`
  - `includeGlobalMemory`
- `exitCondition` participates in completion acceptance before a unit is marked complete
- topology now also carries planner-ready stage metadata for diagnostics and staged execution
- planner-first convergence adds an explicit `ExecutionPlan` and `TaskPlannerService`, and the planner result now drives stage-aware orchestration without introducing a separate public execution mode
- planner summaries expose:
  - `planVersion`
  - `stageCount`
  - `currentStageIndex`
  - `readyStageUnitIds`
  - `providerBatchCount`
  - `providerBatchHints`
  - `batchGroupingHints`
  - `blockingReason`

This is intentionally a current-line convergence step toward the `DigDeeper` planner/batch engine. The runtime now contains:

- a planner turn that computes the active stage and batch hints
- a provider-batch summary for each active stage
- batch-aware tool execution orchestration over the existing invocation/approval chain
- a consolidation turn that decides whether stage output can be accepted or must return to correction
- a stage semantic validator that is the final contract gate for planner/batch execution

The default line still preserves the legacy single-active runtime only as an internal fallback. Planner-aware stage execution, including multi-unit stages, is now the primary path when a planner stage is available. Provider batching, tool batching, and consolidation form the default execution kernel.

## 10.1 Planner-first boundary

Planner logic is now split by layer:

- `domain/runtime/execution-plan.ts`
  - defines `ExecutionPlan`, `PlanStage`, `PlannedBatch`, dependency classification, and plan validation
- `application/tasks/task-planner-service.ts`
  - invokes domain planner logic during submission and diagnostics assembly
- `task-turn-runner`
  - does not build plans
  - only executes against planner-aware runtime state

The default execution line is now planner-aware and includes planner turn, provider-batch diagnostics, batch orchestration, stage semantic validation, consolidation diagnostics, and multi-unit stage execution. The remaining fallback line is internal safety behavior rather than the primary execution model.

## 10.2 Benchmark authority

The runtime now ships with a fixed benchmark harness for hard verification:

- complex DAG with three stages
- planner-primary path
- forced single-active fallback baseline
- measured outputs:
  - API call count
  - prompt token count
  - completion token count
  - end-to-end latency
  - stage count
  - batch count
  - fallback count

The benchmark harness is an engineering validation surface, not a public execution mode. It exists to verify the `DigDeeper` call-compression philosophy against the implemented runtime.

The benchmark surface now has two layers:

- a fixed synthetic baseline for regression stability
- a realistic complex-DAG suite with approval-blocked, consolidation-correction, and planner-fallback validation scenarios
- stability-oriented metrics for correction loop rate, unsafe batch rejection count, compression downgrade count, planner fallback rate, and stage reopen count

Benchmark realism is treated as a validation concern. It must not leak planner, batch, or consolidation rules back into `create-runtime.ts`, interface adapters, or `task-turn-runner`.

## 11. Context policy split

Context selection is now explicitly split inside `domain/runtime`:

- `context-policy.ts`
  - computes accessible unit scope from topology and permission level
  - computes output key narrowing from structured `inputContract`
  - computes memory scope from structured memory selector rules
  - marks whether compatibility fallback was used and exposes retrieval scope diagnostics
- `context-compression-policy.ts`
  - decides which validated outputs remain raw versus summarized
  - preserves correction, approval-blocked, and fallback-related context in conservative mode
  - applies conservative stage memory virtualization before prompt rendering
  - favors explicit omission/summarization notices over silent removal
  - keeps compression decisions out of `prompt-builder.ts`
- `context-selection.ts`
  - remains the thin adapter used by higher layers
- `prompt-builder.ts`
  - renders already-selected context
  - does not decide policy

Prompt slimming is allowed to be stage-aware, but it must stay truth-preserving:

- sections may be rendered as raw, compact summary, or omitted from provider-facing context
- omitted or summarized sections must still keep their section label and an explicit explanation
- prompt builders must not rewrite contract meaning or silently hide capability/memory scope in a way that misleads the model

Compatibility heuristics still exist, but only as explicit fallback:

- structured contract
- normalized explicit fields
- compatibility fallback

Fallback use must be observable through runtime diagnostics rather than silently acting as the primary meaning source.

This split is intentional. Context policy belongs to `domain`, while prompt rendering remains a separate concern.

## 9. Replay and audit requirements

Task runtime state changes must remain traceable through:

- `taskId`
- `sessionId`
- `correlationId`
- `turnId`
- `checkpointId`

Platform writes must remain traceable through:

- `resourceType`
- `resourceId`
- `commandId`
- `auditId`
- `appliedAt`

If a write or state transition cannot be explained by persisted facts, the design is incomplete.
