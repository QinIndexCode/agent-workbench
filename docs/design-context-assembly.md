# Agent Workbench Engine: 上下文组装系统设计文档

> 版本: v1.5
> 日期: 2026-05-05
> 状态: 第五次反思修正（最终版）
>
> **注意**：文中所有代码均为参考实现，具体实现可能根据实际工程需求调整。

---

## 1. 设计目标

设计一个高效、可靠、可扩展的上下文组装系统，解决以下核心问题：
- Skill 如何动态注入上下文
- 历史对话如何智能截断避免信息丢失
- 代码文件内容如何准确传递避免"猜代码"
- Token 预算如何合理分配

**核心原则**：
- **按需加载**：不浪费 Token
- **信息完整**：关键信息不丢失
- **结构清晰**：LLM 易于理解
- **不过度工程**：避免复杂抽象

---

## 2. 当前上下文分层架构

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Core System（永久保留，永不压缩）                    │
│  - Agent 身份、行为约束、上下文层级策略、工作流启发式            │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Durable Memory / Task Frame（结构化、可压缩）        │
│  - USER.md / MEMORY.md、项目记忆、Skill、运行时与任务图          │
│  - 作为背景，不作为当前文件或主机状态的证明                     │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Recent Session（摘要 + 原始滑动窗口）                │
│  - 老事件进入可审计摘要，新事件保留原始角色消息                  │
│  - 解决长任务不闭合、证据丢失和窗口溢出                         │
├─────────────────────────────────────────────────────────────┤
│  Layer 4: Immediate Work（单轮注入，用完即弃）                 │
│  - 当前轮、RAG/Knowledge Brief、附件、Known Files、审批和连续性  │
│  - 放在请求后部，避免破坏 provider prompt-cache 前缀             │
└─────────────────────────────────────────────────────────────┘
```

每轮模型请求前都会预估 `稳定层 + 近期历史 + 即时 RAG/工具内容 + 预留输出 token`：

| 阈值 | 占用比例 | 动作 |
| --- | --- | --- |
| 预警线 | 70% | 轻量裁剪低价值旧事件，缩短过期大工具输出，保持当前目标和关键证据 |
| 压缩线 | 85% | 在请求前增量更新会话摘要，把窗口最老一批事件移出原始滑动窗口 |
| 紧急线 | 95% | 强制压缩大工具日志和历史 reasoning 片段，只保留核心结论和可重查线索 |

该策略优先保护任务成功：缓存命中率优化不能删除必要工具 schema、当前证据、用户最新目标或验证步骤。

---

## 3. 核心组件

### 3.1 ContextAssembler

```typescript
class ContextAssembler {
  private skillRegistry: SkillRegistry;
  private fileStateTrackers = new Map<string, FileStateTracker>(); // 按任务隔离
  private fs: FileSystem;

  constructor(skillRegistry: SkillRegistry, fs: FileSystem) {
    this.skillRegistry = skillRegistry;
    this.fs = fs;
  }

  getFileStateTracker(taskId: string): FileStateTracker {
    if (!this.fileStateTrackers.has(taskId)) {
      this.fileStateTrackers.set(taskId, new FileStateTracker(this.fs));
    }
    return this.fileStateTrackers.get(taskId)!;
  }

  // 清理已完成的任务的 FileStateTracker
  cleanupTask(taskId: string): void {
    this.fileStateTrackers.delete(taskId);
  }

