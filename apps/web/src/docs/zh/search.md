# 网络搜索

网络搜索页用于配置内置 `web_search` 工具可以选择的搜索 Provider。它不是单独的联网开关，真正的联网仍受 `network` 权限控制。

## 首次配置

1. 打开 **设置 → 网络搜索**。
2. 点击 **添加**，选择搜索 Provider。
3. 快速试用可选 DuckDuckGo；正式证据链建议配置 Brave 或 SerpAPI 的 API Key。
4. 如果选择 Custom，Endpoint 必须包含 `{query}` 和 `{limit}` 占位符，例如 `https://search.example.test?q={query}&limit={limit}`。
5. 保存后确认该 Provider 处于“可用”状态。

完成以上配置后，Agent 才有搜索来源可以选择；是否真的联网仍由任务中的 `network` 审批决定。

## 这页会影响什么

- Agent 是否有可用搜索来源
- 搜索证据质量和成本
- 拒绝 `network` 权限后会如何回退

## 当前可选 Provider

- **DuckDuckGo**：适合快速试用，不需要 API Key
- **Brave**：需要 API Key，更适合正式证据链
- **SerpAPI**：需要 API Key，常用于更广的结果聚合
- **Custom**：接入你自己的搜索代理，需填写 `{query}` 和 `{limit}` 模板

## 和权限的关系

最容易误解的一点是：

- 配置好 Provider，不等于任务一定可以联网

只要你拒绝 `network` 权限，Agent 仍然必须退回本地证据，或者明确告诉你无法联网搜索。

## 排查顺序

- 如果搜索没有发生，先看任务时间线里是否出现 `network` 审批。
- 如果审批已允许但没有结果，检查 Provider 是否处于可用状态。
- 如果 Brave、SerpAPI 或 Custom 失败，重新保存 API Key 或 Endpoint。
- 如果 Custom Provider 返回空结果，确认服务端返回的是可被 Agent Workbench 解析的搜索结果结构。
