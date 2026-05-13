# 网络搜索

网络搜索页用于配置内置 `web_search` 工具可以选择的搜索 Provider。它不是单独的联网开关，真正的联网仍受 `network` 权限控制。

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
