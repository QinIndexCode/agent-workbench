# Agent Workflow and Verification

This guide defines how Agent Workbench should help a model do stronger work without reducing its autonomy. The guidance is intentionally a ladder, not a rigid checklist.

## Operating Principles

- Preserve the user's real objective. Do not narrow it to the easiest test, route, fixture, or expected string.
- Choose the smallest workflow that can responsibly answer the request.
- Do not force tools, plans, tests, screenshots, live flows, or long reports for simple chat, low-risk answers, or user requests for a narrow response.
- Prefer current evidence when the answer depends on mutable state such as files, runtime behavior, APIs, UI, docs, model configuration, dates, or external facts.
- Never hardcode behavior to satisfy a particular test prompt, route, fixture, date, or answer string. Implement the general rule and test the rule.
- Verification should increase with risk and blast radius. It should not become a blanket gate that blocks legitimate model behavior.

## Workflow Ladder

Use the lightest rung that fits the task:

1. Direct answer: for stable knowledge, capability explanations, simple transformations, and low-risk clarification.
2. Clarify or infer acceptance criteria: for ambiguous work where success would otherwise be subjective.
3. Read-only diagnosis: for audits, reviews, architecture questions, or investigations where edits are not yet justified.
4. Implement through product boundaries: for code changes, prefer existing APIs, stores, routes, CLIs, and UI contracts over duplicate logic.
5. Recovery or rollback workflow: for failures caused by previous edits, tool errors, broken migrations, or bad generated state.
6. Long-running goal mode: for broad hardening where progress continues across turns and completion requires current evidence.

## Task Graph Compiler

Agent Workbench may compile non-trivial primary tasks into a lightweight task graph before the first model turn. The graph gives the model durable, current-task structure without replacing its judgment:

- Implementation tasks get an active `implement` node with acceptance criteria that preserve scope, product boundaries, and the no-hardcoding rule.
- High-blast-radius or explicitly verified implementation tasks also get required verification guidance and user-named commands when present.
- Read-only investigations get a `research` node with evidence and uncertainty criteria, but no forced edits or required tests.
- Simple chat, greetings, and capability questions do not get a graph, so the system does not overconstrain low-risk answers.

The active node is injected into model context with allowed tool classes, acceptance criteria, and verification method. This gives the model operational guidance while completion blockers still decide only on durable invariants such as missing required verification evidence.

## Verification Ladder

Match proof to risk:

1. No-tool reasoning: enough for trivial or low-risk responses.
2. Read-only evidence: file reads, docs, logs, schema inspection, and API descriptions.
3. Focused tests: unit tests, parser tests, renderers, command parsing, type assertions, or narrow regression tests.
4. Contract tests: public HTTP API, CLI calls, store behavior, permissions, persistence, and cross-package integration.
5. Rendered UI checks: screenshots, responsive viewport checks, interaction checks, and console health for user-facing UI.
6. Live model or real-usage smoke: only when the feature depends on the model or an actual user flow that fixtures cannot prove.
7. Live HTTP resume verifier: `scripts/live-agent-http-resume-verifier.mjs` for release-only proof that a real provider, built server, SQLite persistence, public HTTP task APIs, approvals, restart recovery, guidance consumption, checkpoints, and rollback work together.
8. SWE-bench-style agent evaluation: `scripts/swe-bench-style-agent-eval.mjs` for release-only proof that a real provider can repair isolated issue-style repositories from failing tests, use safe file tools, rerun tests, and satisfy hidden behavior checks without special-casing visible assertions.
9. Non-live suite: `npm.cmd run quality:full` for the repeatable local gate across lint, typecheck, unit, matrix, stress, build, docs, API, E2E, UI, artifact hygiene, and workflow guidance.
10. Release gate: `npm.cmd run quality:release` for release-level claims that require fresh live smoke, live HTTP resume proof, SWE-bench-style repair proof, source-fingerprint-matched UI evidence, and a dated release report. The dated report is generated evidence under `docs/reports/`, not a hand-maintained source document.

## What Counts As Evidence

Evidence is useful only when it covers the preserved acceptance criteria. A green command is not proof by itself.

Good evidence examples:

- A failing test that would fail for narrow special-casing, followed by a passing implementation.
- A built CLI command calling the real server API, followed by a list or show query confirming mutation.
- A screenshot or browser check showing the actual rendered UI state at the relevant viewport.
- A live HTTP verifier run that creates a natural task through the public API, approves tools through the API, restarts the server against the same SQLite database, appends guidance, and verifies checkpoints plus rollback.
- A quality report whose source fingerprint matches the current worktree.
- A generated release report whose JSON inputs all match the same current source fingerprint.

Weak evidence examples:

- A fixture-only flow when a real API path is available.
- A test that asserts one exact generated answer instead of the general behavior.
- A stale report with a mismatched source fingerprint.
- A historical generated report copied into a release without regenerating it from the current checkout.
- A passing command whose scope does not cover the changed behavior.

## Anti-Overconstraint Guardrails

The model should not be punished for choosing a lighter path when it is appropriate. A validation gate should fail only when it protects a durable product invariant, such as:

- The system prompt stops warning against hardcoded test-only behavior.
- The system prompt starts forcing tools, plans, tests, screenshots, or live flows for every request.
- The verification guidance stops distinguishing low-risk answers from high-risk product changes.
- The quality suite stops covering real product surfaces that are already available.
- The non-live gate starts requiring live provider credentials for routine development instead of reserving that requirement for explicit release validation.

If ideal verification is unavailable or disproportionate, use the strongest practical proof and state the remaining risk plainly.
