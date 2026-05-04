# SCC Frontend Deployment And Migration Notes

Date: 2026-05-03

## Scope

This refactor does not require a destructive data migration. It adds governance endpoints and frontend management screens around existing improvement and skill storage.

## Added API Surface

- `GET /experience`
- `POST /experience`
- `GET /experience/:id`
- `PUT /experience/:id`
- `DELETE /experience/:id`
- `POST /experience/bulk-delete`
- `GET /experience/export?format=json|markdown`
- `POST /experience/:id/promote-skill`
- `POST /skills/bulk-delete`
- `GET /skills/export?format=json|markdown`

## Data Strategy

- Existing generated experience proposals remain the source for approved records.
- Manually created experience records are materialized under generated experience storage with an `experience.md` body.
- Skill promotion creates a managed generated skill through the existing skill service.
- Exports are non-mutating:
  - JSON export is intended for migration, audit, and import tooling.
  - Markdown export is intended for human review.

## Rollout Steps

1. Build backend and frontend.
2. Start the local stack.
3. Open Settings > Governance.
4. Verify experience list, create/edit/delete, bulk delete, JSON export, Markdown export, and promote-to-skill.
5. Open Tasks.
6. Verify restart is absent from discussion UI.
7. Start or select a running task and submit guidance.
8. Verify the guidance appears as pending and clears after the backend conversation includes it.

## Rollback

- Frontend rollback is route-level: remove `/settings/governance` and the new Settings tab.
- Backend rollback is API-level: remove the added route handlers and facade methods.
- No existing task or skill restart/recovery storage shape is changed by this pass.

## CI Gate

The intended CI sequence is:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run test:unit -w frontend
npm.cmd run smoke:frontend
npm.cmd run e2e:frontend
```

If stack-level frontend smoke or E2E is unavailable in a developer environment, record the blocker and keep the deterministic Vitest suite green.
