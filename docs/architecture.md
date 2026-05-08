# SCC Agent Workbench Architecture

> 完整文档导航见 [README.md](README.md)。
>
> 本文以当前代码为准。`DigDeeper.md` 是愿景和研究约束，不是已交付清单；当文档和实现冲突时，优先相信源码、测试和真实任务行为。

## Current Product Boundary

SCC 当前实现的是本地 Agent Workbench，而不是脚本门禁系统，也不是完整的多平台 Agent 云。系统职责收敛为：

- 组装上下文，让模型看到必要目标、历史、工具证据、文件状态和相关 skill metadata。
- 暴露工具，并按风险类别做审批。
- 记录事件流，形成用户可见 timeline。
- 在任务完成后生成 Task Memory、Pattern、Skill 方向的数据。
- 提供前端工作台、权限面板、学习面板和轻量任务线程。

系统不做这些事：

- 不用 scenario pack、quality gate、固定 JSON、固定报告模板判断普通任务是否完成。
- 不把工程测试或脚本输出当作任务完成判官。
- 不声称当前已完成 Python SDK、OpenTelemetry 全量兼容或多消息平台网关。MCP 当前覆盖已配置的 stdio 与 streamable HTTP 工具发现/调用，不等同于完整远程 auth 或资源模板平台。

## Runtime Loop

```mermaid
flowchart LR
  U["User goal / guidance"] --> C["ContextAssembler"]
  C --> M["ModelClient"]
  M --> D{"Next turn"}
  D -->|final answer| R["assistant_message + completed"]
  D -->|tool calls| P["PermissionEngine"]
  P --> G{"Global grant?"}
  G -->|yes| X["Execute tool"]
  G -->|no| T{"Task grant?"}
  T -->|yes| X
  T -->|no| A["approval_pending + waiting_approval"]
  A --> H["User decision"]
  H -->|allow_once| X
  H -->|allow_for_task| S["Persist task approval"] --> X
  H -->|allow_globally| GP["Persist global grant"] --> X
  H -->|deny| C
  X --> E["tool_result evidence"]
  E --> F["FileStateTracker update"]
  F --> C
```

## Main Components

| Component | Current implementation | Notes |
| --- | --- | --- |
| HTTP API | `apps/server/src/server.ts` | Fastify routes for tasks, messages, approvals, global permissions, preferences, memories, patterns, skills, reflections, project memories. |
| Persistence | `apps/server/src/sqlite-store.ts` | SQLite key-value namespaces. Good enough for local workbench; not yet a relational query model. |
| Runtime | `packages/core/src/workbench.ts` | Simple model/tool/approval/evidence loop. This is the product source of truth. |
| Context | `packages/core/src/context-assembler.ts` | System layer, loaded skills, skill metadata, project memory, file state table, truncated history. |
| Permissions | `packages/core/src/permission-engine.ts` | Risk-category classifier plus task/global grants. Deterministic safety boundary, not task-quality logic. |
| Tools | `packages/core/src/tools.ts`, `packages/core/src/mcp.ts` | Built-in tools plus configured MCP tools. File writes require `expectedHash`; MCP calls use the same evidence and approval path. |
| Model | `packages/core/src/openai-model.ts` | OpenAI-compatible chat completions and function tools. Uses API key document or env vars. |
| Learning | `packages/core/src/experience.ts` | Task Memory, Experience, Pattern, Skill promotion heuristics. Early-stage and intentionally conservative. |

## Permissions

Approval order is fixed:

1. Global risk-category grant.
2. MCP approval preference for MCP tools.
3. General auto-approval preference for non-MCP tools.
4. Existing task-scoped approval grant.
5. Pending approval UI.
6. Denied result goes back into context for the agent to choose another path.

Risk categories are:

- `host_observation`
- `workspace_read`
- `workspace_write`
- `shell`
- `network`
- `destructive`

Global grants are persisted. Task-scoped grants are stored on the task approval record and rehydrated by the runtime. Preference-based auto approval never bypasses `destructive`; only an explicit global grant can do that.

## Context Assembly

The current ContextAssembler emits:

1. System instructions.
2. Previously loaded full skill bodies.
3. Relevant skill metadata.
4. Project memory.
5. File state table.
6. Recent task history and current input.

Task Memory is never directly injected. Skill metadata may be injected; full skill content is loaded only through `use_skill`.

## Learning Boundary

Learning is advisory. A skill is a reusable hint, not a hidden policy engine and not a completion judge.

Current behavior:

- Every completed task creates Task Memory and Experience.
- Read-only successful experiences can become active skills.
- Side-effect experiences remain candidate skills.
- Reflection can aggregate memories into patterns and promote stable patterns.

Known limitations:

- Skill conflict handling is mostly design-level, not a complete product workflow.
- Skill success/failure stats are not yet updated from future real use.
- Reflection is heuristic and local; it is not yet a robust review-agent process.

## MCP Boundary

Current implementation discovers configured MCP servers over stdio or streamable HTTP, converts `tools/list` schemas into model tool definitions, routes `tools/call` through risk approval, and records results as normal `tool_result` evidence.

Still partial: resource templates, remote auth negotiation, marketplace-style discovery, and broader server lifecycle management are not product-complete.

## Validation

Allowed validation:

- Typecheck.
- Unit/integration tests.
- Build.
- E2E/smoke tests.
- Real task execution and user review.

Disallowed validation:

- Scripts that decide ordinary task quality.
- Prompt injection that forces fixed JSON, report files, quality evidence files, or scenario-specific reports.
- Hidden hardcoded task paths that make one benchmark pass while reducing generality.

Scripts can exist as engineering tests or optional tools. They do not control agent completion.
