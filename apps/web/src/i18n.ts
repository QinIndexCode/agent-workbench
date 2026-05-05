import type { ComposerMode } from "./components/Composer.js";

export type UiLanguage = "zh-CN" | "en-US";

export function normalizeLanguage(language?: string | null): UiLanguage {
  return language === "zh-CN" ? "zh-CN" : "en-US";
}

export function getUiCopy(language?: string | null) {
  return copy[normalizeLanguage(language)];
}

const copy = {
  "zh-CN": {
    shell: {
      close: "关闭",
      tasks: "任务",
      newTask: "新任务",
      settings: "设置",
      searchTasks: "搜索任务",
      noTasks: "还没有任务。",
      noMatchingTasks: "没有匹配的任务。",
      deleteTask: "删除任务",
      deleteTaskTitle: "删除任务？",
      deleteRunning: "当前运行会先停止，然后删除任务。",
      deleteThread: "任务线程和审批记录会被移除。",
      deleteLearning: "同时删除此任务产生的经验和记忆",
      deleteDerivedSkills: "删除仅由此任务派生的 Skill",
      cancel: "取消",
      delete: "删除"
    },
    settings: {
      title: "设置",
      sections: {
        skills: ["Skills", "审核、编辑、合并和导出可复用的 Agent 能力"],
        learning: ["学习", "任务记忆、模式、反思和冲突记录"],
        permissions: ["权限", "全局风险授权、审批策略和 Agent 偏好"],
        mcp: ["MCP", "连接的工具服务器和已发现工具"],
        memory: ["记忆", "项目事实和长期约定"]
      }
    },
    thread: {
      newTask: "新任务",
      ready: "准备开始新任务",
      startGoal: "从一个目标开始。",
      runningGuidance: "运行中 · 输入会作为待处理引导",
      continueTask: (status: string) => `${status} · 输入会继续当前任务`,
      startsNewTask: (status: string) => `${status} · 输入会创建新任务`
    },
    composer: {
      modes: {
        new_task: ["让 Agent 做点什么...", "创建新任务"],
        guidance: ["为运行中的任务追加引导...", "发送待处理引导"],
        continue: ["继续这个任务...", "继续当前任务"]
      } satisfies Record<ComposerMode, [string, string]>,
      working: "处理中",
      send: "发送",
      stop: "停止",
      idle: "空闲",
      workingHint: "正在处理...",
      stopHint: "停止当前运行"
    },
    permissions: {
      title: "权限与偏好",
      subtitle: "全局授权会跳过同类风险的审批 UI。撤销后，下一次同类工具请求会重新进入审批。",
      granted: "已全局允许",
      notGranted: "需要审批",
      allow: "全局允许",
      revoke: "撤销",
      grantedAt: "授权时间",
      reason: "原因",
      noReason: "未记录原因",
      riskNote: "该授权会跨任务生效，可以随时撤销。",
      destructiveNote: "高风险授权。开启后 destructive 工具不会再弹出审批，请只在完全信任当前环境时使用。",
      behaviorTitle: "审批策略",
      preferencesTitle: "Agent 偏好",
      language: "界面与回复语言",
      defaultModel: "默认模型",
      maxTokens: "最大上下文 token",
      autoApprove: "自动审批级别",
      showThinking: "展示思考内容",
      reflectionEnabled: "启用自动反思",
      reflectionSchedule: "反思时间",
      skillAutoInject: "自动注入 Skill 元数据",
      maxInjectedSkills: "最多注入 Skill 数",
      mcpApprovalMode: "MCP 审批模式",
      sanitizeSensitiveData: "清理敏感数据",
      encryptStorage: "加密本地存储",
      on: "开启",
      off: "关闭",
      autoApproveOptions: {
        none: "不自动审批",
        low: "低风险",
        medium: "中低风险",
        all: "全部"
      },
      mcpApprovalOptions: {
        confirm_each: "每次确认",
        confirm_dangerous: "仅高风险确认",
        auto: "自动"
      },
      risks: {
        host_observation: ["主机观察", "查看进程、系统信息、资源占用等只读主机状态。"],
        workspace_read: ["工作区读取", "读取项目文件、列目录、搜索代码，不修改磁盘。"],
        workspace_write: ["工作区写入", "编辑或创建工作区文件。"],
        shell: ["Shell 命令", "运行命令或脚本，可能读取环境状态或启动进程。"],
        network: ["网络访问", "访问远程服务、下载内容或调用外部 API。"],
        destructive: ["破坏性操作", "删除、覆盖、终止或不可逆地改变本地/远程状态。"]
      }
    }
  },
  "en-US": {
    shell: {
      close: "Close",
      tasks: "Tasks",
      newTask: "New Task",
      settings: "Settings",
      searchTasks: "Search tasks",
      noTasks: "No tasks yet.",
      noMatchingTasks: "No matching tasks.",
      deleteTask: "Delete task",
      deleteTaskTitle: "Delete task?",
      deleteRunning: "The current run will be stopped before deletion.",
      deleteThread: "The task thread and approvals will be removed.",
      deleteLearning: "Remove memories and experiences from this task",
      deleteDerivedSkills: "Delete skills derived only from this task",
      cancel: "Cancel",
      delete: "Delete"
    },
    settings: {
      title: "Settings",
      sections: {
        skills: ["Skills", "Review, edit, merge, and export reusable agent behaviors"],
        learning: ["Learning", "Task memory, patterns, reflection, and conflicts"],
        permissions: ["Permissions", "Global risk grants, approval policy, and agent preferences"],
        mcp: ["MCP", "Connected tool servers and discovered tools"],
        memory: ["Memory", "Project facts and durable conventions"]
      }
    },
    thread: {
      newTask: "New task",
      ready: "Ready for a new task",
      startGoal: "Start with a goal.",
      runningGuidance: "Running · input becomes pending guidance",
      continueTask: (status: string) => `${status} · input continues this task`,
      startsNewTask: (status: string) => `${status} · input starts a new task`
    },
    composer: {
      modes: {
        new_task: ["Ask the agent to do something...", "Starts a new task"],
        guidance: ["Add guidance for the running task...", "Sends pending guidance"],
        continue: ["Continue this task...", "Continues the selected task"]
      } satisfies Record<ComposerMode, [string, string]>,
      working: "Working",
      send: "Send",
      stop: "Stop",
      idle: "Idle",
      workingHint: "Working...",
      stopHint: "Stops the current run"
    },
    permissions: {
      title: "Permissions and preferences",
      subtitle: "Global grants skip approval UI for matching risk categories. After revoke, the next matching tool request asks again.",
      granted: "Globally allowed",
      notGranted: "Approval required",
      allow: "Allow globally",
      revoke: "Revoke",
      grantedAt: "Granted at",
      reason: "Reason",
      noReason: "No reason recorded",
      riskNote: "This grant applies across tasks and can be revoked at any time.",
      destructiveNote: "High-risk grant. Destructive tools will stop prompting while it is active.",
      behaviorTitle: "Approval policy",
      preferencesTitle: "Agent preferences",
      language: "UI and response language",
      defaultModel: "Default model",
      maxTokens: "Max context tokens",
      autoApprove: "Auto approval level",
      showThinking: "Show thinking",
      reflectionEnabled: "Enable reflection",
      reflectionSchedule: "Reflection time",
      skillAutoInject: "Auto-inject skill metadata",
      maxInjectedSkills: "Max injected skills",
      mcpApprovalMode: "MCP approval mode",
      sanitizeSensitiveData: "Sanitize sensitive data",
      encryptStorage: "Encrypt local storage",
      on: "On",
      off: "Off",
      autoApproveOptions: {
        none: "None",
        low: "Low risk",
        medium: "Low and medium risk",
        all: "All"
      },
      mcpApprovalOptions: {
        confirm_each: "Confirm each",
        confirm_dangerous: "Confirm dangerous",
        auto: "Auto"
      },
      risks: {
        host_observation: ["Host observation", "Read-only host state such as processes, system info, and resource usage."],
        workspace_read: ["Workspace read", "Read files, list folders, and search code without writing to disk."],
        workspace_write: ["Workspace write", "Edit or create files in the workspace."],
        shell: ["Shell command", "Run commands or scripts that may inspect state or start processes."],
        network: ["Network access", "Reach remote services, download content, or call external APIs."],
        destructive: ["Destructive action", "Delete, overwrite, terminate, or irreversibly change local or remote state."]
      }
    }
  }
} as const;
