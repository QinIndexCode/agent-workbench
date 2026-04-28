# Ecommerce Delivery Baseline

- Treat order, payment, inventory, and refund as idempotent domains.
- Record audit + event evidence for every cross-domain state transition.
- Keep search, analytics, and reporting out of the synchronous checkout write path.
- Require explicit operator review for refund overrides, inventory force-release, and payment reconciliation.
