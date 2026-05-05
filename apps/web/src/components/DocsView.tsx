import { useState } from "react";
import { ExternalLink, Menu } from "lucide-react";
import { getUiCopy } from "../i18n.js";
import { MarkdownText } from "./MarkdownText.js";

const docs = [
  {
    id: "overview",
    title: "SCC Workbench",
    externalUrl: "",
    content: [
      "# SCC Workbench",
      "",
      "SCC 是一个 Agent-first 工作台。系统负责上下文组装、工具权限、事件投影和经验学习；任务完成判断交给 Agent 的证据链与用户反馈。",
      "",
      "## 核心原则",
      "- 不使用旧式脚本门禁或固定输出格式作为任务完成判官。",
      "- 工具执行先经过风险分类，必要时由用户审批。",
      "- 用户运行中输入会进入 pending guidance，并在 safe point 消费。",
      "- Skills 和 Knowledge 是可审核的长期能力，不直接污染每轮上下文。"
    ].join("\n")
  },
  {
    id: "providers",
    title: "Model Providers",
    externalUrl: "",
    content: [
      "# Model Providers",
      "",
      "模型服务商在本机保存。API Key 会加密后写入本地数据目录，前端只显示掩码。",
      "",
      "## 支持协议",
      "- OpenAI-compatible",
      "- Anthropic Messages",
      "- Gemini",
      "",
      "默认推荐 Mimo。自定义模型需要手动填写上下文窗口。"
    ].join("\n")
  },
  {
    id: "permissions",
    title: "Permissions",
    externalUrl: "",
    content: [
      "# Permissions",
      "",
      "权限只服务真实风险，不服务脚本式任务控制。",
      "",
      "## 输入框权限范围",
      "- Ask: 每次按风险请求确认。",
      "- Read only: 只读观察自动通过。",
      "- All: 所有风险类别全局允许，可随时撤销。"
    ].join("\n")
  }
];

export function DocsView({ language, onOpenTasks }: { language?: string | null; onOpenTasks: () => void }) {
  const [activeId, setActiveId] = useState(docs[0]!.id);
  const active = docs.find((doc) => doc.id === activeId) ?? docs[0]!;
  const shell = getUiCopy(language).shell;
  const zh = language === "zh-CN";
  return (
    <section className="settingsView docsView" aria-label={zh ? "文档" : "Docs"}>
      <header className="settingsHeader">
        <button className="mobileTaskToggle" type="button" onClick={onOpenTasks}>
          <Menu size={16} />
          {shell.tasks}
        </button>
        <div>
          <h1>{zh ? "文档" : "Docs"}</h1>
          <p>{zh ? "产品说明、模型配置和权限语义。" : "Product notes, model setup, and permission semantics."}</p>
        </div>
      </header>
      <div className="settingsBody">
        <nav className="settingsNav" aria-label="Docs">
          {docs.map((doc) => (
            <button className={doc.id === active.id ? "settingsNavItem selected" : "settingsNavItem"} type="button" key={doc.id} onClick={() => setActiveId(doc.id)}>
              <span>{doc.title}</span>
              <small>{doc.externalUrl || (zh ? "本地说明" : "Local guide")}</small>
            </button>
          ))}
        </nav>
        <article className="settingsPanel docsArticle">
          <div className="panelHero">
            <div>
              <h2>{active.title}</h2>
              <p>{zh ? "Markdown 文档会在这里直接渲染。" : "Markdown documents render directly here."}</p>
            </div>
            {active.externalUrl ? (
              <a className="subtleButton iconText" href={active.externalUrl} rel="noreferrer" target="_blank">
                <ExternalLink size={15} />
                {zh ? "打开链接" : "Open link"}
              </a>
            ) : null}
          </div>
          <div className="docBody">
            <MarkdownText content={active.content} />
          </div>
        </article>
      </div>
    </section>
  );
}
