# Provider / Skill / MCP Runtime Foundation

## Goal

This layer exists to keep provider calls, skill execution, and MCP connectivity out of the core runtime loop until their contracts are explicit and reusable.

The foundation should always expose three truths before the runtime depends on them:

1. registration and manifest truth
2. capability truth
3. request/response contracts

## Current structure

### `foundation/providers`

- profile, registry, resolver, selection policy, and client request/response contracts
- capability metadata for provider transports
- registry-backed provider client resolution

### `foundation/skills`

- runtime registry and catalog view for executable/runtime skills
- instruction-skill placeholder loading and catalog exposure

### `foundation/mcp`

- MCP client contracts, registry, and catalog view
- transport-specific client implementations for HTTP, stdio, and WebSocket

## Design rules

### 1. Definitions stay separate from execution

`foundation/extensions` owns manifests, placeholder loading, and extension definitions.

Execution-facing contracts stay in:

- `foundation/providers`
- `foundation/skills`
- `foundation/mcp`

### 2. Capabilities must be explicit

Nothing should be considered runnable only because some code is registered.

The foundation must expose capability truth such as:

- provider streaming / tools / JSON-mode support
- skill write / network boundaries
- MCP prompts / resources / streaming support

### 3. Catalog views report readiness, not execution

Catalog helpers should answer:

- is an implementation registered?
- what capability surface is available?

They should not execute the provider, skill, or MCP call themselves.

## Current implementation boundary

The repo now includes the real runtime-facing foundation pieces:

- provider client registry plus real OpenAI-compatible, DeepSeek-compatible, and Anthropic-compatible HTTP clients
- skill runtime registry plus imported/generated instruction skills and executable runtime skills
- MCP client registry plus real HTTP, stdio, and WebSocket transport clients
- capability views that aggregate readiness for the operator surfaces

The remaining work is no longer "foundation existence"; it is operational hardening and validation:

- stronger live-provider validation across external environments
- more production-style MCP/service integration coverage
- broader release/ops hardening around those transports
