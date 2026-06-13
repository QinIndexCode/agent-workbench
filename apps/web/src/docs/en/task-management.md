# Task Management

A task is the core organizational unit in Agent Workbench; each task corresponds to an independent session context.

## Creating Tasks

- Click the **New Task** button in the sidebar to create a task
- New tasks appear in the sidebar task list
- Click a task title to switch to that session

## Goal Mode

Use `/goal <request>` when you want the agent to pursue a verified outcome instead of a short answer. Goal mode runs longer, keeps acceptance criteria and tool progress visible, and continues through exploration, implementation, and verification until the task completes or pauses on limits, permissions, provider failure, or user interruption.

Starting `/goal` always opens a confirmation dialog. Read the warning carefully: this mode may spend more model quota, read or write files repeatedly, run shell commands, and access the network. The **Full risk** option can globally allow destructive actions such as delete, overwrite, and process termination, and requires an extra acknowledgement before it can start.

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
