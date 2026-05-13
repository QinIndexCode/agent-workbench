import { ArrowRight, BookOpen, Compass, Sparkles } from "lucide-react";

export function SettingsPrimer({
  language,
  summary,
  focus,
  impact,
  nextStep,
  onOpenDocs
}: {
  language?: string | null | undefined;
  summary: string;
  focus: string;
  impact: string;
  nextStep: string;
  onOpenDocs?: (() => void) | undefined;
}) {
  const text = getAssistCopy(language);
  return (
    <section className="settingsPrimer" aria-label={text.primerLabel}>
      <div className="settingsPrimerHeader">
        <div className="settingsPrimerCopy">
          <span className="settingsPrimerEyebrow">
            <Sparkles size={13} aria-hidden="true" />
            {text.eyebrow}
          </span>
          <p>{summary}</p>
        </div>
        {onOpenDocs ? (
          <button className="subtleButton iconText" type="button" onClick={onOpenDocs}>
            <BookOpen size={15} />
            {text.viewGuide}
          </button>
        ) : null}
      </div>
      <div className="settingsPrimerGrid">
        <article className="settingsPrimerCell">
          <span>{text.focus}</span>
          <p>{focus}</p>
        </article>
        <article className="settingsPrimerCell">
          <span>{text.impact}</span>
          <p>{impact}</p>
        </article>
        <article className="settingsPrimerCell">
          <span>{text.nextStep}</span>
          <p>{nextStep}</p>
        </article>
      </div>
    </section>
  );
}

export function SettingsEmptyStateCard({
  language,
  title,
  body,
  hint,
  actionLabel,
  actionAriaLabel,
  onAction
}: {
  language?: string | null | undefined;
  title: string;
  body: string;
  hint: string;
  actionLabel: string;
  actionAriaLabel?: string | undefined;
  onAction: () => void;
}) {
  const text = getAssistCopy(language);
  return (
    <section className="settingsEmptyStateCard" aria-label={title}>
      <span className="settingsEmptyIcon" aria-hidden="true">
        <Compass size={18} />
      </span>
      <div className="settingsEmptyCopy">
        <strong>{title}</strong>
        <p>{body}</p>
        <small>{hint}</small>
      </div>
      <div className="settingsEmptyActions">
        <button aria-label={actionAriaLabel} className="primaryInlineButton" type="button" onClick={onAction}>
          {actionLabel}
          <ArrowRight size={14} />
        </button>
        <span>{text.emptyActionHint}</span>
      </div>
    </section>
  );
}

function getAssistCopy(language?: string | null) {
  const zh = language === "zh-CN";
  return {
    primerLabel: zh ? "设置说明" : "Settings primer",
    eyebrow: zh ? "首次使用建议先看这里" : "Start here for the fastest setup",
    viewGuide: zh ? "查看说明" : "View guide",
    focus: zh ? "这页负责什么" : "What this page controls",
    impact: zh ? "改动会影响什么" : "What changes affect",
    nextStep: zh ? "常见下一步" : "Common next step",
    emptyActionHint: zh ? "也可以先查看说明再配置。" : "You can review the guide first, then come back to configure."
  };
}

export function describeActionError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  if (typeof error === "string" && error.trim()) return error.trim();
  return "The requested change could not be saved.";
}
