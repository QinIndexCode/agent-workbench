# CLI Reference

The CLI is a formal consumer of the public REST and WebSocket interfaces. It does not read repositories directly.

Run through:

```bash
npm run cli -- <command>
```

The CLI now has two interactive entry points:

- `chat`: workspace-first human entry point, with TUI when a TTY is available
- `tasks chat`: task-centric compatibility entry point, especially for other agents and scripts

Both CLI surfaces consume the same task diagnostics fact model that powers REST task detail and the frontend operator workspace. The CLI does not define a private diagnostics schema.

Cross-surface interaction rules are aligned around one summary model:

- `tasks status`, `tasks diagnostics`, `chat`, `tasks chat`, `watch`, `tail`, and `stream` all expose the same high-signal summary vocabulary
- the shared summary fields are:
  - `progressState`
  - `stageLabel`
  - `blockingReason`
  - `nextAction`
  - `nextActionReason`
  - `approvalCount`
  - `failureSummary`
  - `recoverySummary`
- human-oriented views show the summary first and push raw evidence down into diagnostics or raw views
- machine-oriented views keep stable JSON shapes and append summary fields instead of inventing a second protocol

Frontend and CLI intentionally share inspector terminology:

- `summary`
- `diagnostics`
- `approvals`
- `tools`
- `events`
- `tasks`
- `raw`

The browser may additionally expose read-only deep task views such as `DAG`, `traces`, `logs`, `commands`, and `memory`, but those still derive from the same public REST facts.

## Global flags

| Flag | Meaning |
| --- | --- |
| `--server <url>` | Backend server base URL |
| `--after-event-id <eventId>` | Replay cursor for event commands |
| `--ws-path <path>` | WebSocket path override |

Default local backend URL:

```text
http://127.0.0.1:3011
```

## Validation helpers

### `npm run test:postgres -w backend`

Runs the Postgres-backed integration suite.

Environment requirements:

- `BACKEND_NEW_PG_TEST_URL`, or
- `BACKEND_NEW_DATABASE_URL`

Example:

```bash
BACKEND_NEW_PG_TEST_URL=postgres://postgres:postgres@127.0.0.1:5432/scc_batch_test npm run test:postgres -w backend
```

Ignored local helper:

```bash
npm run test:postgres:local
```

Recommended local helper defaults:

- auth mode: password-based, not trust-based
- credentials: `postgres / postgres`
- database: `scc_batch_test`

Behavior:

- exits `0` when the Postgres integration suite passes
- exits `2` when the database environment variables are missing
- does not fake success when Postgres is unavailable; release reporting should treat missing env as an external blocker, not as a pass
- release scorecard classifies Postgres results as:
  - `external_blocker` when the env vars are missing
  - `open_gap` when connection, migration, or test execution fails
  - `achieved` when the suite passes
- finer Postgres categories inside the scorecard are:
  - `env_missing`
  - `connection_failed`
  - `migration_failed`
  - `test_failed`
  - `passed`

Recommended local setup:

- database name: `scc_batch_test`
- connection string shape: `postgres://postgres:postgres@127.0.0.1:5432/scc_batch_test`
- run migrations through the test entrypoint itself; do not treat a manually created schema as equivalent validation
- the ignored helper reads `.env.postgres.local` and writes the scorecard profile as `local-postgres`

### `npm run live-provider-scenarios -- --json`

Runs the flagship artifact-quality suite against a real configured provider.

Environment requirements:

- `BACKEND_NEW_LIVE_PROVIDER_ENABLED=1`
- an available provider in `backend/data/providers/manifest.json` or `BACKEND_NEW_LIVE_PROVIDER_MANIFEST`
- `BACKEND_NEW_LIVE_PROVIDER_API_KEY` when the selected provider resolves through `apiKeySecretId`
- optional `BACKEND_NEW_LIVE_PROVIDER_ID` to force one provider id

Behavior:

- exits `0` with structured JSON whether the suite is `achieved`, `open_gap`, or `external_blocker`
- reports `external_blocker` when live execution is disabled, credentials are missing, or the selected provider is unavailable
- does not treat missing provider credentials or unavailable endpoints as a pass
- the live suite injects the API key into its temporary file-backed secret store at runtime and does not require committing credentials into `backend/data/secrets`
- the release scorecard now exposes live-provider mode explicitly as:
  - `disabled`
  - `enabled-but-failed`
  - `achieved`

Validation harness example using an OpenAI-compatible provider:

