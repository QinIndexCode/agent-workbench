# Settings

设置页面用于管理工作台的配置项。

## Providers

管理模型服务商：
- 添加、编辑、删除服务商配置
- 设置默认模型
- 指定上下文窗口大小

## Permissions

管理工具执行权限：
- 设置全局风险类别授权
- 为非 destructive 内置工具配置自动审批
- destructive 工具仍需显式审批，除非用户已全局授权

## MCP

管理外部工具服务：
- 添加/编辑/删除 MCP 配置
- 查看服务状态和已发现工具列表
- 通过同一套审批流程运行 stdio 与 streamable HTTP MCP 工具

## Preferences

调整界面、模型与安全默认值：
- 切换界面语言
- 选择 agent 语气与回复详略
- 开启敏感数据清理后，对工具证据中的常见密钥做脱敏
- 开启本地存储加密后，加密 SQLite 记录 payload
