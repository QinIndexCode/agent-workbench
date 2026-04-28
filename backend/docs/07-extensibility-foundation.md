# backend_new 扩展预留原则

基础层除了稳定，还必须为后续能力预留干净的挂载点。当前先只做“预留”和“注册面”，不做重业务实现。

## 1. 主动配置

配置层现在已经预留以下扩展位：

- `security`
- `skills`
- `mcp`
- `tools`

这意味着后续新增能力时，不需要再去 runtime 内部找位置塞环境变量解析。

## 2. 加密

当前已经补了最小的 secret cipher 抽象：

- `NoopSecretCipher`
- `AesGcmSecretCipher`
- `createSecretCipher()`

原则：

- 密钥只从配置指定的环境变量读取
- 加密能力必须作为基础设施注入
- 不允许在 skill、tool、mcp 代码里各自造一套 secret 处理

## 3. skill 和 MCP 载入

当前已经补了扩展注册中心与 manifest loader：

- `ExtensionRegistry`
- `loadExtensionManifests()`
- `loadSkillPlaceholders()`

原则：

- skill、mcp、tool 都先进入同一套 registry
- runtime 只消费 registry 快照，不直接扫描磁盘
- manifest 是外部声明，registry 是内部统一视图

## 4. agent tool 可扩展

当前工具层先只定义：

- `AgentToolDefinition`
- `inputSchema`
- `source`

这保证后续 builtin tool、skill tool、mcp tool 可以共用同一套定义模型。

## 5. 继续推进的顺序

后续仍然按这个顺序推进：

1. config
2. storage
3. logging
4. security
5. extension registry
6. parser / runtime / tool execution

不要反过来从 runtime 往下倒逼基础设施。