```bash
BACKEND_NEW_LIVE_PROVIDER_ENABLED=1 \
BACKEND_NEW_LIVE_PROVIDER_ID=xiaomi-mimo-v2-flash \
BACKEND_NEW_LIVE_PROVIDER_MODEL=mimo-v2.5 \
BACKEND_NEW_LIVE_PROVIDER_API_KEY=<key> \
npm run live-provider-scenarios -- --json
```

Provider note:

- for openai-compatible providers, store `baseUrl` as the API root such as `https://token-plan-cn.xiaomimimo.com/v1`
- do not store the full `.../chat/completions` URL in the manifest, because the runtime client appends `/chat/completions`
- Xiaomi-style local validation remains a harness concern; it is not a public provider preset or a Core runtime special case.
- ignored local helper:

```bash
npm run release:scorecard:local
```

## Workspace chat

### `chat [--format human|ndjson] [--task <taskId>] [<taskId>|<jsonFile>]`

Workspace-first interactive session mode.

Design constraints:

- still uses public REST and event endpoints only
- does not read repositories directly
- keeps command mode intact for scripts and other agents
- keeps workspace session state in the CLI process, not in backend facts

Behavior:

- when given `--task <taskId>` or positional `<taskId>`, it attaches to that task
- when given `<jsonFile>` or inline submit flags, it submits a seed task and opens a workspace session
- when no task is active, the first free-form prompt creates and starts an ad hoc task
- when the active task is terminal, the next free-form prompt creates a new task instead of restarting the old one

Human mode:

- if TTY is available, `chat` opens a blessed-based full-screen TUI
- without TTY, `chat` falls back to line-oriented human output
- the TUI keeps workspace session state locally and exposes transcript, inspector, input, and status panes
- inspector shortcuts stay local to the CLI and do not change backend facts unless they call an existing task endpoint
- both TTY and line-mode human output now lead with:
  - current status
  - blocking reason
  - suggested next action
  - deeper diagnostics after that

Agent-compatible workspace mode:

```bash
npm run cli -- chat --format ndjson
```

Workspace `ndjson` envelopes include:

- `session`
- `task`
- `event`
- `diagnostics`
- `approvals`
- `prompt`
- `view`

Workspace slash commands:

| Command | Meaning |
| --- | --- |
| `/help` | Show available commands |
| `/tasks` | Show recent and current task list view |
| `/switch <taskId>` | Attach the workspace session to another task |
| `/new [prompt]` | Detach current task, or create and start a new one immediately |
| `/focus <summary\|diagnostics\|events\|approvals\|raw\|tasks>` | Change inspector focus |
| `/raw` | Shortcut for `/focus raw` |
| `/clear` | Clear local transcript view |
| `/task`, `/status` | Show current task summary |
| `/events` | Drain newly recorded runtime events |
| `/diagnostics` | Show planner/batch/consolidation diagnostics |
| `/start [message]` | Start the attached task |
| `/continue [message]` | Continue execution |
| `/pause` | Pause execution |
| `/resume [message]` | Resume execution |
| `/restart [message]` | Restart execution explicitly |
| `/message <text>` | Send an operator message |
| `/approve <invocationId> [reason]` | Approve a pending tool invocation |
| `/reject <invocationId> [reason]` | Reject a pending tool invocation |
| `/interrupt [reason]` | Request an interrupt |
| `/cancel [reason]` | Cancel the task |
| `/exit` | Close the workspace session |

TUI key bindings:

| Key | Meaning |
| --- | --- |
| `Tab` | Cycle transcript, inspector, and input panes |
| `Esc` | Return focus to input |
| `Ctrl-R` | Refresh the active task |
| `q`, `Ctrl-C` | Exit |
| `[` / `]` | When inspector is focused on approvals, move approval selection |
| `a` / `r` | When inspector is focused on approvals, approve or reject the selected item |

## Tasks

The task CLI now supports two interaction styles:

- formal command mode for scripts and stable machine consumption
- `tasks chat` for task-centric interactive sessions layered on top of the same REST and event surfaces

### `tasks list`

Returns `TaskSummaryResponse[]`.

### `tasks get <taskId>`
### `tasks inspect <taskId>`

Returns the full `TaskQueryResponse`.

### `tasks status <taskId>`

Returns a compact JSON summary suitable for scripts.

Current summary fields include:

- `taskId`
- `title`
- `intent`
- `lifecycleStatus`
- `engineStatus`
- `currentUnitId`
- `updatedAt`
- `queueState`
- `pendingApprovalCount`
- `progressState`
- `stageLabel`
- `blockingReason`
- `nextAction`
- `nextActionReason`
- `approvalCount`
- `failureSummary`
- `recoverySummary`

### `tasks submit <jsonFile>`

Submits a task definition JSON file.

