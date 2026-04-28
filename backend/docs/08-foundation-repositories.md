# backend_new 仓储基座

基础层继续往上时，不应该让 runtime 直接碰文件系统，而应该先经过仓储层。

## 当前仓储职责

### TaskRepository

- 负责任务快照持久化
- 不关心 trace，不关心日志
- 是 runtime/task lifecycle 的稳定读写面

### CheckpointRepository

- 负责恢复快照
- 不关心业务解释，只负责保存和读取状态对象

### ApiKeySecretRepository

- 只服务于 API Key / provider secret 存储
- 对外暴露的是 `apiKey`
- 对内落盘的是加密后的 `cipherText`

## 设计原则

- runtime 不直接 `writeJson(task.json)`
- runtime 不直接 `writeJson(checkpoint.json)`
- provider key 不直接 `writeText(api_key.txt)`

统一通过仓储层：

- `TaskRepository`
- `CheckpointRepository`
- `ApiKeySecretRepository`

## 为什么先补这层

因为后续接 parser、tool runtime、provider client 时，最容易重新把文件路径和序列化逻辑散落回业务里。仓储层先立住，可以挡住这类回流。
