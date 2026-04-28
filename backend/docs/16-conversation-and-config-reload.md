# backend_new Conversation 与 Config Reload 基座

在进入真正核心前，还必须把两件长期容易散掉的能力固定下来：

1. conversation / message store
2. config reload policy

## Conversation Store

当前已经补了：

- `ConversationMessageRecord`
- `createConversationMessage()`
- `ConversationRepository`

当前最小运行时已经会写入三类消息：

- `user`
- `assistant`
- `runtime`

这意味着后面不再需要用 trace 充当对话存储。

## Config Reload Policy

当前已经补了：

- `createConfigFingerprint()`
- `createConfigSnapshotRecord()`
- `shouldReloadConfig()`
- `ConfigSnapshotRepository`

当前不是文件 watcher，也不是热更新执行器，而是明确的 reload policy 基座：

- 有当前激活配置快照
- 有 fingerprint
- 有是否需要 reload 的判断

## 当前原则

- 配置重载必须显式可判断
- 对话存储和 trace 存储必须分离
- 后续 runtime / socket / projection 只能消费 conversation store，不直接拿 trace 伪装成聊天记录