For Windows and other shell-quoted automation flows, prefer the JSON-file form when the task contains a structured `outputContract`. This avoids inline JSON quoting drift through `npm run cli -- ...`.

Builtin file tools such as `read_file`, `list_files`, and `search_files` operate against the **task workspace**, not the repository root. For repo-grounded context, use imported workspace docs or seed files into the task workspace before starting the task.

`tasks submit` also supports inline task creation flags, so a JSON file is optional:

```bash
npm run cli -- tasks submit \
  --title "Smoke task" \
  --intent "Verify provider execution" \
  --provider ollama-cloud \
  --output-contract "{\"summary\":\"string\",\"details\":\"string\"}"
```

Supported inline flags:

| Flag | Meaning |
| --- | --- |
| `--title <title>` | Task title |
| `--intent <intent>` | Task goal |
| `--provider <providerId>` | Preferred provider id |
| `--task-id <taskId>` | Optional caller-supplied id |
| `--unit-id <unitId>` | Unit id, defaults to `AGENT-001` |
| `--role <role>` | Unit role |
| `--goal <goal>` | Unit goal, defaults to `intent` |
| `--output-contract <json>` | Unit output contract string |
| `--depends-on <a,b>` | Comma-separated dependencies |
| `--metadata-file <jsonFile>` | Optional metadata JSON |

Scripted machine-readable usage:

- human shell convenience: `npm run cli -- ...`
- automation / JSON parsing: prefer the built CLI entrypoint directly so npm workspace banners do not pollute stdout

```bash
node dist/bin/cli.js tasks submit backend/docs/examples/cloud-smoke-task.json --server http://127.0.0.1:3011
```

### `tasks run [<jsonFile>]`

Composite command:

1. submit task
2. start task
3. follow live execution until a terminal event (`TASK_COMPLETED`, `TASK_CANCELLED`, or `TASK_FAILED`)

When no JSON file is given, it accepts the same inline task creation flags as `tasks submit`.

Windows / PowerShell-safe example using a task file:

```bash
node dist/bin/cli.js tasks run backend/docs/examples/cloud-smoke-task.json --server http://127.0.0.1:3011 --mode tail
```

Optional flags:

| Flag | Meaning |
| --- | --- |
| `--mode <watch\|stream\|tail>` | Live follow mode, default `watch` |
| `--no-start` | Submit only, skip the automatic `start` call |
| `--message <text>` | Optional initial operator message for the start request |

### `tasks chat [<taskId>|<jsonFile>]`

Interactive task session mode.

Design constraints:

- still uses public REST and event endpoints only
- does not read repositories directly
- keeps command mode intact for scripts and other agents
- supports `--format human|ndjson`
- remains task-centric even though top-level `chat` is now workspace-centric

Behavior:

- when given `<taskId>`, it attaches to an existing task
- when given `<jsonFile>` or inline submit flags, it submits a task definition and opens a session
- when given no seed task, the first free-form prompt creates an ad hoc single-unit task and starts it

Human mode is slash-command oriented:

```text
backend_new(task_123)> /status
backend_new(task_123)> /diagnostics
backend_new(task_123)> continue with the latest deployment check
backend_new(task_123)> /approve inv_456 looks safe
backend_new(task_123)> /exit
```

`tasks chat` remains task-centric. It does not add workspace-local recent-task navigation or workspace envelopes.

Agent-compatible mode:

```bash
npm run cli -- tasks chat task_123 --format ndjson
```

In `ndjson` mode the CLI emits line-delimited JSON envelopes for:

- session state
- task summary
- runtime events
- diagnostics
- approvals
- prompt readiness

Supported slash commands:

| Command | Meaning |
| --- | --- |
| `/help` | Show available interactive commands |
| `/task`, `/status` | Show current task summary |
| `/events` | Drain newly recorded runtime events |
| `/diagnostics` | Show planner/batch/consolidation diagnostics |
| `/start [message]` | Start the attached task |
| `/continue [message]` | Continue execution |
| `/pause` | Pause execution |
| `/resume [message]` | Resume execution |
| `/restart [message]` | Restart execution |
| `/message <text>` | Send an operator message without lifecycle transition |
| `/approve <invocationId> [reason]` | Approve a pending tool invocation |
| `/reject <invocationId> [reason]` | Reject a pending tool invocation |
| `/interrupt [reason]` | Request an interrupt |
| `/cancel [reason]` | Cancel the task |
| `/switch <taskId>` | Rebind the session to another task |
| `/exit` | Close the interactive session |

