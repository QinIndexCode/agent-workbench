# Skills

Skills are reusable methods, not transcripts.

## When a skill is healthy

- it describes a repeatable method
- it names the required tools
- it lists the context where it applies
- it includes exclusions for cases where it should not fire
- it does not contain machine-specific output or one-off conclusions

## Statuses

- **Candidate**: ready for review, not automatically trusted as an active method
- **Active**: available for runtime matching
- **Suspended**: kept for audit, not injected at runtime
- **Retired**: historical only

## Before activating a candidate

1. Check the title and applicability.
2. Remove one-off task output.
3. Verify the required tools and exclusions.
4. Look at **Curator** for evidence and duplicate reasoning.

## Good default

If you are unsure, leave the skill as **Candidate** until repeated tasks prove it is stable.

## Built-in Office visual QA skill

Agent Workbench ships with an active **Office Document and Deck Visual QA** skill. It applies to DOCX, PPTX, PDF, Word, PowerPoint, reports, briefs, and slide decks where visual quality matters.

This built-in skill is intentionally stricter than a file-exists check. It tells the agent to render document pages or slides to images, inspect the result, fix visible defects, and only then report the visual verdict. Use it when generated Office files must be judged for layout, hierarchy, spacing, table readability, and presentation polish.

The default path favors editable OOXML generation with existing Python document libraries and rendered/proxy PNG evidence. Optional dependency installation or version checks are treated as setup only, not as completion evidence.

## Built-in browser and computer-control skill

Agent Workbench also ships with an active **Browser and Computer Control via MCP** skill. It applies to browser automation, GUI visual inspection, keyboard or mouse actions, desktop app operation, screenshot verification, and bugs that can only be reproduced in a graphical interface.

The principle is simple: do not hide keyboard or mouse control inside ordinary shell/file tools, and do not fake GUI capability with hard-coded output. Browser control should come through a Playwright-compatible or browser-control MCP server. Desktop app control should come through a dedicated computer-control MCP server or supported computer-use plugin. Tools must be discovered first, then run through the normal approval, evidence, and task timeline flow.

Keep risk mapping conservative. Screenshots, DOM reads, console reads, and window metadata are usually observational. External navigation, login flows, and remote pages are network-sensitive. Clicks, typing, hotkeys, drags, uploads, downloads, clipboard operations, and desktop commands can change host state and may need higher-risk approval. Start with a harmless observation, take the smallest action that proves the flow, and capture fresh evidence after every mutation.
