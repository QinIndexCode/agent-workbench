# backend_new Projection 与 Event 基座

继续补基座时，不能把“给前端看的状态”和“runtime 内部状态”混成一团。

## 1. Projection 的角色

`TaskProjection` 是面对外部展示与查询的稳定视图。

它的目标不是保留全部内部细节，而是提供一份：

- 状态稳定
- 字段稳定
- 能直接被前端或 API 消费

的任务视图。

当前已经补了：

- `buildTaskProjection()`
- `TaskProjectionRepository`

当前稳定关联字段：

- `latestSessionId`
- `latestCorrelationId`
- `latestTurnId`
- `latestCheckpointId`

## 2. Event Envelope 的角色

`RuntimeEventEnvelope` 是实时更新的统一契约。

它解决的问题是：

- 前端不应该直接消费 runtime 内部对象
- socket / queue / stream 不应该各自发不同形状的裸对象

当前已经补了：

- `createRuntimeEventEnvelope()`
- `RuntimeEventRepository`

当前事件最小关联字段：

- `sessionId`
- `correlationId`
- `turnId`
- `checkpointId`

## 3. 当前边界

- runtime state 是内部事实
- projection 是外部稳定视图
- event envelope 是实时增量通知

三者不能混用，也不能互相替代。

## 4. 为什么这层仍然是基座

因为如果没有 projection / event contract，后面前端同步、socket 推送、任务详情页、任务列表页都会直接依赖 runtime 的临时字段，最终再次形成强耦合。
