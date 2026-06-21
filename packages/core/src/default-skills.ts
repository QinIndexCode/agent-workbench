import type { SkillRecord } from "@agent-workbench/shared";
import { nowIso } from "./ids.js";
import { normalizeSkillRecord } from "./experience.js";

export const DEFAULT_OFFICE_VISUAL_QA_SKILL_ID = "skill_default_office_visual_qa";
export const DEFAULT_OFFICE_VISUAL_QA_SKILL_TITLE = "Office Document and Deck Visual QA";
export const DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_ID = "skill_default_browser_computer_control";
export const DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_TITLE = "Browser and Computer Control via MCP";

type DefaultSkillFactory = (now?: string) => SkillRecord;

export const DEFAULT_SKILL_FACTORIES: DefaultSkillFactory[] = [
  createDefaultOfficeVisualQaSkill,
  createDefaultBrowserComputerControlSkill
];

export function createDefaultOfficeVisualQaSkill(now: string = nowIso()): SkillRecord {
  return normalizeSkillRecord({
    id: DEFAULT_OFFICE_VISUAL_QA_SKILL_ID,
    sourceMemoryIds: [],
    title: DEFAULT_OFFICE_VISUAL_QA_SKILL_TITLE,
    body: DEFAULT_OFFICE_VISUAL_QA_SKILL_BODY,
    applicability: {
      description:
        "Use for DOCX, PPTX, PDF, Word, PowerPoint, slide deck, report, proposal, brief, and other Office-style deliverables where visual quality matters.",
      requiredTools: ["write_file", "run_command", "attach_task_file"],
      requiredContext: ["The task asks to create, edit, inspect, or judge a document or presentation artifact."],
      exclusions: ["Do not use for plain chat answers that do not create or assess a document artifact."],
      minConfidence: 0.65,
      keywords: [
        "docx",
        "pptx",
        "pdf",
        "word",
        "powerpoint",
        "deck",
        "presentation",
        "slides",
        "report",
        "brief",
        "visual qa",
        "document"
      ]
    },
    stats: {
      totalUses: 0,
      successUses: 0,
      failureUses: 0,
      successRate: 0,
      consecutiveFailures: 0
    },
    version: 1,
    corrections: [],
    status: "active",
    relatedPatterns: [],
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now
  });
}

export function createDefaultBrowserComputerControlSkill(now: string = nowIso()): SkillRecord {
  return normalizeSkillRecord({
    id: DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_ID,
    sourceMemoryIds: [],
    title: DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_TITLE,
    body: DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_BODY,
    applicability: {
      description:
        "Use when a task requires browser automation, visual GUI inspection, keyboard or mouse actions, desktop app operation, screenshot-based verification, or reproduction of a GUI-only bug.",
      requiredTools: ["mcp", "screenshot", "browser", "computer-control", "attach_task_file"],
      requiredContext: [
        "The task depends on a graphical interface, browser flow, keyboard input, mouse clicks, screenshot evidence, or a desktop application."
      ],
      exclusions: [
        "Do not use when the same outcome can be verified more safely through files, structured APIs, or ordinary command output."
      ],
      minConfidence: 0.65,
      keywords: [
        "browser",
        "playwright",
        "chrome",
        "computer",
        "desktop",
        "gui",
        "screenshot",
        "keyboard",
        "mouse",
        "click",
        "type",
        "visual",
        "app",
        "mcp"
      ]
    },
    stats: {
      totalUses: 0,
      successUses: 0,
      failureUses: 0,
      successRate: 0,
      consecutiveFailures: 0
    },
    version: 1,
    corrections: [],
    status: "active",
    relatedPatterns: [],
    createdAt: now,
    lastUsedAt: now,
    updatedAt: now
  });
}

