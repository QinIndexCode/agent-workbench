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
      defaultFolder: "默认文件夹",
      addFolder: "新建文件夹",
      editFolder: "编辑文件夹",
      deleteFolder: "删除文件夹",
      clearFolder: "清空任务",
      folderName: "文件夹名称",
      folderPath: "本地路径",
      folderPathPlaceholder: "例如 D:\\Projects\\demo",
      folderTasks: (count: number) => `${count} 个任务`,
      clearFolderTitle: "清空此文件夹的任务？",
      clearFolderBody: (name: string) => `“${name}” 中的任务会被删除，文件夹会保留。`,
      deleteFolderTitle: "删除此任务文件夹？",
      deleteFolderBody: (name: string, count: number) => `“${name}” 会从 SCC 中删除，里面的 ${count} 个任务也会被永久删除。`,
      deleteFolderDiskSafe: "不会删除真实磁盘目录，但任务线程、审批记录和所选学习数据无法恢复。",
      noTasks: "还没有任务。",
      noMatchingTasks: "没有匹配的任务。",
      editTask: "编辑任务",
      editTaskTitle: "编辑任务",
      taskTitle: "任务标题",
      taskFolder: "所属文件夹",
      deleteTask: "删除任务",
      deleteTaskTitle: "删除任务？",
      deleteRunning: "当前运行会先停止，然后删除任务。",
      deleteThread: "任务线程和审批记录会被移除。",
      deleteLearning: "同时删除此任务产生的经验和记忆",
      deleteDerivedSkills: "删除仅由此任务派生的 Skill",
      cancel: "取消",
      delete: "删除",
      save: "保存"
    },
    settings: {
      title: "设置",
      sections: {
        providers: ["模型配置", "添加模型、管理本地密钥、预设厂商和当前使用模型"],
        permissions: ["权限审批", "审批模式、风险覆盖和工具授权"],
        mcp: ["MCP", "连接的工具服务器和已发现工具"],
        integrations: ["集成", "Discord、飞书和外部消息入口"],
        scheduled: ["定时任务", "一次性或周期性触发 Agent 任务"],
        search: ["网络搜索", "配置 Agent 可选择使用的搜索 Provider"],
        preferences: ["偏好", "语言、展示方式和 Agent 行为"]
      }
    },
    thread: {
      newTask: "新任务",
      ready: "准备开始新任务",
      startGoal: "从一个目标开始。",
      connect: "Connect",
      configureModel: "配置模型",
      heroTitle: "开启新任务",
      heroTitleVariants: [
        "开启新任务",
        "你好，需要帮忙吗？",
        "今天想做些什么？",
        "让想法变成现实",
        "开始创造，从这里出发",
        "有什么可以帮你的？",
        "一起搞定它吧",
        "你的下一个任务是？",
        "准备好开工了吗？",
        "想法很多，从一个开始",
        "说出你的需求",
        "让 AI 为你工作",
        "从想法到行动",
        "今天打算完成什么？"
      ],
      heroSubtitle: "描述你想解决的问题。SCC 会组装上下文、请求必要权限，并把执行证据清晰展示给你。",
      heroSubtitleVariants: [
        "描述你想解决的问题。SCC 会组装上下文、请求必要权限，并把执行证据清晰展示给你。",
        "写下你的目标，让 SCC 为你分析、规划、执行。",
        "从一句话开始，SCC 会帮你拆解任务并逐步完成。",
        "告诉 SCC 你想做什么，它会把复杂的事情变简单。",
        "输入你的需求，SCC 将自动规划最佳执行路径。",
        "描述你遇到的问题，SCC 会找到最优解法。",
        "一句话描述你的目标，其余的交给 SCC。",
        "SCC 会理解你的意图，自动拆解并执行复杂任务。",
        "用自然语言告诉它你要做什么，剩下的不用操心。",
        "SCC 将读取上下文、分析依赖，为你生成完整方案。",
        "从模糊的想法到精确的执行，只需一句话。",
        "无论多复杂的任务，SCC 都能帮你分步完成。",
        "说出你想实现的效果，SCC 来搞定技术细节。"
      ],
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
      useLocalTitle: "使用本地标题继续",
      errorBoundaryTitle: "出错了",
      errorBoundaryDescription: "应用遇到了意外错误。你可以尝试刷新页面恢复。",
      errorBoundaryRefresh: "刷新页面",
      requestTimeout: "请求超时，请检查网络连接后重试。",
      requestBackendTimeout: "后端响应超时。模型处理时间较长，请稍后重试或检查后端服务状态。",
      requestCancelled: "请求被取消。",
      requestFailed: (status: number) => `请求失败 (${status})。`
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
      attachments: "附件",
      uploading: "上传中",
      removeAttachment: (name: string) => `移除 ${name}`,
      folder: "文件夹",
      folderToggle: "选择工作文件夹",
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
        all: "完全访问"
      },
      permissionPresetDescriptions: {
        ask: "每次按风险请求确认",
        read_only: "只读观察自动通过",
        custom: "自定义风险类别",
        all: "允许所有风险类别，包括破坏性操作"
      },
      keyboardHint: "Shift + Enter 换行 / Enter 发送"
    },
    permissions: {
      title: "权限审批",
      subtitle: "选择工具调用的审批模式，并直接查看每类风险会被执行、询问还是自动审批。",
      modeTitle: "审批策略",
      modeSubtitle: "按风险类别控制工具调用审批。只读模式只放行观察和读取。",
      modeCustomDescription: "逐项选择全局允许的风险类别；包含破坏性操作时请确认风险边界。",
      modeAutoApprovalDescription: "按风险元数据自动审批选中的非破坏性类别，可额外启用 LLM 审批。",
      modeFullAccessDescription: "全局允许全部风险类别，包括破坏性操作。选择前必须确认。",
      coverageTitle: "风险覆盖",
      coverageSubtitle: "当前模式下未覆盖的风险类别会逐次询问。",
      coverageCustomSubtitle: "自定义模式直接编辑全局允许类别。",
      coverageAutoSubtitle: "自动审批模式只自动审批选中的非破坏性类别。",
      coverageFullAccessSubtitle: "完全访问会全局允许全部类别，包括破坏性操作。",
      granted: "已全局允许",
      notGranted: "需要审批",
      autoAllowed: "自动通过",
      approvalRequired: "需要确认",
      allow: "全局允许",
      allowRisk: (risk: string) => `全局允许 ${risk}`,
      revoke: "撤销",
      revokeRisk: (risk: string) => `撤销 ${risk}`,
      enableRisk: (risk: string) => `选择 ${risk}`,
      disableRisk: (risk: string) => `取消 ${risk}`,
      grantedAt: "授权时间",
      reason: "原因",
      noReason: "未记录原因",
      riskNote: "未被当前模式覆盖时会进入审批流程。",
      readOnlyNote: "只读模式会自动执行该类安全观察操作。",
      customGrantedNote: "自定义模式会跨任务全局允许该类别。",
      ruleAutoAllowedNote: "自动审批会按工具风险元数据自动批准该类别。",
      strategyLocked: "切换到 Custom 后可逐项调整。",
      globalGrantNote: "该类别已被当前模式全局允许。",
      destructiveNote: "破坏性操作默认逐次询问，不会被规则或 LLM 自动审批。",
      destructiveAutoNote: "破坏性操作不能进入自动审批覆盖范围。",
      destructiveFullAccessNote: "完全访问已全局允许破坏性操作，请确保当前环境可接受该风险。",
      behaviorTitle: "行为设置",
      preferencesTitle: "Agent 偏好",
      preferencesSubtitle: "这些设置影响语言、回答风格和 Agent 可见行为。",
      preferencesBehaviorSubtitle: "这些偏好只影响展示和存储，不改变权限审批模式。",
      personalizeTitle: "个性化设置",
      personalizeSubtitle: "配置界面语言、回复风格和技能注入行为。",
      providerTitle: "模型 Provider",
      language: "界面与回复语言",
      theme: "外观主题",
      agentTone: "Agent 语气",
      agentRole: "Agent 角色",
      responseDetail: "回答详略",
      startupView: "启动页面",
      llmProvider: "LLM Provider",
      defaultModel: "默认模型",
      customModel: "自定义模型 ID",
      providerBaseUrl: "Base URL",
      contextMode: "上下文模式",
      contextLimit: "上下文上限",
      contextHelp: "自动模式会跟随模型上限；手动值不能超过当前模型窗口。",
      maxTokens: "最大上下文 token",
      showThinking: "展示思考内容",
      skillAutoInject: "自动注入 Skill 元数据",
      maxInjectedSkills: "最多注入 Skill 数",
      mcpApprovalMode: "MCP 审批模式",
      mcpApprovalHelp: "仅影响 MCP 工具；仍以工具风险和显式授权为边界。",
      llmApprovalMode: "LLM 自动审批（实验）",
      llmApprovalHelp: "仅在规则仍需审批时触发，最多批准非破坏性工具；会额外消耗 token。",
      llmApprovalAutoOnly: "仅在自动审批模式下可启用；其他模式按风险列表和用户审批执行。",
      fullAccessTitle: "确认完全访问",
      fullAccessBody: "完全访问会全局允许所有风险类别，包括删除、覆盖、终止进程等破坏性操作。只有在你确定当前工作区和任务边界可信时才启用。",
      fullAccessConfirm: "启用完全访问",
      fullAccessCancel: "取消",
      sanitizeSensitiveData: "清理敏感数据",
      encryptStorage: "加密本地存储",
      mcpApprovalOptions: {
        confirm_each: "每次确认",
        confirm_dangerous: "仅高风险确认",
        auto: "自动"
      },
      llmApprovalOptions: {
        off: "关闭",
        non_destructive: "仅非破坏性"
      },
      permissionModes: {
        ask: {
          label: "每次询问",
          description: "每次确认"
        },
        read_only: {
          label: "只读",
          description: "只读自动"
        },
        full_access: {
          label: "完全访问",
          description: "全部风险"
        },
        custom: {
          label: "自定义",
          description: "自定义"
        },
        auto_approval: {
          label: "自动审批",
          description: "自动审批"
        }
      },
      contextModeOptions: {
        auto: "自动",
        manual: "手动"
      },
      agentToneOptions: {
        concise: "简洁",
        balanced: "均衡",
        warm: "温和",
        formal: "正式"
      },
      responseDetailOptions: {
        brief: "简短",
        normal: "正常",
        detailed: "详细"
      },
      startupViewOptions: {
        last_task: "恢复上次任务",
        last_folder: "恢复上次文件夹",
        new_task: "始终新任务"
      },
      themeOptions: {
        dark: "黑色",
        light: "白色",
        system: "跟随系统"
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
      defaultFolder: "Default",
      addFolder: "New folder",
      editFolder: "Edit folder",
      deleteFolder: "Delete folder",
      clearFolder: "Clear tasks",
      folderName: "Folder name",
      folderPath: "Local path",
      folderPathPlaceholder: "For example D:\\Projects\\demo",
      folderTasks: (count: number) => `${count} task${count === 1 ? "" : "s"}`,
      clearFolderTitle: "Clear this folder's tasks?",
      clearFolderBody: (name: string) => `Tasks in "${name}" will be deleted. The folder will be kept.`,
      deleteFolderTitle: "Delete this task folder?",
      deleteFolderBody: (name: string, count: number) => `"${name}" will be removed from SCC and its ${count} task${count === 1 ? "" : "s"} will be permanently deleted.`,
      deleteFolderDiskSafe: "The real disk directory will not be deleted, but task threads, approvals, and selected learning data cannot be restored.",
      noTasks: "No tasks yet.",
      noMatchingTasks: "No matching tasks.",
      editTask: "Edit task",
      editTaskTitle: "Edit task",
      taskTitle: "Task title",
      taskFolder: "Folder",
      deleteTask: "Delete task",
      deleteTaskTitle: "Delete task?",
      deleteRunning: "The current run will be stopped before deletion.",
      deleteThread: "The task thread and approvals will be removed.",
      deleteLearning: "Remove memories and experiences from this task",
      deleteDerivedSkills: "Delete skills derived only from this task",
      cancel: "Cancel",
      delete: "Delete",
      save: "Save"
    },
    settings: {
      title: "Settings",
      sections: {
        providers: ["Model configuration", "Add models, manage local keys, presets, and the active model"],
        permissions: ["Permissions", "Approval modes, risk coverage, and tool authorization"],
        mcp: ["MCP", "Connected tool servers and discovered tools"],
        integrations: ["Integrations", "Discord, Feishu, and external message entrypoints"],
        scheduled: ["Scheduled tasks", "One-shot or recurring agent tasks"],
        search: ["Web search", "Configure search providers the agent can choose"],
        preferences: ["Preferences", "Language, display, and agent behavior"]
      }
    },
    thread: {
      newTask: "New task",
      ready: "Ready for a new task",
      startGoal: "Start with a goal.",
      connect: "Connect",
      configureModel: "Configure model",
      heroTitle: "Start a new task",
      heroTitleVariants: [
        "Start a new task",
        "What can I help you build?",
        "Ready to bring ideas to life?",
        "Let's make something great",
        "What would you like to accomplish?",
        "What's on your mind?",
        "Let's get things done",
        "What's the next mission?",
        "Ready to roll up your sleeves?",
        "So many ideas, pick one",
        "Tell me what you need",
        "Let AI do the heavy lifting",
        "From idea to reality",
        "What shall we build today?"
      ],
      heroSubtitle: "Describe the problem you want solved. SCC assembles context, asks for the right permissions, and keeps evidence visible.",
      heroSubtitleVariants: [
        "Describe the problem you want solved. SCC assembles context, asks for the right permissions, and keeps evidence visible.",
        "Write your goal and let SCC analyze, plan, and execute for you.",
        "Start with one sentence — SCC will break it down and handle the rest.",
        "Tell SCC what you need. It makes complex tasks simple.",
        "Type your request and SCC will find the best path to get it done.",
        "Describe what's bothering you. SCC will find the best solution.",
        "One sentence about your goal — SCC takes care of the rest.",
        "SCC will read your context, analyze dependencies, and generate a complete plan.",
        "Just say it in plain language. SCC handles the technical details.",
        "From a vague idea to precise execution, it all starts with one sentence.",
        "No matter how complex, SCC breaks it down and tackles it step by step.",
        "Tell it what you want to achieve — SCC will figure out how."
      ],
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
      useLocalTitle: "Use local title",
      errorBoundaryTitle: "Something went wrong",
      errorBoundaryDescription: "The application encountered an unexpected error. You can try refreshing the page to recover.",
      errorBoundaryRefresh: "Refresh Page",
      requestTimeout: "Request timed out. Please check your network connection and try again.",
      requestBackendTimeout: "Backend response timed out. The model is taking too long. Please try again later or check the backend service status.",
      requestCancelled: "Request was cancelled.",
      requestFailed: (status: number) => `Request failed (${status}).`
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
      attachments: "Attachments",
      uploading: "Uploading",
      removeAttachment: (name: string) => `Remove ${name}`,
      folder: "Folder",
      folderToggle: "Choose work folder",
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
        all: "Full access"
      },
      permissionPresetDescriptions: {
        ask: "Ask before each risk class",
        read_only: "Auto-allow read-only observation",
        custom: "Choose risk classes",
        all: "Allow every risk class, including destructive"
      },
      keyboardHint: "Shift + Enter for newline / Enter to send"
    },
    permissions: {
      title: "Permissions",
      subtitle: "Choose how tool calls are approved, and see exactly which risk classes run, ask, or auto-approve.",
      modeTitle: "Approval strategy",
      modeSubtitle: "Control tool approvals by risk class. Read only allows observation and file reads.",
      modeCustomDescription: "Choose globally allowed risk classes one by one; include destructive only when that risk is acceptable.",
      modeAutoApprovalDescription: "Auto-approve selected non-destructive classes from risk metadata, with optional LLM approval.",
      modeFullAccessDescription: "Globally allow every risk class, including destructive. Confirmation is required.",
      coverageTitle: "Risk coverage",
      coverageSubtitle: "Risk classes not covered by the current mode ask for approval.",
      coverageCustomSubtitle: "Custom mode edits globally allowed classes directly.",
      coverageAutoSubtitle: "Auto approval only covers selected non-destructive classes.",
      coverageFullAccessSubtitle: "Full access globally allows every class, including destructive.",
      granted: "Globally allowed",
      notGranted: "Approval required",
      autoAllowed: "Auto allowed",
      approvalRequired: "Ask first",
      allow: "Allow globally",
      allowRisk: (risk: string) => `Allow ${risk} globally`,
      revoke: "Revoke",
      revokeRisk: (risk: string) => `Revoke ${risk}`,
      enableRisk: (risk: string) => `Select ${risk}`,
      disableRisk: (risk: string) => `Deselect ${risk}`,
      grantedAt: "Granted at",
      reason: "Reason",
      noReason: "No reason recorded",
      riskNote: "This class enters the approval flow when it is not covered by the current mode.",
      readOnlyNote: "Read only automatically executes this safe observation class.",
      customGrantedNote: "Custom mode globally allows this class across tasks.",
      ruleAutoAllowedNote: "Auto approval approves this class from tool risk metadata.",
      strategyLocked: "Switch to Custom to adjust individual categories.",
      globalGrantNote: "This class is globally allowed by the current mode.",
      destructiveNote: "Destructive tools ask by default and are never rule- or LLM-approved.",
      destructiveAutoNote: "Destructive cannot be part of auto-approval coverage.",
      destructiveFullAccessNote: "Full access globally allows destructive tools. Use only inside a trusted task boundary.",
      behaviorTitle: "Behavior settings",
      preferencesTitle: "Agent preferences",
      preferencesSubtitle: "These settings control language, response style, and visible agent behavior.",
      preferencesBehaviorSubtitle: "These preferences affect display and storage, not permission approval modes.",
      personalizeTitle: "Personalization",
      personalizeSubtitle: "Configure UI language, reply style, and skill injection behavior.",
      providerTitle: "Model provider",
      language: "UI and response language",
      theme: "Appearance theme",
      agentTone: "Agent tone",
      agentRole: "Agent role",
      responseDetail: "Response detail",
      startupView: "Startup view",
      llmProvider: "LLM provider",
      defaultModel: "Default model",
      customModel: "Custom model id",
      providerBaseUrl: "Base URL",
      contextMode: "Context mode",
      contextLimit: "Context limit",
      contextHelp: "Auto follows the selected model limit. Manual values cannot exceed the model window.",
      maxTokens: "Max context tokens",
      showThinking: "Show thinking",
      skillAutoInject: "Auto-inject skill metadata",
      maxInjectedSkills: "Max injected skills",
      mcpApprovalMode: "MCP approval mode",
      mcpApprovalHelp: "Only affects MCP tools, still bounded by tool risk and explicit grants.",
      llmApprovalMode: "LLM auto approval (experimental)",
      llmApprovalHelp: "Runs only when rules still require approval, can approve non-destructive tools only, and uses extra tokens.",
      llmApprovalAutoOnly: "Available only in Auto approval mode; other modes follow the risk list and user approval.",
      fullAccessTitle: "Confirm full access",
      fullAccessBody: "Full access globally allows every risk class, including delete, overwrite, process termination, and other destructive operations. Enable it only when this workspace and task boundary are trusted.",
      fullAccessConfirm: "Enable full access",
      fullAccessCancel: "Cancel",
      sanitizeSensitiveData: "Sanitize sensitive data",
      encryptStorage: "Encrypt local storage",
      mcpApprovalOptions: {
        confirm_each: "Confirm each",
        confirm_dangerous: "Confirm dangerous",
        auto: "Auto"
      },
      llmApprovalOptions: {
        off: "Off",
        non_destructive: "Non-destructive only"
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
        full_access: {
          label: "Full access",
          description: "All risks"
        },
        custom: {
          label: "Custom",
          description: "Fine tune"
        },
        auto_approval: {
          label: "Auto approval",
          description: "Auto review"
        }
      },
      contextModeOptions: {
        auto: "Auto",
        manual: "Manual"
      },
      agentToneOptions: {
        concise: "Concise",
        balanced: "Balanced",
        warm: "Warm",
        formal: "Formal"
      },
      responseDetailOptions: {
        brief: "Brief",
        normal: "Normal",
        detailed: "Detailed"
      },
      startupViewOptions: {
        last_task: "Restore last task",
        last_folder: "Restore last folder",
        new_task: "Always new task"
      },
      themeOptions: {
        dark: "Dark",
        light: "Light",
        system: "System"
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