  assemble(task: TaskDetail, budget: TokenBudget): AssembledContext {
    const layers: string[] = [];
    let usedTokens = 0;

    // Layer 1: System Instructions（固定）
    const systemLayer = this.buildSystemLayer();
    layers.push(systemLayer);
    usedTokens += estimateTokens(systemLayer);

    // Layer 2: Skill MetaData（轻量）
    const skillLayer = this.buildSkillMetaLayer(task);
    layers.push(skillLayer);
    usedTokens += estimateTokens(skillLayer);

    // Layer 3: File State Table（动态，但限制大小）
    const tracker = this.getFileStateTracker(task.id);
    const fileLayer = tracker.buildFileStateTable();
    const fileTokens = estimateTokens(fileLayer);
    if (fileLayer && usedTokens + fileTokens < budget.maxTotal * 0.3) {
      layers.push(fileLayer);
      usedTokens += fileTokens;
    }

    // Layer 4+5: Conversation History + Current Input
    const remainingTokens = budget.maxTotal - usedTokens - budget.reservedForResponse;
    const historyLayer = buildHistoryLayer(task, remainingTokens, tracker);
    layers.push(historyLayer);

    // 过滤空字符串，避免多余的换行
    const nonEmptyLayers = layers.filter(l => l.trim().length > 0);

    return {
      systemPrompt: nonEmptyLayers.slice(0, 2).join("\n\n"),
      input: nonEmptyLayers.slice(2).join("\n\n"),
      usedTokens: estimateTokens(nonEmptyLayers.join("\n\n"))
    };
  }
}
```

### 3.2 Skill 注入机制

**混合模式**：MetaData 轻量注入 + `use_skill` 工具按需加载

```typescript
// Layer 2 内容示例
function buildSkillMetaLayer(task: TaskDetail): string {
  // 按相关性和成功率排序，只取最相关的 Top N
  const skills = skillRegistry
    .listActive()
    .map(skill => ({
      skill,
      relevance: calculateRelevance(task.title, skill) // 复用设计文档中的相关性计算
    }))
    .filter(s => s.relevance > 0.3)
    .sort((a, b) => {
      const scoreA = a.relevance * (0.5 + 0.5 * a.skill.successRate);
      const scoreB = b.relevance * (0.5 + 0.5 * b.skill.successRate);
      return scoreB - scoreA;
    })
    .slice(0, 5) // 最多 5 个，避免过多
    .map(s => s.skill);

  if (skills.length === 0) return "";
  
  const lines = [
    "## Available Skills",
    "Call use_skill(skillId) when you need detailed guidance.",
    ""
  ];

  for (const skill of skills) {
    lines.push(`- ${skill.id}: ${skill.title} (${Math.round(skill.successRate * 100)}% success)`);
  }

  return lines.join("\n");
}

// use_skill 工具定义
const useSkillTool = {
  type: "function" as const,
  name: "use_skill",
  description: "Load a skill's full content into context for this task.",
  parameters: {
    type: "object",
    properties: {
      skillId: { type: "string", description: "Skill ID from Available Skills list" }
    },
    required: ["skillId"]
  }
};
```

**防循环机制**：
```typescript
interface TaskSkillSession {
  loadedSkills: Set<string>;
  loadCount: number;
}

const MAX_SKILL_LOADS = 3;

function canLoadSkill(skillId: string, session: TaskSkillSession): boolean {
  if (session.loadedSkills.has(skillId)) return false;
  if (session.loadCount >= MAX_SKILL_LOADS) return false;
  return true;
}
```

### 3.3 文件状态追踪

```typescript
interface FileState {
  path: string;
  content: string;           // 当前内容（限制长度）
  contentHash: string;       // 内容哈希
  lastModified: string;      // 最后修改时间
  isPartial: boolean;        // 是否为部分内容
}

interface FileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

class FileStateTracker {
  private states = new Map<string, FileState>();
  private maxFiles = 20;
  private maxContentLength = 2000;
  private fs: FileSystem;

  constructor(fs: FileSystem) {
    this.fs = fs;
  }

  updateFromToolResult(event: TaskEvent): void {
    const toolName = String(event.payload["toolName"] ?? "");
    const output = String(event.payload["output"] ?? "");

    // 跳过二进制数据
    if (looksLikeBinary(output)) {
      return;
    }

    // 处理 read_file 工具结果
    if (toolName === "read_file") {
      const path = String(event.payload["args"]?.["path"] ?? "");
      if (path && output) {
        this.states.set(path, {
          path,
          content: output.slice(0, this.maxContentLength),
          contentHash: hash(output),
          lastModified: event.createdAt,
          isPartial: output.length > this.maxContentLength
        });
      }
      return;
    }

    // 处理 list_files / search_files 结果（只记录文件路径，不记录内容）
    if (toolName === "list_files" || toolName === "search_files") {
      // 这些工具返回文件列表，不更新文件内容
      return;
    }

    // 处理 run_command 可能返回的文件内容
    // 通过路径推断：如果输出包含文件路径格式，且内容像代码/文本
    const inferredPath = inferFilePathFromOutput(output);
    if (inferredPath && looksLikeFileContent(output, inferredPath)) {
      this.states.set(inferredPath, {
        path: inferredPath,
        content: output.slice(0, this.maxContentLength),
        contentHash: hash(output),
        lastModified: event.createdAt,
        isPartial: output.length > this.maxContentLength
      });
    }
  }

