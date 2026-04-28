# Frontend Validation Report

This report captures the current frontend validation posture after adding both a browser-driven smoke runner and a strict browser E2E gate.

## Verified On April 1, 2026

- frontend builds successfully from the workspace root
- backend API handoff and frontend integration guides remain aligned on REST-first truth
- `Dashboard`, `Tasks`, `Queue`, and `Settings` routes load under a live Vite dev server
- browser smoke validation passes on `390 / 768 / 1280 / 1600` widths
- no console failures remain in the smoke run after fixing the missing favicon resource
- task explorer and inspector scroll visibility checks pass in layouts where they are expected to render
- settings nested routes (`general / connections / capabilities / skills / state`) load without runtime errors
- legacy compatibility routes `/settings/providers` and `/settings/secrets` redirect to `/settings/connections` without runtime errors
- browser E2E now passes for task creation and mutation flows:
  - pause / resume / completion
  - approval approve
  - approval reject
  - artifact routing apply with operator-selected destination

## Validation Method

- script: `npm run smoke:frontend`
- implementation: `frontend/scripts/smoke-validate.mjs`
- report artifact: `.codex-run/logs/frontend-smoke-report.json`
- browser engine: system Chrome via `playwright-core`

- script: `npm run e2e:frontend`
- implementation: `frontend/scripts/task-e2e-validate.mjs`
- report artifact: `.codex-run/logs/frontend-e2e-report.json`
- browser engine: system Chrome via `playwright-core`

## Current Smoke Coverage

- route load and non-blank page verification
- framework error-overlay detection
- console/page/request failure capture
- dashboard page render
- queue page render
- settings page render and nested route navigation
- compatibility redirects for `/settings/providers` and `/settings/secrets`
- tasks page render
- task inspector toggle and scroll check
- task explorer bottom-item visibility check on desktop-width layouts

## Current E2E Coverage

- create task from the browser UI
- start a task and observe runtime state changes
- pause and resume a running task
- resolve approvals through the Approvals rail
- observe `destination_path_required`, choose a project-relative destination, apply artifacts, and continue to completion
- confirm summary / events / artifact state stay aligned with backend truth

## Remaining Frontend Gaps

- layout validation is broad and practical, but not yet a pixel-perfect regression suite
- manual operator UX review is still useful for density, copy polish, and advanced long-content behavior

## Current Conclusion

Frontend interaction is no longer untested. It is now:

- build-validated
- typecheck-validated
- browser-smoke-validated

The remaining work is hardening and deeper interaction coverage, not basic route viability.
