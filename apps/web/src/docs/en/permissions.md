# Permissions

The permission system controls tool execution policy, managed by risk level.

## Permission Levels

### Ask
Request user confirmation before each tool execution. Suitable for:
- Handling sensitive data
- Operations that may affect the system
- Scenes where you need to know every step

### Read only
Read-only operations pass automatically; write operations still require confirmation. Suitable for:
- File reading and directory browsing
- Information query operations

### All
All risk categories are allowed globally. Suitable for:
- Repetitive, predictable tasks
- Established trusted workflows

Can be downgraded from All to a stricter level at any time.

## Risk Classification

The system classifies tool calls as follows:
- **Low risk**: Read, query, compute
- **Medium risk**: File modification, configuration change
- **High risk**: Delete, network request, system command
