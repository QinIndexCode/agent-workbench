# Migration Blueprint

## Phase 1

- single-repo layered system
- one logical database
- async event bus abstraction
- cache/read-model abstraction

## Phase 2

- separate search indexing workers
- isolate analytics ingestion
- introduce dedicated payment callback worker

## Phase 3

- split order/inventory/fulfillment write domain
- isolate promotions/loyalty evaluation
- separate customer-service operator APIs

## Guardrails

- do not split before idempotency and audit surfaces are proven
- preserve contract-first events before physical service extraction
