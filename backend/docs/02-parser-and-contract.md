# 解析器与契约设计

## 1. 解析器支持的显式输出形式

必须兼容以下 wrapper：

```text
[AGENT-002_OUTPUT] ... [/AGENT-002_OUTPUT]
<AGENT-002_OUTPUT> ... </AGENT-002_OUTPUT>
<output unit="AGENT-002"> ... </output>
```

原因：

- DeepSeek 类模型容易把方括号替换成角括号
- 不能因为标签风格差异就丢失语义正确的输出

## 2. OUTPUT_CONTRACT 的解析方式

旧系统的问题之一，是把下面这种描述直接当 JSON parse：

```text
问题清单JSON格式：{'accuracyIssues': [...], 'functionalityGaps': [...]}
```

这会失败。

新设计分 3 级解析：

1. JSON Schema
2. Plain JSON shape
3. Descriptive pseudo-shape key extraction

只要能够稳定提取结构键，就应允许结构匹配验证继续进行。

## 3. Parser 输出模型

解析器统一输出：

```ts
type ParsedTurn = {
  rawText: string;
  explicitOutputs: ExplicitOutputEnvelope[];
  trackers: ProgressTrackerEnvelope[];
  toolCalls: ToolCallEnvelope[];
  warnings: string[];
};
```

## 4. 契约校验原则

### 4.1 明确区分三种失败

- `TRACKER_INVALID`
- `OUTPUT_INVALID`
- `TOOL_CALL_INVALID`

### 4.2 不允许模糊恢复

如果当前失败是 `OUTPUT_INVALID`，下一轮必须明确要求补 output，而不是只要求补 tracker。

### 4.3 files_created 不能独立成事实

`files_created` 只能是：

- 当前轮真实 tool execution 的投影
- 或 runtime 自动归一化后的结果

不能接受纯声明式声称。

