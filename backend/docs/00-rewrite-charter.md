# backend_new 重写宪章

## 1. 重写目标

本次重写只解决一个核心问题：让 SCC-Batch 后端重新回到“可推理、可验证、可追踪”的状态。

不是为了改掉上层哲学，而是为了把当前后端里已经失控的几条关键链拆开重建：

- LLM 输出解析链
- 工具调用执行链
- Progress Tracker 状态推进链
- Checkpoint / Resume 恢复链
- Trace / Task / Socket 观测链

## 2. 保留的上层设计

以下设计原则必须保留，不允许在重写中偏移：

- 契约驱动 DAG 架构
- Agent Unit 明确职责边界
- 运行时只允许当前 ready unit 推进
- 语义输出和实体产物都必须可验证
- 暂停 / 恢复依赖显式状态，而不是隐式猜测
- 前端看到的状态必须可由后端状态还原

## 3. 当前旧后端的主要失败模式

### 3.1 解析失败与语义成功并存

模型已经给出语义正确的内容，但 parser / contract validator 没能稳定接住，导致：

- 输出未进入 semantic cache
- tracker 被降级
- 当前 unit 卡在 PARTIAL

### 3.2 工具产物与状态产物分离

当前存在以下风险：

- `files_created` 与真实工具执行不一致
- 任务 JSON / HTML 展示“已创建”
- workspace 实际并没有对应文件

### 3.3 恢复模式与纠错模式冲突

旧系统在 `awaitingProgressTracker` 下经常只要求“再发 tracker”，但实际上当前需要的是：

- 先补合法 explicit output
- 再提交 tracker

这会导致 runtime 指令自相矛盾。

### 3.4 日志很多，但不是取证级完整

旧系统会记：

- task JSON
- displayHistory
- llmContext
- traces

但它们不是同一套真实链路：

- displayHistory 会过滤
- trace 会截断
- checkpoint 曾经不保存完整 history

## 4. backend_new 的基本原则

### 4.1 一条事实，只有一个权威来源

- Unit 状态以 runtime state 为准
- 实体文件以 tool execution result 为准
- semantic output 以 validated output store 为准
- 前端展示以 projection 为准，不直接拼字段猜

### 4.2 解析器只做解析，不做调度

parser 只回答这些问题：

- 有没有 tool call
- 有没有 explicit unit output
- 有没有 progress tracker
- 每个结构的解析置信度和来源是什么

parser 不直接修改状态。

### 4.3 状态机只吃结构化输入

调度器 / runtime 只消费结构化结果，不直接读原始 LLM 文本。

### 4.4 错误恢复必须单向

恢复动作要明确分流：

1. 缺 output：补 output
2. 缺 tracker：补 tracker
3. 缺 tool evidence：补 tool action
4. 真阻塞：FAILED + blocker

不允许在一个循环里反复切换恢复目标。

### 4.5 日志优先面向复盘

每个关键状态变化都必须能回答：

- 是谁触发的
- 基于什么输入
- 为什么变更
- 改成了什么