### `tasks start <taskId>`
### `tasks continue <taskId> [--message <text>]`
### `tasks pause <taskId>`
### `tasks resume <taskId>`
### `tasks restart <taskId>`
### `tasks interrupt <taskId> [--reason <text>]`
### `tasks cancel <taskId> [--reason <text>]`
### `tasks message <taskId> --message <text>`

These commands call the matching REST lifecycle endpoints and print `TaskActionResponse`.

### `tasks commands <taskId>`

Returns the recorded operator command history.

### `tasks operator-messages <taskId>`

Returns the recorded operator message history and consumption state.

### `tasks events <taskId> [--after-event-id <eventId>]`

Returns the current event list from REST.

### `tasks approve <taskId> <invocationId> <APPROVED|REJECTED|EXPIRED>`

Optional flags:

| Flag | Meaning |
| --- | --- |
| `--granted-by <name>` | Operator name |
| `--reason <text>` | Approval explanation |

### `tasks watch <taskId>`

Human-oriented live mode.

Behavior:

1. Fetches `GET /tasks/:id`
2. Tries WebSocket first
3. Falls back to SSE
4. Falls back to REST polling

### `tasks stream <taskId>`

Machine-oriented event streaming.

Output format: one JSON object per line.

Example:

```json
{"kind":"runtime_event","source":"ws","taskId":"task_123","event":"TASK_CANCELLED","latestEventId":"evt_11","summary":{"progressState":"failed","stageLabel":"Stage 2 of 3","blockingReason":"The last task turn failed.","nextAction":"Restart task","nextActionReason":"Restart rebuilds execution from the current task definition.","approvalCount":0,"failureSummary":"Task failed during verification.","recoverySummary":null},"data":{"eventId":"evt_11","taskId":"task_123","type":"TASK_CANCELLED"}}
```

### `tasks tail <taskId>`

Human-oriented concise event summary mode. No TUI.

Example output:

```text
[ws] TASK_STARTED task_123 | state=running | Runtime is actively progressing through the current unit. | next=Inspect diagnostics
[ws] CHECKPOINT_WRITTEN task_123 | state=running | Runtime is actively progressing through the current unit. | next=Inspect diagnostics
[ws] TASK_CANCELLED task_123 | state=failed | The last task turn failed. | next=Restart task
```

### Task diagnostics commands

| Command | Meaning |
| --- | --- |
| `tasks discussion <taskId>` | Conversation and operator message view |
| `tasks tooling <taskId>` | Tool approval and invocation view |
| `tasks traces <taskId>` | Runtime trace envelopes |
| `tasks debug <taskId>` | Debug payload |
| `tasks recent-analysis <taskId>` | Recent task analysis events |
| `tasks diagnostics` | Aggregate task diagnostics |
| `tasks diagnostics <taskId>` | Summary-first diagnostics for one task: problem, cause, suggested action, then planner, batch, consolidation, contract, compression policy, batch-admission, prompt section attribution, stage memory, capability selection, and retrieval selection details |
| `tasks recoverable` | Recoverable task list |

## Queue

### `queue active`

Returns active queue records.

### `queue dead-letters`

Returns dead-letter queue records.

### `queue recover-expired`

Triggers expired lease recovery.

### `queue requeue <taskId>`

Requeues a dead-letter task.

## Memory

### `memory profile`

Returns the durable user preference profile currently learned by the runtime.

## Platform

These commands remain REST-first and machine-readable.

### Providers

| Command | Meaning |
| --- | --- |
| `platform providers list` | List provider views |
| `platform providers presets` | List provider preset catalog entries |
| `platform providers get <providerId>` | Get provider view |
| `platform providers test <providerId>` | Smoke test provider connectivity |
| `platform providers set-default <providerId>` | Set default provider |
| `platform providers upsert <jsonFile> --id <providerId>` | Upsert provider profile |
| `platform providers delete <providerId>` | Delete provider profile |
| `platform providers secrets` | List provider secret summaries |
| `platform providers secrets set --provider <id> --label <label> --api-key <key>` | Create/update provider secret |

Provider write commands return the same platform action envelope shape as REST, including `commandId`, `auditId`, and `appliedAt`.

Provider views now also carry the normalized capability-hub fields:

- `readiness`
- `authSource`
- `adapter`
- `model`
- `variant`
- `implementationStatus`
- `capabilities`

Provider preset catalog entries distinguish:

- `runnable`: backed by a registered generic adapter such as OpenAI-compatible, DeepSeek-compatible, or Anthropic-compatible
- `profile-only`: visible for structured configuration but not runnable in this release
- `external-auth-required`: enterprise/cloud profile that needs additional account, region, deployment, OAuth, or SigV4 configuration

