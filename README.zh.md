<div align="center">
  <img src="frontend\public\logo.png" alt="SCC-Batch Logo" width="120" height="120">
</div>

# SCC-Batch 中文总览

SCC-Batch 是一个基于契约驱动 DAG 架构的多智能体协作批处理任务执行系统，目标是把复杂任务转化为可控、可观测、可恢复、可验证的执行流程。

## 核心能力

- 契约驱动 DAG：通过 `GlobalContract + DAGScheduler + AgentUnit` 约束执行边界
- 动态任务规划：`SCCPlanner` 根据任务类型选择模板规划或 AI 规划
- 语义缓存：缓存单元输出与上下文签名，减少重复执行
- 暂停与恢复：支持任务级暂停、恢复与上下文快照延续
- 实时状态同步：通过 Socket.IO 推送任务快照、状态、流式事件与终态
- Grounded 执行：对仓库分析、artifact 验证、remediation 等路径增加证据约束

## 核心运行链路

```text
Task Submission
  -> SCCPlanner
  -> DAGScheduler
  -> SCCEngine
  -> Tool Runtime
  -> TaskManager / Socket State Sync
```

## 主要目录

- `backend/`: 后端服务、SCC runtime、测试、API 文档
- `frontend/`: 前端页面、状态管理、Socket 客户端
- `docs/`: 架构、设计原则、复审与优化跟踪
- `data/`: 运行数据、日志、缓存、任务输出

## 快速开始

### 安装依赖

```bash
npm install
```

### 本地开发

```bash
# 启动后端
npm run dev:backend

# 启动前端
npm run dev:frontend
```

### 启动服务

```bash
# 启动后端
npm run start

# 启动后端并拉起前端开发服务
npm run start:all
```

### 构建与检查

```bash
# 前端生产构建
npm run build

# 后端类型检查
npm run typecheck
```

### 默认地址

- 后端 API: `http://localhost:4200/api`
- 前端界面: `http://localhost:5173`
- Socket.IO: `http://localhost:4200`

## 当前实现边界

- 当前根目录 `build` 脚本只构建前端
- 当前根目录 `typecheck` 脚本只检查后端
- 更完整的接口说明请查看 `backend/docs/api/`
- 更完整的架构说明请查看 `docs/`

## 文档导航

- [架构与设计](docs/architecture.zh.md)
- [设计优势](docs/advantages.zh.md)
- [契约驱动 DAG 架构](docs/contract-driven-dag.zh.md)
- [后端 REST API](backend/docs/api/index.md)
- [WebSocket 事件](backend/docs/api/websocket-events.md)
- [复审与优化跟踪](docs/review/)

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 19 + TypeScript + Vite + Zustand |
| 后端 | Node.js 18+ + TypeScript + Express |
| 实时通信 | Socket.IO 4 |
| AI 集成 | Ollama / OpenAI / Anthropic |
| 存储 | JSON 文件存储 |
