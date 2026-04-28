<div align="center">
  <img src="frontend\public\logo.png" alt="SCC-Batch Logo" width="170" height="170">
</div>

# SCC-Batch Overview

SCC-Batch is a contract-driven DAG runtime for multi-agent batch task execution. It is designed to make complex task execution controllable, observable, recoverable, and verifiable.

## Core Capabilities

- Contract-driven DAG execution with `GlobalContract + DAGScheduler + AgentUnit`
- Dynamic planning through deterministic templates and AI-assisted planning
- Semantic cache for repeated unit execution
- Pause and resume with persisted runtime context
- Real-time task synchronization over Socket.IO
- Grounded execution paths for repository analysis, artifact verification, and remediation

## Runtime Flow

```text
Task Submission
  -> SCCPlanner
  -> DAGScheduler
  -> SCCEngine
  -> Tool Runtime
  -> TaskManager / Socket State Sync
```

## Repository Layout

- `backend/`: backend services, SCC runtime, tests, API docs
- `frontend/`: React UI and Socket client
- `docs/`: architecture, design, and review documents
- `data/`: runtime data, cache, logs, and outputs

## Quick Start

### Install dependencies

```bash
npm install
```

### Local development

```bash
npm run dev:backend
npm run dev:frontend
```

### Start services

```bash
npm run start
npm run start:all
```

### Build and checks

```bash
npm run build
npm run typecheck
```

### Default URLs

- Backend API: `http://127.0.0.1:3011`
- Frontend UI: `http://localhost:5173`
- WebSocket endpoint: `ws://127.0.0.1:3011/ws`

## Current Scope Notes

- The root `build` script currently builds the frontend only
- The root `typecheck` script currently checks the backend only
- Detailed API docs live under `backend/docs/api/`
- Detailed architecture docs live under `docs/`

## Documentation Index

- [Architecture & Design](docs/architecture.en.md)
- [Design Advantages](docs/advantages.en.md)
- [Contract-Driven DAG Architecture](docs/contract-driven-dag.en.md)
- [Backend REST API](backend/docs/api/index.md)
- [WebSocket Events](backend/docs/api/websocket-events.md)
- [Review and optimization tracking](docs/review/)

## Tech Stack

| Layer    | Technology                             |
| -------- | -------------------------------------- |
| Frontend | React 19 + TypeScript + Vite + Zustand |
| Backend  | Node.js 18+ + TypeScript + Express     |
| Realtime | Socket.IO 4                            |
| AI       | Ollama / OpenAI / Anthropic            |
| Storage  | JSON file storage                      |
