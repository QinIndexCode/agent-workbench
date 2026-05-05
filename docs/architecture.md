# Architecture Notes

> 完整文档导航见 [README.md](README.md)（实现标准总目录）。

The preserved design files are treated as source material:

- `docs/DigDeeper.md` contributes simple composition, transparent execution, tool contracts, and minimal context.
- `docs/experience.md` contributes progressive disclosure, model autonomy under guardrails, risk-based approvals, traceability, and experience-to-skill growth.

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

## Component Interaction (Full Task Lifecycle)

```mermaid
sequenceDiagram
    participant U as User
    participant CA as ContextAssembler
    participant MI as ModelInvoker
    participant CP as ContractParser
    participant CV as ContractValidator
    participant SM as SnapshotManager
    participant EH as ErrorHandler
    participant MS as MemorySystem

    U->>CA: task goal + events
    CA->>CA: buildSystemLayer()
    CA->>CA: buildSkillMetaLayer(task)
    CA->>CA: buildFileStateTable()
    CA->>CA: buildHistoryLayer(task, budget)
    CA->>MI: assemble(systemPrompt, input)

    MI->>MI: chat.completions.create()
    MI-->>MI: [streaming chunks]
    MI->>CP: raw response text

    CP->>CP: split by UNIT_ID markers
    CP->>CP: extract output fields

    CV->>CP: validate per unit
    alt format error
        CV->>EH: format_error(unit, fields)
        EH->>MI: retry with fix prompt
    else contract violation
        CV->>EH: violation(unit, clause)
        EH->>MI: retry with reinforced contract
    else dependency missing
        CV->>EH: dependency_missing(unit, upstream)
        EH->>MI: retry upstream unit
    else all valid
        CV->>SM: commit validated snapshots
        SM->>SM: persist unit outputs (GLOBAL/DEPENDENCY/PRIVATE)
    end

    CV-->>U: final validated result

    opt task completed
        SM->>MS: generate TaskMemory
        MS->>MS: save task memory (pending reflection)
    end
```

## Safety Boundary

The system never blocks a task because it failed a fixed task script. It only pauses for real operational risk: host observation, workspace read, workspace write, shell, network, or destructive actions.

## Learning Boundary

Completed tasks generate experience records. Read-only records can become enabled skills automatically. Records involving side effects remain drafts until reviewed.