export const DEFAULT_OFFICE_VISUAL_QA_SKILL_BODY = `# Office Document and Deck Visual QA

Use this skill whenever the task asks to create, edit, inspect, or judge a DOCX, PPTX, PDF, Word document, slide deck, presentation, report, proposal, brief, or other Office-style deliverable where visual quality matters.

## Source and thanks

This local Agent Workbench skill is original guidance adapted from Agent Workbench visual smoke findings and public skill patterns. References reviewed: Anthropic public Skills docx/pptx guidance on GitHub (https://github.com/anthropics/skills/tree/main/skills/docx and https://github.com/anthropics/skills/tree/main/skills/pptx), iOfficeAI OfficeCLI skill notes (https://github.com/iOfficeAI/OfficeCLI), and OpenAI bundled Documents/Presentations/PDF skill workflows available in the local Codex runtime. Thanks to those maintainers and authors for publishing practical document-agent patterns.

## Non-negotiable rule

A generated Office file is not done because it exists or because the OOXML zip structure is valid. Completion requires rendered visual evidence: export DOCX/PPTX/PDF to page or slide images, inspect those images, list defects, fix the source, and re-render until the latest pass has no material visual defects.

## Creation standards

- Decide the artifact type before writing: memo, delivery brief, proposal, SOP, dashboard deck, review deck, or reference guide.
- Use a deliberate style system: page/slide size, margins, type scale, heading ladder, palette, table treatment, callouts, and footer/page markers.
- Avoid generic blue-only templates unless the user explicitly asks for minimal corporate styling. Pick one dominant color, restrained support colors, and one accent.
- Use structure that matches the information: prose for explanation, cards for short comparable items, tables only for true row/column comparisons, timelines for plans, and callouts for decisions or risks.
- Prefer editable native Office content over screenshots or full-page bitmaps.
- Do not invent project facts, metrics, dates, paths, logos, customer names, or source claims.

## Default implementation workflow

Prefer this order unless the user or project gives a stronger local renderer:

1. Use existing local Python packages such as python-docx, python-pptx, Pillow, openpyxl, and zip/xml inspection to create and inspect editable OOXML artifacts.
2. On Windows, write non-trivial scripts to a .py file first, then run the file. Prefer PowerShell here-strings or write_file over long python -c commands; long quoted inline scripts are fragile and often fail before producing artifacts.
3. Do not spend the main task budget installing optional renderers. Only run pip install when an import actually fails and the missing package is essential. Dependency install/version-check output is setup evidence, not completion evidence.
4. When native Office or LibreOffice is already available, use it for high-fidelity export. If it is not available, create faithful visual proxy images from the DOCX/PPTX structure with Pillow and clearly label this as proxy visual QA.
5. Completion requires artifact paths plus rendered/proxy image paths and a visual verdict. A directory check, dependency version, or empty command output is not enough.
6. When the latest rendered/proxy image is useful for user inspection, call attach_task_file on the generated image inside the task folder so it appears in the task timeline.

## DOCX checklist

- Use generous margins and readable body text; avoid dense walls of text.
- Build real headings and real tables; do not fake tables with spacing.
- Tables need explicit column widths, padding, vertical rhythm, and readable wrapping.
- Cover pages should look intentional: balanced title block, metadata, and visual restraint. Avoid a nearly empty page unless it is a conscious cover design.
- Avoid orphan sections and pages that contain only a few lines unless the user asked for a sparse executive style.

## PPTX checklist

- Every slide needs a purpose and a visible information design, not only title plus bullets.
- Use strong title/body size contrast and keep body text readable at projected size.
- Maintain consistent alignment, margins, card spacing, footer treatment, and palette.
- Avoid repeated identical layouts across the whole deck unless it is a strict template.
- Avoid text-only slides, low contrast, cramped cards, clipped text, and decorative lines that collide with wrapped titles.

## Visual QA gate

Render every page or slide to PNG before final response. Use the best available renderer in this order:

1. Native Office COM export on Windows when Word or PowerPoint is already available.
2. LibreOffice headless export to PDF when LibreOffice is already available.
3. A project-approved or script-built proxy renderer that produces full-page images from the actual DOCX/PPTX/PDF structure.

Then inspect the images and record issues:

- text overlap, clipping, cut-off glyphs, or content outside page/slide bounds
- cramped sections, weak margins, inconsistent gaps, or excessive blank pages
- table text pinned to borders, uneven column widths, tiny type, or broken wrapping
- inconsistent heading hierarchy, palette drift, or mismatched component styles
- placeholder text, fake data, broken paths, or chat/process language leaking into the deliverable

If issues are found, fix the source artifact and re-render. Do not claim flagship or polished quality after only one structural check.

## Response discipline

In the final answer, separate:

- generation success: whether files were created and opened/rendered
- visual verdict: polished, acceptable with caveats, or not production-ready
- concrete defects: page/slide numbers and what to change
- remaining limits: missing renderer, missing font, or task paused/incomplete state
`;

