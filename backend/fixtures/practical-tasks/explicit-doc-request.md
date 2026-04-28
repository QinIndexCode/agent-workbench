请把下面要点整理成一份可直接给 operator 使用的发布检查清单：

- 发布前需要检查 provider 与 secret
- worker 必须启用，且 /ready 的 queueReady 要为 true
- 路径策略 blocker 必须清空
- 发布中关注 heartbeat、approval backlog、hook failure
- 发布后核对 diagnostics、events、capability warnings 和回滚说明