This keeps provider selection and diagnostics aligned across REST, CLI, Web, and task debug summaries.

### Capability hub

| Command | Meaning |
| --- | --- |
| `platform capabilities list` | List unified provider / MCP / skill / workspace capability entries |
| `platform capabilities status` | Return summarized readiness totals and warnings across the capability hub |

Capability entries use the shared vocabulary:

- `kind`
- `readiness`
- `scope`
- `warning`

### Ecosystem, tools, MCP, and scenario packs

| Command | Meaning |
| --- | --- |
| `platform ecosystem status` | Return the full ecosystem readiness projection |
| `platform tools list` | List tool capability entries, evidence shape, failure taxonomy, and readiness |
| `platform tools health` | Return compact tool health checks for automation |
| `platform mcp list` | List configured MCP servers |
| `platform mcp status` | Return MCP readiness projection from the ecosystem registry |
| `platform mcp get <serverId>` | Get one MCP server view |
| `platform mcp test <serverId>` | Run MCP connectivity and capability smoke test |
| `platform mcp upsert <jsonFile> --id <serverId>` | Upsert MCP server definition |
| `platform mcp delete <serverId>` | Delete MCP server definition |
| `platform scenarios list` | List registered scenario packs with core quality profile, scenario gate, model, timeout, and surface-check policy |

### Skills

| Command | Meaning |
| --- | --- |
| `platform skills list` | List skills |
| `platform skills get <skillId>` | Get one skill with readiness, dependency, and asset metadata |
| `platform skills status <skillId>` | Get the current status view for one skill |
| `platform skills status` | Return skill readiness projection from the ecosystem registry |
| `platform skills refresh` | Refresh configured skill roots |
| `platform skills import --name <name> --root <path> [--id <id>]` | Import/register a skill placeholder |
| `platform skills import-marketplace --marketplace <file> --plugin <name> [--skill <path>]` | Import Claude-style instruction skills from a marketplace manifest into the local skill registry |

Skill catalog entries now distinguish:

- `runtime-skill`
  - executable through the existing runtime `invokeSkill(...)` path
- `instruction-skill`
  - imported guidance bundle such as `SKILL.md + templates/assets`
  - injected into task context and operator summaries
  - not executed through the module runtime path
  - may expose dependency hints such as `declaredDependencies.mcpServers`

Skill status views now expose:

- `kind`
- `readiness`
- `assetSummary`
- `instructionSource`
- `declaredDependencies`

### Channels

| Command | Meaning |
| --- | --- |
| `platform channels list` | List channels |
| `platform channels get <channelId>` | Get channel |
| `platform channels create <jsonFile>` | Create channel |
| `platform channels update <channelId> <jsonFile>` | Update channel |
| `platform channels delete <channelId>` | Delete channel |
| `platform channels test <channelId>` | Test channel |

### Schedules

| Command | Meaning |
| --- | --- |
| `platform schedules list` | List schedules |
| `platform schedules get <scheduleId>` | Get schedule |
| `platform schedules create <jsonFile>` | Create schedule |
| `platform schedules update <scheduleId> <jsonFile>` | Update schedule |
| `platform schedules delete <scheduleId>` | Delete schedule |
| `platform schedules pause <scheduleId>` | Pause schedule |
| `platform schedules resume <scheduleId>` | Resume schedule |

### Memories

| Command | Meaning |
| --- | --- |
| `platform memories list` | List memories |
| `platform memories search <query>` | Search memories |
| `platform memories get <memoryId>` | Get memory |
| `platform memories create <jsonFile>` | Create memory |
| `platform memories update <memoryId> <jsonFile>` | Update memory |
| `platform memories delete <memoryId>` | Delete memory |

### Config, stats, system

| Command | Meaning |
| --- | --- |
| `platform config get` | Get config state |
| `platform config set <jsonFile>` | Partial config update |
| `platform config reload` | Reload active config snapshot |
| `platform config health` | Detailed config health |
| `platform stats get` | Aggregate statistics |
| `platform system startup` | Startup/system view |
| `platform system metrics` | Runtime metrics view |

`platform config get|set|reload` expose:

- `activeSnapshotVersion`
- `reloadApplied`
- `restartRequired`

### Audit

| Command | Meaning |
| --- | --- |
| `platform audit <RESOURCE_TYPE> <RESOURCE_ID>` | Read append-only platform command and audit history |

## Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Request, parsing, transport, or protocol failure |

## Error output

CLI failures remain machine-readable:

```json
{
  "error": "Request failed with status 500.",
  "statusCode": 500
}
```

Transport fallback diagnostics may also be written to stderr during `watch`, `stream`, or `tail`.
