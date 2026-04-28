# backend_new 基础加固原则

在 `config -> storage -> logging` 三层已经落地之后，必须继续做防御式约束，否则后续 runtime 接入时会把问题重新带回来。

## 1. 配置系统必须拒绝模糊输入

当前配置层已经补了这些硬约束：

- 所有目录路径必须是绝对路径
- `longTextLimit >= shortTextLimit`
- `jsonSpacing` 必须在合理范围内
- `auditFileName` 不能包含路径段，且必须是 `.jsonl`
- `storage.encoding` 只允许一组白名单编码

原则：

- 配置错误要尽早失败
- 不接受“先跑起来再说”的宽松默认

## 2. 存储系统必须防路径逃逸

当前存储层已经补了两类防护：

- `taskId` 只能使用安全字符，不允许空值、`.`、`..`、路径分隔符
- `resolveWorkspacePath()` 会校验目标路径必须留在 task workspace 内部

原则：

- 任何 task/workspace 路径都必须经过统一布局层生成
- runtime、tool、artifact 模块不得自行拼接工作区路径

## 3. 写入必须尽量原子

当前文件存储层：

- `writeText()` 使用临时文件 + rename
- `appendText()` 在单进程内按文件串行化，避免同进程并发交错写入

原则：

- checkpoint、task snapshot、配置快照一律走原子写
- JSONL 审计与 trace 允许 append，但必须保证同进程顺序

## 4. 日志必须有会话和顺序

当前日志层已经补了：

- `sessionId`
- `sequence`
- 初始化幂等
- 非空 `taskId` 校验

原则：

- 单看日志文件时，必须能判断事件顺序
- 发生进程重启时，必须能区分不同会话写出的日志段

## 5. 后续接入约束

后续所有 parser/runtime/lifecycle 模块：

- 只能依赖 `TaskLogWriter`
- 不能自己再造 trace writer
- 不能自己直接 `fs.writeFile`
- 不能绕过 `StorageLayout` 直接操作 task/workspace 路径
