# Skill Compatibility Audit

This audit captures the April 4, 2026 deep review of skill, MCP, workspace workflow, and task-summary integration after the dual-track Claude-style skill compatibility work landed on the active mainline.

## Audit Scope

- `TaskTurnRunner`, recovery, and queue-runtime-projection summary alignment
- workspace workflow execution chain, including `.scc` rules, hooks, agents, and instruction-skill selection
- task-level skill, MCP, and instruction-skill closure across backend debug, CLI summaries, and Web operator views
- scorecard, benchmark, and docs alignment for new skill compatibility coverage
- Claude-style bundle import using a real local sample at `D:\download\skills-main\skills-main`

## Findings

### Fixed Bugs And Regression Risks

1. `bug / regression risk`: explicit instruction-skill selection used to stack with workspace-default and heuristic matches instead of taking precedence.
   - impact: task debug could report the wrong `selectedCount`, inject extra instruction bundles, and mislead Web/CLI summaries.
   - evidence: fixed in `backend/src/application/runtime/workspace-workflow-context.ts`; regression now covered in `backend/tests/functional-lines.test.cjs`.

2. `bug / regression risk`: Claude-style marketplace import used the wrong root when the manifest lived under `.claude-plugin/marketplace.json`.
   - impact: imports from real Anthropic-style samples could resolve to `.claude-plugin/skills/...` instead of the actual repo `skills/...` directory, making imported bundles unusable.
   - evidence: fixed in `backend/src/application/platform/skill-service.ts`; real import path now verified against `D:\download\skills-main\skills-main`.

3. `bug / regression risk`: instruction-skill dependency hints such as `mcpServers` were dropped by metadata normalization.
   - impact: selected instruction-skill summaries lost MCP dependency visibility, so operators could not tell what external capability the bundle expected.
   - evidence: fixed in `backend/src/application/runtime/workspace-workflow-context.ts`; summary coverage now present in task debug and Web task details.

4. `bug / regression risk`: the workspace hook runner could throw synchronously on `spawn` failures such as `EPERM`.
   - impact: a local hook execution problem could crash the task path instead of surfacing as observability.
   - evidence: fixed in `backend/src/application/runtime/workspace-hook-runner.ts`; failures now convert into structured hook execution records.

### Open Gaps

1. `open_gap`: default-environment live-provider validation is still disabled unless `BACKEND_NEW_LIVE_PROVIDER_ENABLED` is set.
   - impact: enhanced validation remains partially environment-gated even though the local helper path is green.
   - evidence: `release-scorecard.json` reports `liveProviderProfile.mode = disabled`.

2. `open_gap`: default-environment Postgres validation still reports `external_blocker / env_missing`.
   - impact: the default scorecard cannot claim always-on Postgres closure even though the local password-mode helper is green.
   - evidence: `release-scorecard.json` reports `postgresValidation.category = env_missing`.

### Design Mismatches That Are Intentional

1. `design mismatch`: Claude-style bundles are not executable runtime skills.
   - impact: imported `SKILL.md + assets` bundles do not go through `invokeSkill(...)`.
   - current handling: they are catalogued as `instruction-skill`, surfaced in operator views, and injected into prompt/context as guidance plus asset references.

2. `design mismatch`: instruction-skill MCP dependencies are metadata hints, not auto-wired execution bindings.
   - impact: a bundle can declare `mcpServers` or related hints, but v1 only exposes them in summaries and selection context.

### Future Enhancements

1. `future enhancement`: marketplace lifecycle management for instruction-skill bundles.
   - scope: enable/disable, update, dependency resolution, remote sync, and richer registry controls.

2. `future enhancement`: automatic skill-to-MCP compatibility checks or auto-binding.
   - scope: matching declared MCP requirements to configured servers and surfacing readiness before task execution starts.

3. `future enhancement`: richer operator review UX for dual-track skills.
   - scope: deeper skill asset previews, bundle diffing, and explicit task-time skill selection beyond the current metadata/default/heuristic model.

## Verified Compatibility Result

Claude-style skill bundles can now be integrated into SCC with these guarantees:

- imported through a formal platform entrypoint
- classified as `instruction-skill` instead of being misrepresented as `runtime-skill`
- indexed with `assetSummary` and `instructionSource`
- surfaced in task debug, CLI summaries, and Web task details
- injected into prompt/context with precedence after project instructions and matched rules

This is enough to call the current model **compatible and usable**, but not "runtime-identical" to executable module skills.

## Validation Evidence

- backend tests: `172 pass / 4 skip / 0 fail`
- default scorecard:
  - `general-complex = 31/31`
  - `workspace_workflow = achieved`
  - `extensions_workflow = achieved`
  - `skill_compatibility = achieved`
  - `long_running_reliability = achieved`
- verification sources:
  - `backend/tests/functional-lines.test.cjs`
  - `backend/tests/general-complex-scenarios.test.cjs`
  - `backend/tests/prompt-builder.test.cjs`
  - `.codex-run/logs/release-scorecard.json`

## Interpretation

The active mainline no longer has a skill compatibility gap in the sense of "Claude-style skills cannot be brought into SCC".

The remaining distinction is architectural:

- `runtime-skill` means executable adapter
- `instruction-skill` means guidance and asset bundle

That boundary is now explicit in code, UI, CLI, scorecard, and docs.
