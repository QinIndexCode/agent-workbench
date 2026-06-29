# Task Management

A task is the core organizational unit in Agent Workbench; each task corresponds to an independent session context.

## Creating Tasks

- Click the **New Task** button in the sidebar to create a task
- New tasks appear in the sidebar task list
- Click a task title to switch to that session

## Goal Mode

Use `/goal <request>` when you want the agent to pursue a verified outcome instead of a short answer. Goal mode runs longer, keeps acceptance criteria and tool progress visible, and continues through exploration, implementation, and verification until the task completes or pauses on limits, permissions, provider failure, or user interruption.

Starting `/goal` always opens a confirmation dialog. Read the warning carefully: this mode may spend more model quota, read or write files repeatedly, run shell commands, and access the network. The **Full risk** option can globally allow destructive actions such as delete, overwrite, and process termination, and requires an extra acknowledgement before it can start.

## Input Commands

Type `/` on the first input line to see available commands. Commands only change how the current request enters the existing task system; they do not bypass permissions, model configuration, attachment handling, or server APIs.

### `/goal <request>`

Creates a goal-mode task. Use it for repair-and-verify work, deep audits, feature completion, long-running tests, or any task that should keep moving toward verified completion. A permission confirmation is required before it starts.

### `/plan <request>`

Creates or appends a plan-first request. The agent should produce a visible plan, acceptance criteria, risks, and confirmation questions, then wait for you before implementation. It does not enter goal mode and does not automatically allow file writes, shell commands, or network access.

### `/review <scope>`

Submits the request as a strict review. The agent should lead with reproducible issues, risks, regressions, and missing tests, then fix confirmed issues.

### `/verify <target>`

Verifies the current state with evidence first. Use it to check whether a feature, fix, CLI command, or document is actually working, with residual risk called out.

### `/debug <issue>`

Runs a debugging loop: reproduce or localize the symptom, find the smallest root cause, fix it, and regression-test it.

### `/research <question>`

Use this for current external facts or local research. Time-sensitive information should be checked online; local project facts should cite real files, APIs, or test evidence.

### `/doc <request>`

Creates or updates documentation after checking the current implementation and existing doc boundaries. It should not present plans as shipped facts or overstate protocol/tool support.

### `/knowledge [question]`

Without arguments, opens **Library → Knowledge**. With a question, submits a Knowledge request that uses `knowledge_search` when saved background material is needed and verifies live source files separately.

### `/memory [request]`

Without arguments, opens **Library → Memory**. With a request, checks or organizes durable memory, keeping only stable, reusable, confirmed information.

### `/skill [request]`

Without arguments, opens **Library → Skills**. With a request, checks Skill duplicates, conflicts, applicability, and whether a skill should be created or merged.

### `/cache [scope]`

Checks LLM request cache hit rate, provider configuration, and request assembly. This must preserve task quality; do not remove necessary tools, context, or verification just to improve cache hits.

### Navigation commands

- `/docs` opens Docs
- `/settings` opens Settings
- `/model` opens Model Providers
- `/permissions` opens Permissions
- `/search` opens Web Search provider settings
- `/mcp` opens MCP settings
- `/integrations` opens Integrations
- `/schedule` opens Scheduled Tasks
- `/prefs` opens Preferences
- `/curator` opens Curator

### `/help`

Opens this task-management documentation with the current command list and boundaries.

### `//`

Use `//` when you want to send ordinary text that begins with `/`. Agent Workbench sends it as a normal message instead of parsing it as a command.

## Task History

- All task sessions are saved automatically
- The sidebar task list supports scrolling
- Click a task to view its full message history

## Execution Flow

1. User sends a message
2. System assembles context (history + current input + attachments)
3. Model generates a response
4. If the response includes tool calls, the system handles them per the permission policy
5. Tool results are returned to the model for continued generation
6. Final result is presented to the user
