# Unresolved Gaps

This list captures the remaining gaps after the current file-system mainline, benchmark target, and frontend smoke gate are green in the default environment.

The functional coverage view now lives in [33-functional-coverage-matrix.md](D:/MyCode/myApp_/Scc_batch_web/backend/docs/33-functional-coverage-matrix.md), so this document only tracks what is still unresolved after that wider validation surface.

## Backend Hardening Gaps

- provider timeout, retry, and production observability still need deeper stress coverage beyond the current structured failure taxonomy
- live-provider quality validation is now green on the local ignored Xiaomi provider path:
  - local `release:scorecard:local` reaches a green live-provider proof line
  - local `release:scorecard:live-postgres` is the full-fidelity ignored helper when Xiaomi live-provider and local Postgres both need to be proven in one report
  - the remaining gap is still default-environment enablement, where the default scorecard does not assume ignored local provider secrets
- Postgres validation remains environment-gated in the default environment:
  - current default entrypoint: `npm run test:postgres -w backend`
  - ignored local helpers: `npm run test:postgres:local` and `npm run release:scorecard:live-postgres`
  - required env: `BACKEND_NEW_PG_TEST_URL` or `BACKEND_NEW_DATABASE_URL`
  - recommended local password-mode connection: `postgres://postgres:postgres@127.0.0.1:5432/scc_batch_test`
- Postgres scorecard reporting now distinguishes:
  - `env_missing`
  - `connection_failed`
  - `migration_failed`
  - `test_failed`
- deeper recovery and failure-churn testing is still worth expanding beyond the current workflow, breadth, general-complex, flagship, and live-provider suites, even after the new long-running reliability families were added to general-complex
- context-history remains the residual benchmark-side cost center even though the current `tokenReductionRatio = 0.72` already satisfies the target
- capability-hub coverage is now green on the active mainline, so remaining side-capability gaps are no longer about basic readiness visibility; they are about deeper provider stress, dependency lifecycle depth, and richer automatic binding
- provider-core, permissions-hooks, and subagent-routing are now green on the default engineering floor, so the remaining side-capability gaps are no longer baseline routing or visibility gaps; they are deeper stress, policy ergonomics, and automatic dependency-management gaps
- dual-track skill support is now green for import, discovery, prompt injection, and tri-surface visibility, but these follow-up gaps remain:
  - no automatic MCP binding from instruction-skill dependency hints
  - no marketplace lifecycle features such as enable/disable, dependency resolution, or remote sync
  - `instruction-skill` bundles remain guidance assets rather than executable runtime modules by design

## Frontend Gaps

- browser smoke and browser E2E are both green on the default mainline; remaining frontend work is now deeper visual regression, longer-session operator review, and chunk-size optimization rather than missing mutation-flow coverage
- task-heavy and diagnostics-heavy UI still needs deeper long-session operator review beyond current smoke and E2E checks
- operator workspace experience is clearer than before and now shares summary-first progress language with Human CLI and Agent CLI, but it is still optimized for expert operators rather than first-time users
- the core production font packaging issue is fixed, but richer visual regression coverage is still thinner than the backend validation surface

## Product Gaps

- release evidence is now bundled through `npm run release:scorecard`, and the current report cleanly separates `engineering_floor` from `enhanced_validation` while preserving `achieved`, `open_gap`, and `external_blocker`; full local truth for Xiaomi live-provider plus Postgres now has its own explicit ignored helper profile instead of overloading the default command
- public mixed-baseline parity and manual artifact audit are now green in the default engineering floor, so remaining product gaps are no longer about whether SCC can reconstruct publicly documented OpenCode / Claude Code / SWE-bench-style task shapes on its own runtime
- practical task acceptance and practical manual audit are now green in the default engineering floor, so remaining product gaps are no longer about whether SCC can handle mixed real user tasks such as vague content requests, explicit docs, operator reports, analysis briefs, repo-grounded changes, and review artifacts under a ship-ready bar
- `cli_web_interaction`, `interaction_e2e`, `cli_interaction_transcript`, `runtime_stress_validation`, `ecommerce_delivery`, and `ecommerce_readiness` are now green in the default engineering floor, so remaining product gaps are no longer about whether SCC can present a usable operator surface or model a layered high-volume commerce reference; they are about deeper load/stress validation and broader production hardening
- the legacy and transition code trees have been removed from the repository; remaining product gaps are now entirely on the active mainline rather than on migration leftovers
- historical temp workspaces and `.codex-run/logs` are now cleaned before unified scorecard reruns, but retained-workspace review flows still depend on explicit local keep switches when failures need manual inspection
- flagship quality evidence is implemented and locally verified against the Xiaomi provider; the remaining gap is carrying that same evidence into default environments without the local helper env
- general-complex task coverage is now green on the file-system mainline at `31 / 31`, including the workflow-layer families (`workspace-bootstrap`, `workspace-docs-import`, `workspace-command-driven-task`, `decision-doc-from-imported-sources`), the extension-layer families (`skill-driven-task`, `mcp-tool-assisted-task`, `skill-failure-diagnostics`, `mcp-failure-recovery`), the skill-compatibility families (`instruction-skill-guided-task`, `instruction-skill-with-assets`, `mixed-runtime-and-instruction-skill-task`), and the long-running reliability families (`long-running-correction-churn`, `checkpoint-recovery-task`, `provider-failure-streak-task`, `extension-failure-stability-task`), so remaining product gaps are no longer about baseline task diversity; they are about deeper stress coverage, marketplace lifecycle depth, and future rich-media expansion
- backend tests and default engineering-floor scorecard are now green at `179 / 4 / 0`, so remaining product gaps are not baseline correctness gaps; they are hardening and environment gaps
- repo-real completion and mixed-public parity are both green:
  - `real_task_completion = achieved`
  - `public_capability_parity = achieved`
  - `manual_artifact_audit = achieved`
- remaining product gaps are no longer about proving SCC can solve complex repo-shaped tasks under strict artifact review; they are about deeper live-provider stress, default-environment enablement, and broader ecosystem depth
- the new workspace workflow layer is code-complete, regression-backed, and already green in the default scorecard; remaining workspace-facing product work is no longer basic route availability, but deeper operator review and richer long-session UX validation
- interaction summaries are now aligned across Web, Human CLI, and Agent CLI, so the remaining product gap is polish and stress-testing rather than summary-model inconsistency
- Claude-style skill compatibility is now implemented on the active mainline; the remaining product gap is no longer whether those bundles can be brought into SCC, but how much further the project wants to go beyond import-plus-context support
- provider/MCP/skill/workspace capability-hub views are now implemented on the active mainline; the remaining product gap is not a missing side-capability surface, but deeper readiness automation and operator troubleshooting depth
- production deployment guidance and operator troubleshooting docs still need more depth
- provider-stress and database-stress scorecards are still thinner than the rest of the validation surface

## Interpretation

These are no longer missing-core-architecture gaps.

They are:

- hardening gaps
- deeper validation gaps
- environment gaps

The mainline should continue improving through evidence-driven tightening, not another architectural rewrite.
