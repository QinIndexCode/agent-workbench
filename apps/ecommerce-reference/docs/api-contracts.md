# API Contracts

## Payment webhook

- verify provider signature before any state mutation
- use provider event id as the idempotency key
- duplicate delivery must be acknowledged without double authorization
- write audit + `order.payment_authorized` event only on first acceptance

## Refund flow

- refund requests are recorded before compensation executes
- compensation releases inventory, emits `order.refunded`, and writes audit
- replayed refund commands must not restock inventory twice

## Search and analytics

- search indexing consumes immutable order projection updates
- analytics consumes order events from async topics, never from synchronous write APIs
