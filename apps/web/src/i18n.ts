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
      navigation: "主导航",
      tasks: "任务",
      newTask: "新任务",
      history: "历史记录",
      library: "资料库",
      settings: "设置",
      support: "支持",
      docs: "文档",
      engineStatus: {
        running: "LOCAL ENGINE: RUNNING",
        streaming: "LOCAL ENGINE: STREAMING",
        attention: "LOCAL ENGINE: NEEDS ATTENTION"
      },
      searchTasks: "搜索任务",
      folders: "任务文件夹",
      allTasks: "全部任务",
      defaultFolder: "未分类",
      addFolder: "新建文件夹",
      editFolder: "编辑文件夹",
      deleteFolder: "删除文件夹",
      clearFolder: "清空任务",
      folderName: "文件夹名称",
      folderTasks: (count: number) => `${count} 个任务`,
      clearFolderTitle: "清空此文件夹的任务？",
      clearFolderBody: (name: string) => `“${name}” 中的任务会被删除，文件夹会保留。`,
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
        providers: ["模型配置", "添加模型、管理本地密钥、预设厂商和当前使用模型"],
        permissions: ["权限", "全局风险授权、审批策略和 Agent 偏好"],
        mcp: ["MCP", "连接的工具服务器和已发现工具"],
        preferences: ["偏好", "语言、思考展示、反思和敏感数据处理"]
      }
    },
    thread: {
      newTask: "新任务",
      ready: "准备开始新任务",
      startGoal: "从一个目标开始。",
      connect: "Connect",
      heroTitle: "开启新任务",
      heroSubtitle: "描述你想解决的问题。SCC 会组装上下文、请求必要权限，并把执行证据清晰展示给你。",
      suggestions: [
        {
          title: "查看系统状态",
          description: "列出当前运行的软件，并按 CPU 或内存占用排序。",
          prompt: "帮我看一下当前桌面运行的软件有哪些，性能占用最高的是哪些"
        },
        {
          title: "分析项目代码",
          description: "阅读当前项目结构，指出最需要优化的模块。",
          prompt: "阅读当前项目结构，帮我找出最需要优化的前后端问题"
        },
        {
          title: "沉淀为 Skill",
          description: "把一次可复用经验整理为可审核的 Skill 草稿。",
          prompt: "根据最近的任务经验，帮我整理一个可复用的 Skill 草稿"
        }
      ],
      runningGuidance: "运行中 · 输入会作为待处理引导",
      continueTask: (status: string) => `${status} · 输入会继续当前任务`,
      titleGenerationFailed: "短标题生成失败。",
      retryTitle: "重试",
      useLocalTitle: "使用本地标题继续"
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
      stopHint: "停止当前运行",
      attachFile: "添加文件",
      voiceInput: "语音输入",
      voiceInputStop: "停止听写",
      voiceUnsupported: "当前浏览器不支持语音输入",
      attachedFile: "已附加文件",
      model: "Model",
      modelToggle: "选择模型",
      permission: "权限",
      permissionToggle: "选择权限范围",
      modelUnknown: "未配置",
      permissionDefault: "按需审批",
      permissionPresets: {
        ask: "Ask",
        read_only: "Read only",
        custom: "Custom",
        all: "All"
      },
      permissionPresetDescriptions: {
        ask: "每次按风险请求确认",
        read_only: "只读观察自动通过",
        custom: "自定义风险类别",
        all: "允许所有风险类别"
      },
      keyboardHint: "Shift + Enter 换行 / Enter 发送"
    },
    permissions: {
      title: "权限与偏好",
      subtitle: "全局授权会跳过同类风险的审批 UI。撤销后，下一次同类工具请求会重新进入审批。",
      modeTitle: "权限模式",
      modeSubtitle: "选择默认授权范围。需要更高风险时，Agent 仍会按真实动作请求确认。",
      modeCustomDescription: "当前授权来自单次全局审批，和预设模式不完全一致。可以一键切回 Ask、Read only 或 All。",
      resetAsk: "重置为 Ask",
      coverageTitle: "风险覆盖",
      coverageSubtitle: "这里展示哪些风险会自动通过；单项撤销只用于修正已有全局授权。",
      granted: "已全局允许",
      notGranted: "需要审批",
      autoAllowed: "自动通过",
      approvalRequired: "需要确认",
      allow: "全局允许",
      revoke: "撤销",
      revokeRisk: (risk: string) => `撤销 ${risk}`,
      enableRisk: (risk: string) => `自动通过 ${risk}`,
      disableRisk: (risk: string) => `取消自动通过 ${risk}`,
      grantedAt: "授权时间",
      reason: "原因",
      noReason: "未记录原因",
      riskNote: "该授权会跨任务生效，可以随时撤销。",
      destructiveNote: "高风险授权。开启后 destructive 工具不会再弹出审批，请只在完全信任当前环境时使用。",
      behaviorTitle: "审批策略",
      preferencesTitle: "Agent 偏好",
      preferencesSubtitle: "这些设置影响界面语言、运行展示和学习策略。",
      providerTitle: "模型 Provider",
      language: "界面与回复语言",
      llmProvider: "LLM Provider",
      defaultModel: "默认模型",
      customModel: "自定义模型 ID",
      providerBaseUrl: "Base URL",
      contextMode: "上下文模式",
      contextLimit: "上下文上限",
      contextHelp: "自动模式会跟随模型上限；手动值不能超过当前模型窗口。",
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
      permissionModes: {
        ask: {
          label: "Ask",
          description: "每次确认"
        },
        read_only: {
          label: "Read only",
          description: "只读自动"
        },
        custom: {
          label: "Custom",
          description: "自定义"
        },
        all: {
          label: "All",
          description: "全部自动"
        }
      },
      contextModeOptions: {
        auto: "自动",
        manual: "手动"
      },
      risks: {
        host_observation: ["主机观察", "查看进程、系统信息、资源占用等只读主机状态。"],
        workspace_read: ["读取文件", "读取项目文件、列目录、搜索代码，不修改磁盘。"],
        workspace_write: ["修改文件", "编辑或创建本地文件。"],
        shell: ["Shell 命令", "运行命令或脚本，可能读取环境状态或启动进程。"],
        network: ["网络访问", "访问远程服务、下载内容或调用外部 API。"],
        destructive: ["破坏性操作", "删除、覆盖、终止或不可逆地改变本地/远程状态。"]
      }
    }
  },
  "en-US": {
    shell: {
      close: "Close",
      navigation: "Primary navigation",
      tasks: "Tasks",
      newTask: "New Task",
      history: "History",
      library: "Library",
      settings: "Settings",
      support: "Support",
      docs: "Docs",
      engineStatus: {
        running: "LOCAL ENGINE: RUNNING",
        streaming: "LOCAL ENGINE: STREAMING",
        attention: "LOCAL ENGINE: NEEDS ATTENTION"
      },
      searchTasks: "Search tasks",
      folders: "Task folders",
      allTasks: "All tasks",
      defaultFolder: "Uncategorized",
      addFolder: "New folder",
      editFolder: "Edit folder",
      deleteFolder: "Delete folder",
      clearFolder: "Clear tasks",
      folderName: "Folder name",
      folderTasks: (count: number) => `${count} task${count === 1 ? "" : "s"}`,
      clearFolderTitle: "Clear this folder's tasks?",
      clearFolderBody: (name: string) => `Tasks in "${name}" will be deleted. The folder will be kept.`,
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
        providers: ["Model configuration", "Add models, manage local keys, presets, and the active model"],
        permissions: ["Permissions", "Global risk grants, approval policy, and agent preferences"],
        mcp: ["MCP", "Connected tool servers and discovered tools"],
        preferences: ["Preferences", "Language, thinking display, reflection, and sensitive data handling"]
      }
    },
    thread: {
      newTask: "New task",
      ready: "Ready for a new task",
      startGoal: "Start with a goal.",
      connect: "Connect",
      heroTitle: "Start a new task",
      heroSubtitle: "Describe the problem you want solved. SCC assembles context, asks for the right permissions, and keeps evidence visible.",
      suggestions: [
        {
          title: "Inspect system load",
          description: "List running desktop software and rank CPU or memory usage.",
          prompt: "Show me which desktop software is running and which processes use the most CPU and memory"
        },
        {
          title: "Analyze this project",
          description: "Read the project structure and identify the highest-impact fixes.",
          prompt: "Read the current project structure and identify the highest-impact frontend and backend issues"
        },
        {
          title: "Draft a Skill",
          description: "Turn a reusable experience into a reviewable Skill draft.",
          prompt: "Use recent task experience to draft a reusable Skill"
        }
      ],
      runningGuidance: "Running · input becomes pending guidance",
      continueTask: (status: string) => `${status} · input continues this task`,
      titleGenerationFailed: "Short title generation failed.",
      retryTitle: "Retry",
      useLocalTitle: "Use local title"
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
      stopHint: "Stops the current run",
      attachFile: "Attach file",
      voiceInput: "Voice input",
      voiceInputStop: "Stop dictation",
      voiceUnsupported: "Voice input is not supported in this browser",
      attachedFile: "Attached file",
      model: "Model",
      modelToggle: "Choose model",
      permission: "Scope",
      permissionToggle: "Choose permission scope",
      modelUnknown: "not configured",
      permissionDefault: "approval",
      permissionPresets: {
        ask: "Ask",
        read_only: "Read only",
        custom: "Custom",
        all: "All"
      },
      permissionPresetDescriptions: {
        ask: "Ask before each risk class",
        read_only: "Auto-allow read-only observation",
        custom: "Choose risk classes",
        all: "Allow every risk class"
      },
      keyboardHint: "Shift + Enter for newline / Enter to send"
    },
    permissions: {
      title: "Permissions and preferences",
      subtitle: "Global grants skip approval UI for matching risk categories. After revoke, the next matching tool request asks again.",
      modeTitle: "Permission mode",
      modeSubtitle: "Choose the default authorization scope. Higher-risk actions can still ask when the agent needs them.",
      modeCustomDescription: "Current grants came from individual approvals and do not match a preset. Switch back to Ask, Read only, or All at any time.",
      resetAsk: "Reset to Ask",
      coverageTitle: "Risk coverage",
      coverageSubtitle: "Shows what can run automatically. Per-risk revoke is only for correcting existing global grants.",
      granted: "Globally allowed",
      notGranted: "Approval required",
      autoAllowed: "Auto allowed",
      approvalRequired: "Ask first",
      allow: "Allow globally",
      revoke: "Revoke",
      revokeRisk: (risk: string) => `Revoke ${risk}`,
      enableRisk: (risk: string) => `Auto-allow ${risk}`,
      disableRisk: (risk: string) => `Stop auto-allowing ${risk}`,
      grantedAt: "Granted at",
      reason: "Reason",
      noReason: "No reason recorded",
      riskNote: "This grant applies across tasks and can be revoked at any time.",
      destructiveNote: "High-risk grant. Destructive tools will stop prompting while it is active.",
      behaviorTitle: "Approval policy",
      preferencesTitle: "Agent preferences",
      preferencesSubtitle: "These settings control language, runtime display, and learning behavior.",
      providerTitle: "Model provider",
      language: "UI and response language",
      llmProvider: "LLM provider",
      defaultModel: "Default model",
      customModel: "Custom model id",
      providerBaseUrl: "Base URL",
      contextMode: "Context mode",
      contextLimit: "Context limit",
      contextHelp: "Auto follows the selected model limit. Manual values cannot exceed the model window.",
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
      permissionModes: {
        ask: {
          label: "Ask",
          description: "Confirm first"
        },
        read_only: {
          label: "Read only",
          description: "Read auto"
        },
        custom: {
          label: "Custom",
          description: "Fine tune"
        },
        all: {
          label: "All",
          description: "All auto"
        }
      },
      contextModeOptions: {
        auto: "Auto",
        manual: "Manual"
      },
      risks: {
        host_observation: ["Host observation", "Read-only host state such as processes, system info, and resource usage."],
        workspace_read: ["Read files", "Read project files, list folders, and search code without writing to disk."],
        workspace_write: ["Change files", "Edit or create local files."],
        shell: ["Shell command", "Run commands or scripts that may inspect state or start processes."],
        network: ["Network access", "Reach remote services, download content, or call external APIs."],
        destructive: ["Destructive action", "Delete, overwrite, terminate, or irreversibly change local or remote state."]
      }
    }
  }
} as const;
