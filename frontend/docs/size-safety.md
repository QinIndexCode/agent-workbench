# Frontend Size Safety

This frontend uses a custom token setup where shorthand width utilities such as
`max-w-sm`, `max-w-md`, `max-w-lg`, `max-w-xl`, `w-sm`, `w-md`, `w-lg`,
`w-xl`, `min-w-sm`, `min-w-md`, `min-w-lg`, and `min-w-xl` can resolve against
spacing tokens instead of container widths.

To keep dialogs, empty states, toasts, and floating panels from collapsing into
narrow columns:

- Use explicit bracket widths for overlays and floating UI.
  Example: `w-[min(36rem,calc(100vw-2rem))] max-w-[36rem]`
- Use stable container widths for page sections.
  Preferred: `max-w-2xl`, `max-w-3xl`, `max-w-4xl`, `max-w-5xl`, `max-w-7xl`
- Use explicit bracket widths for help copy and empty-state text blocks.
  Example: `max-w-[36rem]`

The automated guardrail for this rule lives in:

- `frontend/scripts/audit-safe-size-classes.mjs`

Run it with:

```powershell
npm run audit:size-classes -w frontend
```

The audit fails on ambiguous width classes unless a line is explicitly marked
with `size-audit:ignore`.
