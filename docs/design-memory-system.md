# Agent Workbench Engine: Experience & Skill 系统设计文档

> 版本: v3.0 (Final)
> 日期: 2026-05-05
> 状态: 定稿（整合上下文组装、长期记忆、MCP 接入设计）
>
> **注意**：文中所有代码均为参考实现，具体实现可能根据实际工程需求调整。

---

## 1. 设计目标

让 Agent 具备**持续学习能力**：
- 从任务执行中提取可复用模式
- 在相似任务中自动应用已学技能
- 通过反思不断优化技能质量
- 减少用户重复性指导

**核心原则**：
- **默认无打扰**：用户不需要为每个任务做决策
- **渐进式固化**：Task Memory → Pattern → Skill，越往后越严格
- **统计驱动**：用数据说话，不是人工判断
- **可修正**：错了可以标记，系统自适应调整
- **透明可控**：用户可以随时查看和干预

---

## 2. 核心概念

### 2.1 三层记忆模型

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1: Task Memory (任务记忆)                              │
│  - 每个任务自动记录                                            │
│  - 包含：目标、工具链、结果、Agent 自评、MetaData               │
│  - 用途：离线分析的原料                                         │
│  - 生命周期：30天后归档                                         │
│  - 注入上下文：❌ 从不                                          │
├─────────────────────────────────────────────────────────────┤
│  Layer 2: Pattern (模式)                                      │
│  - 从多个相似 Task Memory 提取的通用方法                        │
│  - 包含：触发条件、工具序列、注意事项                            │
│  - 用途：Agent 推理时的参考提示（弱约束）                        │
│  - 生命周期：观察中 → 稳定 → 废弃                               │
│  - 注入上下文：✅ 可选（Agent 自行判断）                         │
├─────────────────────────────────────────────────────────────┤
│  Layer 3: Skill (技能)                                        │
│  - 经过验证的可靠模式                                           │
│  - 包含：明确适用场景、精确参数、错误处理                         │
│  - 用途：Agent 可直接依赖（强约束）                              │
│  - 生命周期：候选 → 活跃 → 暂停 → 淘汰                           │
│  - 注入上下文：✅ 自动匹配注入                                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键区别

| 维度 | Task Memory | Pattern | Skill |
|------|-------------|---------|-------|
| 来源 | 单次任务 | 多次任务聚合 | Pattern 固化 |
| 确定性 | 低（原始记录） | 中（观察到的规律） | 高（验证过的方法） |
| 注入方式 | 不注入 | 可选参考 | 自动匹配 |
| 用户可见 | 是（历史记录） | 是（Learning 面板） | 是（Learning 面板） |
| 修正权限 | 用户 | Agent+用户 | Agent+用户 |

**重要**：Task Memory **从不**直接注入上下文。只有 Skill 会被注入，Pattern 仅作为 Agent 的内部参考。

---

## 3. 数据模型

### 3.1 Task Memory

```typescript
interface TaskMemory {
  id: string;
  taskId: string;
  title: string;
  
  // 核心内容
  goal: string;                    // 用户原始目标（敏感信息需脱敏，见第11节）
  toolsUsed: ToolTrace[];          // 工具调用链
  result: string;                  // 最终结果摘要
  
  // Agent 自评（任务完成时与总结报告一起生成）
  assessment: {
    goalAchieved: boolean;
    confidence: number;            // 0-1
    issues: string[];              // 遇到的问题
    learnings: string[];           // 学到的东西
    suggestedPatterns: string[];   // 建议提取的模式
  };
  
  // MetaData（任务完成时生成，用于快速筛选）
  // 生成方式：基于任务事件流自动提取，不额外调用模型
  meta: {
    outcome: "success" | "failure" | "partial";
    complexity: "simple" | "medium" | "complex";
    domains: string[];             // 领域标签，如 ["git", "testing"]
    tools: string[];               // 使用的工具名
    hasSideEffects: boolean;       // 是否有副作用
    duration: number;              // 执行耗时（秒）
  };
  
  // 统计
  reflectionCount: number;         // 被反思分析的次数
  
  // 状态
  reflectionStatus: "pending" | "reflected" | "archived";
  
  createdAt: string;
}

interface ToolTrace {
  toolName: string;
  args: Record<string, unknown>;
  result: string;
  riskCategory: RiskCategory;
}
```

**MetaData 生成规则**（基于事件流自动提取，无需模型调用）：
- `outcome`: 根据任务最终状态（completed=success, failed=failure, 其他=partial）
- `complexity`: 根据工具调用次数（1-2=simple, 3-5=medium, 6+=complex）
- `domains`: 根据工具名映射（git 相关工具 → "git"，测试相关 → "testing"）
- `tools`: 直接提取工具名列表
- `hasSideEffects`: 检查是否有 workspace_write / destructive 风险类别的工具调用

### 3.2 Pattern

```typescript
interface Pattern {
  id: string;
  
  // 识别信息
  title: string;
  description: string;
  
  // 触发条件
  trigger: {
    keywords: string[];            // 关键词匹配
    requiredTools: string[];       // 必须工具
    domainHints: string[];         // 领域提示
  };
  
  // 模式内容
  content: {
    approach: string;              // 方法论
    toolSequence: string[];        // 推荐工具序列
    cautions: string[];            // 注意事项
    commonMistakes: string[];      // 常见错误
  };
  
  // 统计
  sourceTaskCount: number;         // 基于多少个任务
  successCount: number;
  failureCount: number;
  
  // 状态
  status: "forming" | "stable" | "deprecated";
  confidence: number;              // 0-1
  
  // 状态转换条件
  // forming → stable: sourceTaskCount >= 3 且 confidence >= 0.6
  // stable → deprecated: 连续 5 次验证失败 或 30 天未使用
  
  // 关联
  relatedSkills: string[];         // 关联的 Skill IDs
  
  createdAt: string;
  lastValidatedAt: string;
}
```

### 3.3 Skill

```typescript
interface Skill {
  id: string;
  sourcePatternId: string;
  
  // 基本信息
  title: string;
  body: string;                    // Markdown 格式的详细指南（环境无关，见第11节）
  
  // 严格的适用条件
  applicability: {
    description: string;           // 一句话描述适用场景
    requiredTools: string[];       // 必须工具
    requiredContext: string[];     // 必须上下文
    exclusions: string[];          // 不适用场景
    minConfidence: number;         // 最低置信度
    keywords: string[];            // 用于匹配的关键词（与 Pattern.trigger.keywords 语义一致）
  };
  
  // 质量指标
  stats: {
    totalUses: number;             // 被使用次数
    successUses: number;
    failureUses: number;
    successRate: number;           // 动态计算
    lastFailureAt?: string;        // 最后一次失败时间
    consecutiveFailures: number;   // 连续失败次数
  };
  
  // 版本（覆盖式，但保留历史）
  version: number;
  corrections: Correction[];       // 修正历史（最多保留 10 条，超出时归档到单独存储）
  
  // 状态
  status: "candidate" | "active" | "suspended" | "retired";
  
  // 关联
  relatedPatterns: string[];
  
  createdAt: string;
  lastUsedAt: string;
  updatedAt: string;
}

interface Correction {
  id: string;
  type: "user" | "agent" | "auto";
  reason: string;
  originalBody: string;
  revisedBody: string;
  createdAt: string;
}
```

