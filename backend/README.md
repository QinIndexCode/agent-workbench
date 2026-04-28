# backend

`backend` is the default SCC-Batch backend runtime.

## What it includes

- contract-driven multi-agent runtime
- single-active-unit orchestration
- REST, WebSocket, SSE fallback, and CLI interfaces
- file and Postgres storage modes
- queue, worker, checkpoint, projection, and recovery support
- provider adapters for OpenAI-compatible, DeepSeek-compatible, and Anthropic-compatible transports
- local and cloud provider presets, including Ollama, HuggingFace-compatible local endpoints, vLLM, and LM Studio
- a loopback-first browser workbench, with bearer-token non-loopback access reserved for automation/integration clients

## Commands

- `npm run typecheck`
- `npm test`
- `npm run test:postgres`
- `npm run migrate`
- `npm run start`
- `npm run start:worker`
- `npm run cli -- <command>`

## Interface docs

- `docs/21-rest-api-reference.md`
- `docs/22-websocket-protocol-reference.md`
- `docs/23-cli-reference.md`
- `docs/24-frontend-integration-guide.md`

## Core boundary

- `foundation` owns storage, queue, providers, registries, and runtime-neutral policies
- `domain` owns parser, validation, prompt/context management, and state transitions
- `application` owns lifecycle, orchestration, worker behavior, and adapters
- `interfaces` owns REST, WebSocket, health, readiness, and CLI protocols
