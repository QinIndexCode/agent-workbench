# SCC-Batch

SCC-Batch is an experimental runtime and operator platform for planning, executing, reviewing, and continuing complex AI-assisted tasks through one shared backend, CLI, and web workbench.

This repository is currently published as **experimental / pre-1.0**. The mainline is usable and actively validated, but the public contract should still be treated as evolving.

## What is in this repo

- [`backend`](./backend)
  Contract-driven runtime, worker, HTTP/WebSocket interfaces, CLI, audits, and benchmark suites.
- [`frontend`](./frontend)
  React operator workbench for `Tasks`, `Queue`, `Dashboard`, and `Settings`.
- [`apps/ecommerce-reference`](./apps/ecommerce-reference)
  A layered reference workspace used to validate delivery readiness against a more realistic application shape.
- [`.scc`](./.scc)
  Workspace instructions, docs sources, and command templates for the repo itself.

## Quick start

### Prerequisites

- Node.js 20+
- npm 10+
- Windows, macOS, or Linux

### Default local workflow

```bash
npm install
npm run build
npm run dev
```

The default browser workbench is intentionally **local-first / loopback-first**. Use the web UI from the same machine that runs the backend. Non-loopback control-plane access exists for automation and integration clients, not as a general remote browser-console contract in the current release.

Default ports:

- backend: `3011`
- frontend dev server: `5173`

If either port is already occupied, the launcher now exits early and tells you which process is in the way instead of silently drifting to another port.

### Global command

You can also install the lightweight launcher globally from a local checkout:

```bash
npm install -g .
scc-batch dev
```

The global `scc-batch` command is a repo-aware wrapper. It expects to be executed inside an SCC-Batch checkout (or with an explicit `--repo` where supported), then delegates to the local workspace.

Useful commands:

```bash
scc-batch dev
scc-batch backend
scc-batch worker
scc-batch frontend
scc-batch cli
scc-batch doctor
scc-batch port-check
scc-batch workspace commands list
scc-batch workspace commands install
scc-batch workspace commands run --name <command>
```

### Workspace command install

Repo-local workspace commands can be installed as per-user shims:

```bash
scc-batch workspace commands list
scc-batch workspace commands install --name frontend-smoke
sccw-scc-batch-frontend-smoke
scc-batch workspace commands uninstall --name frontend-smoke
```

Installed shims live in:

- Windows: `%USERPROFILE%\\.scc-batch\\bin`
- POSIX: `$HOME/.scc-batch/bin`

If that bin directory is not on your `PATH`, the installer tells you exactly what to add.

## Validation and review helpers

The repository includes both engineering-floor checks and heavier benchmark-style validation suites.

Common entry points:

```bash
npm run test
npm run typecheck
npm run smoke:frontend
npm run e2e:frontend
npm run review:frontend:mainline
npm run review:frontend:live
npm run review:frontend:delegation-live
npm run repo-hygiene
npm run repo-delivery
```

Additional scorecards and benchmark suites:

- `npm run release:scorecard`
- `npm run public-capability-parity`
- `npm run manual-artifact-audit`
- `npm run ecommerce-delivery`
- `npm run ecommerce-readiness`

## Provider model

SCC-Batch now treats provider setup as **curated presets + custom provider**:

- quick-add presets for common hosted and local providers
- API-key-first setup for hosted providers
- explicit runtime-vs-saved default provider truth
- full custom provider support for OpenAI-compatible and other advanced transports

The provider UI and API keep these two truths visible:

- **Saved default**
  The default provider stored in config
- **Runtime default**
  The provider currently active in runtime

If runtime is still catching up, the UI surfaces `runtime pending` or `reload required` rather than pretending no provider is enabled.

## Skills and workspace workflow

SCC-Batch supports both runtime and instruction-oriented skills:

- `runtime-skill`
  Executable through the backend runtime
- `instruction-skill`
  Imported guidance bundles such as `SKILL.md`, templates, and assets

Workspace metadata lives in `.scc/` and can include:

- `project.md`
- `docs.json`
- `commands/*.md`
- `rules/*.md`
- `agents/*.md`
- `hooks.json`

### Importing skills

Skills can be imported through either the web workbench or the CLI.

Human-oriented CLI examples:

```bash
npm run cli -- platform skills list
npm run cli -- platform skills import --id writer-instructions --name "Writer instructions" --root .codex/skills/writer
npm run cli -- platform skills import-marketplace --marketplace .agents/plugins/marketplace.json --plugin my-plugin --skill skills/writer
```

Provider preset discovery is also available from the CLI:

```bash
npm run cli -- platform providers presets
```

## Optional local enhancements

These are supported but not required for the default local setup:

- live provider validation sourced from `dont_touch_(APIKEY).md` using the canonical Xiaomi Mimo `mimo-v2.5` profile
- Postgres-backed validation helpers
- higher-fidelity benchmark profiles

Ignored local env helpers:

- `.env.postgres.local`

### Canonical release scorecard profile

`npm run release:scorecard` keeps the external-integration bar intact. A fully green run requires the same two external truths the product depends on:

- Postgres via `BACKEND_NEW_PG_TEST_URL` or `BACKEND_NEW_DATABASE_URL`
- live provider execution via `BACKEND_NEW_LIVE_PROVIDER_ENABLED=1` plus the canonical `xiaomi-mimo-v2-flash` provider/secret, now pinned to model `mimo-v2.5`

Without those inputs, the scorecard is expected to report external blockers rather than pretend the repo has passed a full release-grade profile.

For the current local repo workflow, the live provider source of truth is `dont_touch_(APIKEY).md`. The canonical Xiaomi live provider keeps the stable id `xiaomi-mimo-v2-flash`, but its canonical model truth is `mimo-v2.5`. The supported task-validation path is now real-provider only; do not reintroduce mock provider manifests for operator or Agent CLI testing.

## Current release stance

Use SCC-Batch today if you are comfortable working with an actively evolving operator/runtime system.

Expect this repo to be strongest when:

- you want the full task lifecycle in one place
- you want CLI + web + runtime truth to line up
- you want explicit approvals, artifact routing, and follow-up continuation
- you are comfortable operating the browser workbench from the same local machine as the backend

Expect rough edges around:

- live provider and database environment setup
- release/ops hardening outside the default local profile
- pre-1.0 surface changes

## Documentation map

Start here when orienting:

- [`backend/README.md`](./backend/README.md)
- [`backend/docs/11-directory-map.md`](./backend/docs/11-directory-map.md)
- [`backend/docs/33-functional-coverage-matrix.md`](./backend/docs/33-functional-coverage-matrix.md)
- [`backend/docs/32-unresolved-gaps.md`](./backend/docs/32-unresolved-gaps.md)