**Skill 淘汰规则**：
```typescript
function shouldRetireSkill(skill: Skill): boolean {
  // 条件1：连续失败过多
  if (skill.stats.consecutiveFailures >= 5) return true;
  
  // 条件2：成功率过低且使用次数足够
  if (skill.stats.totalUses >= 10 && skill.stats.successRate < 0.3) return true;
  
  // 条件3：长期未使用
  const daysSinceLastUse = (Date.now() - new Date(skill.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceLastUse > 90 && skill.stats.totalUses < 5) return true;
  
  return false;
}
```

### 3.4 数据持久化层

**存储介质**：SQLite（本地文件）

```typescript
interface StorageSchema {
  // 表1: task_memories
  task_memories: {
    id: string;
    data: JSON;                    // 完整的 TaskMemory 对象
    created_at: number;
    archived_at: number | null;
  };
  
  // 表2: patterns
  patterns: {
    id: string;
    data: JSON;
    status: "forming" | "stable" | "deprecated";
    created_at: number;
    updated_at: number;
  };
  
  // 表3: skills
  skills: {
    id: string;
    data: JSON;
    status: "candidate" | "active" | "suspended" | "retired";
    success_rate: number;          // 冗余存储，便于查询
    created_at: number;
    updated_at: number;
    last_used_at: number;
  };
  
  // 表4: skill_corrections（归档的修正记录）
  skill_corrections: {
    id: string;
    skill_id: string;
    data: JSON;
    created_at: number;
  };
  
  // 表5: conflicts
  conflicts: {
    id: string;
    skill_a: string;
    skill_b: string;
    type: string;
    severity: string;
    status: "pending" | "resolved" | "auto_resolved";
    resolution: JSON | null;
    created_at: number;
    resolved_at: number | null;
  };
  
  // 表6: reflection_sessions（反思会话状态）
  reflection_sessions: {
    id: string;
    status: "running" | "completed" | "partial" | "failed";
    progress: JSON;                // { phase, completedDomains, nextStep }
    token_used: number;
    budget: number;
    created_at: number;
    completed_at: number | null;
  };
  
  // 表7: reflection_snapshots（反思快照，用于撤销）
  reflection_snapshots: {
    id: string;
    session_id: string;
    snapshot_type: "before" | "after";
    patterns: JSON | null;         // 反思前的 Pattern 状态
    skills: JSON | null;           // 反思前的 Skill 状态
    created_at: number;
  };
}
```

**备份与恢复策略**：

SQLite 单文件特性决定了备份操作极其简单，但 WAL 模式下需要注意：

```
备份时必须同时复制三个文件：
  memory.db        (主数据库)
  memory.db-wal    (Write-Ahead Log)
  memory.db-shm    (Shared Memory)

备份命令示例 (PowerShell):
  Copy-Item -Path "data\memory.db*" -Destination "backups\memory_$(Get-Date -Format 'yyyyMMdd_HHmmss')\"

恢复步骤:
  1. 停止所有写入进程
  2. 用备份文件覆盖 data/ 目录下的对应文件
  3. 重启系统，SQLite 自动执行 WAL checkpoint 恢复一致性
```

- 备份频率：每天夜间反思完成后自动备份一次
- 备份保留：保留最近 7 天的每日备份 + 最近 4 周的每周备份
- 备份位置：`data/backups/` 目录，与数据库同盘（跨盘备份由运维层负责）

**归档策略**：
- Task Memory 30 天后自动归档（archived_at 字段标记）
- 归档后不再参与反思，但保留在数据库中（可手动查看）
- 每 90 天清理一次已归档超过 180 天的记录（导出到文件后删除）
- Skill corrections 超过 10 条后，旧记录移动到 skill_corrections 表

**并发控制**：
- SQLite 使用 WAL（Write-Ahead Logging）模式，支持读写并发
- 反思开始时锁定任务列表快照，执行过程中新产生的 Task Memory 留到下次反思处理
- Skill 更新使用事务，避免部分写入

---

## 4. Skill 匹配算法（核心）

### 4.1 匹配流程

```typescript
function findRelevantSkills(taskTitle: string, skills: Skill[]): Skill[] {
  // 1. 过滤活跃 Skill
  const active = skills.filter(s => s.status === "active");
  
  // 2. 计算相关性分数
  const scored = active.map(skill => ({
    skill,
    score: calculateRelevance(taskTitle, skill)
  }));
  
  // 3. 过滤低相关性
  const relevant = scored.filter(s => s.score > 0.3);
  
  // 4. 按综合分数排序（相关性 + 成功率 + 时效性）
  const sorted = relevant.sort((a, b) => {
    const scoreA = calculateCompositeScore(a.skill, a.score);
    const scoreB = calculateCompositeScore(b.skill, b.score);
    return scoreB - scoreA;
  });
  
  // 5. 限制数量（避免上下文过长）
  return sorted.slice(0, 3).map(s => s.skill);
}

function calculateCompositeScore(skill: Skill, relevance: number): number {
  // 时效性衰减：超过 30 天未使用，成功率权重下降
  const daysSinceLastUse = (Date.now() - new Date(skill.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24);
  const recencyFactor = Math.max(0.5, 1 - daysSinceLastUse / 60); // 60 天后降至 0.5
  
  // 综合分数 = 相关性 * (0.4 + 0.4 * 成功率 + 0.2 * 时效性)
  return relevance * (0.4 + 0.4 * skill.stats.successRate + 0.2 * recencyFactor);
}
```

### 4.2 相关性计算（支持中英文）

```typescript
function calculateRelevance(taskTitle: string, skill: Skill): number {
  const title = taskTitle.toLowerCase();
  const keywords = skill.applicability.keywords.map(k => k.toLowerCase());
  
  // 1. 分词（支持中英文）
  const titleWords = tokenize(title);
  const keywordWords = new Set(keywords.flatMap(k => tokenize(k)));
  
  // 2. 关键词匹配（Jaccard 相似度）
  const intersection = new Set([...titleWords].filter(w => keywordWords.has(w)));
  const union = new Set([...titleWords, ...keywordWords]);
  const keywordScore = union.size > 0 ? intersection.size / union.size : 0;
  
  // 3. 领域匹配
  const domainScore = skill.applicability.requiredContext.some(ctx => 
    title.includes(ctx.toLowerCase())
  ) ? 0.3 : 0;
  
  // 4. 工具匹配
  const toolScore = skill.applicability.requiredTools.some(tool => 
    title.includes(tool.toLowerCase())
  ) ? 0.2 : 0;
  
  // 5. 短语精确匹配（加分项）
  const exactMatchScore = keywords.some(k => title.includes(k)) ? 0.2 : 0;
  
  return Math.min(1, keywordScore + domainScore + toolScore + exactMatchScore);
}

// 分词函数：支持中英文混合
function tokenize(text: string): Set<string> {
  const words = new Set<string>();
  
  // 英文：按非字母数字分词
  const englishWords = text.match(/[a-z0-9]+/g) || [];
  englishWords.forEach(w => words.add(w));
  
  // 中文：按字符分词（简单但有效）
  // 更优方案：引入轻量级中文分词库（如 nodejieba 的 wasm 版本）
  const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
  chineseChars.forEach(c => words.add(c));
  
  // 中文双字词（可选，提高匹配精度）
  for (let i = 0; i < chineseChars.length - 1; i++) {
    words.add(chineseChars[i] + chineseChars[i + 1]);
  }
  
  return words;
}
```

### 4.3 注入格式

