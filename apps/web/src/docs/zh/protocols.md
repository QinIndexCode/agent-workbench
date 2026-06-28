# Agent 通用协议

本页说明 Agent Workbench 如何理解 **Loop Engineering**、MCP 和 A2A。核心原则是：把已经实现的能力写清楚，把生态协议边界写清楚，不把规划中的适配伪装成已交付功能。

## Loop Engineering

Loop Engineering 是 Agent Workbench 的运行时工程约束，不是固定流程脚本。一个高质量任务应该在同一条任务时间线里闭合这些环节：

1. **Observe**：读取当前目标、文件、配置、历史、附件和工具证据。
2. **Plan**：在不窄化用户目标的前提下，选择最小可行执行路径。
3. **Act**：通过内置工具或已发现 MCP 工具行动；所有高风险动作进入审批。
4. **Verify**：用读回、测试、截图、API 查询或真实任务证据确认结果。
5. **Reflect**：把成功模式和失败原因记录为 Task Memory、Pattern 或候选 Skill。
6. **Persist / Stop**：保存状态、附件、检查点和最终结论；如果证据不足，明确说明剩余风险。

这个闭环不要求每个简单问题都使用工具，也不允许为了通过某个测试而硬编码固定答案。验证强度应随风险上升：聊天解释可以轻量，代码修改、外部事实、GUI、CLI、权限、模型调用和发布判断必须有当前证据。

为了控制成本，Loop Engineering 还必须保持 Prompt Cache 友好：稳定系统指令、Skill metadata、项目上下文和工具名称族应尽量位于请求前部，任务特有证据放在后部；不能为了提高命中率删除工具 schema、隐藏证据或降低验证质量。目标是缓存命中率和任务质量同时成立，而不是用少发上下文换取虚假的低成本。

## MCP 与 A2A 的区别

| 协议 | 解决的问题 | 在 Agent Workbench 中的状态 |
| --- | --- | --- |
| MCP | Agent 到工具、数据源和外部工作流的连接 | 已支持配置式 stdio 与 streamable HTTP 工具发现、`tools/list`、`tools/call`，并进入同一套风险审批和时间线证据 |
| A2A | Agent 到 Agent 的发现、委托、消息、任务状态和 artifact 交换 | 作为生态对齐方向记录；当前没有宣称已暴露 A2A server 或完整 A2A client |
| AGENTS.md | 仓库内给编码 Agent 的行为说明 | 可作为项目约束文档使用，但不是网络互操作协议 |

简化理解：**MCP 让一个 Agent 知道可以用什么工具，A2A 让不同厂商、不同框架的 Agent 可以互相发现和协作。**

## 当前 A2A 生态口径

Google 在 2025-04-09 发布 Agent2Agent（A2A）协议，定位为开放的 Agent 互操作协议。A2A 后续被捐赠给 Linux Foundation，并由 AWS、Cisco、Google、Microsoft、Salesforce、SAP、ServiceNow 等参与的 Agent2Agent 项目推进。Microsoft 公开表示支持 A2A，并在 Azure AI Foundry / Copilot Studio 方向提供 A2A 能力。

这意味着项目文档应写成“对齐 A2A 生态，后续可实现 A2A adapter”，而不是写成“Agent Workbench 已完整支持 A2A”。

## 后续实现 A2A adapter 时的验收边界

如果要把 Agent Workbench 暴露为 A2A 端点，至少需要同时满足：

- **Agent Card**：只暴露可公开的能力、输入模式、认证要求和服务端点。
- **Task lifecycle**：把外部任务映射到内部 task status、pending approval、completed、failed、cancelled。
- **Messages and artifacts**：把 A2A message、part、artifact 映射到时间线、附件和 transcript。
- **Auth and audit**：所有远程调用必须有认证、request id、审计日志和敏感字段脱敏。
- **Approval mapping**：外部 Agent 请求的文件、shell、网络、MCP 或 destructive 行为仍必须走 Agent Workbench 权限引擎。
- **Loop evidence**：远程任务不能只返回最终文本；需要保留可读证据，支持用户回看。

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
