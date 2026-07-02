# Memory

Memory is the durable background Agent Workbench carries across tasks.

## The two documents

- **USER.md**: your personal working preferences and durable behavior notes
- **MEMORY.md**: project-level notes for the current folder

## Structured project memories

Use structured memory items for facts that should stay searchable and categorized, such as:

- architecture choices
- tech stack notes
- business logic constraints
- repo conventions

## Context layers

Agent Workbench separates context by lifetime:

- **Core system**: permanent agent rules and safety boundaries, never compressed
- **Durable memory**: USER.md, project MEMORY.md, structured project memories, and loaded reusable skills
- **Recent session**: an auditable summary plus a raw sliding window of the latest conversation and tool evidence
- **Immediate work**: current turn, Knowledge/RAG pointers, attachments, Known Files, approvals, and active continuity

Knowledge search results and auto-injected Knowledge briefs belong to the immediate work layer. They help the next action, but they are not written back to memory unless you explicitly ask for durable memory to change.

Before each model request, the runtime estimates the context window. At about 70% usage it trims low-value raw detail, at 85% it updates the session summary, and at 95% it bounds large tool logs so the current turn can still complete.

## Keep memory clean

- remove one-off task results
- keep statements short and reusable
- compact `MEMORY.md` when it starts repeating itself