```typescript
function buildSkillPrompt(skills: Skill[]): string {
  if (skills.length === 0) return "";
  
  const lines = ["## Relevant Skills", ""];
  
  for (const skill of skills) {
    lines.push(`### ${skill.title}`);
    lines.push(`Applicable when: ${skill.applicability.description}`);
    lines.push(`Success rate: ${Math.round(skill.stats.successRate * 100)}%`);
    lines.push("");
    lines.push(skill.body.slice(0, 800)); // 限制长度
    lines.push("");
  }
  
  lines.push("Note: Skills are suggestions. Use your judgment.");
  lines.push("");
  
  return lines.join("\n");
}
```

**关键限制**：
- 最多注入 3 个 Skill
- 每个 Skill 最多 800 字符
- 总注入不超过 3000 字符
- 不匹配时不注入（避免噪音）

---

## 5. 生命周期流程

### 5.0 冷启动策略

系统从零开始运行时（零条 Task Memory、零个 Pattern、零个 Skill），按以下路径逐步激活学习能力：

1. **前5个任务**：仅生成 Task Memory（标记为 pending），不触发反思。Agent 完全依赖系统提示词和用户指令执行，Skill MetaData 层为空。
2. **第5个任务完成后**：`minTasksForReflection: 5` 条件满足，自动或手动触发首次 Meta Reflection。此时仅执行轻量统计分析，不做 Domain/Skill 生成。
3. **累积10个任务后**：满足 Domain Reflection 的最小样本量，开始提取 Pattern（forming 状态）。
4. **Pattern 满足固化条件后**：自动晋升为 Skill（candidate→active），后续任务开始享受 Skill 注入。

冷启动期间的降级行为：Skill 匹配返回空列表时，ContextAssembler 的 Layer 2 不输出内容，Agent 正常工作但不享受经验加速。

### 5.1 Task Memory 生成（自动）

```
任务完成
    │
    ▼
Agent 生成总结报告给用户
    │
    ├── 同时生成 assessment（自评）
    ├── 同时生成 meta（元数据标签，基于规则自动提取）
    │
    ▼
保存 Task Memory
    │
    ▼
标记为 "pending"（待反思）
```

**关键设计**：MetaData 基于规则自动提取，不额外调用模型，避免延迟。

**容错设计**：
- `assessment` 生成失败时不阻塞 Task Memory 保存，使用默认值（`goalAchieved: false, confidence: 0, issues: [], learnings: []`）
- `meta` 生成失败时使用最保守值（`outcome: "partial", complexity: "simple"`）

### 5.2 反思流程（异步）

```
触发条件满足（夜间/手动/定时）
    │
    ▼
┌─────────────────┐
│  Step 1: Meta   │
│  Reflection     │
│  (轻量)         │
└─────────────────┘
    │
    ├── 读取所有"pending" Task Memory 的 MetaData
    ├── 生成统计摘要
    ├── 识别异常和机会
    │
    ├── 无异常 ─────────────► 标记为"reflected"，结束
    │
    └── 发现机会
            │
            ▼
┌─────────────────┐
│  Step 2: Domain │
│  Reflection     │
│  (中等)         │
└─────────────────┘
    │
    ├── 选择 Top 1-2 领域
    ├── 读取该领域 Task Memory 的完整内容（限制10个）
    ├── 提取/更新 Pattern
    │
    ├── 无新 Pattern ───────► 标记为"reflected"，结束
    │
    └── 发现新 Pattern
            │
            ▼
┌─────────────────┐
│  Step 3: Skill  │
│  Generation     │
│  (重，低频)      │
└─────────────────┘
    │
    ├── 检查 Pattern 是否满足固化条件
    ├── 生成/更新 Skill
    ├── 检测冲突
    ├── 解决冲突（或标记为人工审核）
    │
    ▼
标记为"reflected"
```

### 5.3 Skill 固化条件

```typescript
function shouldPromoteToSkill(pattern: Pattern): boolean {
  // 条件1：使用次数
  if (pattern.sourceTaskCount < 5) return false;
  
  // 条件2：成功率
  const total = pattern.successCount + pattern.failureCount;
  if (total < 5) return false;
  const rate = pattern.successCount / total;
  if (rate < 0.75) return false;
  
  // 条件3：稳定性
  if (pattern.status !== "stable") return false;
  
  // 条件4：置信度
  if (pattern.confidence < 0.8) return false;
  
  return true;
}
```

### 5.4 Pattern 状态转换

```
forming ──(sourceTaskCount >= 3 且 confidence >= 0.6)──► stable
   │                                                        │
   │                                                        │
   └──(连续 3 次验证失败)────────────────────────────────────► deprecated
   
stable ──(连续 5 次验证失败 或 30 天未使用)──► deprecated
```

### 5.5 Skill 状态转换

```
candidate ──(首次创建)──► active
   │                        │
   │                        │
   └──(成功率过低)──────────► suspended
   
active ──(shouldRetireSkill 返回 true)──► retired
   │                                        │
   │                                        │
   └──(检测到冲突，人工审核)──────────────────► suspended
   
suspended ──(用户手动恢复)──► active
         │
         └──(长期未恢复)────► retired
```

---

## 6. 冲突处理

### 6.1 冲突类型

| 冲突类型 | 说明 | 示例 |
|---------|------|------|
| **覆盖冲突** | 两个 Skill 适用于相同场景 | Skill A: "用 git rebase" vs Skill B: "用 git merge" |
| **顺序冲突** | 工具序列矛盾 | Skill A: "先测试后提交" vs Skill B: "先提交后测试" |
| **参数冲突** | 相同工具不同参数 | Skill A: "deploy --prod" vs Skill B: "deploy --staging" |
| **范围冲突** | 适用场景重叠但不完全相同 | Skill A: "React 组件测试" vs Skill B: "前端单元测试" |

### 6.2 冲突检测

```typescript
interface Conflict {
  id: string;
  type: "overlap" | "sequence" | "parameter" | "scope";
  skillA: string;
  skillB: string;
  description: string;
  severity: "high" | "medium" | "low";
  
  // 解决方案（由反思生成）
  resolution?: {
    strategy: "merge" | "specialize" | "deprecate_one" | "keep_both" | "manual_review";
    reason: string;
    mergedSkillId?: string;
  };
}

function detectConflicts(skills: Skill[]): Conflict[] {
  const conflicts: Conflict[] = [];
  
  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i];
      const b = skills[j];
      
      // 检查适用场景重叠
      const overlap = calculateApplicabilityOverlap(a.applicability, b.applicability);
      if (overlap > 0.7) {
        conflicts.push({
          id: createId("conflict"),
          type: "overlap",
          skillA: a.id,
          skillB: b.id,
          description: `Skills "${a.title}" and "${b.title}" have ${Math.round(overlap * 100)}% applicability overlap`,
          severity: overlap > 0.9 ? "high" : "medium"
        });
      }
      
      // 检查工具序列冲突（如果都有 toolSequence）
      const sequenceConflict = detectSequenceConflict(a, b);
      if (sequenceConflict) {
        conflicts.push(sequenceConflict);
      }
    }
  }
  
  return conflicts;
}

