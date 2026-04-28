# Practical Task Acceptance

This document describes the practical user-task acceptance layer that now sits on the default `engineering_floor`.

## Goal

The practical task layer exists to answer a stricter question than the engineering benchmark suites:

- can SCC finish real user-facing tasks, not just engineering-shaped scenarios
- can it handle ambiguous requests without bluffing
- can it produce artifacts that are usable with only minor edits

## Scope

The current suite covers eight families:

- `vague-blog-request`
- `explicit-blog-request`
- `vague-summary-request`
- `explicit-doc-request`
- `operator-report-task`
- `analysis-brief-task`
- `practical-engineering-change-task`
- `practical-review-task`

These families intentionally mix:

- content creation
- document transformation
- operator reporting
- analysis and recommendation writing
- repo-grounded engineering work
- finding-first review work

## Hybrid Clarify

Ambiguous tasks are evaluated with `Hybrid Clarify`, not with a “never ask” rule.

### High-risk ambiguity

If critical scope is missing, SCC must:

- surface what is known
- surface what is missing
- explain why direct delivery would be premature
- provide next questions or next actions

### Low-risk ambiguity

If the task is safe to draft directly, SCC may continue without blocking, but only if:

- assumptions are explicit
- the assumptions are visible in the artifact
- the summary does not pretend the missing context was known

## Acceptance Bar

Automatic acceptance requires:

- `passRate = 100%`
- `artifactQualityPassRate = 1`
- no `unknown` failure category
- correct `clarificationMode`
- correct `assumptionDisclosure`

Manual acceptance requires:

- all entries `passed`
- the `Ship-Ready With Minor Edits` bar

That bar means:

- the artifact answers the user intent
- the structure is immediately usable
- only light editing or stylistic polish should remain

## Fixtures

Fixture inputs live inside the repo under:

- `backend/fixtures/practical-tasks/`

The suite does not depend on ad-hoc network input or manual prompt tweaking.

## Relationship To Other Suites

This practical layer does not replace:

- `real_task_completion`
- `public_capability_parity`
- `manual_artifact_audit`

Instead, it complements them:

- `real_task_completion` proves SCC can finish complex repo tasks
- `public_capability_parity` proves SCC can reconstruct public OpenCode / Claude Code style task shapes
- `practical_task_acceptance` proves SCC can handle mixed real user tasks
- `practical_manual_audit` proves those outputs remain ship-ready under human review
