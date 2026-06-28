# Agent Protocols

This page only explains Agent Workbench interoperability boundaries with external agent and tool ecosystems. The rule is simple: document implemented protocol behavior as implemented behavior, document ecosystem alignment as alignment, and do not present runtime workflow guidance or planned adapters as shipped protocol capability.

## MCP vs A2A

**MCP**

Solves agent-to-tool, data-source, and workflow connection. Agent Workbench implements configured stdio and streamable HTTP discovery, `tools/list`, and `tools/call`, with the same approval and timeline evidence path as built-in tools.

**A2A**

Solves agent-to-agent discovery, delegation, messages, task state, and artifact exchange. Public Agent Card discovery is implemented; Agent Workbench does not currently claim a full A2A server or full A2A client.

**AGENTS.md**

Provides repository-local guidance for coding agents. It is useful as project instructions, but it is not a network interoperability protocol.

Short version: **MCP tells an agent what tools it can use. A2A lets independent agents from different vendors or frameworks discover and collaborate with each other.**

## Current A2A ecosystem wording

Google announced Agent2Agent (A2A) on 2025-04-09 as an open agent interoperability protocol. A2A was later donated to the Linux Foundation and is developed through the Agent2Agent project with participants including AWS, Cisco, Google, Microsoft, Salesforce, SAP, and ServiceNow. Microsoft has publicly announced A2A support for Azure AI Foundry and Copilot Studio directions.

So project documentation should say "Agent Card discovery is available and the project is aligned with the A2A ecosystem for a future adapter boundary" and avoid implying a complete A2A server/client is shipped today.

## Current Agent Card Discovery

The server exposes `/.well-known/agent-card.json` so other agents or orchestrators can discover the local Agent Workbench. The card contains only public information:

- name, description, version, and documentation URL
- a custom `local-http` supported interface that points to same-origin `/api`
- the `x-agent-workbench-session` authentication requirement, with clients expected to call `/api/session/bootstrap` first
- high-level task, workspace-tool, and memory/knowledge/skill capabilities
- `Cache-Control` and `ETag` headers for discovery caching

The discovery card does not include the real session token, API keys, SQLite paths, or local file paths. It also does not mean `/api` is a standard A2A JSON-RPC or HTTP+JSON task endpoint.

## Adapter acceptance boundary

If Agent Workbench later exposes an A2A endpoint, that adapter should satisfy at least:

- **Agent Card**: continue to expose only public capabilities, input modes, authentication requirements, and service endpoints.
- **Task lifecycle**: map remote tasks to internal task status, pending approval, completed, failed, and cancelled states.
- **Messages and artifacts**: map A2A messages, parts, and artifacts to timeline events, attachments, and transcripts.
- **Auth and audit**: require authentication, request ids, audit logging, and sensitive-field redaction for remote calls.
- **Approval mapping**: remote requests for file, shell, network, MCP, or destructive actions still pass through the Agent Workbench permission engine.
- **Evidence retention**: remote tasks should not return only final text; they must preserve readable evidence for user review.

## What not to conflate

- Webhook integrations turn external chat messages into tasks; they are not A2A.
- An MCP server can provide browser or computer-control tools, but it is still a tool connection, not a full agent task protocol.
- A2A does not replace MCP, Agent Workbench permissions, SQLite state, checkpoints, or the learning system.

## Sources reviewed

- [Google: Announcing the Agent2Agent Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol documentation](https://a2a-protocol.org/latest/)
- [Google Cloud donates A2A to Linux Foundation](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/)
- [Microsoft: Empowering multi-agent apps with A2A](https://www.microsoft.com/en-us/microsoft-cloud/blog/2025/05/07/empowering-multi-agent-apps-with-the-open-agent2agent-a2a-protocol/)
- [Model Context Protocol documentation](https://modelcontextprotocol.io/docs/getting-started/intro)
