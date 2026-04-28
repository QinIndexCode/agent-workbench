# backend_new Provider 基座

参考 `DigDeeper.md` 的几个核心观点，provider 基础层必须满足三件事情：

1. 保持简单，不把模型调用和 provider 配置拉成一团
2. 契约优先，provider 的可用信息必须结构化
3. 让本地 / 云端切换成为配置问题，而不是 runtime 魔法

## 当前分层

### `foundation/providers/types.ts`

- 定义 `ProviderProfile`
- 明确 `vendor / transport / model / baseUrl / apiKeySecretId`
- 明确 `auth / endpoints / apiVersion / organization / project`

### `foundation/providers/presets.ts`

- 提供主流厂商 preset
- 当前覆盖：
  - OpenAI / ChatGPT
  - Anthropic
  - Grok / xAI
  - DeepSeek
  - Gemini
  - MiniMax
  - ZhiPu / GLM
  - Kimi / Moonshot
  - Ollama
  - Meta / Llama
  - Custom

### `foundation/providers/registry.ts`

- 内部统一注册表
- 注册时先做 preset 归一化
- 阻止重复 provider id

### `foundation/providers/manifest-loader.ts`

- 从 provider manifest 加载 profile
- 只负责装载，不负责 secret 解析

### `foundation/providers/resolver.ts`

- 通过 `ApiKeySecretRepository` 解析 api key
- 输出 `ResolvedProviderProfile`
- 在这里补 vendor preset 默认值，而不是让 runtime 临时猜测

### `application/adapters/providers/*`

- `openai-compatible-client.ts`
- `deepseek-compatible-client.ts`
- `anthropic-compatible-client.ts`
- `provider-client-helpers.ts`

这些实现消费统一的 resolved profile，不把厂商差异散落进 runtime。

## 当前原则

- provider 配置与 api key 分离
- provider manifest 不存明文 key
- runtime 只消费 resolved profile
- 本地模型 transport 不强制要求 `baseUrl`
- 云端兼容 transport 必须显式提供 `baseUrl` 或由 preset 补默认值
- 厂商差异下沉到 `vendor + transport + auth + endpoints`
- runtime 不直接知道“某家厂商要什么特殊 header 或特殊路径”

## 为什么这层现在就要补

后续 model invoker、provider client、任务执行入口都会依赖 provider。
如果这里不先统一，后面很容易在多个模块里各自复制 provider 配置、header 拼装、baseUrl 判断和 key 读取逻辑，最后又回到旧架构那种分散状态。
