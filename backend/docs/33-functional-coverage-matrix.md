# Functional Coverage Matrix

This matrix captures verification coverage by resource domain on the current file-system mainline. It complements the capability matrix by answering a different question: not only whether a capability exists, but whether its read path, write path, and failure surface are exercised by automated verification.

## Coverage Legend

- `read`: read/query surfaces are exercised by automated tests or smoke flows
- `write`: mutation authority and replay/audit evidence are exercised
- `diagnostics`: error, edge, or blocked states are surfaced structurally rather than as raw strings only

## Matrix

| Domain | Read coverage | Write coverage | Diagnostics coverage | Primary evidence |
| --- | --- | --- | --- | --- |
| `tasks` | stable | stable | stable | `backend/tests/task-runtime-and-http.test.cjs`, `backend/tests/workflow-scenarios.test.cjs`, `backend/tests/flagship-scenarios.test.cjs` |
| `queue` | stable | stable | stable | `backend/tests/task-runtime-and-http.test.cjs`, `backend/tests/functional-lines.test.cjs`, `frontend/src/modules/queue/QueuePage.tsx` |
| `providers` | stable | stable | stable | `backend/tests/provider-skill-mcp-foundation.test.cjs`, `backend/tests/conversation-and-config.test.cjs`, `backend/tests/functional-lines.test.cjs` |
| `config` | stable | stable | stable | `backend/tests/conversation-and-config.test.cjs`, `backend/tests/docs-consistency.test.cjs` |
| `skills` | stable | stable | stable | `backend/tests/provider-skill-mcp-foundation.test.cjs`, `backend/tests/runtime-integration.test.cjs`, `backend/tests/functional-lines.test.cjs` |
| `mcp` | stable | stable | stable | `backend/tests/provider-skill-mcp-foundation.test.cjs`, `backend/tests/functional-lines.test.cjs`, `backend/src/interfaces/http/routes/platform-routes.ts` |
| `channels` | stable | stable | partial | `backend/tests/runtime-integration.test.cjs` |
| `schedules` | stable | stable | partial | `backend/tests/runtime-integration.test.cjs` |
| `memories` | stable | stable | partial | `backend/tests/runtime-integration.test.cjs` |
| `statistics/system` | stable | read-only | partial | `backend/tests/runtime-integration.test.cjs`, `scripts/release-scorecard.mjs` |
| `frontend operator views` | stable | stable | stable | `frontend/scripts/smoke-validate.mjs`, `frontend/src/modules/tasks/TasksPage.tsx`, `frontend/src/modules/settings/SettingsConnectionsPage.tsx`, `frontend/src/modules/queue/QueuePage.tsx` |
| `repo hygiene` | stable | stable | stable | `backend/tests/repo-hygiene.test.cjs`, `scripts/check-repo-hygiene.mjs`, `scripts/release-scorecard.mjs` |
| `repo delivery` | stable | stable | stable | `scripts/check-repo-delivery.mjs`, `scripts/release-scorecard.mjs`, `backend/data/.gitignore` |

## Complex Task Coverage

