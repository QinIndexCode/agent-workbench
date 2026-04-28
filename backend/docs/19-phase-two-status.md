# backend_new second-phase status

## What is already stable

The current second-phase baseline already includes:

- file and postgres storage modes
- schema-versioned Postgres migration bootstrap with execution history
- foundation support for database, queue, worker, and recovery
- single-active-unit sequential runtime
- REST plus WebSocket interfaces, with SSE fallback kept for compatibility
- WebSocket heartbeat and after-event replay support
- queue dead-letter listing, requeue, and expired-lease recovery entry points
- unified task query payloads that include runtime, projection, queue state, conversations, and provider failure diagnostics
- provider failure now lands consistently in trace, checkpoint, projection, and runtime events
- provider adapters for `openai-compatible`, `deepseek-compatible`, and `anthropic-compatible`
- mainstream vendor presets plus local deployment presets for Ollama, HuggingFace-style local endpoints, vLLM, and LM Studio
- builtin workspace tools
- persistent approvals, tool invocations, projections, conversations, and validated outputs
- prompt building, provider-context compression, and state transitions as separate runtime surfaces
- MCP adapters for `stdio`, `http`, and `ws`
- module skill runtime validation with structured error metadata
- env-gated live Postgres integration test entry points
- CLI access through the same REST fact surface used by external clients
- interface reference docs for REST, WebSocket, CLI, and frontend integration
- CLI watch/stream/tail/status modes with WebSocket-first fallback behavior

## What is intentionally stable at the boundary level

- `foundation` carries infrastructure, contracts, registries, and runtime-neutral policy only
- `application` carries lifecycle, worker behavior, adapters, and task orchestration
- `domain` carries parser, validation, prompt policy consumption, context management, and state transition rules
- `interfaces` carries protocol exposure only

## What is still not product-finished

- live Postgres production validation still needs more hardening
- provider production policies still need deeper timeout, retry, and observability refinement
- MCP transport support is now available in `stdio/http/ws`, but production connection hardening still needs more validation
- skill package runtime coverage is still at the focused module-entry level, not a broad ecosystem level
- deployment and operating documentation still needs more production detail

## Current implementation focus

The current priority is architectural tightening, not feature sprawl:

1. keep `PromptBuilder`, `ContextManager`, and `StateTransitionApplier` as the runtime core
2. keep provider-facing context compression separate from user-visible conversation storage
3. keep `create-runtime.ts` as a facade instead of a growing god object
4. keep docs, tests, and implementation aligned before moving deeper into production hardening
5. keep Postgres live validation and production deployment guidance as the last gap before phase-three work
