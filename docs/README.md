# SCC-Batch Engine 实现标准

> 版本: 1.0
> 日期: 2026-05-05
> 状态: 正式版

---

## 文档导航

本文档集是 SCC-Batch Engine（Semantic Contract-based Batch DAG Engine）的完整实现标准，涵盖从架构哲学到组件级实现细节的全部内容。

### 阅读路径

```
                    ┌─────────────────────┐
                    │    README.md        │
                    │   (本文档 - 总目录)  │
                    └──────┬──────┬───────┘
                           │      │
              ┌────────────┘      └────────────┐
              ▼                                ▼
   ┌─────────────────────┐        ┌──────────────────────┐
   │  architecture.md    │        │   DigDeeper.md       │
   │  (系统概览与运行时)  │        │  (架构全解与设计哲学) │
   └─────────┬───────────┘        └──────────┬───────────┘
             │                               │
             └───────────┬───────────────────┘
                         │
            ┌────────────┴────────────┐
            ▼                         ▼
   ┌────────────────────┐   ┌──────────────────────┐
   │ design-context-    │   │ design-memory-       │
   │ assembly.md        │   │ system.md            │
   │ (上下文组装标准)    │   │ (记忆与技能系统标准)  │
   └────────────────────┘   └──────────────────────┘
            │                         │
            └───────────┬─────────────┘
                        │
                        ▼
              ┌─────────────────────┐
              │  experience.md      │
              │  (行业经验参考)      │
              └─────────────────────┘
```

---

## 文档清单

| 文档 | 类型 | 内容 | 面向读者 |
|------|------|------|---------|
| [architecture.md](architecture.md) | 系统概览 | 运行时流程、安全边界、学习边界、组件交互时序 | 新加入的开发者、架构评审者 |
| [DigDeeper.md](DigDeeper.md) | 架构标准 | 设计哲学、核心定位、6层架构、执行流程、行业对标 | 架构师、技术决策者 |
| [design-context-assembly.md](design-context-assembly.md) | 组件实现标准 | 5层上下文架构、ContextAssembler、FileStateTracker、流式解析、工具定义 | 实现上下文系统的开发者 |
| [design-memory-system.md](design-memory-system.md) | 组件实现标准 | 三层记忆模型、Skill生命周期、反思系统、冲突处理、MCP接入 | 实现记忆与学习系统的开发者 |
| [experience.md](experience.md) | 行业参考 | 主流AI IDE设计经验总结、可复用工程化经验 | 全体开发者（可选阅读） |

---

## 核心术语表

| 术语 | 全称 | 含义 |
|------|------|------|
| **SCC** | Semantic Contract-based | 语义契约驱动 |
| **Batch DAG** | Batch Directed Acyclic Graph | 批处理有向无环图 |
| **Agent Unit** | — | DAG中的一个执行节点，所有行为完全由契约约束 |
| **ACI** | Agent-Computer Interface | 智能体-计算机接口（Anthropic 提出） |
| **Task Memory** | — | 三层记忆模型的最底层，单次任务的自动记录 |
| **Pattern** | — | 从多个Task Memory中提取的通用方法（观察阶段） |
| **Skill** | — | 经过验证的可靠模式（可注入上下文的固化能力） |
| **MCP** | Model Context Protocol | 模型上下文协议，标准化的工具连接规范 |
| **Reflection** | — | 从Task Memory中提取Pattern/Skill的异步分析过程 |

---

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0 | 2026-05-05 | 初始正式版：整合所有设计文档为统一实现标准 |
