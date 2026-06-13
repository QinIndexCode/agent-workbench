# 模型配置

模型配置页用于把真正可执行任务的模型入口接到 Agent Workbench。没有可用 Provider 时，任务、标题生成和继续会话都可能受限。

## 这页会影响什么

- 当前任务默认用哪个模型
- 可用模型的上下文窗口大小
- 主模型失败后是否允许回退到备用 Provider
- 本地保存了哪些 API Key

## 推荐的首次配置

1. 先只添加一个你确定能正常返回结果的 Provider。
2. 保存后确认它已经成为“当前使用”。
3. 点击该 Provider 行里的“测试连接”，确认后端能用当前 Base URL、模型和本地密钥完成最小预检。
4. 运行一次真实任务或标题生成，确认完整链路通畅。
5. 再决定是否补充备用 Provider。

## 常见字段如何理解

### 协议 / Preset vendor

用于选择预设供应商或协议类型。预设通常会自带推荐模型和默认 Base URL。

### Base URL

用于指定实际请求入口。自定义兼容服务时尤其要核对。

### 模型

可以从预设中选，也可以手动填自定义模型 ID。

配置 Xiaomi MiMo 时，使用 OpenAI 兼容入口 `https://api.xiaomimimo.com/v1`，并使用预设里的小写模型 ID，例如 `mimo-v2.5-pro`。模型 ID 和上下文窗口保持一致，可以避免 Workbench 在请求规模上错误降级。

### Context window

决定单次请求可用的上下文规模。手动填写时，要确保与你实际模型能力匹配。

### Available to tasks

关闭后会保留配置和密钥，但任务不会选择它。

### Make active

保存后立即切换到该 Provider，适合首次配置或明确准备迁移时使用。

### 测试连接

测试连接会通过后端向当前 Provider 发起一次最小化模型请求，不会在前端读取或展示 API Key。结果会区分三类常见问题：

- 配置或密钥需要检查：通常是 401/403、无密钥、Base URL 或模型 ID 不匹配。
- 服务限流：通常是 429，需要等待配额恢复或更换 Provider。
- 服务暂时不可用：通常是 5xx 或网络瞬断，可以稍后重试。

## Prompt Cache

Agent Workbench 会把稳定指令、项目上下文和确定性排序后的工具 Schema
放在请求前部，让 Provider 能在多轮任务中复用相同的 Prompt 前缀。

Anthropic Messages 默认启用自动 Prompt Cache；OpenAI 官方端点会收到稳定的
`prompt_cache_key`。不同的 OpenAI 兼容服务支持情况不一致，仅在服务明确支持
该参数时设置 `AGENT_WORKBENCH_PROMPT_CACHE_MODE=always`；设置为 `off`
可关闭显式缓存提示。Provider 返回缓存 Token 数据时，Workbench 会记录实际命中量。
