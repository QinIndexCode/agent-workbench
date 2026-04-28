---
description: Enforce idempotency on core transaction domains
---
Payment, refund, inventory, and order transition handlers must accept replay safely and expose the idempotency key they rely on.
