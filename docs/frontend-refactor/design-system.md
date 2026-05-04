# SCC Frontend Design System

Date: 2026-05-03

## Product Direction

SCC is an operator workbench. The UI should feel like a dense professional console: restrained, legible, and built for repeated task supervision. Avoid marketing composition, nested cards, oversized status ornaments, and decorative gradients.

## Tokens

- Use semantic surface tokens from `frontend/src/index.css`.
- Use compact borders and backgrounds: `border-border-subtle`, `bg-surface`, `bg-surface-elevated`, `bg-surface-hover`.
- Use text tokens by hierarchy: `text-text-primary`, `text-text-secondary`, `text-text-muted`.
- Keep dominant palettes balanced and avoid one-hue screens.

## Shape

- Cards and panels use `rounded-lg` or smaller.
- Icon buttons may be circular only when the shape communicates the action, such as the composer send button.
- Do not nest cards inside cards. Repeated items can be cards, but page sections should remain unframed or use one clear container.

## Components

- Base primitives live in `frontend/src/components/ui`.
- Use shared primitives before writing local HTML variants:
  - `Button`
  - `Card`
  - `Input`
  - `Textarea`
  - `Checkbox`
  - `ManagementTable`
  - `PaginationBar`
  - `AdminModal`
  - `ConfirmDialog`
  - `Spinner`
- Use Lucide icons for new actions. Keep older handwritten icons only where they remain part of existing shell semantics.

## Interaction States

- Loading actions use `Spinner` and `aria-busy` where useful.
- Destructive operations require `ConfirmDialog`.
- Empty states should give the next concrete action, not product explanation.
- Export actions produce files directly through the browser download flow.

## Task Workbench Rules

- The task list keeps text lifecycle labels because it is a scanning surface.
- The thread and inspector avoid duplicate lifecycle dots and badges.
- Composer primary action is a circular up-arrow button.
- Pause is a rounded square icon button.
- Running guidance is allowed and appears as pending until the backend conversation accepts it.
- Restart is not part of TaskDiscussion UI contracts.

## Responsive Rules

- Keep workbench layouts scrollable rather than collapsed into unreadable columns.
- Use explicit width constraints for overlays and floating UI.
- Avoid ambiguous width utilities covered by `frontend/docs/size-safety.md`.
