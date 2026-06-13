# Agent Workbench 快速启动

## 环境要求

- Node.js 22 或更新版本
- npm 10 或更新版本
- Windows 是当前完整验证平台

## 首次启动

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run dev:all
```

启动后访问：

- Web UI：`http://127.0.0.1:5173`
- API 健康检查：`http://127.0.0.1:5177/health`

默认服务与 session bootstrap 只适合受信任的本机访问，不要直接暴露到
不受信任网络。

## CLI

仅启动后端：

```powershell
npm.cmd run cli -- serve
```

在另一个终端中使用 CLI：

```powershell
npm.cmd run cli -- health
npm.cmd run cli -- task list
npm.cmd run cli -- task create "检查当前项目" --watch
```

完整命令见 [docs/cli.md](docs/cli.md)。

## 常用验证

```powershell
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run audit:prod
npm.cmd run quality:full
```

运行数据默认保存在 `data/`，该目录不会提交到 Git。不要把 API Key、
SQLite、模型 trace、附件或测试报告加入版本控制。
