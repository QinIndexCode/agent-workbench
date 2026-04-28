# Observability

## Signals

- order lifecycle transition counts
- payment webhook replay count
- inventory reservation age and stale-release alarms
- refund compensation backlog
- admin operator action audit coverage
- search indexing lag
- analytics pipeline delay

## Alerts

- payment authorization mismatch
- missing audit record after state mutation
- dead-letter growth in async compensation topics
- cache projection lag beyond SLO

## Operator notes

- every high-risk action points to audit and event evidence
- customer-service cases link to order, refund, and fulfillment identifiers