function calculateApplicabilityOverlap(a: Skill["applicability"], b: Skill["applicability"]): number {
  // 1. 关键词重叠
  const keywordOverlap = jaccardSimilarity(
    new Set(a.keywords.map(k => k.toLowerCase())),
    new Set(b.keywords.map(k => k.toLowerCase()))
  );
  
  // 2. 工具重叠
  const toolOverlap = jaccardSimilarity(
    new Set(a.requiredTools.map(t => t.toLowerCase())),
    new Set(b.requiredTools.map(t => t.toLowerCase()))
  );
  
  // 3. 上下文重叠
  const contextOverlap = jaccardSimilarity(
    new Set(a.requiredContext.map(c => c.toLowerCase())),
    new Set(b.requiredContext.map(c => c.toLowerCase()))
  );
  
  // 加权平均（关键词最重要）
  return keywordOverlap * 0.5 + toolOverlap * 0.3 + contextOverlap * 0.2;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = new Set([...a].filter(x => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

function detectSequenceConflict(a: Skill, b: Skill): Conflict | null {
  // 从 Skill body 中提取工具序列（简化实现）
  const extractTools = (body: string): string[] => {
    const matches = body.match(/`([a-z-]+)`/g) || [];
    return matches.map(m => m.slice(1, -1));
  };
  
  const toolsA = extractTools(a.body);
  const toolsB = extractTools(b.body);
  
  // 如果工具集合高度重叠但顺序不同，可能是顺序冲突
  const commonTools = toolsA.filter(t => toolsB.includes(t));
  if (commonTools.length >= 2) {
    const overlap = commonTools.length / Math.max(toolsA.length, toolsB.length);
    if (overlap > 0.5) {
      return {
        id: createId("conflict"),
        type: "sequence",
        skillA: a.id,
        skillB: b.id,
        description: `Skills "${a.title}" and "${b.title}" use similar tools in different sequences`,
        severity: "medium"
      };
    }
  }
  
  return null;
}
```

### 6.3 冲突解决策略

**原则**：自动处理低风险冲突，高风险冲突需要用户确认。

```typescript
function resolveConflict(conflict: Conflict, skills: Skill[]): Resolution {
  const skillA = skills.find(s => s.id === conflict.skillA)!;
  const skillB = skills.find(s => s.id === conflict.skillB)!;
  
  // 策略1：成功率差距大 → 自动降级差的
  if (Math.abs(skillA.stats.successRate - skillB.stats.successRate) > 0.3) {
    const better = skillA.stats.successRate > skillB.stats.successRate ? skillA : skillB;
    const worse = skillA.stats.successRate > skillB.stats.successRate ? skillB : skillA;
    return {
      strategy: "deprecate_one",
      reason: `${better.title} has significantly higher success rate (${better.stats.successRate})`,
      action: () => {
        worse.status = "suspended";
        worse.corrections.push({
          type: "auto",
          reason: `Superseded by ${better.title} due to higher success rate`,
          originalBody: worse.body,
          revisedBody: `See ${better.title} (${better.id})`,
          createdAt: nowIso()
        });
      }
    };
  }
  
  // 策略2：成功率接近 → 需要人工审核
  if (Math.abs(skillA.stats.successRate - skillB.stats.successRate) < 0.1) {
    return {
      strategy: "manual_review",
      reason: "Both skills have similar success rates. Human review needed.",
      action: () => {
        markConflictForReview(conflict);
      }
    };
  }
  
  // 策略3：范围冲突 → 自动细分
  if (conflict.type === "scope") {
    return {
      strategy: "specialize",
      reason: "Both skills are valid for different sub-cases",
      action: () => {
        refineApplicability(skillA, skillB);
      }
    };
  }
  
  // 默认：人工审核
  return {
    strategy: "manual_review",
    reason: "Conflict type requires human judgment",
    action: () => {
      markConflictForReview(conflict);
    }
  };
}

function refineApplicability(skillA: Skill, skillB: Skill): void {
  // 自动细分的实现：让模型重写 applicability
  // 1. 构建提示，要求模型区分两个 Skill 的适用场景
  // 2. 模型返回细化的 exclusions 和 requiredContext
  // 3. 更新两个 Skill 的 applicability
  
  const prompt = `
Two skills have overlapping applicability. Please refine their conditions to make them distinct:

Skill A: ${skillA.title}
Current applicability: ${JSON.stringify(skillA.applicability)}

Skill B: ${skillB.title}
Current applicability: ${JSON.stringify(skillB.applicability)}

Please provide refined "exclusions" for each skill to clarify when one should be used over the other.
`;
  
  // 调用模型获取细化结果
  // const result = await model.generate(prompt);
  // 解析结果并更新 skillA.applicability.exclusions 和 skillB.applicability.exclusions
}
```

**冲突自愈机制**：
```typescript
function autoResolveStaleConflicts(conflicts: Conflict[]): void {
  const STALE_DAYS = 30;
  
  for (const conflict of conflicts) {
    if (conflict.status !== "pending") continue;
    
    const daysSinceCreated = (Date.now() - new Date(conflict.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceCreated > STALE_DAYS) {
      // 自动降级两个 Skill 的优先级
      const skillA = getSkill(conflict.skillA);
      const skillB = getSkill(conflict.skillB);
      
      if (skillA) skillA.status = "suspended";
      if (skillB) skillB.status = "suspended";
      
      conflict.status = "auto_resolved";
      conflict.resolution = {
        strategy: "deprecate_one",
        reason: `Auto-resolved after ${STALE_DAYS} days of inactivity`
      };
    }
  }
}
```

**重要**：高风险冲突（成功率接近、涉及 destructive 工具）**必须**人工审核，不能自动处理。

---

## 7. 反思系统

### 7.1 触发条件

| 触发方式 | 条件 | 优先级 | 说明 |
|---------|------|--------|------|
| **夜间自动** | 每天 02:00，且有待反思任务 | 低 | 默认开启，可在设置中关闭 |
| **手动触发** | 用户点击"Run Reflection" | 高 | 立即执行 |
| **定时触发** | 待反思任务达到 10 个 | 中 | 防止积压 |

**移除**：空闲触发（过于频繁，干扰用户）

### 7.2 Token 预算控制

```typescript
interface ReflectionBudget {
  maxTotalTokens: number;        // 单次反思总预算，默认 10000
  maxMetaTokens: number;         // Meta 反思预算，默认 1000
  maxDomainTokens: number;       // Domain 反思预算，默认 4000
  maxSkillTokens: number;        // Skill 生成预算，默认 5000
  
  minTasksForReflection: number; // 最少任务数，默认 5
  maxTasksPerDomain: number;     // 每领域最大任务数，默认 10
  maxDomainsPerSession: number;  // 每次反思最大领域数，默认 2
}
```

**预算超限处理**：
- 不硬截断正在进行的操作
- 完成当前步骤后停止
- 记录"部分完成"状态
- 下次反思时继续

### 7.3 渐进式批处理

```typescript
async function runReflection(tasks: TaskMemory[], budget: ReflectionBudget): Promise<ReflectionResult> {
  let usedTokens = 0;
  const result: ReflectionResult = { 
    changes: [],
    completed: false,
    nextStep: null
  };
  
  // Step 1: Meta Reflection（总是执行）
  const metaResult = await runMetaReflection(tasks);
  usedTokens += metaResult.tokensUsed;
  result.metaSummary = metaResult.summary;
  
  if (usedTokens >= budget.maxTotalTokens || metaResult.recommendedDomains.length === 0) {
    result.completed = true;
    return result;
  }
  
  // Step 2: Domain Reflection（按需）
  const domains = metaResult.recommendedDomains.slice(0, budget.maxDomainsPerSession);
  for (const domain of domains) {
    if (usedTokens >= budget.maxTotalTokens) {
      result.nextStep = { phase: "domain", remainingDomain: domain };
      return result;
    }
    
    const domainTasks = tasks
      .filter(t => t.meta.domains.includes(domain))
      .slice(0, budget.maxTasksPerDomain);
    
    const domainResult = await runDomainReflection(domain, domainTasks);
    usedTokens += domainResult.tokensUsed;
    result.changes.push(...domainResult.changes);
  }
  
  if (usedTokens >= budget.maxTotalTokens) {
    result.nextStep = { phase: "skill" };
    return result;
  }
  
  // Step 3: Skill Generation（低频）
  const patternsToPromote = result.changes
    .filter(c => c.type === "pattern_updated" && c.confidence > 0.8);
  
  for (const pattern of patternsToPromote) {
    if (usedTokens >= budget.maxTotalTokens) {
      result.nextStep = { phase: "skill", remainingPattern: pattern.id };
      return result;
    }
    
    const skillResult = await runSkillGeneration(pattern);
    usedTokens += skillResult.tokensUsed;
    result.changes.push(skillResult.change);
  }
  
  result.completed = true;
  return result;
}
```

### 7.4 反思容错与恢复

**状态持久化**：
```typescript
interface ReflectionSession {
  id: string;
  status: "running" | "completed" | "partial" | "failed";
  progress: {
    phase: "meta" | "domain" | "skill";
    completedDomains: string[];
    remainingDomain?: string;
    remainingPattern?: string;
  };
  tokenUsed: number;
  budget: ReflectionBudget;
  createdAt: string;
  completedAt?: string;
}
```

**恢复机制**：
```typescript
async function resumeReflection(sessionId: string): Promise<ReflectionResult> {
  const session = await db.reflection_sessions.findById(sessionId);
  
  if (!session || session.status !== "partial") {
    throw new Error("No partial reflection session found");
  }
  
  // 读取上次的状态，从 nextStep 继续
  const tasks = await getPendingTasks();
  const budget = {
    ...session.budget,
    maxTotalTokens: session.budget.maxTotalTokens - session.tokenUsed
  };
  
  return runReflection(tasks, budget, session.progress);
}
```

**与任务执行互斥**：
```typescript
async function startReflection(): Promise<void> {
  // 检查是否有正在执行的任务
  const activeTasks = await getActiveTasks();
  if (activeTasks.length > 0) {
    // 延迟到任务完成后执行
    scheduleReflectionAfterTasksComplete();
    return;
  }
  
  // 检查是否已有正在进行的反思
  const runningSession = await db.reflection_sessions.findOne({ status: "running" });
  if (runningSession) {
    // 恢复之前的反思
    await resumeReflection(runningSession.id);
    return;
  }
  
  // 开始新的反思
  await runNewReflection();
}
```

### 7.5 Token 计数策略

```typescript
function estimateTokens(text: string): number {
  // 简单估算：1 token ≈ 4 个英文字符 或 1 个中文字符
  const englishChars = (text.match(/[a-zA-Z0-9]/g) || []).length;
  const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
  const otherChars = text.length - englishChars - chineseChars;
  
  return Math.ceil(englishChars / 4) + chineseChars + Math.ceil(otherChars / 2);
}

// 如果模型 API 返回真实 token 数，优先使用真实值
function getActualTokensUsed(response: ModelResponse): number {
  return response.usage?.totalTokens ?? estimateTokens(response.text);
}
```

---

## 8. 用户交互

### 8.1 Learning 面板

```
┌─────────────────────────────────────┐
│  📚 Learning                        │
├─────────────────────────────────────┤
│  Active Skills (3)                  │
│  ├── Git workflow                   │
│  ├── React component test           │
│  └── API debugging                  │
│                                     │
│  Forming Patterns (2)               │
│  ├── Database migration  [观察中]    │
│  └── Docker setup      [观察中]     │
│                                     │
│  Recent Task Memories (5)           │
│  ├── Fix login bug     [✓ success]  │
│  ├── Add user profile  [✓ success]  │
│  └── ...                            │
│                                     │
│  [🔄 Run Reflection Now]            │
│  Last run: 2024-01-15 02:00         │
│  Next run: 2024-01-16 02:00         │
└─────────────────────────────────────┘
```

**简化视图**（新手模式）：
```
┌─────────────────────────────────────┐
│  📚 Learning                        │
├─────────────────────────────────────┤
│  Agent has learned 3 skills         │
│  from your previous tasks.          │
│                                     │
│  [View Details]  [Run Reflection]   │
└─────────────────────────────────────┘
```

### 8.2 反思进度界面

```
┌─────────────────────────────────────┐
│  🤖 Reflection in Progress          │
├─────────────────────────────────────┤
│  Phase 1/3: Meta Analysis ✓         │
│  - Analyzed: 45 tasks               │
│  - Found: 2 domains to explore      │
│                                     │
│  Phase 2/3: Domain Analysis...      │
│  - Processing: git domain           │
│  - Tasks: 10/10                     │
│                                     │
│  Tokens used: 2,400 / 10,000        │
│  [████████░░░░░░░░░░]               │
│                                     │
│  [Cancel]                           │
└─────────────────────────────────────┘
```

### 8.3 Skill 修正询问框（类似 Codex/Trae）

**触发时机**：反思过程中，当 Agent 检测到 Skill 的 body 与最新 Task Memory 存在显著差异时。

```
┌─────────────────────────────────────┐
│  💡 Agent suggests a correction     │
├─────────────────────────────────────┤
│  Skill: "Git workflow"              │
│                                     │
│  Current:                           │
│  "1. git pull                       │
│   2. make changes                   │
│   3. git commit"                    │
│                                     │
│  Suggested change:                  │
│  "1. git fetch                       │
│   2. git rebase origin/main         │
│   3. make changes                   │
│   4. git commit"                    │
│                                     │
│  Reason: Recent tasks show rebase   │
│  produces cleaner history than      │
│  pull-merge.                        │
│                                     │
│  [✓ Accept]  [✏️ Edit]  [✗ Reject]  │
└─────────────────────────────────────┘
```

### 8.4 冲突审核界面

```
┌─────────────────────────────────────┐
│  ⚠️ Skill Conflict Detected         │
├─────────────────────────────────────┤
│  Skill A: "Git merge workflow"      │
│  Success rate: 75%                  │
│                                     │
│  Skill B: "Git rebase workflow"     │
│  Success rate: 78%                  │
│                                     │
│  Overlap: 85% (high)                │
│                                     │
│  Agent suggests:                    │
│  "Keep both but refine conditions:  │
│   - Use merge for feature branches  │
│   - Use rebase for personal branches│
│                                     │
│  [✓ Accept]  [✏️ Edit]  [✗ Reject]  │
└─────────────────────────────────────┘
```

### 8.5 反思撤销功能

```typescript
interface ReflectionSnapshot {
  id: string;
  sessionId: string;
  snapshotType: "before" | "after";
  patterns: Pattern[] | null;
  skills: Skill[] | null;
  createdAt: string;
}

async function undoLastReflection(): Promise<void> {
  // 1. 找到最后一次完成的反思会话
  const lastSession = await db.reflection_sessions.findOne(
    { status: "completed" },
    { orderBy: { completedAt: "desc" } }
  );
  
  if (!lastSession) {
    throw new Error("No reflection to undo");
  }
  
  // 2. 读取反思前的快照
  const beforeSnapshot = await db.reflection_snapshots.findOne({
    sessionId: lastSession.id,
    snapshotType: "before"
  });
  
  if (!beforeSnapshot) {
    throw new Error("Snapshot not found");
  }
  
  // 3. 恢复数据
  if (beforeSnapshot.patterns) {
    await db.patterns.deleteMany({}); // 或更精细的恢复
    await db.patterns.insertMany(beforeSnapshot.patterns);
  }
  
  if (beforeSnapshot.skills) {
    await db.skills.deleteMany({});
    await db.skills.insertMany(beforeSnapshot.skills);
  }
  
  // 4. 标记会话为已撤销
  await db.reflection_sessions.update(lastSession.id, { status: "undone" });
}
```

**UI 设计**：
```
┌─────────────────────────────────────┐
│  ⚠️ Undo Last Reflection?           │
├─────────────────────────────────────┤
│  This will revert:                  │
│  - 2 new Patterns                   │
│  - 1 updated Skill                  │
│                                     │
│  Changes will be preserved in       │
│  history but no longer active.      │
│                                     │
│  [Undo]  [Cancel]                   │
└─────────────────────────────────────┘
```

---

## 9. 配置

```typescript
interface MemorySystemConfig {
  // 反思设置
  reflection: {
    enabled: boolean;              // 默认 true
    autoSchedule: boolean;         // 默认 true
    scheduleTime: string;          // "02:00"
    allowManualTrigger: boolean;   // 默认 true
    tokenBudget: ReflectionBudget;
  };
  
  // 领域过滤
  domains: {
    focus: string[];               // 默认 []（全部）
    ignore: string[];              // 默认 ["chitchat", "query"]
  };
  
  // Skill 设置
  skill: {
    autoPromote: boolean;          // 默认 true
    minSuccessRate: number;        // 默认 0.75
    minTaskCount: number;          // 默认 5
    maxActiveSkills: number;       // 默认 50
    maxInjectedSkills: number;     // 默认 3
    maxSkillLength: number;        // 默认 800（字符）
    maxCorrections: number;        // 默认 10
    retireCheckIntervalDays: number; // 默认 7
  };
  
  // 存储设置
  storage: {
    taskMemoryRetentionDays: number;  // 默认 30
    archiveOldMemories: boolean;      // 默认 true
    dbPath: string;                   // 默认 "./data/memory.db"
  };
  
  // 冲突处理
  conflict: {
    autoResolveLowRisk: boolean;   // 默认 true
    manualReviewHighRisk: boolean; // 默认 true
    staleConflictDays: number;     // 默认 30
  };
  
  // 隐私设置
  privacy: {
    sanitizeGoals: boolean;        // 默认 true（脱敏目标中的敏感信息）
    encryptStorage: boolean;       // 默认 true
  };
}
```

---

## 10. 实现优先级

| 优先级 | 功能 | 说明 |
|--------|------|------|
| P0 | Task Memory 生成 | 任务完成时自动生成 |
| P0 | MetaData 生成 | 基于规则自动提取 |
| P0 | Skill 匹配算法 | 核心功能，必须精确定义 |
| P0 | Skill 注入上下文 | 任务开始时匹配注入 |
| P0 | 数据持久化层 | SQLite 存储方案 |
| P1 | Meta Reflection | 轻量分析 |
| P1 | Domain Reflection | 按需深入 |
| P1 | Learning 面板 | 前端展示 |
| P1 | 中文分词支持 | 提高中文场景匹配精度 |
| P2 | Skill 固化 | 自动提升 |
| P2 | 冲突检测 | 自动发现 |
| P2 | 冲突解决（低风险） | 自动处理 |
| P2 | Skill 淘汰机制 | 自动清理劣质 Skill |
| P3 | 手动反思触发 | 用户主动触发 |
| P3 | 冲突审核（高风险） | 人工确认 |
| P3 | Skill 修正询问 | 前端交互 |
| P3 | 反思撤销 | 回滚错误反思 |
| P3 | 数据脱敏 | 隐私保护 |

---

## 11. 安全与隐私

### 11.1 数据脱敏

```typescript
function sanitizeGoal(goal: string): string {
  // 1. 检测并替换密码/密钥
  let sanitized = goal;
  
  // 密码模式：password=xxx, pwd=xxx, secret=xxx
  sanitized = sanitized.replace(/(password|pwd|secret|token|key)\s*[=:]\s*\S+/gi, '$1=***');
  
  // API Key 模式：sk-xxx, ak-xxx
  sanitized = sanitized.replace(/\b(sk|ak)-[a-zA-Z0-9]{10,}\b/g, '***');
  
  // 2. 检测并替换路径中的用户名
  sanitized = sanitized.replace(/\/home\/[^/\s]+/g, '/home/$USER');
  sanitized = sanitized.replace(/C:\\Users\\[^\\\s]+/g, 'C:\\Users\\$USER');
  
  // 3. 检测并替换邮箱
  sanitized = sanitized.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '***@***.***');
  
  return sanitized;
}
```

### 11.2 Skill 环境无关性

```typescript
function sanitizeSkillBody(body: string): string {
  // 确保 Skill body 不包含环境特定的信息
  let sanitized = body;
  
  // 替换绝对路径为占位符
  sanitized = sanitized.replace(/\/(home|Users)\/[^/\s]+/g, '/$USER');
  
  // 替换特定 IP/端口
  sanitized = sanitized.replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+\b/g, '<host>:<port>');
  
  // 替换特定用户名
  sanitized = sanitized.replace(/\buser\w*\b/gi, '<username>');
  
  return sanitized;
}
```

### 11.3 存储加密（可选）

```typescript
interface EncryptionConfig {
  enabled: boolean;
  algorithm: "aes-256-gcm";
  keyDerivation: "pbkdf2";
  // 密钥由用户主密码派生，不存储在本地
}
```

---

## 12. 系统集成

### 12.1 与 Task 系统的集成点

```typescript
// 文件: packages/core/src/task-turn-runner.ts

async function onTaskComplete(task: Task): Promise<void> {
  // 1. 生成 Task Memory
  const memory = await generateTaskMemory(task);
  
  // 2. 保存到存储
  await memoryStorage.saveTaskMemory(memory);
  
  // 3. 触发反思检查（如果满足条件）
  await reflectionScheduler.checkAndTrigger();
}

async function onTaskStart(task: Task): Promise<void> {
  // 1. 查找相关 Skill
  const skills = await skillMatcher.findRelevantSkills(task.title);
  
  // 2. 构建 Skill Prompt
  const skillPrompt = buildSkillPrompt(skills);
  
  // 3. 注入到 system prompt
  if (skillPrompt) {
    task.systemPrompt += "\n\n" + skillPrompt;
  }
}
```

### 12.2 事件流集成

```typescript
// 文件: packages/core/src/events.ts

enum MemoryEventType {
  TASK_MEMORY_CREATED = "memory:task_created",
  PATTERN_DISCOVERED = "memory:pattern_discovered",
  SKILL_PROMOTED = "memory:skill_promoted",
  SKILL_CORRECTED = "memory:skill_corrected",
  CONFLICT_DETECTED = "memory:conflict_detected",
  REFLECTION_STARTED = "memory:reflection_started",
  REFLECTION_COMPLETED = "memory:reflection_completed",
}

interface MemoryEvent {
  type: MemoryEventType;
  payload: unknown;
  timestamp: string;
}
```

### 12.3 与现有 Provider 的集成

```typescript
// Skill 注入发生在构建 system prompt 时
function buildSystemPrompt(context: PromptContext): string {
  const basePrompt = getBaseSystemPrompt();
  
  // 注入相关 Skill
  const skills = skillMatcher.findRelevantSkills(context.taskTitle);
  const skillPrompt = buildSkillPrompt(skills);
  
  return [
    basePrompt,
    skillPrompt,
    context.customInstructions
  ].filter(Boolean).join("\n\n");
}
```

---

## 13. 风险评估与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Token 成本过高 | 高 | 预算控制、渐进式批处理、部分完成恢复 |
| Skill 质量差 | 高 | 严格的固化条件、成功率统计、用户反馈、淘汰机制 |
| 冲突未解决 | 中 | 自动检测、低风险自动处理、高风险人工审核、冲突自愈 |
| 用户隐私泄露 | 中 | 本地存储、不上传云端、数据脱敏 |
| 学习效果不明显 | 中 | 指标监控（Skill 使用率、成功率变化） |
| Skill 匹配错误 | 高 | 相关性阈值、成功率加权、时效性衰减、用户标记错误 |
| 上下文过长 | 中 | Skill 数量限制、长度限制、不匹配不注入 |
| 中文匹配失效 | 高 | 中文分词支持、字符级匹配 |
| 数据丢失 | 高 | SQLite 持久化、定期备份、反思快照 |

---

## 14. 监控指标

```typescript
interface MemorySystemMetrics {
  // Task Memory
  totalMemories: number;
  pendingReflections: number;
  avgTaskComplexity: number;
  
  // Pattern
  totalPatterns: number;
  formingPatterns: number;
  stablePatterns: number;
  deprecatedPatterns: number;
  
  // Skill
  totalSkills: number;
  activeSkills: number;
  suspendedSkills: number;
  retiredSkills: number;
  avgSkillSuccessRate: number;
  skillUsageRate: number;          // 有多少任务使用了 Skill
  
  // Reflection
  totalReflections: number;
  avgTokensPerReflection: number;
  patternsDiscovered: number;
  skillsPromoted: number;
  reflectionsUndone: number;
  
  // Conflict
  totalConflicts: number;
  autoResolved: number;
  pendingReview: number;
  staleConflicts: number;
  
  // Performance
  avgSkillMatchTime: number;       // 匹配耗时（ms）
  avgReflectionDuration: number;   // 反思耗时（分钟）
}
```

---

## 15. 上下文组装设计

> **详细设计参见**：[design-context-assembly.md](design-context-assembly.md)
>
> 本章仅列出与 Experience/Skill 系统的集成要点，完整的分层架构、ContextAssembler、FileStateTracker、对话历史格式化、工具定义等内容请参考独立文档。

### 15.1 Skill 匹配与上下文注入

Skill 系统通过以下方式与上下文组装系统协作：

1. **Layer 2（Skill MetaData）注入**：任务开始时，将匹配的 Skill 以轻量列表（标题+成功率）注入到 Layer 2
2. **`use_skill` 工具**：Agent 可通过此工具按需加载 Skill 完整内容
3. **匹配算法复用**：`findRelevantSkills`（第4节）的输出作为 `ContextAssembler.buildSkillMetaLayer` 的输入

### 15.2 通过事件流更新 FileStateTracker

```typescript
// 监听工具结果，更新文件状态表
workbench.onEvent((event) => {
  if (event.type === "tool_result") {
    contextAssembler.getFileStateTracker(event.taskId).updateFromToolResult(event);
  }
});
```

Skill 执行过程中产生的文件变更，通过此事件监听机制自动同步到上下文系统。

---

## 16. 长期记忆与用户偏好

### 16.1 三层用户记忆模型

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: User Preferences (用户偏好)                    │
│  - 显式设置：模型选择、主题、语言、审批策略               │
│  - 存储位置：SQLite records 表，namespace = "preferences" │
│  - 注入时机：每次组装上下文时                             │
│  - 格式：Key-Value，轻量                                 │
├─────────────────────────────────────────────────────────┤
│  Layer 2: User Habits (用户习惯)                         │
│  - 隐式学习：常用工具、代码风格、项目结构偏好             │
│  - 来源：Task Memory 统计分析                            │
│  - 更新：反思过程中提取                                  │
│  - 格式：Pattern 或轻量 Skill                            │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Cross-Task Memory (跨任务记忆)                 │
│  - 长期知识：项目架构、技术栈、业务逻辑                  │
│  - 来源：用户主动录入 + Agent 自动提取                   │
│  - 更新：用户确认后固化                                  │
│  - 格式：结构化文档（Markdown/JSON）                     │
└─────────────────────────────────────────────────────────┘
```

### 16.2 User Preferences 数据模型

```typescript
export const UserPreferencesSchema = z.object({
  // 模型设置
  defaultModel: z.string().default("gpt-4o"),
  fallbackModel: z.string().optional(),
  maxTokensPerRequest: z.number().default(128000),
  
  // 行为设置
  autoApprove: z.enum(["none", "low", "medium", "all"]).default("low"),
  showThinking: z.boolean().default(true),
  language: z.string().default("zh-CN"),
  
  // 反思设置
  reflectionEnabled: z.boolean().default(true),
  reflectionSchedule: z.string().default("02:00"),
  
  // 记忆设置
  skillAutoInject: z.boolean().default(true),
  maxInjectedSkills: z.number().default(3),
  
  // MCP 设置
  mcpApprovalMode: z.enum(["confirm_each", "confirm_dangerous", "auto"]).default("confirm_dangerous"),
  
  // 隐私设置
  sanitizeSensitiveData: z.boolean().default(true),
  encryptStorage: z.boolean().default(true),
  
  updatedAt: z.string()
});

type UserPreferences = z.infer<typeof UserPreferencesSchema>;
```

### 16.3 User Habits 提取

```typescript
interface UserHabit {
  id: string;
  category: "coding_style" | "tool_preference" | "workflow";
  pattern: string;
  evidence: string[];
  confidence: number;
  createdAt: string;
}

function extractHabits(tasks: TaskMemory[]): UserHabit[] {
  const habits: UserHabit[] = [];
  
  // 检测导入风格
  const importStyle = detectImportStyle(tasks);
  if (importStyle.confidence > 0.8) {
    habits.push({
      id: createId("habit"),
      category: "coding_style",
      pattern: `User prefers ${importStyle.type} imports`,
      evidence: importStyle.taskIds,
      confidence: importStyle.confidence,
      createdAt: nowIso()
    });
  }
  
  // 检测测试偏好
  const testPreference = detectTestPreference(tasks);
  if (testPreference.confidence > 0.8) {
    habits.push({
      id: createId("habit"),
      category: "tool_preference",
      pattern: `User prefers ${testPreference.framework} for testing`,
      evidence: testPreference.taskIds,
      confidence: testPreference.confidence,
      createdAt: nowIso()
    });
  }
  
  return habits;
}
```

### 16.4 Cross-Task Memory（项目记忆）

```typescript
interface ProjectMemory {
  id: string;
  projectId: string;
  title: string;
  content: string;
  category: "architecture" | "tech_stack" | "business_logic" | "convention";
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function buildProjectContext(projectId: string, store: WorkbenchStore): string {
  const memories = store.listProjectMemories(projectId);
  
  const lines = ["## Project Context"];
  for (const memory of memories) {
    lines.push(`\n### ${memory.title} [${memory.category}]`);
    lines.push(memory.content.slice(0, 1000));
  }
  
  return lines.join("\n");
}
```

### 16.5 偏好注入上下文

```typescript
function buildSystemLayer(task: TaskDetail, prefs: UserPreferences): string {
  const lines = [
    "You are the Agent Workbench agent.",
    "Choose the next action yourself based on the user's goal, the available tools, and the evidence already shown.",
    "Use tools when the environment must be observed. Do not invent host, file, network, or command results.",
    "When evidence is enough, answer directly. Do not emit fixed wrappers or diagnostic files."
  ];
  
  // 注入用户偏好
  if (prefs.language === "zh-CN") {
    lines.push("Respond in Chinese unless user asks otherwise.");
  }
  
  lines.push(`Auto-approval level: ${prefs.autoApprove}`);
  lines.push(`User language preference: ${prefs.language}`);
  
  return lines.join("\n");
}
```

---

## 17. MCP 与第三方 Skill 接入

### 17.1 MCP 接入架构

```
┌─────────────────────────────────────────────────────────┐
│  Agent Workbench Engine                                       │
│  ┌─────────────────────────────────────────────────┐   │
│  │  MCP Client Manager                              │   │
│  │  ┌─────────────┐ ┌─────────────┐ ┌───────────┐ │   │
│  │  │ MCP Server 1 │ │ MCP Server 2 │ │  Local   │ │   │
│  │  │ (Filesystem) │ │   (Git)      │ │  Tools   │ │   │
│  │  └─────────────┘ └─────────────┘ └───────────┘ │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### 17.2 MCP 工具转换

