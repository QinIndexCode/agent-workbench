---
description: Prevent validation harness and scenario-specific behavior from redefining the SCC-Batch core.
paths: backend/src, frontend/src, scripts, backend/docs, docs(knowlage), .scc
---
Treat `docs(knowlage)/DigDeeper.md` as the north-star design for the core engine: semantic contracts, planner/batch DAG execution, minimal context, tool evidence, correction loops, and verifiable completion.

Keep the product layers separate:

1. Core Engine: domain/runtime contracts, parser, planner/batch execution, context policy, state transitions, tool evidence, and acceptance gates.
2. Operator Plane: Web/CLI control surfaces, human review, task discussion, archive, and experience review.
3. Ecosystem Plane: provider, MCP, skills, tool health, and workspace workflow visibility.
4. Validation Harness: scenario packs, real-task wave runners, release scorecards, live-provider probes, benchmark repair policies, and scenario artifact audits.

Do not move scenario-specific behavior into the Core Engine. Database-lab rules, Xiaomi provider details, benchmark-specific repair tactics, and real-task-wave continuation policies must stay behind scenario-pack or harness boundaries.

Generic runtime changes are acceptable when they improve all tasks: structured tool result feedback, invalid tool JSON correction, context compression that preserves truth, replayable evidence, consistent Web/CLI/API projections, and operator guidance that cannot weaken runtime correction.

When a change could fit both a generic runtime path and a scenario path, default to the scenario path until there is cross-scenario evidence and an explicit architecture update.