  // 从 edit_file 工具调用更新文件状态
  async updateFromEdit(toolCall: TaskEvent, result: TaskEvent): Promise<void> {
    const path = String(toolCall.payload["path"] ?? "");
    if (!path) return;

    // 如果编辑成功，重新读取文件获取最新内容
    if (result.payload["ok"] === true) {
      try {
        const newContent = await this.fs.readFile(path);
        this.states.set(path, {
          path,
          content: newContent.slice(0, this.maxContentLength),
          contentHash: hash(newContent),
          lastModified: result.createdAt,
          isPartial: newContent.length > this.maxContentLength
        });
      } catch {
        // 读取失败，忽略
      }
    }
  }

  buildFileStateTable(): string {
    if (this.states.size === 0) return "";

    const lines = ["## Known Files (do not guess content)"];
    
    for (const [path, state] of this.states) {
      lines.push(`\n### ${path}`);
      if (state.isPartial) lines.push("(partial content)");
      lines.push("```");
      lines.push(state.content);
      lines.push("```");
    }

    return lines.join("\n");
  }

  // 限制文件数量，保留最近修改的
  prune(): void {
    if (this.states.size <= this.maxFiles) return;
    
    const sorted = [...this.states.entries()]
      .sort((a, b) => new Date(b[1].lastModified).getTime() - new Date(a[1].lastModified).getTime());
    
    this.states = new Map(sorted.slice(0, this.maxFiles));
  }

  hasFile(path: string): boolean {
    return this.states.has(path);
  }

  getFile(path: string): FileState | undefined {
    return this.states.get(path);
  }
}
```

### 3.4 对话历史格式化

采用 Markdown + 轻量标签，避免 XML 的 Token 开销和转义问题。

```typescript
function buildHistoryLayer(task: TaskDetail, maxTokens: number, fileStateTracker: FileStateTracker): string {
  const events = task.events.filter(e => 
    e.type !== "status_changed" && 
    e.type !== "task_created" &&
    e.type !== "experience_recorded" &&
    e.type !== "skill_promoted"
  );

  const formatted: string[] = [];
  let usedTokens = 0;

  // 逆向遍历（从最新开始），优先保留最近事件
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    let text = formatEvent(event, fileStateTracker);
    const tokens = estimateTokens(text);

    if (usedTokens + tokens > maxTokens) {
      // 预算不足，添加截断提示
      formatted.unshift("... (earlier events omitted)");
      break;
    }

    formatted.unshift(text);
    usedTokens += tokens;
  }

  return formatted.join("\n\n");
}

// 检查工具结果是否已在 FileStateTracker 中记录
function isFileContentInTracker(event: TaskEvent, tracker: FileStateTracker): boolean {
  if (event.type !== "tool_result") return false;
  const toolName = String(event.payload["toolName"] ?? "");
  if (toolName === "read_file") {
    const path = String(event.payload["args"]?.["path"] ?? "");
    return tracker.hasFile(path);
  }
  return false;
}

function formatEvent(event: TaskEvent, tracker?: FileStateTracker): string {
  switch (event.type) {
    case "user_message":
      return `**User**: ${event.summary}`;
    
    case "assistant_message":
      return `**Agent**: ${event.summary}`;
    
    case "tool_requested":
      return `**Tool Call**: ${event.payload["toolName"]}(${JSON.stringify(event.payload["args"] ?? {})})`;
    
    case "tool_result": {
      // 如果文件内容已在 FileStateTracker 中，历史记录中只保留引用
      if (tracker && isFileContentInTracker(event, tracker)) {
        const path = String(event.payload["args"]?.["path"] ?? "");
        return `**Tool Result**: File content recorded in Known Files (${path})`;
      }
      return `**Tool Result**:\n${formatToolOutput(String(event.payload["output"] ?? ""))}`;
    }
    
    case "approval_pending":
      return `**Approval Required**: ${event.payload["toolName"]} [${event.payload["riskCategory"]}]`;
    
    case "approval_resolved":
      return `**Approval Resolved**: ${event.payload["decision"]}`;
    
    case "guidance_consumed":
      return `**Guidance**: ${event.summary}`;
    
    default:
      return `**${event.type}**: ${event.summary}`;
  }
}

