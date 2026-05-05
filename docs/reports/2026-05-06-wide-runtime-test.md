# SCC wide runtime and product-surface test report

Date: 2026-05-06

## Scope

This pass covered the runtime, settings, model provider, permissions, MCP, library, skill lifecycle, reflection, history deletion, and real task workbench flows. Tests used the isolated E2E database at `data/e2e-workbench.sqlite`; the real task history and Skill data were not used as the default test target.

## Changes verified

- Mimo Provider bootstrap: when the Provider table is empty and the local API key document contains a complete Mimo configuration, the server creates one encrypted `ModelProviderRecord`, marks it active, and exposes only masked key metadata.
- Provider safety: API keys are encrypted through the existing secret store; frontend responses include `apiKeyRef.last4` only.
- Browser CORS: explicit `GET/POST/PATCH/DELETE/OPTIONS` support was added so real browser edit/delete flows work across the Vite and API ports.
- Runtime closure: the default SQLite store is closed with the Fastify app, preventing Windows test cleanup failures from locked temp files.
- E2E coverage: host observation approval, global permission reuse, model provider add/edit-modal/delete, MCP add/delete, Skill create/edit-modal/delete, Knowledge create/delete, reflection trigger, History delete, and mobile task approval flow.

## Results

- `npm.cmd run typecheck`: passed.
- `npm.cmd test`: passed, 4 files / 54 tests.
- `npm.cmd run build`: passed.
- `npm.cmd run check:no-old-control`: passed, no legacy control-chain terms found.
- `npm.cmd run test:e2e`: passed, 4 executed / 2 intentionally skipped mobile management tests.

## Findings fixed

- Browser PATCH/DELETE requests were not reliable before this pass because CORS did not explicitly list non-simple methods. This made model editing, MCP deletion, task deletion, and other management actions look clickable while the API action did not complete. Fixed in the server CORS configuration.
- Default SQLite runtime instances did not close during Fastify shutdown. This caused `EPERM` cleanup failures on Windows temp directories in startup/bootstrap tests. Fixed by registering a runtime close hook.
- Local API key parsing did not expose provider section metadata, making safe Mimo bootstrap awkward. Fixed by adding a provider-aware loader while preserving the existing secret-safe public config shape.

## Remaining risks

- Management CRUD is now covered on desktop. Mobile management screens are skipped intentionally; mobile coverage currently focuses on the primary task/approval flow.
- E2E uses a deterministic test model command and isolated database. A live Mimo smoke test should be run manually when validating network/model availability, but it must not log or expose API keys.
- Skill lifecycle tests confirm ordinary task completion records memory without immediate Skill solidification. More long-horizon tests are still needed for multi-day reflection quality and real user correction loops.

