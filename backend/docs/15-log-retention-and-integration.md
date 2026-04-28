# backend_new 日志保留与集成测试

## 日志保留机制

`backend_new` 现在已经有基础的日志过期清理机制，目标不是“无限留痕”，而是“可复盘且可控”。

当前规则：

- 配置项：
  - `logging.retentionDays`
  - `logging.cleanupOnInitialize`
- 清理目标：
  - `logs`
  - `traces`
  - `events`
  - `tool-invocations`
  - `conversations`

当前不会主动清理：

- checkpoints
- task snapshots
- projections
- validated outputs
- secrets

因为这些更接近状态事实，而不是纯运行日志。

## 为什么只清理这些目录

因为日志类文件天然是“可再生成的运行留痕”，而：

- checkpoint
- task snapshot
- projection
- validated output

属于运行事实或恢复事实，清理策略不能和日志混为一类。

## 集成测试的目标

除了单元测试，现在还需要最小集成测试去验证：

1. `create-runtime` 能否把最小执行链跑通
2. logs / checkpoint / projection / event / validated output 是否一致落盘
3. 错误分流时是否进入正确的 `pendingCorrection`