```typescript
interface MCPClient {
  name: string;
  tools: MCPTool[];
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callTool(name: string, args: unknown): Promise<unknown>;
}

function convertMCPTool(mcpTool: MCPTool): ToolDefinition {
  return {
    type: "function",
    name: `mcp_${mcpTool.name}`,
    description: `[MCP:${mcpTool.serverName}] ${mcpTool.description}`,
    parameters: mcpTool.inputSchema
  };
}

function getAvailableTools(mcpManager: MCPClientManager): ToolDefinition[] {
  const localTools = [runCommandTool, readFileTool, editFileTool, searchFilesTool, listFilesTool];
  const mcpTools = mcpManager.getAllTools().map(convertMCPTool);
  return [...localTools, ...mcpTools];
}
```

### 17.3 MCP 调用权限控制

```typescript
function shouldConfirmMCPTool(tool: ToolDefinition, prefs: UserPreferences): boolean {
  if (prefs.mcpApprovalMode === "auto") return false;
  if (prefs.mcpApprovalMode === "confirm_each") return true;
  // confirm_dangerous: 只确认危险操作
  return isDangerousTool(tool);
}

function isDangerousTool(tool: ToolDefinition): boolean {
  const dangerousPatterns = ["rm -rf", "drop", "delete", "format", "reset"];
  const toolStr = JSON.stringify(tool).toLowerCase();
  return dangerousPatterns.some(p => toolStr.includes(p));
}
```

