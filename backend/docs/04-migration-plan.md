# 迁移方案

## 1. 原则

不做大爆炸切换。

采用“旧后端继续服务，新后端逐模块替换”的策略。

## 2. 迁移顺序

### Phase 1

先替换纯内核模块：

- parser
- contract validator
- runtime state machine
- trace recorder

### Phase 2

接管任务生命周期：

- start
- pause
- resume
- restart

### Phase 3

接管前端投影：

- task snapshot
- trace stream
- terminal state projection

## 3. 验收标准

### 3.1 DeepSeek 兼容

- 角括号 explicit output 可接受
- 描述型 output contract 可验证
- output invalid 时不会被错误地引导成 tracker-only

### 3.2 产物一致性

- `files_created` 与 tool result 一致
- task JSON、workspace、trace 三者一致

### 3.3 恢复一致性

- pause / resume / restart 有显式状态轨迹
- 终态前 trace 已 flush

