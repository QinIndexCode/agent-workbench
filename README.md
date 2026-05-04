# SCC Agent Workbench

SCC Agent Workbench is rebuilt as an agent-first local workbench. The runtime owns context assembly, tool permissions, event projection, user guidance, and visible evidence. The agent owns planning and next-step selection.

## Architecture

- `apps/server`: Fastify API, WebSocket snapshot endpoint, SQLite-backed state.
- `apps/web`: Codex-style workbench UI with one prompt box, one adaptive action button, timeline, and approvals.
- `packages/core`: agent loop, permission engine, tool execution, experience capture, skill promotion.
- `packages/shared`: strict Zod schemas and shared TypeScript types.

## Runtime Principles

- Simple loop first: model turn, tool request, approval or execution, evidence returned, next turn.
- Scripts and commands are evidence, not task judges.
- User guidance can arrive during execution and stays pending until the next safe point.
- Tool permissions are risk-class based: allow once, allow for task, or deny.
- Experience records become skills through a guarded promotion path.

## Model Provider

The server uses `OPENAI_API_KEY` when present. If it is not set, it looks for a key in `dont_touch_(APIKEY).md`. Without a key, the workbench falls back to a small local planner so the permission and tool loop still runs offline.

## Commands

```bash
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run check:no-old-control
npm.cmd run dev
```

The web UI runs on `http://127.0.0.1:5173`; the API runs on `http://127.0.0.1:5177`.