### 17.4 第三方 Skill 接入

```typescript
interface Skill {
  id: string;
  source: "system" | "user" | "marketplace" | "mcp";
  sourceUrl?: string;
  
  title: string;
  description: string;
  version: string;
  author?: string;
  
  body: string;
  applicability: SkillApplicability;
  permissions: SkillPermission[];
  stats: SkillStats;
  
  status: "active" | "suspended" | "disabled";
  trustLevel: "high" | "medium" | "low";
}

interface SkillPermission {
  type: "file_read" | "file_write" | "command_exec" | "network";
  scope: string;
}

async function loadThirdPartySkill(url: string, store: WorkbenchStore): Promise<Skill> {
  const response = await fetch(url);
  const definition = await response.json();
  
  const skill = SkillSchema.parse(definition);
  
  // 权限审查
  if (hasDangerousPermissions(skill.permissions)) {
    skill.trustLevel = "low";
    skill.status = "disabled";
  }
  
  await store.saveSkill(skill);
  return skill;
}
```

### 17.5 Skill 冲突处理策略

**决策**：Skill 冲突不自动解决，由用户和 Agent 自行决定。

```typescript
function handleSkillConflict(conflict: Conflict): void {
  // 记录冲突，通知用户
  notifyUserOfConflict(conflict);
  
  // 标记两个 Skill 为待审核状态
  const skillA = getSkill(conflict.skillA);
  const skillB = getSkill(conflict.skillB);
  
  if (skillA) skillA.status = "suspended";
  if (skillB) skillB.status = "suspended";
  
  // 等待用户决策
  // 用户可以选择：保留 A、保留 B、保留两者、合并、修改
}
```

