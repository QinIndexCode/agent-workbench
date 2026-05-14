# Agent Workbench 快速启动指南

## 一键启动

在项目根目录运行：

```bash
npm.cmd run dev:all
```

这会同时启动：
- 后端服务器：端口 `5177`，先启动。
- 前端界面：端口 `5173`，后端启动约 2 秒后启动。

启动成功后，在浏览器中打开 http://127.0.0.1:5173/

## 其他可用命令

| 命令 | 说明 |
|------|------|
| `npm.cmd run build` | 构建整个项目 |
| `npm.cmd run dev` | 仅启动后端服务器 |
| `npm.cmd run dev:server` | 仅启动后端服务器 |
| `npm.cmd run dev:web` | 仅启动前端界面 |
| `npm.cmd run dev:all` | 同时启动前后端 |

## 首次使用

1. 构建项目：
   ```bash
   npm.cmd run build
   ```

2. 启动开发环境：
   ```bash
   npm.cmd run dev:all
   ```

3. 在浏览器中打开：
   - 前端: http://127.0.0.1:5173/
   - 后端健康检查: http://127.0.0.1:5177/health

## 端口说明

- 后端 API: `5177`
- 前端 Vite: `5173`

## 注意事项

- 确保已经安装 Node.js 18+。
- 首次运行需要配置模型提供商。
- 数据会保存在 `data/workbench.sqlite`。
- 按 `Ctrl+C` 可以停止所有服务。

## 技术说明

`npm.cmd run dev:all` 使用项目内 Node.js 启动脚本，避免 Windows shell 差异：
- 后端先启动，约 2 秒后启动前端。
- 两个服务有独立输出前缀。
- 按 `Ctrl+C` 会关闭两个子进程。
