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

### `foundation/providers/preset-catalog.ts`

- 提供单一结构化 preset catalog，避免 backend、frontend、CLI 各自维护一份厂商模板
- 当前按三类表达 provider：
  - `api-key`: 普通 API key / bearer token provider
  - `enterprise-cloud`: 需要 region、project、deployment、account、SigV4/OAuth 等额外企业云配置
  - `local`: Ollama、LM Studio、vLLM、LocalAI、llama.cpp 等 OpenAI-compatible 本地 HTTP 服务
- 每个 preset 都声明 `implementationStatus`：
  - `runnable`: 已有通用 adapter 可以按 transport 执行
  - `profile-only`: 只作为配置档案和 UI/CLI 可见 catalog，不伪装成可运行
  - `external-auth-required`: 需要企业云鉴权或额外配置，不能只靠一个 API key 自动运行
- 每个 preset 都声明输入/输出 modality、vision/file capability 和建议环境变量；这些是能力契约，不代表 runtime 已经接收任意二进制附件。

### `foundation/providers/presets.ts`

- 从 catalog 生成向后兼容的 `ProviderPreset`
- 继续负责 profile 归一化和默认值填充
- 不再维护第二份厂商列表

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
- 图片、文件等能力先通过 provider capability 和 `inspect_file` 这类安全工具显式呈现；模型请求是否接收附件必须另行定义通用 contract，不能由单个 provider 特性倒推 runtime 语义

## 为什么这层现在就要补

后续 model invoker、provider client、任务执行入口都会依赖 provider。
如果这里不先统一，后面很容易在多个模块里各自复制 provider 配置、header 拼装、baseUrl 判断和 key 读取逻辑，最后又回到旧架构那种分散状态。