---

## 18. 实现注意事项

### 18.1 时间戳格式

- **数据模型层**：使用 ISO 8601 字符串（`new Date().toISOString()`）
- **存储层**：使用 Unix 时间戳（`Date.now()`）
- **转换**：在 Repository 层统一转换，上层不感知差异

```typescript
// Repository 层转换示例
function toDb(memory: TaskMemory) {
  return {
    ...memory,
    created_at: new Date(memory.createdAt).getTime()
  };
}

function fromDb(row: DbRow): TaskMemory {
  return {
    ...row.data,
    createdAt: new Date(row.created_at).toISOString()
  };
}
```

### 18.2 关键算法测试用例

**`calculateRelevance` 测试**：
| 任务标题 | Skill 关键词 | 预期分数 | 说明 |
|---------|------------|---------|------|
| "fix git merge conflict" | ["git", "merge"] | ~0.8 | 高匹配 |
| "deploy to production" | ["git", "merge"] | ~0.1 | 低匹配 |
| "解决 git 合并冲突" | ["git", "merge"] | ~0.7 | 中文匹配 |
| "run jest tests" | ["jest", "testing"] | ~0.9 | 精确匹配 |

**`shouldPromoteToSkill` 测试**：
| sourceTaskCount | successCount | failureCount | status | confidence | 预期结果 |
|----------------|-------------|-------------|--------|-----------|---------|
| 5 | 4 | 1 | "stable" | 0.85 | true |
| 3 | 3 | 0 | "stable" | 0.9 | false（次数不足）|
| 5 | 3 | 2 | "stable" | 0.85 | false（成功率不足）|
| 5 | 4 | 1 | "forming" | 0.85 | false（状态不足）|