export const DEFAULT_BROWSER_COMPUTER_CONTROL_SKILL_BODY = `# Browser and Computer Control via MCP

Use this skill when the task needs browser automation, GUI inspection, keyboard or mouse actions, screenshot evidence, desktop app operation, or reproduction of a bug that only appears in a graphical interface.

## Source and thanks

This local Agent Workbench skill is original guidance aligned with Agent Workbench's MCP and approval model. References reviewed: OpenAI Codex open-source repository (https://github.com/openai/codex), OpenAI Codex MCP documentation (https://developers.openai.com/codex/mcp), OpenAI Codex permissions and approvals documentation (https://developers.openai.com/codex/permissions and https://developers.openai.com/codex/agent-approvals-security), and Codex Computer Use documentation (https://developers.openai.com/codex/app/computer-use). Thanks to those maintainers and authors for documenting the safer extension pattern.

## Non-negotiable rule

Do not fake GUI capability with hard-coded command outputs, hidden fixture state, or test-only scripts. If the task requires seeing or operating a GUI, use a real connected browser/computer-control tool and record observable evidence in the task timeline.

## Preferred architecture

- Prefer structured APIs, files, and command output when they can verify the result without GUI control.
- For local web apps, prefer a Playwright-compatible or browser-control MCP server that exposes explicit tools such as navigate, click, type, screenshot, console logs, network logs, and DOM inspection.
- For native desktop apps or workflows that genuinely require keyboard and mouse control, connect a dedicated computer-control MCP server or supported computer-use plugin.
- Keep keyboard and mouse operations out of the built-in shell/file tool surface. They affect host state outside the project and must stay behind explicit tool registration and approvals.
- Every connected GUI tool must appear through tool discovery before use. If no such tool is available, say that clearly and fall back to code-level or HTTP-level verification.

## Risk mapping

Map each discovered GUI tool by actual impact, not by convenience:

- screenshot, DOM read, accessibility tree read, console read, and window metadata: host_observation or workspace_read
- local app navigation, local browser navigation, and localhost probing: host_observation or network depending on target
- external navigation, remote page fetches, login flows, and third-party APIs: network
- click, type, hotkey, drag, file chooser, upload, download, clipboard, or desktop app commands: shell or destructive depending on side effects
- credential entry, payment, account deletion, irreversible settings, bulk sends, or destructive host actions: destructive and require explicit user approval

## Execution workflow

1. Confirm the target surface: local web app, remote website, desktop app, browser extension, emulator, or OS setting.
2. Check discovered MCP tools before acting. Prefer the smallest tool set that can observe and interact with the target.
3. Start with a harmless observation: screenshot, DOM/accessibility snapshot, title/url check, or visible text extraction.
4. Plan clicks and typing from observed state, not from assumed coordinates. Prefer selectors or accessibility roles; use coordinates only when no semantic target exists.
5. After every mutating action, capture fresh evidence: screenshot, DOM snapshot, console log, resulting file, or server response. If the screenshot is saved inside the task folder and the user needs to see it, call attach_task_file so the timeline carries the actual image.
6. Stop when the requested state is verified, not when the click sequence merely completes.

## Browser QA checklist

- Verify that the page loaded at the intended URL and not an error, blank page, login redirect, or stale tab.
- Capture console errors and network failures when available.
- Check desktop and mobile/narrow layouts when the task touches responsive behavior.
- For forms, verify typed values before submission and resulting state after submission.
- For downloads/uploads, verify the actual resulting file or attachment metadata.

## Desktop control checklist

- On Windows, assume the active desktop can be affected; keep actions scoped and visible.
- Avoid global hotkeys unless the target window is confirmed active.
- Never type secrets unless the user explicitly requested it and the target is verified.
- Treat clipboard operations as sensitive because they can cross app boundaries.
- Do not leave long-running GUI helper processes behind; timeout cleanup must terminate child process trees.

## Failure handling

If the GUI tool is unavailable, blocked, or cannot see the target:

- Report the missing capability precisely.
- Use HTTP, CLI, unit tests, or file inspection for partial verification when possible.
- Do not claim that keyboard, mouse, or browser interaction was tested unless a real GUI tool produced evidence.
`;
