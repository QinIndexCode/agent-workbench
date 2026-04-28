# Ecommerce Reference

Single-repo layered ecommerce reference system used by SCC to validate delivery readiness against a realistic retail platform shape.

## Scope

- Storefront and admin console surfaces
- Catalog, search, cart, checkout, order, inventory, payment, promotion
- Membership, customer account, fulfillment, refund/return
- Analytics, customer-service, operator tooling

## Why this exists

This app is not a toy storefront. It is a reference workspace that encodes the minimum engineering constraints needed before a system can be expanded toward high-volume commerce:

- idempotent payment, order, refund, and inventory flows
- auditable cross-domain state transitions
- explicit async/event boundaries
- cache/read-model separation
- operator actions and recovery guidance
- deployment and migration templates

## Run

```bash
npm run demo --prefix apps/ecommerce-reference
```

The demo executes an in-memory checkout, payment webhook replay, search indexing, analytics emission, customer-service case creation, and refund compensation flow.