function formatToolOutput(output: string): string {
  const maxLen = 4000;
  if (output.length <= maxLen) return output;

  // 按输出类型智能处理
  if (looksLikeErrorOutput(output)) {
    // 错误输出：保留错误信息和堆栈，省略中间重复部分
    return extractErrorSummary(output);
  }

  if (looksLikeTestOutput(output)) {
    // 测试输出：保留摘要和失败详情
    return extractTestSummary(output);
  }

  if (looksLikeFileList(output)) {
    // 文件列表：通常不大，直接返回
    return output;
  }

  // 默认：保留开头和结尾
  const head = output.slice(0, 2000);
  const tail = output.slice(-2000);
  return `${head}\n\n... (${output.length - 4000} chars omitted) ...\n\n${tail}`;
}

function looksLikeErrorOutput(output: string): boolean {
  return /error|exception|failed|stack trace/i.test(output);
}

function looksLikeTestOutput(output: string): boolean {
  return /passing|failing|test suite|✓|✗/i.test(output);
}

function looksLikeFileList(output: string): boolean {
  return output.split("\n").every(line => line.includes("/") || line.includes("\\") || line.trim() === "");
}

function looksLikeBinary(output: string): boolean {
  // 检测是否包含大量不可打印字符
  const nonPrintable = output.split("").filter(c => {
    const code = c.charCodeAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  }).length;
  return nonPrintable > output.length * 0.1; // 超过 10% 不可打印字符
}

function inferFilePathFromOutput(output: string): string | null {
  // 从输出中推断文件路径（简化实现）
  const lines = output.split("\n");
  for (const line of lines.slice(0, 20)) {
    // 匹配文件路径格式：必须包含 / 或 \，且以常见扩展名结尾
    const match = line.match(/[\w\-./\\]+\.(js|ts|jsx|tsx|py|java|go|rs|cpp|c|h|md|json|yaml|yml|txt|html|css|scss)[\s:"']/i);
    if (match) {
      return match[0].replace(/[\s:"']$/, "");
    }
  }
  return null;
}

// 简单的内容哈希函数（实际实现应使用更可靠的算法）
function hash(content: string): string {
  let h = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    h = ((h << 5) - h) + char;
    h = h & h;
  }
  return h.toString(16);
}

function extractErrorSummary(output: string): string {
  const lines = output.split("\n");
  const errorLines: string[] = [];
  const seenMessages = new Set<string>();

  for (const line of lines) {
    if (/error|exception|failed/i.test(line)) {
      const normalized = line.replace(/\d+/g, "#").trim();
      if (!seenMessages.has(normalized)) {
        seenMessages.add(normalized);
        errorLines.push(line);
      }
    }
  }

  // 保留前 10 个唯一错误 + 最后 20 行
  const tail = lines.slice(-20);
  return [...errorLines.slice(0, 10), "...", ...tail].join("\n");
}

function extractTestSummary(output: string): string {
  const lines = output.split("\n");
  
  // 找测试摘要行（通常在开头或结尾）
  const summaryIndex = lines.findIndex(l => /test suite|passing|failing/i.test(l));
  const summary = summaryIndex >= 0 ? lines[summaryIndex] : "";

  // 找失败测试详情
  const failLines = lines.filter(l => /fail|✗|error/i.test(l)).slice(0, 10);

  return [summary, "", ...failLines, "... (omitted)"].join("\n");
}
```

---

### 3.5 辅助函数

```typescript
function estimateTokens(text: string): number {
  // 简单估算：英文 ~4 chars/token，中文 ~1 char/token
  // 实际实现应使用 tiktoken 等库精确计算
  let tokens = 0;
  for (const char of text) {
    if (/[\u4e00-\u9fa5]/.test(char)) {
      tokens += 1;
    } else if (/[a-zA-Z0-9]/.test(char)) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return Math.ceil(tokens);
}

function looksLikeFileContent(output: string, inferredPath: string): boolean {
  // 通过扩展名和内容特征判断输出是否像文件内容
  const ext = inferredPath.split(".").pop()?.toLowerCase() ?? "";

  // 已知文本扩展名，直接信任
  const textExtensions = ["js", "ts", "jsx", "tsx", "py", "java", "go", "rs",
    "cpp", "c", "h", "md", "json", "yaml", "yml", "txt", "html", "css", "scss",
    "xml", "toml", "ini", "cfg", "sh", "bat", "ps1", "sql"];
  if (textExtensions.includes(ext)) return true;

  // 非文本扩展名，检查可打印字符比例
  const printable = output.split("").filter(c => {
    const code = c.charCodeAt(0);
    return code >= 32 && code <= 126 || code === 9 || code === 10 || code === 13;
  }).length;
  return printable > output.length * 0.85;
}

function extractSkillCalls(toolCalls: unknown[]): Array<{ skillId: string }> {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call): call is { function: { name: string; arguments: string } } =>
      typeof call === "object" &&
      call !== null &&
      "function" in call &&
      call.function?.name === "use_skill"
    )
    .map(call => {
      try {
        const args = JSON.parse(call.function.arguments);
        return { skillId: args.skillId };
      } catch {
        return null;
      }
    })
    .filter((call): call is { skillId: string } => call !== null);
}

function extractOtherToolCalls(toolCalls: unknown[]): ToolCall[] {
  if (!Array.isArray(toolCalls)) return [];
  return toolCalls
    .filter((call): call is { id: string; function: { name: string; arguments: string } } =>
      typeof call === "object" &&
      call !== null &&
      "function" in call &&
      call.function?.name !== "use_skill" &&
      typeof call.id === "string"
    )
    .map(call => ({
      id: call.id,
      toolName: call.function.name,
      args: JSON.parse(call.function.arguments) as Record<string, unknown>
    }));
}
```

---

## 4. 工具定义

### 4.1 现有工具保留

```typescript
const runCommandTool = {
  type: "function" as const,
  name: "run_command",
  description: "Execute a shell command. Use for complex operations or when other tools don't fit.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" }
    },
    required: ["command"]
  }
};
```

### 4.2 新增工具

```typescript
const readFileTool = {
  type: "function" as const,
  name: "read_file",
  description: "Read file content with optional line range. Use this instead of run_command for reading files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      offset: { type: "number", description: "Start line (1-based), default 1" },
      limit: { type: "number", description: "Max lines to read, default 100" }
    },
    required: ["path"]
  }
};

