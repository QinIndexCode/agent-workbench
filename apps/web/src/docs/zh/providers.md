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

配置 Xiaomi MiMo 普通按量 API 时，使用 OpenAI 兼容入口 `https://api.xiaomimimo.com/v1` 和 `sk-*` API Key。MiMo Token Plan 是独立套餐，API Key 格式为 `tp-*`，Base URL 也必须换成 Token Plan 页面显示的专属地址，例如 `https://token-plan-cn.xiaomimimo.com/v1`、`https://token-plan-sgp.xiaomimimo.com/v1` 或 `https://token-plan-ams.xiaomimimo.com/v1`。两类 Key 不能混用。

Token Plan 文档还提供 Anthropic 兼容入口，例如 `/anthropic`，但当前模型配置预设只代表 OpenAI-compatible 请求形态；如果某个外部工具要求 Anthropic 协议，需要选择对应协议或自定义端点。

Kimi Code Plan 要求稳定的 `prompt_cache_key` 来提高缓存命中率。Workbench 在自动缓存模式下会对 Kimi 官方端点发送稳定缓存键；普通自定义 OpenAI-compatible 服务不会默认发送该字段，除非你显式设置 `AGENT_WORKBENCH_PROMPT_CACHE_MODE=always`。

Qwen / DeepSeek 的“思考模式”控制存在厂商扩展字段，例如 Qwen 的 `enable_thinking` 或 DeepSeek 的 reasoning 控制。Workbench 的预设保持标准 OpenAI-compatible 请求，不会自动注入未暴露在 UI 中的非标准参数；需要精细控制时可使用厂商控制台或后续自定义能力扩展。

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

Agent Workbench 会把稳定指令和项目上下文放在请求前部，让 Provider
能在多轮任务中复用相同的 Prompt 前缀。

Anthropic Messages 默认启用自动 Prompt Cache；OpenAI 官方端点、Kimi 官方端点和
MiMo Token Plan OpenAI-compatible 端点会收到稳定的 `prompt_cache_key`。不同的
OpenAI 兼容服务支持情况不一致，仅在服务明确支持该参数时设置
`AGENT_WORKBENCH_PROMPT_CACHE_MODE=always`；设置为 `off` 可关闭显式缓存提示。
Provider 返回缓存 Token 数据时，Workbench 会记录实际命中量。

缓存命中率目标按滚动窗口计算。第一轮请求通常是 warmup，后续同一
provider/model/endpoint 和同一组工具名称族会复用稳定 `prompt_cache_key`。
完整工具 Schema 仍会随每次请求发送，因此缓存路由不会削弱可用工具能力或任务质量。
Workbench 还会为初始直答类 final 回复保留短期内存响应缓存；涉及工具调用、文件证据、
图片输入或已有历史的任务不会使用这层缓存。达到生产成本目标时，滚动
`cachedTokens / inputTokens` 应不低于 90%；如果低于目标，优先检查是否频繁切换模型、
Base URL、工具集合或禁用了 provider 侧缓存。
