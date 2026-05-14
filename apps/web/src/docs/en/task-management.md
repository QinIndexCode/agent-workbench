# Task Management

A task is the core organizational unit in Agent Workbench; each task corresponds to an independent session context.

## Creating Tasks

- Click the **New Task** button in the sidebar to create a task
- New tasks appear in the sidebar task list
- Click a task title to switch to that session

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
