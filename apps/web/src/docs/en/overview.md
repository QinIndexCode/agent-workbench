# Agent Workbench

Agent Workbench is an Agent-oriented workbench for organizing task context, managing tool permissions, tracking event streams, and maintaining reusable capability modules.

## Architecture

The system consists of the following components:
- **Task Management**: Create, execute, and track task sessions
- **Context Assembly**: Organize user input, file attachments, and history into model-ready context
- **Tool Permissions**: Risk-grade tool calls and enforce confirmation or auto-execution per policy
- **Event Projection**: Present Agent execution as a timeline
- **Loop Engineering**: Close Observe, Plan, Act, Verify, Reflect, and Persist/Stop inside one visible task timeline
- **Protocol Boundary**: MCP connects tools; A2A connects agents. The product currently implements MCP tool integration and treats A2A as a future adapter boundary.

## Quick Start

1. Click **New Task** in the sidebar to create a session
2. Describe your request in the input box; text, file attachments, and voice input are supported
3. The model analyzes context and generates a response
4. If tool execution is needed, the system confirms or auto-executes per the current permission policy
5. Results are appended to the task timeline; you may follow up or correct

To understand external tools, browser/computer control, A2A, and MCP boundaries, read the **MCP** and **Agent Protocols** docs pages next.