| Family | Input shape | Typical tools | Required artifacts | Required verification | Validation status | Primary evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `workflow` | multi-stage coding tasks | `read_file`, `write_file`, `run_command`, `search_files` | task-specific code outputs | lifecycle completion and scenario assertions | stable | `backend/tests/workflow-scenarios.test.cjs`, `backend/src/application/benchmark/workflow-scenarios.ts` |
| `breadth` | practical mixed engineering tasks | read/write/search/command plus approval-sensitive tools | family-specific code or config outputs | scenario-specific content and command assertions | stable | `backend/tests/runtime-benchmark.test.cjs`, `backend/src/application/benchmark/breadth-scenarios.ts` |
| `general-complex` | broader engineering and special-case requests | read/write/search/command, structured report generation, task-level skill/MCP extension invocation, and long-running recovery churn | config, script, transformed data, workspace maintenance artifacts, `.scc` workflow bootstraps, workspace docs import summaries, command-driven reports, rebuilt workspace indexes, docs bundles, decision logs, diagnosis reports, policy-limited edits, multi-artifact bundles, extension-assisted outputs, and long-running recovery artifacts | artifact-quality verdict, family breakdown, failure-category summary, and long-running reliability summaries | stable | `backend/tests/general-complex-scenarios.test.cjs`, `backend/src/application/benchmark/general-complex-scenarios.ts`, `scripts/clean-test-artifacts.mjs` |
| `workspace workflow` | `.scc` project instructions, commands, and docs import | workspace loader, memory import, CLI platform workspace commands, read-only workflow view | `.scc/project.md`, `.scc/commands/*.md`, `.scc/docs.json`, workspace-scoped memories | prompt precedence, docs import dedupe, command discovery, HTTP/CLI agreement | stable | `backend/tests/functional-lines.test.cjs`, `backend/tests/prompt-builder.test.cjs`, `backend/src/application/platform/workspace-workflow-service.ts` |
| `extensions workflow` | task metadata, skill runtimes, MCP servers, and task debug summaries | runtime facade skill invocation, MCP tool calls, CLI/HTTP platform surfaces, and task observability | task-level `skillSummary`, `mcpSummary`, and extension execution events | task debug visibility, tri-surface summary consistency, and extension failure taxonomy | stable | `backend/tests/functional-lines.test.cjs`, `backend/src/application/platform/mcp-service.ts`, `backend/src/application/tasks/task-turn-runner.ts` |
| `flagship` | high-intensity coding flows | read/write/search/command with batch execution | multi-file code artifacts and testable outputs | call-count, batch, recovery, and artifact assertions | stable | `backend/tests/flagship-scenarios.test.cjs`, `backend/src/application/benchmark/flagship-scenarios.ts` |
| `live-provider` | real-provider public-benchmark-style coding tasks | real provider tool planning and execution | real workspace artifacts per family | automated artifact-quality verdicts under live provider | conditional | `backend/tests/live-provider-scenarios.test.cjs`, `backend/src/application/benchmark/live-provider-scenarios.ts`, `scripts/run-live-provider-local.mjs` |

## Notes

- `partial` does not mean missing implementation. It means the surface exists, but failure-path or edge-path automation is still thinner than the core task, queue, and provider lines.
- CLI, REST, and WebSocket consistency is covered through a combination of `backend/tests/cli-interface.test.cjs`, `backend/tests/task-runtime-and-http.test.cjs`, and `backend/tests/functional-lines.test.cjs`.
- Repository-surface integrity is now guarded separately from runtime behavior so deleted legacy paths cannot drift back into official scripts, docs, or scorecard outputs.
- Enhanced validation surfaces such as live-provider and Postgres remain part of the scorecard, but they are intentionally treated as layered gates rather than default-environment always-on requirements.
- `general-complex` extends the task matrix toward more varied engineering requests without introducing a parallel execution framework; it reuses the same planner-first, analyze/implement/verify, artifact-acceptance, and diagnostics seams as the rest of the mainline.
- the current Workspace+Docs wave inside `general-complex` now also covers `workspace-bootstrap`, `workspace-docs-import`, `workspace-command-driven-task`, and `decision-doc-from-imported-sources`, and these families now contribute to `byFamily` totals in the suite and the unified scorecard.
- the current Skill+MCP wave inside `general-complex` now also covers `skill-driven-task`, `mcp-tool-assisted-task`, `skill-failure-diagnostics`, and `mcp-failure-recovery`, and these families now contribute to `extensions_workflow` in the unified scorecard.
- the current long-running reliability wave inside `general-complex` now also covers `long-running-correction-churn`, `checkpoint-recovery-task`, `provider-failure-streak-task`, and `extension-failure-stability-task`, and these families now contribute to `long_running_reliability` in the unified scorecard.
