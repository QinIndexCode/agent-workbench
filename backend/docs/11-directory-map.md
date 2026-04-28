# backend_new directory map

## foundation

### `foundation/config`
- configuration model
- defaults
- environment loading
- validation
- controlled reload policy

### `foundation/storage`
- storage adapter contract
- file-backed implementation
- path layout
- atomic JSON and JSONL persistence

### `foundation/logging`
- audit
- trace
- checkpoint logging
- retention policy

### `foundation/database`
- Postgres adapter
- schema helpers
- migration plan
- schema version table
- migration execution history

### `foundation/queue`
- single-database queue persistence
- claim
- heartbeat
- retry
- dead-letter storage

### `foundation/repository`
- task runtime persistence
- checkpoint persistence
- session, projection, event, approval, invocation, output, and conversation persistence
- file and postgres repository implementations

### `foundation/security`
- API key encryption and decryption only

### `foundation/providers`
- provider profile model
- preset normalization
- profile resolution
- selection policy
- client registry and capability contract
- prompt policy definitions

### `foundation/extensions`
- tool, skill, and MCP definitions
- extension catalog registry

### `foundation/skills`
- skill runtime contract
- runtime registry
- capability catalog view
- module runtime validation boundary
- structured skill error envelope

### `foundation/mcp`
- MCP client contract
- runtime registry
- capability catalog view
- `stdio`, `http`, and `ws` client adapters
- capability discovery contract

### `foundation/tools`
- invocation contract
- permission policy
- approval and dispatch planning
- executor registry
- execution result and error taxonomy

### `foundation/bootstrap`
- the foundation composition root

### `foundation/correlation`
- session, correlation, turn, and checkpoint identifiers

### `foundation/conversation`
- append-only user-visible and runtime-visible conversation records

### `foundation/projection`
- runtime event envelopes
- task projections
- event hub

## domain

### `domain/contracts`
- runtime and task core types

### `domain/parser`
- LLM response structure extraction

### `domain/validation`
- explicit output validation
- tracker validation
- acceptance policy

### `domain/runtime`
- prompt building
- prompt budget control
- vendor prompt policy consumption
- provider-context compression
- state transition rules
- turn orchestration

## application

### `application/create-runtime.ts`
- runtime facade and top-level assembly only

### `application/tasks`
- task lifecycle
- task queries
- turn execution
- tool dispatch orchestration

#### `application/tasks/commands`
- command dispatcher
- lifecycle command handlers
- operator interaction handlers
- approval command handlers

#### `application/tasks/lifecycle`
- task application facade
- task lifecycle service
- task command executor facade

#### `application/tasks/planning`
- task planner service

#### `application/tasks/tools`
- tool batch executor service
- tool dispatch orchestrator

#### `application/tasks/control`
- interrupt controller
- operator command service
- task turn runtime control

#### `application/tasks/persistence`
- provider failure persistence
- successful turn persistence
- validated output persistence
- task projection persistence

#### `application/tasks/turns`
- turn planner execution
- turn batch execution
- turn consolidation
- turn context assembly
- stage turn context assembly
- turn provider execution
- turn outcome mapper
- turn runtime state builder
- turn phase types

### `application/runtime`
- runtime analysis
- extension runtime access
- prompt capability summaries
- runtime service bundle assembly

### `application/worker`
- queue worker loop
- recovery services
- dead-letter and lease recovery orchestration

### `application/adapters`
- concrete provider adapters
- builtin tool adapters
- skill runtime adapters
- MCP runtime adapters

## interfaces

### `interfaces/http`
- REST commands and queries
- health and readiness
- SSE fallback
- queue diagnostics and recovery endpoints

### `interfaces/cli`
- CLI runner built on top of the stable REST fact surface
- submit, query, action, approval, and queue diagnostics commands
- watch, stream, tail, and status terminal consumption modes
- workspace-first `chat` plus task-centric `tasks chat`

#### `interfaces/cli/chat`
- workspace/task session controller
- ndjson protocol normalization
- blessed-based TUI adapter
- CLI-local session state, recent-task memory, and inspector snapshots only
- no backend workspace session persistence

### `interfaces/ws`
- WebSocket subscription protocol
- event replay and delivery
- heartbeat and structured error envelopes

## tests

- all tests are scoped to `backend_new`
- `node:test` is the current test runner
- each new layer must arrive with direct tests, not only indirect integration coverage
