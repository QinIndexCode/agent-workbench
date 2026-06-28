# Agent 通用协议

本页只说明 Agent Workbench 和外部 Agent / 工具生态之间的互操作协议边界。核心原则是：把已经实现的协议能力写清楚，把生态对齐方向写清楚，不把运行时工作流、产品方法论或规划中的 adapter 伪装成已交付协议。

## MCP 与 A2A 的区别

**MCP**

解决 Agent 到工具、数据源和外部工作流的连接。Agent Workbench 已支持配置式 stdio 与 streamable HTTP 工具发现、`tools/list`、`tools/call`，并让这些工具进入同一套风险审批和时间线证据。

**A2A**

解决 Agent 到 Agent 的发现、委托、消息、任务状态和 artifact 交换。Agent Workbench 已提供公开 Agent Card discovery；当前不宣称完整 A2A server 或完整 A2A client。

**AGENTS.md**

仓库内给编码 Agent 的行为说明，可作为项目约束文档使用，但不是网络互操作协议。

简化理解：**MCP 让一个 Agent 知道可以用什么工具，A2A 让不同厂商、不同框架的 Agent 可以互相发现和协作。**

## 当前 A2A 生态口径

Google 在 2025-04-09 发布 Agent2Agent（A2A）协议，定位为开放的 Agent 互操作协议。A2A 后续被捐赠给 Linux Foundation，并由 AWS、Cisco、Google、Microsoft、Salesforce、SAP、ServiceNow 等参与的 Agent2Agent 项目推进。Microsoft 公开表示支持 A2A，并在 Azure AI Foundry / Copilot Studio 方向提供 A2A 能力。

这意味着项目文档应写成“已提供 discovery card，并对齐 A2A 生态，后续可实现 A2A adapter”，不要暗示完整 A2A server/client 已经交付。

## 当前 Agent Card discovery

Server 暴露 `/.well-known/agent-card.json`，供其他 Agent 或编排器主动发现本地 Agent Workbench。该卡片只包含公开信息：

- 名称、描述、版本和文档地址。
- 自定义 `local-http` supported interface，指向同源 `/api`。
- `x-agent-workbench-session` 认证要求，提示客户端先调用 `/api/session/bootstrap` 获取进程内 token。
- 任务、工作区工具、记忆/知识/Skill 三类高层能力。
- `Cache-Control` 和 `ETag`，便于发现方缓存。

这个 discovery card 不包含真实 session token、API key、SQLite 路径或本地文件路径，也不表示 `/api` 已经是标准 A2A JSON-RPC / HTTP+JSON task endpoint。

## 后续实现 A2A adapter 时的验收边界

如果要把 Agent Workbench 暴露为 A2A 端点，至少需要同时满足：

- **Agent Card**：继续只暴露可公开的能力、输入模式、认证要求和服务端点。
- **Task lifecycle**：把外部任务映射到内部 task status、pending approval、completed、failed、cancelled。
- **Messages and artifacts**：把 A2A message、part、artifact 映射到时间线、附件和 transcript。
- **Auth and audit**：所有远程调用必须有认证、request id、审计日志和敏感字段脱敏。
- **Approval mapping**：外部 Agent 请求的文件、shell、网络、MCP 或 destructive 行为仍必须走 Agent Workbench 权限引擎。
- **Evidence retention**：远程任务不能只返回最终文本；需要保留可读证据，支持用户回看。

## 不应混淆的内容

- Webhook 集成把外部消息平台接入任务，不等于 A2A。
- MCP server 可以提供 browser 或 computer-control 工具，但它仍是工具连接，不是另一个 Agent 的完整任务协议。
- A2A 不替代 MCP，也不替代 Agent Workbench 自己的权限、SQLite 状态、检查点和学习系统。

## 参考来源

- [Google: Announcing the Agent2Agent Protocol](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol documentation](https://a2a-protocol.org/latest/)
- [Google Cloud donates A2A to Linux Foundation](https://developers.googleblog.com/en/google-cloud-donates-a2a-to-linux-foundation/)
- [Microsoft: Empowering multi-agent apps with A2A](https://www.microsoft.com/en-us/microsoft-cloud/blog/2025/05/07/empowering-multi-agent-apps-with-the-open-agent2agent-a2a-protocol/)
- [Model Context Protocol documentation](https://modelcontextprotocol.io/docs/getting-started/intro)
