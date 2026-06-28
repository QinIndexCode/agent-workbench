# Agent Protocols

This page explains how Agent Workbench treats **Loop Engineering**, MCP, and A2A. The rule is simple: document implemented behavior as implemented behavior, document protocol alignment as alignment, and do not present planned adapters as shipped product capability.

## Loop Engineering

Loop Engineering is the runtime discipline behind Agent Workbench. It is not a fixed script. A strong task should close these phases inside the same visible timeline:

1. **Observe**: read the current goal, files, configuration, history, attachments, and tool evidence.
2. **Plan**: choose the smallest responsible path without narrowing the user's real objective.
3. **Act**: use built-in tools or discovered MCP tools; risky actions go through approval.
4. **Verify**: confirm results through read-back, tests, screenshots, API queries, or real task evidence.
5. **Reflect**: record useful outcomes and failures as Task Memory, Patterns, or candidate Skills.
6. **Persist / Stop**: save state, attachments, checkpoints, and the final answer; if proof is incomplete, state the remaining risk.

The loop does not force tool use for every simple answer, and it must never hardcode one benchmark prompt or expected string. Verification should scale with risk: a low-risk explanation can stay light, while code edits, external facts, GUI work, CLI behavior, permissions, model calls, and release judgments need current evidence.

To control cost, Loop Engineering must also stay prompt-cache friendly: stable system instructions, Skill metadata, project context, and tool-name families should remain near the front of requests, while task-specific evidence stays later. Do not improve cache hit rate by dropping tool schemas, hiding evidence, or weakening verification. The target is cache efficiency and task quality together, not cheaper prompts that make the agent less capable.

## MCP vs A2A

| Protocol | Problem solved | Agent Workbench status |
| --- | --- | --- |
| MCP | Agent-to-tool, data-source, and workflow connection | Implemented for configured stdio and streamable HTTP discovery, `tools/list`, and `tools/call`, with the same approval and timeline evidence path as built-in tools |
| A2A | Agent-to-agent discovery, delegation, messages, task state, and artifact exchange | Tracked as ecosystem alignment; Agent Workbench does not currently claim a shipped A2A server or full A2A client |
| AGENTS.md | Repository-local guidance for coding agents | Useful as project instructions, but it is not a network interoperability protocol |

Short version: **MCP tells an agent what tools it can use. A2A lets independent agents from different vendors or frameworks discover and collaborate with each other.**

## Current A2A ecosystem wording

Google announced Agent2Agent (A2A) on 2025-04-09 as an open agent interoperability protocol. A2A was later donated to the Linux Foundation and is developed through the Agent2Agent project with participants including AWS, Cisco, Google, Microsoft, Salesforce, SAP, and ServiceNow. Microsoft has publicly announced A2A support for Azure AI Foundry and Copilot Studio directions.

So project documentation should say "aligned with the A2A ecosystem and ready for a future adapter boundary", not "Agent Workbench fully supports A2A today."

## Adapter acceptance boundary

If Agent Workbench later exposes an A2A endpoint, that adapter should satisfy at least:

- **Agent Card**: expose only public capabilities, input modes, authentication requirements, and service endpoints.
- **Task lifecycle**: map remote tasks to internal task status, pending approval, completed, failed, and cancelled states.
- **Messages and artifacts**: map A2A messages, parts, and artifacts to timeline events, attachments, and transcripts.
- **Auth and audit**: require authentication, request ids, audit logging, and sensitive-field redaction for remote calls.
- **Approval mapping**: remote requests for file, shell, network, MCP, or destructive actions still pass through the Agent Workbench permission engine.
- **Loop evidence**: remote tasks should not return only final text; they must preserve readable evidence for user review.

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