const editFileTool = {
  type: "function" as const,
  name: "edit_file",
  description: "Edit file by specifying line range and replacement text. Safer than run_command for file modifications. Set expectedHash to the hash from read_file to detect concurrent modifications.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      expectedHash: { type: "string", description: "Expected content hash from read_file. If file changed, edit will fail." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            startLine: { type: "number" },
            endLine: { type: "number" },
            newText: { type: "string" }
          },
          required: ["startLine", "endLine", "newText"]
        }
      }
    },
    required: ["path", "edits"]
  }
};

const searchFilesTool = {
  type: "function" as const,
  name: "search_files",
  description: "Search for files or content in workspace.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query or glob pattern" },
      path: { type: "string", description: "Directory to search, default workspace root" }
    },
    required: ["query"]
  }
};

const listFilesTool = {
  type: "function" as const,
  name: "list_files",
  description: "List files in a directory.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path, default '.'" },
      recursive: { type: "boolean", description: "List recursively", default: false }
    },
    required: ["path"]
  }
};
```

---

## 5. Token 预算分配

```typescript
interface TokenBudget {
  maxTotal: number;           // 模型最大上下文，如 128000
  reservedForResponse: number; // 预留响应空间，如 16000
}

function calculateBudget(model: string): TokenBudget {
  // 根据模型类型返回不同预算
  switch (model) {
    case "gpt-4o":
      return { maxTotal: 128000, reservedForResponse: 16000 };
    case "gpt-4":
      return { maxTotal: 8192, reservedForResponse: 2000 };
    default:
      return { maxTotal: 128000, reservedForResponse: 16000 };
  }
}

```

---

## 6. 与现有系统集成

### 6.1 集成点

```typescript
// OpenAIModelClient 修改
export class OpenAIModelClient implements ModelClient {
  private contextAssembler: ContextAssembler;
  private skillLoadDepth = 0;
  private readonly MAX_SKILL_LOAD_DEPTH = 2; // 防止无限递归

