<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/src/assets/logo/logo-whiteTheme.png">
    <source media="(prefers-color-scheme: light)" srcset="apps/web/src/assets/logo/logo-blackTheme.png">
    <img src="./apps/web/src/assets/logo/logo-blackTheme.png" alt="Agent Workbench logo" width="152">
  </picture>
</p>

<h1 align="center">Agent Workbench</h1>

Agent Workbench is a local-first workspace for running tool-using AI tasks with
explicit permissions, durable SQLite state, visible evidence, a Web UI, and an
HTTP-backed CLI.

The runtime owns context assembly, permission checks, tool execution, event
projection, checkpoints, and learning records. The model chooses the next step
inside those boundaries.

> This project is licensed under the MIT License. See [LICENSE](LICENSE).

## Capabilities

- Local task threads with streaming responses and pending user guidance.
- Risk-based approval for file, shell, network, MCP, and destructive actions.
- Encrypted SQLite-backed task state, checkpoints, attachments, and rollback.
- OpenAI-compatible, Anthropic, and Gemini provider configuration.
- Knowledge search, task memory, skills, reflection, and curation workflows.
- Web UI for desktop and mobile-sized screens.
- `aw` / `agent-workbench` CLI using the same public server APIs as the Web UI.
- Loop Engineering guidance for evidence-driven observe, act, verify, reflect,
  persist, and cache-aware execution.
- MCP tool integration today, with A2A/Agent2Agent tracked as an explicit future
  interoperability boundary rather than a claimed shipped adapter.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Windows is the fully validated runtime and quality-gate platform

The portable build is checked on Linux, but shell-tool behavior and the complete
E2E suite are currently validated on Windows.

## Quick Start

```bash
npm ci
npm run build
npm run dev:all
```

On Windows PowerShell, use `npm.cmd` if the `npm` shim is unavailable:

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run dev:all
```

Open:

- Web UI: `http://127.0.0.1:5173`
- API health: `http://127.0.0.1:5177/health`

The default server and session bootstrap are intended for trusted local access.
Do not expose the server directly to an untrusted network.

## Model Providers

Configure a provider from the Web UI or through environment variables. The
server uses `OPENAI_API_KEY` when present. Scoped Agent Workbench variables are
also supported:

```text
AGENT_WORKBENCH_OPENAI_API_KEY
AGENT_WORKBENCH_OPENAI_BASE_URL
AGENT_WORKBENCH_MODEL
AGENT_WORKBENCH_PROMPT_CACHE_MODE
```

Plaintext key files are not loaded implicitly. Without a configured provider,
the workbench uses a small local fallback so permission and tool flows remain
testable.

Prompt caching defaults to `auto`: Anthropic Messages enables automatic prompt
caching, and official OpenAI, Kimi, and MiMo Token Plan OpenAI-compatible
endpoints receive a stable `prompt_cache_key`. Set
`AGENT_WORKBENCH_PROMPT_CACHE_MODE=always` for a compatible custom OpenAI
endpoint that supports `prompt_cache_key`, or `off` to disable explicit cache
hints. Agent Workbench also keeps stable instructions and context ahead
of task-specific content to improve provider-side cache reuse. Initial
direct-answer final replies can also be served from a short in-memory response
cache; tool calls, file evidence, image inputs, and tasks with existing history
are excluded.

Provider usage records include per-request and rolling prompt-cache hit ratios.
After the first warmup request, the target rolling hit ratio is 90% or better
for cache-capable providers. OpenAI-compatible cache keys are scoped to the
model, endpoint, and sorted tool-name family so harmless schema text changes do
not fragment routing. The full tool schema is still sent in every request, so
cache routing does not reduce available tool capability or task quality.

## CLI

Start the server explicitly:

```bash
npm run cli -- serve
```

Then use the same server APIs from another terminal:

```bash
npm run cli -- health
npm run cli -- task list
npm run cli -- task create "Inspect this project" --watch
```

See [docs/cli.md](docs/cli.md) for the full command reference.

## Quality

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:prod
npm run quality:full
```

`quality:full` covers unit tests, real-task matrices, stress tests, build,
documentation checks, API route coverage, Web E2E, accessibility, artifact
hygiene, release-source hygiene, and workflow guidance.

To remove generated UI/test output and dated flagship Markdown reports while
leaving source docs and real local data intact:

```bash
npm run clean:release-artifacts
```

For a source-tree release sanity check:

```bash
npm run check:release-source
```

## Architecture

- `apps/server`: Fastify HTTP/WebSocket API and SQLite persistence.
- `apps/web`: React/Vite workbench UI.
- `apps/cli`: local HTTP CLI.
- `packages/core`: agent loop, permissions, tools, context, and learning.
- `packages/shared`: shared schemas and TypeScript types.

See [docs/architecture.md](docs/architecture.md) for the current implementation
boundary. Historical research and vision documents are not delivery promises.

## Documentation

- [Quick start](QUICKSTART.md)
- [Documentation map](docs/README.md)
- [CLI reference](docs/cli.md)
- [Agent workflow and verification](docs/agent-workflow.md)
- [Architecture and protocol boundaries](docs/architecture.md)

Generated flagship reports are validation artifacts, not hand-written product
documentation. See [docs/reports/README.md](docs/reports/README.md) for the
report boundary.

## Contributing And Security

- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Release checklist](RELEASE_CHECKLIST.md)
