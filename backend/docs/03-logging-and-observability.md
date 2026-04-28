# 日志与可观测性设计

## 1. 目标

任何一次失败都必须能回答：

- 前端点了什么
- 后端接收了什么
- runtime 当时状态是什么
- prompt 发了什么
- LLM 回了什么
- parser 解析成了什么
- validator 为什么接受或拒绝
- 状态机如何推进
- 为什么最终失败

## 2. 三层日志模型

### 2.1 Audit Log

面向任务生命周期：

- create
- start
- pause
- resume
- cancel
- restart

### 2.2 Runtime Trace

面向 SCC 运行：

- prompt_built
- ai_response
- response_parsed
- validation_result
- state_transition
- checkpoint

### 2.3 Projection Log

面向前端推送：

- task_snapshot_emitted
- task_status_emitted
- trace_delta_emitted

## 3. 完整性要求

### 3.1 checkpoint

必须保存：

- full history
- display history
- llm context
- semantic cache
- invalid output units
- progress history
- current unit state
- correction mode

### 3.2 trace flush

终态必须强制 flush，不允许只依赖定时器。

### 3.3 可配置截断

trace 允许截断，但必须：

- 有清晰阈值
- 可配置
- 关键场景可切到 debug/full 模式

## 4. 关联 ID

每条链路至少要带：

- `taskId`
- `sessionId`
- `correlationId`
- `turnId`
- `unitId`
- `checkpointId`
- `socketRequestId` / `httpRequestId`