  async next(task: TaskDetail): Promise<ModelTurn> {
    // 检查任务状态
    if (task.status !== "running") {
      return { kind: "final", message: `Task is ${task.status}.` };
    }

    const context = this.contextAssembler.assemble(task, calculateBudget(this.model));

    const response = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: context.systemPrompt },
        { role: "user", content: context.input }
      ],
      tools: this.getTools(),
      tool_choice: "auto"
    });

    // 分离 use_skill 调用和普通工具调用
    const allToolCalls = response.choices[0]?.message?.tool_calls ?? [];
    const skillCalls = extractSkillCalls(allToolCalls);
    const otherCalls = extractOtherToolCalls(allToolCalls);

    // 处理 use_skill 调用
    if (skillCalls.length > 0 && this.skillLoadDepth < this.MAX_SKILL_LOAD_DEPTH) {
      this.skillLoadDepth++;
      for (const call of skillCalls) {
        if (this.contextAssembler.canLoadSkill(call.skillId, task.id)) {
          this.contextAssembler.loadSkill(call.skillId, task.id);
        }
      }

      // 如果同时有普通工具调用，先返回工具调用，下次再加载 skill
      if (otherCalls.length > 0) {
        this.skillLoadDepth--;
        return { kind: "tool_calls", calls: otherCalls };
      }

      // 重新组装上下文并再次请求
      const result = await this.next(task);
      this.skillLoadDepth--;
      return result;
    }

    this.skillLoadDepth = 0; // 重置深度

    // 处理普通工具调用
    if (otherCalls.length > 0) {
      return { kind: "tool_calls", calls: otherCalls };
    }

    return this.parseResponse(response);
  }
}
```

### 6.2 事件监听

```typescript
// 监听工具结果，更新文件状态表
workbench.onEvent((event) => {
  if (event.type === "tool_result") {
    contextAssembler.fileStateTracker.updateFromToolResult(event);
  }
});
```

---

## 7. 流式响应处理

为提升用户体验和交互感，上下文组装系统支持流式响应（SSE streaming）。

### 7.1 核心策略

流式处理的核心原则：**累积分块文本，超过分行阈值后增量解析，实时触发文件状态追踪。**

```
LLM streaming chunks
    │
    ▼
StreamingParser (累积分块)
    │
    ├── 每收到 chunk → 追加到 buffer
    ├── 检测到完整行（\n）→ emit line event
    ├── 检测到 UNIT_END 标记 → emit unit_complete event
    │
    ▼
ContextAssembler.handleStreamEvent(event)
    │
    ├── "line" → 可选：实时展示给用户
    ├── "unit_complete" → ContractParser.parseUnit(buffer)
    ├── "stream_end" → 触发
    │       ContextAssembler.buildFileStateTable()
    │       ContextAssembler.buildHistoryLayer()
    │
    ▼
完整上下文切换：流式 → 非流式（后续交互可复用完整上下文）
```

### 7.2 StreamingParser

```typescript
type StreamEvent =
  | { type: "chunk"; text: string }
  | { type: "line"; line: string }
  | { type: "unit_complete"; unitId: string; output: string }
  | { type: "stream_end"; fullText: string }
  | { type: "error"; message: string };

class StreamingParser {
  private buffer = "";
  private currentUnitId: string | null = null;
  private currentUnitBuffer = "";

  onChunk(chunk: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    this.buffer += chunk;
    events.push({ type: "chunk", text: chunk });

    // 检测完整行
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx + 1);
      this.buffer = this.buffer.slice(newlineIdx + 1);
      events.push({ type: "line", line });

      // 检测 UNIT_ID 标记：### UNIT_ID: xxx
      const unitMatch = line.match(/^### UNIT_ID: (\S+)/);
      if (unitMatch) {
        this.currentUnitId = unitMatch[1];
        this.currentUnitBuffer = "";
      }

      // 检测 UNIT_END 标记：### UNIT_END
      if (/^### UNIT_END/.test(line) && this.currentUnitId) {
        events.push({
          type: "unit_complete",
          unitId: this.currentUnitId,
          output: this.currentUnitBuffer
        });
        this.currentUnitId = null;
        this.currentUnitBuffer = "";
        continue;
      }

      // 累积当前单元输出
      if (this.currentUnitId) {
        this.currentUnitBuffer += line;
      }
    }

    return events;
  }

  onEnd(): StreamEvent {
    return {
      type: "stream_end",
      fullText: this.buffer + this.currentUnitBuffer
    };
  }

  reset(): void {
    this.buffer = "";
    this.currentUnitId = null;
    this.currentUnitBuffer = "";
  }
}
```

### 7.3 ContextAssembler 流式集成

```typescript
class ContextAssembler {
  private parser = new StreamingParser();

