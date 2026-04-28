# 审批与分发基座

## 目标

在真正接入 tool executor 之前，先把以下事实层固定下来：

1. `approval` 是独立事实，不是 runtime 内存标记
2. `invocation` 的状态推进必须能表达 `DENIED`
3. `dispatch review` 只做规划，不做实际执行
4. executor 是否可恢复、是否支持 approval resume，必须由 capability 明确声明

## 当前边界

当前基座已经具备：

- `ToolApprovalRecord` 持久化
- approval append-only resolution
- `ToolInvocationStatus` 的 `DENIED`
- `ToolExecutorRegistry` 与 capability 注册
- `planToolInvocationDispatch()` 纯规划函数
- `BackendNewRuntime.resolveToolApproval()` 审批落盘
- `BackendNewRuntime.reviewPendingToolDispatch()` 分发前审查

当前仍然故意没有做：

- 真实 executor 执行
- approval 后自动恢复执行
- 前端审批交互
- tool side effect 真实落地

## 设计原则

### 1. 审批与执行分离

审批只改变“是否允许继续”，不直接触发工具执行。

### 2. review 只输出计划

`reviewPendingToolDispatch()` 的职责是回答：

- 哪些 invocation 已可分发
- 哪些 invocation 仍需等待审批
- 哪些 invocation 已不可恢复

它不负责真正执行工具。

### 3. 缺失 executor capability 视为不可分发

如果 invocation 已经 `PLANNED`，但当前没有注册 executor capability，则 review 必须显式返回 `DENY`，而不是把问题留到更晚的执行阶段。

### 4. 用户拒绝不等于执行失败

审批拒绝属于授权边界，不属于工具运行失败，因此 invocation 状态应为 `DENIED`，而不是 `FAILED`。

## 下一步

在这层之上，下一阶段再补：

1. executor interface 的真实实现
2. dispatch apply 层
3. approval 后恢复执行链
4. tool result 与 runtime state transition 的真正联动
