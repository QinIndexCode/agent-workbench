# Skills

Skill 是可复用方法，不是任务转录副本。

## 一个健康的 Skill 通常具备

- 描述的是可重复的方法
- 明确写出需要的工具
- 明确写出适用上下文
- 有排除条件
- 不包含当前机器状态或一次性结论

## 状态说明

- **Candidate**：等待人工复核，不会直接被当成稳定方法
- **Active**：可在运行时匹配并加载
- **Suspended**：保留审计价值，但不会注入运行时
- **Retired**：只保留历史记录

## 激活前建议

1. 先检查标题和适用场景
2. 去掉一次性任务输出
3. 核对 required tools 和 exclusions
4. 再去 **Curator** 看证据与重复判断

如果拿不准，就继续保持 **Candidate**。

## 内置 Office 视觉 QA Skill

Agent Workbench 内置并默认启用 **Office Document and Deck Visual QA** Skill。它适用于 DOCX、PPTX、PDF、Word、PowerPoint、报告、简报和幻灯片等需要视觉质量判断的交付物。

这个内置 Skill 的标准高于“文件存在”或“OOXML 结构有效”。它会要求 agent 将文档页面或幻灯片渲染成图片，检查排版效果，修复可见缺陷，然后再给出视觉判断。生成 Office 文件时，需要重点看层级、留白、表格可读性、是否裁切/重叠，以及整体是否像正式交付物。

默认路径优先使用现有 Python 文档库生成可编辑 OOXML，并产出渲染或代理 PNG 证据。可选依赖安装和版本检查只算准备工作，不算任务完成证据。

## 内置浏览器与电脑控制 Skill

Agent Workbench 也默认启用 **Browser and Computer Control via MCP** Skill。它适用于浏览器自动化、GUI 视觉检查、键盘/鼠标动作、桌面应用操作、截图验证，以及只能在图形界面复现的问题。

这个 Skill 的核心原则是：不要把键鼠操作混进普通 shell/file 内置工具，也不要用硬编码结果冒充真实 GUI 能力。浏览器控制优先通过 Playwright 兼容或 browser-control MCP server 接入；桌面应用控制应通过专用 computer-control MCP server 或受支持的电脑控制插件接入。所有工具都必须先被发现，再按实际影响进入审批、证据和任务时间线。

风险分类要保持保守：截图、DOM、console 和窗口元数据通常是观察类；外部导航、登录和远程页面属于网络类；click、type、hotkey、拖拽、上传、下载、剪贴板和桌面命令可能影响主机状态，需要更高风险审批。验证时先做无害观察，再执行最小动作，每次变更后都要重新截图、读取 DOM/日志或检查实际结果。
