# Agent Workbench CLI

The CLI package lives in `apps/cli` and exposes two binary names:

- `aw`
- `agent-workbench`

It is a local HTTP client for the existing Agent Workbench server. It does not
start background services automatically, write SQLite directly, or duplicate
runtime business logic.

## Server

Start the local server explicitly:

```bash
npm.cmd run cli -- serve --host 127.0.0.1 --port 5177
```

Binding to a non-loopback host is blocked unless `--yes` is supplied. The
default session bootstrap is intended for trusted local access.

Other commands default to `http://127.0.0.1:5177`. Override the API base with:

```bash
npm.cmd run cli -- --api http://127.0.0.1:5177 health
```

or:

```bash
set AGENT_WORKBENCH_API_BASE=http://127.0.0.1:5177
```

The API base priority is:

1. `--api <url>`
2. `AGENT_WORKBENCH_API_BASE`
3. `http://127.0.0.1:5177`

Each CLI process bootstraps a local session token from
`/api/session/bootstrap` and sends it in `x-agent-workbench-session`.
Tokens are not persisted.

## Output

Most commands print compact human-readable summaries by default:

```bash
npm.cmd run cli -- task list
```

Use `--json` to print the raw API response:

```bash
npm.cmd run cli -- --json task show task_123 --events 50
```

Use `--quiet` to suppress normal output when only the exit code matters.
`--json` cannot be combined with `--watch`, because watch mode streams
incremental human-readable events.

## Common Commands

Health:

```bash
npm.cmd run cli -- health
```

Tasks:

```bash
npm.cmd run cli -- task list --include-children
npm.cmd run cli -- task create "Inspect this project" --title "CLI smoke" --watch
npm.cmd run cli -- task show task_123 --events 100
npm.cmd run cli -- task send task_123 "Continue with focused verification" --watch
npm.cmd run cli -- task control task_123 pause
npm.cmd run cli -- task approve task_123 approval_123 allow-task --reason "trusted workspace read"
npm.cmd run cli -- task transcript task_123
npm.cmd run cli -- task checkpoints task_123
npm.cmd run cli -- task rollback preview task_123 --checkpoint checkpoint_123
npm.cmd run cli -- task turns list task_123
```

Attachments:

```bash
npm.cmd run cli -- task create "Read this file" --attach .\README.md
npm.cmd run cli -- task attachments upload .\README.md
npm.cmd run cli -- task attachments list task_123
npm.cmd run cli -- task attachments delete attachment_123
```

`task attachments upload <path>` creates an unattached upload record. To attach
files to a task in the same operation, prefer `task create --attach <path>` or
`task send --attach <path>`.

Settings and side capabilities:

```bash
npm.cmd run cli -- folder list
npm.cmd run cli -- prefs get
npm.cmd run cli -- profile get
npm.cmd run cli -- permission list
npm.cmd run cli -- provider list
npm.cmd run cli -- provider test provider_123
npm.cmd run cli -- provider cache
npm.cmd run cli -- provider cache --task task_123
npm.cmd run cli -- mcp server list
npm.cmd run cli -- mcp tools
npm.cmd run cli -- knowledge search "rollback policy"
npm.cmd run cli -- skill duplicates
npm.cmd run cli -- memory task-list
npm.cmd run cli -- curator runs
npm.cmd run cli -- reflection runs
npm.cmd run cli -- schedule list
npm.cmd run cli -- search-provider list
npm.cmd run cli -- integration list
```

For commands with less common request fields, pass API-compatible bodies with
`--data` or repeated `--set` flags:

```bash
npm.cmd run cli -- provider add --data "{\"vendor\":\"custom\",\"label\":\"Local\",\"protocol\":\"openai_compatible\",\"baseUrl\":\"http://127.0.0.1:8000/v1\",\"models\":[{\"id\":\"local-model\",\"label\":\"Local model\"}],\"defaultModelId\":\"local-model\"}"
npm.cmd run cli -- schedule create "Daily check" "Summarize open tasks" --set frequency=daily --set timeOfDay=09:00
```

`provider test <providerId>` performs a minimal server-side preflight request
against the saved provider secret and returns only a redacted status, HTTP code,
failure class, model, and base URL. It is the quickest way to distinguish an
Agent/runtime regression from an invalid key, expired token, rate limit, or
provider outage.

`provider cache [--task <taskId>]` reads server-side prompt-cache telemetry from
`/api/prompt-cache-stats`. The default table keeps the cache health visible in
CLI workflows; `--json` preserves the raw records for dashboards or cost
analysis. After the first warmup request, the operational target remains a
rolling `cachedTokens / inputTokens` ratio of 90% or better.

## Uploads

`--attach <path>` and `knowledge upload <path>` read local files in the CLI,
base64 encode the content, and submit it through the existing HTTP endpoints.
File validation, persistence, encryption, and sensitive-preview behavior remain
server/core responsibilities.

## Testing

The CLI is included in the root build and typecheck scripts:

```bash
npm.cmd run typecheck
npm.cmd run build
npm.cmd test -- apps/cli
```

The integration tests start an in-process `createApp({ logger: false })`
server and exercise the real HTTP API rather than bypassing server routes.

## Cleaning Live Model Artifacts

Large live-model validation runs can generate model traces, tool-output
materializations, checkpoints, and attachment files under `data/` and
`workspace/default/data/`. Clean those raw artifacts and remove stale
machine-readable live/flagship summary reports with:

```bash
npm.cmd run clean:model-artifacts
```

Generated markdown reports under `docs/reports/` are ignored release artifacts;
rerun `quality:full` or `quality:flagship` to refresh a current dated report.
Pass `-- --keep-reports` only when the machine-readable summary reports must be
preserved for manual inspection:

```bash
npm.cmd run clean:model-artifacts -- --keep-reports
```

For release-source cleanup, use:

```bash
npm.cmd run clean:release-artifacts
npm.cmd run check:release-source
```

The cleanup command removes generated UI/test output and dated Markdown reports
while leaving `docs/reports/README.md`, source docs, SQLite data, attachments,
and checkpoints alone. The release-source check verifies that those boundaries
still hold before moving the source tree into a new repository.
