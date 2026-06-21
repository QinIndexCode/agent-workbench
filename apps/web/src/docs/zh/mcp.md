# MCP

MCP 页用于把外部工具服务器接入 Agent Workbench，并让这些工具和内置工具一样进入审批、证据和时间线体系。

## 支持的接入方式

### stdio

适合本地脚本或本地服务进程，通常要填写：

- 命令
- 参数
- 可选工作目录

### streamable HTTP

适合远程 MCP endpoint，通常只需要 URL。

## 风险覆盖是做什么的

风险覆盖不是给整台服务器降级，而是把**某个具体工具**重新映射到另一个风险类别。

适合：

- 你非常确定某个工具的实际风险比默认标记更高或更低

## 推荐的首次验证

1. 添加一台简单 MCP 服务器
2. 成功连接
3. 在“已发现工具”中看到工具列表
4. 断开连接后确认工具不可再发现
5. 再决定是否接入更复杂的生产工具

## 浏览器和电脑控制工具

Agent Workbench 内置工具面保持克制：shell、工作区文件、网页搜索、知识库、记忆、Skill 和任务控制。浏览器自动化、更细的桌面/电脑控制能力，建议通过 MCP server 接入，而不是假设运行时默认存在。

浏览器任务优先接入 Playwright 兼容或 browser-control MCP server，并让它显式暴露 navigate、click、type、screenshot、console logs、DOM inspection 等工具。风险分类要按实际影响配置：

- 截图、DOM 读取、console 读取通常属于 `workspace_read` 或 `host_observation`
- 打开外部网站通常属于 `network`
- 点击、表单输入、下载、上传、桌面动作可能需要 `shell` 或 `destructive`，取决于具体影响

配置浏览器工具时优先选择 selector、role 或 accessibility tree 定位；坐标点击只能作为无语义目标的兜底。每次 click、type、hotkey、drag、upload 或 download 后，都要让工具产出新的截图、DOM、console/network 证据或实际文件结果。

桌面/电脑控制能力影响主机状态，尤其在 Windows 上通常会操作当前前台桌面。接入这类 MCP server 时，不要给整台 server 一键降风险；按工具分别设置风险覆盖，并把剪贴板、全局快捷键、文件选择器、系统设置、账号/支付/删除等动作视为高风险。

接入 browser 或 computer-control MCP server 后，先用一个无害本地 URL 或测试窗口做验证：打开目标，获取一次截图或 DOM/窗口快照，并确认对应工具证据出现在任务时间线中。若没有真实工具证据，不应声称完成过键盘、鼠标或浏览器操作测试。
