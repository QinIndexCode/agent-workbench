# Architecture Notes

The preserved design files are treated as source material:

- `docs(knowlage)/DigDeeper.md` contributes simple composition, transparent execution, tool contracts, and minimal context.
- `docs(knowlage)/experience.md` contributes progressive disclosure, model autonomy under guardrails, risk-based approvals, traceability, and experience-to-skill growth.

## Runtime Flow

```mermaid
flowchart LR
  U["User goal or guidance"] --> C["Context builder"]
  C --> M["Agent model"]
  M --> A{"Tool needed?"}
  A -->|No| R["Assistant result"]
  A -->|Yes| P["Risk classification"]
  P --> H{"Approved?"}
  H -->|Pending| W["Pause for user decision"]
  H -->|Allowed| T["Execute tool"]
  T --> E["Tool evidence"]
  E --> C
```

## Safety Boundary

The system never blocks a task because it failed a fixed task script. It only pauses for real operational risk: host observation, workspace read, workspace write, shell, network, or destructive actions.

## Learning Boundary

Completed tasks generate experience records. Read-only records can become enabled skills automatically. Records involving side effects remain drafts until reviewed.
