# Curator

Curator 用来解释 SCC 为什么推荐、拦截或判重某个 Skill 候选。

## 优先看什么

- **Reason**：为什么会出现这条建议
- **Evidence**：背后的来源任务、工具或模式
- **Blocked reasons**：为什么没有晋升
- **Duplicate basis**：为什么会被归到重复组

## 推荐操作

- **Activate**：只有在候选明显可复用时才启用
- **Suspend**：当已启用 Skill 开始漂移或误命中时暂停
- **Merge duplicates**：只有它们确实描述同一工作流时才合并

## 强候选通常满足

- 背后有重复成功任务
- 工具序列稳定且不止一步
- 文案是可复用方法，而不是某次任务结果

如果这些信号还弱，就保持 candidate 或 not promoted。