---

## 附录 A：版本历史

| 版本 | 日期 | 变更内容 | 反思次数 |
|------|------|---------|---------|
| v1.0 | 2024-01-15 | 初始设计文档 | 0 |
| v2.0 | 2024-01-15 | 第一次反思迭代：修复 MetaData 生成时机、Skill 匹配算法、冲突解决、Token 预算、多用户场景、前端交互等 10 个问题 | 1 |
| v2.1 | 2024-01-15 | 第二次反思迭代：新增数据持久化层、修复接口不一致、中文分词支持、Pattern/Skill 状态机、淘汰机制、反思容错、冲突检测算法、冲突自愈、Learning 面板简化视图、反思撤销、安全隐私、系统集成等 18 个改进 | 2 |
| v2.2 | 2024-01-15 | 第三次反思迭代：补充 assessment 容错、反思并发控制、SQLite WAL 模式、时间戳格式统一、关键算法测试用例、版本历史 | 3 |
| v3.0 | 2026-05-05 | 整合上下文组装设计（第15章）：ContextAssembler、Skill 注入机制、FileStateTracker、对话历史格式化、工具定义 | - |
| v3.0 | 2026-05-05 | 整合长期记忆与用户偏好（第16章）：三层用户记忆模型、UserPreferences、UserHabits、ProjectMemory | - |
| v3.0 | 2026-05-05 | 整合 MCP 与第三方 Skill 接入（第17章）：MCP 架构、工具转换、权限控制、第三方 Skill 加载、冲突处理策略 | - |

---

*文档结束 - v3.0 (Final)（整合版）*
