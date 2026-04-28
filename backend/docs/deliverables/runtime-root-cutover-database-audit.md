# Runtime Root Cutover Database Audit

- Generated: 2026-04-26
- Status: pre-cutover historical snapshot
- Purpose: preserve the last accepted database live-task evidence that existed before the runtime root moved to `backend/data`
- Superseded by: `backend/docs/deliverables/runtime-root-post-cutover-database-audit.md`
- Source reports:
  - `.codex-run/logs/real-task-wave-report.json`
  - `.codex-run/logs/real-task-wave-report.md`
  - `.codex-run/logs/real-task-wave/database-near-mysql-design/debug.json`
  - `.codex-run/logs/real-task-wave/database-near-mysql-verify/debug.json`

## Scope

This audit preserves the last verified evidence for:

- `database-near-mysql-design`
- `database-near-mysql-verify`

At capture time, the original live-task workspaces still existed under the legacy runtime root:

- `backend/backend_new_data/workspace/task_1777171412953_cefa9c0a`
- `backend/backend_new_data/workspace/task_1777171644537_111c6e1b`

Those legacy runtime workspaces were eligible for deletion as part of the hard cutover to `backend/data`. They are not the current runtime root.

## Scenario Results

### database-near-mysql-design

- Task ID: `task_1777171412953_cefa9c0a`
- Classification: `passed`
- Lifecycle: `COMPLETED`
- Acceptance: `passed`
- Quality: `passed (database_near_mysql_design)`
- Artifact audit: `passed`
- Surface checks: Web `true`, Human CLI `true`, Agent CLI `true`
- Artifact progress:
  - design docs complete
  - prototype top-level files complete
  - prototype src depth reached (`3` files)
  - quality evidence present: `quality/database-design.json`
  - benchmark self-check passed
- Produced files preserved in the legacy workspace include:
  - `database-lab/design/README.md`
  - `database-lab/design/architecture.md`
  - `database-lab/design/storage-engine.md`
  - `database-lab/design/sql-compatibility.md`
  - `database-lab/design/benchmark-plan.md`
  - `database-lab/prototype/package.json`
  - `database-lab/prototype/README.md`
  - `database-lab/prototype/scripts/bench.js`
  - `database-lab/prototype/src/index.js`
  - `database-lab/prototype/src/storage-engine.js`
  - `database-lab/prototype/src/buffer-pool.js`
  - `quality/database-design.json`
- Cost profile from `debug.json`:
  - total tokens: `68802`
  - turn count: `13`
  - tool invocations: `21`
  - correction depth: `12`

### database-near-mysql-verify

- Task ID: `task_1777171644537_111c6e1b`
- Classification: `passed`
- Lifecycle: `COMPLETED`
- Acceptance: `passed`
- Quality: `passed (database_near_mysql_verify)`
- Artifact audit: `passed`
- Surface checks: Web `true`, Human CLI `true`, Agent CLI `true`
- Artifact progress:
  - design docs complete
  - prototype top-level files complete
  - prototype src depth reached (`3` files)
  - quality evidence present: `quality/database-design.json`, `quality/database-benchmark-result.json`
  - benchmark self-check passed
- Verification-only preserved outputs include:
  - `database-lab/prototype/results/bench-dry-run.json`
  - `quality/database-benchmark-result.json`
- Cost profile from `debug.json`:
  - total tokens: `11262`
  - turn count: `4`
  - tool invocations: `6`
  - correction depth: `3`

## Consistency Check

The preserved evidence is internally consistent across:

- runtime acceptance truth
- quality gate truth
- artifact audit
- Web / Human CLI / Agent CLI visibility

No split outcome was observed for these two scenarios in the preserved reports.

## Efficiency Assessment

The last successful database pair is materially more efficient than the earlier runaway database attempts:

- combined token total: `80064`
- combined turn count: `17`
- combined tool invocations: `27`

This is acceptable as the archival baseline for the runtime-root cutover. Future regressions should be compared against this preserved baseline, not against the deleted legacy runtime workspaces.
