# SCC Frontend Refactor Progress And Debt

Date: 2026-05-03

## Completed In This Pass

- Corrected shadcn configuration drift by pointing `frontend/components.json` to `src/index.css`.
- Added reusable UI primitives for input, textarea, checkbox, table, tabs, separator, and spinner.
- Reworked task discussion controls:
  - removed visible restart action from discussion UI,
  - replaced send text control with circular up-arrow icon control,
  - added square pause control,
  - added spinner loading states,
  - added running-task guidance,
  - added pending guidance rendering before backend confirmation.
- Removed frontend validation selectors that expected `task-action-restart`.
- Added governance APIs for experience CRUD, experience export, promotion, skill bulk delete, and skill export.
- Added Settings > Governance workbench for experience and skill management.
- Removed `frontend/src/patches/task-progress.patch`.

## Current Architecture Decisions

- Backend restart capability stays available for diagnostic and recovery flows outside TaskDiscussion.
- A backend `restart_task` primary action in task metadata is displayed as repair guidance in the discussion composer, not as a restart button.
- Experience records are governance data, not a direct unsafe file editor.
- Export formats are JSON manifest and Markdown bundle.
- Skills are managed assets. Bulk delete is limited to entries the skill service allows to remove.

## Debt Register

| Priority | Debt | Mitigation |
| --- | --- | --- |
| P0 | `TasksPage` remains a large module. | Extract task list, thread timeline, composer, inspector, and action model after current UI contract is stable. |
| P0 | Frontend coverage was previously script-heavy and not component-focused. | Add Vitest and React Testing Library coverage for the new task action and governance contracts. |
| P1 | Legacy `TaskDetailPane` still exists as a non-primary surface. | Keep until route ownership is fully proven, then remove or convert to a small reusable inspector. |
| P1 | Some handwritten icons remain. | Replace high-traffic actions with Lucide first, then remove unused icon exports. |
| P1 | Settings still has several local admin patterns. | Consolidate forms around shared admin primitives after governance flows are validated. |
| P2 | Full browser E2E coverage requires the backend stack. | Keep smoke/e2e stack scripts and add deterministic mocked component coverage for fast CI. |

## Validation Targets

- `npm.cmd run typecheck -w frontend`
- `npm.cmd run build -w frontend`
- `npm.cmd run test:unit -w frontend`
- `rg "task-action-restart|unexpectedRestart|Restart task" frontend/src frontend/scripts`
- Backend typecheck for governance endpoint additions.

## Open Follow-Up

The next refactor pass should split `TasksPage` into smaller modules. This pass intentionally kept most task logic in place to avoid mixing the UI contract change with a large ownership move.
