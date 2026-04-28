# backend_new Validated Output 与 Tool Contract 基座

在真正进入 parser validator 和 tool runtime 之前，还必须先补两层稳定基座：

1. validated output store
2. tool invocation contract

## 1. Validated Output Store

当前已经补了：

- `ValidatedOutputRecord`
- `ValidatedOutputRepository`
- `FileValidatedOutputRepository`

它的职责不是替代 runtime state，而是保存“已经被上层接受、可复用的结构化输出”。

当前最小运行时只在满足以下条件时写入：

- 有 explicit output
- explicit output 可解析为 JSON

后续真正的 validator 接入后，再把“parsed”升级成“validated”。

当前记录还会显式绑定：

- `sessionId`
- `correlationId`
- `turnId`
- `checkpointId`

这样 validated output 不只是“有一份结构化结果”，而是能回溯“这份结果是在哪一次 turn、哪一个 checkpoint 被接受的”。

## 2. Tool Invocation Contract

当前已经补了：

- `ToolInvocationRequest`
- `validateToolInvocationRequest()`
- `ToolInvocationRecord`
- `FileToolInvocationRepository`
- `createToolInvocationRecord()`
- `ToolResultEnvelope`
- `classifyToolError()`
- `applyToolInvocationTransition()`
- `evaluateToolExecutionPolicy()`
- `ToolExecutor` / `ToolExecutionContext`
- `createToolExecutionAuditDetails()`
- `ToolApprovalRecord`
- `resolveToolApprovalRecord()`
- `findLatestApprovalForInvocation()`
- `ToolExecutorRegistry`
- `dispatchToolExecutor()`
- `ToolExecutorCapability`
- `evaluateToolInvocationResumePolicy()`

设计重点：

- tool 定义的单一来源仍然是 `ExtensionRegistry`
- tool invocation 校验层只消费 registry，不自己维护第二套 tool 定义
- required 参数和类型在调用前先校验
- invocation 记录必须绑定 `sessionId / correlationId / turnId / checkpointId`
- parser 负责提取 tool call 结构，runtime 只负责校验与持久化
- tool 执行结果不能直接塞裸对象，必须先进入统一 `ToolResultEnvelope`
- invocation 状态推进必须显式经过 `PLANNED -> RUNNING -> SUCCEEDED/FAILED`
- 用户授权等级固定为三档：`full / ask / read-only`
- `ask` 模式下，`WRITE / NETWORK / HIGH risk` 工具必须进入 `WAITING_APPROVAL`
- `read-only` 模式下，`WRITE / NETWORK` 工具直接拒绝进入执行链
- `WAITING_APPROVAL` 不只是状态字面量，必须伴随一条 `ToolApprovalRecord`

当前最小 parser 已接受两类 tool call 形态：

- JSON 形态：`{"current_unit":"AGENT-001","tool_name":"search_files","arguments":{"pattern":"TODO"}}`
- XML 形态：`<tool unit="AGENT-001" name="search_files">{"pattern":"TODO"}</tool>`

当前错误分类先固定为最小集合：

- `VALIDATION`
- `PERMISSION`
- `NOT_FOUND`
- `TIMEOUT`
- `RATE_LIMIT`
- `EXECUTION`
- `UNKNOWN`

## 4. 用户授权等级

当前基座已经把用户授权等级下沉到 tool execution policy：

- `full`
  - 工具可直接进入计划/执行链
- `ask`
  - 低风险 `READ / PROCESS` 工具可直接进入计划链
  - `WRITE / NETWORK / HIGH risk` 工具进入 `WAITING_APPROVAL`
- `read-only`
  - 仅允许 `READ / PROCESS`
  - `WRITE / NETWORK` 直接拒绝

## 5. 审批与执行器注册

当前又补了两层基础面：

- `ToolApprovalRepository`
  - 记录待审批事实
  - 不负责真正的人机交互
- `ToolExecutorRegistry + dispatchToolExecutor()`
  - 先固定 executor 注册与分发契约
  - 后面接真正 executor 时，不再改 runtime 主结构

## 6. 审批决议与恢复分发

当前又补了两条“审批之后”的基础规则：

- `resolveToolApprovalRecord()`
  - 把 `PENDING` 决议为 `APPROVED / REJECTED / EXPIRED`
- `evaluateToolInvocationResumePolicy()`
  - 判断 invocation 在当前 approval 状态下能否恢复分发

恢复决策固定成三种：

- `DISPATCH`
- `WAIT_APPROVAL`
- `DENY`

## 7. 执行能力声明

`ToolExecutorRegistry` 现在不仅注册 executor，也注册 capability：

- `supportsApprovalResume`
- `supportsDryRun`
- `supportsStreaming`
- `maxExecutionMs`

这样后面真正接 executor 时，runtime 不需要再猜某个工具“能不能审批后恢复、能不能流式、有没有时间上限”。 

## 3. 为什么这仍然是基座

因为如果不先立住这两层，后面一进入真正的 tool runtime 和 contract validation，就很容易再次出现：

- output 是否有效没有稳定落点
- tool call 请求和 tool 执行记录没有统一契约
- runtime 里到处直接拼 tool 调用对象
