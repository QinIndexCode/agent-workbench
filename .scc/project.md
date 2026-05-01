# SCC-Batch workspace guidance

SCC-Batch is a runtime/operator platform that keeps backend task truth, CLI behavior, and web operator state aligned.

## Working agreements

- Prefer evidence over assumption. If docs and code disagree, trust the implementation and fix the docs.
- Treat `Tasks` as the main operator workbench. Side surfaces like `Queue`, `Settings`, and `Improvements` should support it, not drift away from it.
- Keep backend truth and frontend display synchronized. Do not land a UI change that masks a backend truth gap.
- Default to explicit lifecycle handling: approvals, artifact routing, archive state, provider truth, and recovery status should stay visible and testable.
- Keep `docs(knowlage)/DigDeeper.md` as the architectural north star: SCC-Batch is first a semantic contract based batch DAG engine. Operator, ecosystem, and validation harness features must support that core, not redefine it.
- Keep scenario-specific logic isolated. Database labs, Xiaomi live-provider details, real-task waves, benchmark repair heuristics, and scenario-pack audits must not leak into the generic runtime, parser, executor, quality core, or product contract unless promoted through an explicit architecture decision.

## High-value repo paths

- `backend/src/application`
- `backend/src/interfaces`
- `backend/src/foundation`
- `frontend/src/pages`
- `frontend/src/components`
- `scripts/`
- `apps/ecommerce-reference/`

## Operator expectations

- Verify with `npm.cmd` on Windows.
- Prefer narrow, targeted validation before heavy benchmark suites.
- When touching repo-level behavior, keep `README.md`, `.scc`, and the release-facing scripts in sync.
