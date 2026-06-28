# Agent Workbench 文档导航

当前交付边界以源码、测试和 [architecture.md](architecture.md) 为准。
`DigDeeper.md`、`experience.md` 与设计文档保留历史研究和设计背景，不是
已交付功能清单。

## 推荐阅读顺序

1. [../README.md](../README.md)：项目定位、启动方式、质量门禁。
2. [architecture.md](architecture.md)：当前系统边界、运行时、权限和验证原则。
3. [cli.md](cli.md)：`aw` / `agent-workbench` 本地 HTTP CLI。
4. [agent-workflow.md](agent-workflow.md)：Agent 工作流、验证阶梯和反硬编码约束。
5. `apps/web/src/docs/`：Web 内置帮助文档，包含 MCP、Agent 通用协议、模型缓存和设置说明，必须和实际页面/路由保持同步。
6. 设计背景文档：按需阅读，不作为发布承诺。

## 文档清单

| 文档 | 类型 | 内容 | 面向读者 |
|------|------|------|---------|
| [architecture.md](architecture.md) | 系统概览 | 运行时流程、安全边界、学习边界、组件交互时序 | 新加入的开发者、架构评审者 |
| [cli.md](cli.md) | 本地 CLI | `aw`/`agent-workbench` 命令、HTTP session、上传、清理 live-model 产物 | 本地运维与自动化使用者 |
| [agent-workflow.md](agent-workflow.md) | Agent 工作流 | 工作流阶梯、验证阶梯、反硬编码与反过度约束边界 | Agent 指令与质量门禁维护者 |
| [design-context-assembly.md](design-context-assembly.md) | 组件实现标准 | 5层上下文架构、ContextAssembler、FileStateTracker、流式解析、工具定义 | 实现上下文系统的开发者 |
| [design-memory-system.md](design-memory-system.md) | 组件实现标准 | 三层记忆模型、Skill生命周期、反思系统、冲突处理、MCP接入 | 实现记忆与学习系统的开发者 |
| [DigDeeper.md](DigDeeper.md) | 历史愿景 | 早期设计哲学、研究假设和行业对标，不是交付清单 | 架构研究者 |
| [experience.md](experience.md) | 行业参考 | 主流AI IDE设计经验总结、可复用工程化经验 | 全体开发者（可选阅读） |
| [reports/README.md](reports/README.md) | 生成物说明 | 发布复验报告的生成位置、证据来源和发布边界 | 发布维护者 |

## 生成物边界

`docs/reports/*.md` 由 `scripts/write-release-report.mjs` 生成，属于验证
产物，不是手写源文档。迁移到新仓库或准备发布时，只保留
`docs/reports/README.md`；需要证据快照时重新运行门禁生成当前日期报告。

## 核心术语表

| 术语 | 全称 | 含义 |
|------|------|------|
| **Agent Workbench** | Local-first agent workbench | 本地优先、权限驱动、证据可见的 Agent 工作台 |
| **Task Graph** | Durable task state | 用于保留目标、实现与验证状态，不是固定脚本编排 |
| **Agent Unit** | — | 任务图中的一个执行节点，所有行为完全由契约约束 |
| **ACI** | Agent-Computer Interface | 智能体-计算机接口（Anthropic 提出） |
| **Task Memory** | — | 三层记忆模型的最底层，单次任务的自动记录 |
| **Pattern** | — | 从多个Task Memory中提取的通用方法（观察阶段） |
| **Skill** | — | 经过验证的可靠模式（可注入上下文的固化能力） |
| **MCP** | Model Context Protocol | 模型上下文协议，标准化的工具连接规范 |
| **A2A** | Agent2Agent Protocol | Agent 到 Agent 的互操作协议；当前项目只做生态对齐说明，不声称已完整实现 adapter |
| **Loop Engineering** | — | Observe、Plan、Act、Verify、Reflect、Persist/Stop 的运行时闭环工程约束 |
| **Prompt Cache** | — | 通过稳定前缀和 provider 缓存能力降低重复输入 token 成本，目标是在不削弱任务质量的前提下提高命中率 |
| **Reflection** | — | 从Task Memory中提取Pattern/Skill的异步分析过程 |

---

## 维护规则

- 改动 API、CLI 命令、Web 路由或设置页时，同步更新对应文档。
- 运行 `npm.cmd run test:docs` 验证 Web 内置文档索引、路由和设置页映射。
- 不在文档中保存真实 API key、token、SQLite 数据、模型 trace 或私有用户数据。
- 迁移新仓库前运行 `npm.cmd run clean:release-artifacts`，只保留源文档和必要说明。
- 迁移新仓库前运行 `npm.cmd run check:release-source`，确认发布源目录边界没有漂移。
