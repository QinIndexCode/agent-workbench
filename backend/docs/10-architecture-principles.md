# backend_new architecture principles

This document is not a feature list. It is the constraint set that all future implementation must follow.

## 1. Foundation before orchestration

The implementation order is fixed:

1. config
2. storage
3. logging
4. repository
5. provider and extension registry
6. parser and contract validation
7. runtime and lifecycle
8. REST, WebSocket, projection, and operations

No new runtime behavior may skip lower layers and grow directly into orchestration.

## 2. One composition root

Dependency assembly must enter through the composition root:

- `src/foundation/bootstrap/create-foundation.ts`
- `src/application/create-runtime.ts`

`create-runtime.ts` is a facade and assembly point only. It may wire services together, but it must not absorb worker, server, prompt, protocol, or state-transition business rules.

## 3. One fact, one authority

Each operational fact must have one authoritative source:

- config fact -> `BackendNewConfig`
- layout fact -> `StorageLayout`
- task runtime fact -> `TaskRuntimeRepository`
- checkpoint fact -> `CheckpointRepository`
- provider definition fact -> `ProviderRegistry`
- tool and extension definition fact -> `ExtensionRegistry`
- user conversation fact -> `ConversationRepository`
- provider-facing context fact -> runtime state and checkpoint references

Do not create parallel truth sources for the same thing.

## 4. Runtime has stable core surfaces

The runtime core must remain centered on three stable surfaces:

- `PromptBuilder`
- `ContextManager`
- `StateTransitionApplier`

Later features may extend these surfaces, but must not collapse the logic back into `task-turn-runner` or `create-runtime.ts`.

## 5. Logs and storage must support replay

Every state change must be traceable by:

- `taskId`
- `sessionId`
- `correlationId`
- `turnId`
- `checkpointId`

If an operation cannot be replayed from those anchors plus stored facts, the design is incomplete.

## 6. Explicit boundaries, no hidden coupling

- parser does not mutate runtime state
- prompt builder does not read repositories directly
- runtime does not reinterpret raw LLM text after parser/validation has already decided structure
- provider adapters do not own task orchestration
- interfaces do not redefine state semantics
- repositories do not interpret business meaning

## 7. User-visible conversation and provider context are different

- user-visible conversation is append-only and must remain complete
- provider-facing context may be compressed and budgeted
- compression policy must never mutate user-visible conversation storage
- checkpoints must reference both tracks explicitly

## 8. Extensions must be registered before use

Providers, tools, skills, and MCP servers must be registered first, then consumed through registries and capability views. Runtime code must not scan arbitrary files or invent extension definitions on the fly.

## 9. Scenario and harness boundaries

The core runtime must remain aligned with the `DigDeeper` design: semantic contracts, planner/batch DAG execution, minimal context, tool evidence, correction loops, and verifiable completion.

Operator, ecosystem, and validation harness features may grow around the runtime, but they must not redefine generic runtime semantics. Database-lab rules, provider-specific live checks, benchmark repair heuristics, real-task-wave continuation policies, and scenario artifact audits belong behind scenario-pack or harness boundaries.

Promote behavior into the generic runtime only when it is scenario-neutral and supported by cross-scenario evidence. Acceptable generic promotions include structured tool result feedback, invalid tool JSON correction, truth-preserving context compression, replayable evidence, three-surface consistency, and operator guidance that cannot weaken runtime correction.
