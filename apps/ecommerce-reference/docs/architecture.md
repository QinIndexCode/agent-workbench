# Ecommerce Architecture

## Boundaries

- `web/storefront`: buyer-facing browse, cart, checkout, account
- `web/admin`: promotions, catalog, fulfillment, refunds, customer-service operations
- `src/domain`: order, payment, inventory, promotion, refund, membership
- `src/application`: checkout orchestration, search indexing, analytics, operator workflows
- `src/infrastructure`: event bus, audit log, cache/read-model, deployment adapters

## Non-negotiable production constraints

- `order`, `payment`, `refund`, and `inventory` state changes are idempotent
- external callbacks must verify signatures and tolerate replay
- every cross-domain transition writes audit and event records
- reporting and async flows are decoupled from the write path
- customer-service and operator actions must be reviewable after the fact

## Scale posture

This repository stays single-repo and layered for the first delivery milestone. Future split points are explicit:

- catalog/search
- checkout/payment
- order/inventory/fulfillment
- promotions/loyalty
- analytics/reporting
- operator tooling / customer-service