  async assembleStreaming(
    task: TaskDetail,
    budget: TokenBudget,
    onChunk: (chunk: string) => void
  ): Promise<StreamedContext> {
    const systemLayer = buildSystemLayer(task);
    const skillLayer = buildSkillMetaLayer(task, this.skillRegistry);
    const tracker = this.getFileStateTracker(task.id);

    const response = await fetchChatCompletionStream({
      systemPrompt: [systemLayer, skillLayer].filter(Boolean).join("\n\n"),
      messages: this.buildInitialMessages(task)
    });

    for await (const chunk of response) {
      onChunk(chunk);

      const events = this.parser.onChunk(chunk);
      for (const event of events) {
        if (event.type === "line") {
          // 实时行可用于UI展示
          this.emitUserVisibleLine(event.line);
        }
        if (event.type === "unit_complete") {
          tracker.updateFromToolResult({
            type: "tool_result",
            payload: { toolName: "batch_unit", output: event.output }
          });
        }
      }
    }

    const endEvent = this.parser.onEnd();

    // 流结束后，构建完整的非流式上下文（用于后续交互）
    const fileLayer = tracker.buildFileStateTable();
    const historyLayer = buildHistoryLayer(task, budget.totalForHistory(), tracker);

    return {
      fullContext: [endEvent.fullText, fileLayer, historyLayer].filter(Boolean).join("\n\n"),
      usedTokens: estimateTokens(endEvent.fullText)
    };
  }
}
```

### 7.4 流式处理的边界条件

| 场景 | 处理方式 |
|------|---------|
| 网络中断 | `StreamingParser` 状态保留，支持断点续传（需API支持） |
| Buffer 内存溢出 | `currentUnitBuffer` 超过 64KB 时，截断并标记 `isPartial: true` |
| 标记缺失（无 UNIT_END） | `onEnd()` 将 `currentUnitBuffer` 作为最后一个单元处理 |
| 并发的流式请求 | 每个任务拥有独立的 `StreamingParser` 实例 |

---

## 8. 实现优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | ContextAssembler 基础框架 | 分层组装、Token 估算 |
| P0 | Skill MetaData 注入 | 轻量 skill 列表 |
| P0 | use_skill 工具 | 按需加载 skill 内容 |
| P1 | FileStateTracker | 追踪文件状态，防猜代码 |
| P1 | 对话历史格式化 | Markdown 格式、智能截断 |
| P1 | read_file 工具 | 分页读取 |
| P2 | edit_file 工具 | 行级编辑 |
| P2 | search_files / list_files | 文件搜索和列表 |
| P2 | 防循环机制 | Skill 加载次数限制 |
| P3 | 增量组装优化 | 性能优化 |

---

## 9. 版本历史

| 版本 | 反思次数 | 主要修正 |
|------|---------|---------|
| v1.0 | 0 | 初始设计文档 |
| v1.1 | 1 | 添加 `updateFromEdit` 方法、防递归深度限制、智能工具输出摘要、Token 估算函数 |
| v1.2 | 2 | 抽象 FileSystem 接口、按相关性排序 Skill MetaData、历史记录去重（FileStateTracker 已记录的文件内容不再重复显示）、分离 skill 和普通工具调用处理 |
| v1.3 | 3 | 添加 `hasFile`/`getFile` 方法、`extractSkillCalls`/`extractOtherToolCalls` 函数定义、优化 skill 和普通调用同时存在的处理、Token 估算增加说明 |
| v1.4 | 4 | FileStateTracker 按任务隔离、任务状态检查、二进制数据跳过、路径推断优化 |
| v1.5 | 5 | `cleanupTask` 内存清理、空层过滤、`edit_file` 增加 `expectedHash`、路径正则优化、添加 `hash` 函数实现 |

---

## 10. 设计总结

### 核心设计决策

1. **Skill 注入**：MetaData 轻量注入 + `use_skill` 工具按需加载，避免 Token 浪费
2. **上下文格式**：Markdown + 轻量标签，平衡可读性和 Token 开销
3. **文件状态追踪**：按任务隔离，自动从工具结果更新，防止"猜代码"
4. **历史截断**：逆向遍历优先保留最近事件，已记录文件内容去重
5. **Token 预算**：分层分配，精确估算（实际使用 tiktoken）

### 关键防漏洞机制

- **防循环**：Skill 加载深度限制（最多 2 层）
- **防并发冲突**：`edit_file` 带 `expectedHash` 版本校验
- **防内存泄漏**：任务完成后清理 FileStateTracker
- **防二进制污染**：自动跳过二进制数据
- **防信息丢失**：文件状态表与历史记录去重

---

*文档结束 - v1.5（最终版）*
