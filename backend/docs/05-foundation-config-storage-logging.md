# backend_new 基础分层：Config -> Storage -> Logging

## 目标

`backend_new` 不再从 runtime 或 parser 直接长出日志能力，而是先固定 3 层基础设施顺序：

1. `config`
2. `storage`
3. `logging`

这个顺序必须严格成立，因为：

- 没有配置系统，就没有稳定的数据目录、日志限额、持久化策略。
- 没有存储系统，日志系统只能退化成内存记录，无法用于真实复盘。
- 日志系统必须只是“配置驱动 + 存储驱动”的上层能力，不能反向侵入 runtime 核心状态机。

## 目录职责

### `src/foundation/config`

- 定义 `BackendNewConfig`
- 提供默认值
- 负责环境变量解析和路径归一化
- 不包含业务逻辑

### `src/foundation/storage`

- 定义统一 `StorageAdapter`
- 提供文件系统实现 `FileStorageAdapter`
- 提供 `StorageLayout`
- 只关心“往哪里写”和“如何写”，不关心日志语义

### `src/foundation/logging`

- 定义审计日志、运行时 trace、checkpoint 的结构
- 统一做日志内容裁剪与脱敏入口
- 基于 `StorageAdapter + StorageLayout + Config` 写日志
- 不直接依赖 parser / planner / engine 细节

## 当前已落地内容

- `loadBackendNewConfig()`：从默认值与环境变量构建配置
- `FileStorageAdapter`：文件系统读写、JSON、JSONL 追加
- `StorageLayout`：统一 task / trace / checkpoint / workspace 路径
- `TaskLogWriter`：审计日志、trace、checkpoint 三类写入器

## 下一步接入原则

后续 runtime / parser / lifecycle 只能通过显式依赖注入使用：

- `config`
- `storage`
- `layout`
- `logWriter`

不允许在任意域模块中直接自行拼接路径、直接 `fs.writeFile`、直接定义另一套 trace 裁剪规则。
