# backend_new 会话与 Provider 选择基座

继续补基座时，必须先解决两个长期会在旧架构里失控的问题：

1. 一次执行到底属于哪个 session / correlation
2. 当前任务到底应该选哪个 provider

## 1. Execution Session / Correlation

当前基础层已经补了：

- `createExecutionCorrelation()`
- `ExecutionSessionRepository`
- `TaskMetadataRepository`

原则：

- 每次实际执行尝试都必须有 `sessionId`
- 跨日志、checkpoint、task snapshot 的关联必须有 `correlationId`
- task metadata 只记录“当前任务的持久元信息”
- execution session 记录“某一次执行尝试”

## 2. Provider Selection Policy

当前 provider 层已经补了：

- `ProviderRegistry`
- `resolveProviderProfile()`
- `selectProviderProfile()`

选择顺序固定：

1. request 指定的 `preferredProviderId`
2. config 指定的 `defaultProviderId`
3. 如果配置要求优先本地，则优先 `local-stdio`
4. 否则取过滤后的第一个 provider

## 3. 为什么这仍然属于基座

因为 session 和 provider selection 都是“上层运行时必然依赖，但不应该在上层临时决定”的问题。

如果不先把这层做稳，后面 parser、runtime、tool execution、queue、resume 都会重复各自处理：

- session id 生成
- correlation id 拼接
- provider fallback 逻辑
- 默认 provider 选择

这正是旧架构容易重新变重、变乱的地方。
