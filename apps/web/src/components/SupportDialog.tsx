import { BookOpen, Keyboard, ShieldCheck, Sparkles, X } from "lucide-react";

export function SupportDialog({
  language,
  open,
  onClose,
  onOpenDocs
}: {
  language?: string | null;
  open: boolean;
  onClose: () => void;
  onOpenDocs: () => void;
}) {
  if (!open) return null;
  const text = getSupportCopy(language);
  const cards = [
    { icon: Sparkles, title: text.askTitle, body: text.askBody },
    { icon: ShieldCheck, title: text.permissionTitle, body: text.permissionBody },
    { icon: Keyboard, title: text.shortcutTitle, body: text.shortcutBody }
  ];
  return (
    <div className="modalOverlay" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section aria-modal="true" className="supportDialog" role="dialog" aria-labelledby="support-dialog-title">
        <header className="dialogHeader">
          <h3 id="support-dialog-title">{text.title}</h3>
          <button aria-label={text.close} className="iconButton" type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="supportGrid">
          {cards.map((card) => {
            const Icon = card.icon;
            return (
              <article key={card.title}>
                <span className="supportCardIcon">
                  <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
                </span>
                <div className="supportCardContent">
                  <strong>{card.title}</strong>
                  <p>{card.body}</p>
                </div>
              </article>
            );
          })}
        </div>
        <footer className="supportFooter">
          <button
            className="subtleButton iconText"
            type="button"
            onClick={() => {
              onClose();
              onOpenDocs();
            }}
          >
            <BookOpen size={15} />
            {text.openDocs}
          </button>
        </footer>
      </section>
    </div>
  );
}

function getSupportCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    title: zh ? "需要一点帮助？" : "Need a hand?",
    askTitle: zh ? "如何提问" : "How to ask",
    askBody: zh ? "直接描述目标、约束和你希望看到的结果。运行中也可以追加引导。" : "Describe the goal, constraints, and desired result. You can add guidance while a task is running.",
    permissionTitle: zh ? "权限如何工作" : "How permissions work",
    permissionBody: zh ? "Agent Workbench 只在真实风险出现时请求授权；全局授权可在权限页撤销。" : "Agent Workbench asks only when real risk appears. Global grants can be revoked in Permissions.",
    shortcutTitle: zh ? "输入快捷键" : "Input shortcuts",
    shortcutBody: zh ? "Enter 发送，Shift + Enter 换行。附件和语音会进入当前输入上下文。" : "Enter sends, Shift + Enter inserts a newline. Attachments and voice go into the current input context.",
    openDocs: zh ? "打开文档" : "Open Docs",
    close: zh ? "关闭" : "Close"
  };
}
