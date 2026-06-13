# Contributing

Thank you for improving Agent Workbench. Keep changes focused, evidence-backed,
and compatible with the local-first security model.

## Before You Start

- Search existing issues before opening a new one.
- Use an issue for substantial behavior, security-boundary, or architecture changes.
- Never commit API keys, provider secrets, SQLite runtime data, model traces, or generated test artifacts.
- Do not hardcode behavior for one test prompt, fixture, route, or expected output.
- Treat `docs/reports/*.md` as generated evidence. Regenerate it for validation, but do not hand-maintain old reports as source docs.

## Local Setup

Requirements:

- Node.js 22 or newer
- npm 10 or newer
- Windows is the fully validated development platform

```bash
npm ci
npm run build
npm run quality:full
```

On Windows PowerShell, `npm.cmd` may be used instead of `npm`.

## Pull Requests

- Explain the user-visible behavior and the reason for the change.
- Add focused regression tests for changed behavior.
- Include the commands used to verify the change.
- Keep generated files and local runtime data out of commits.
- Update documentation when commands, configuration, or product boundaries change.

The minimum review gate is:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run audit:prod
```

Changes affecting shared runtime behavior, permissions, persistence, Web UI, or
CLI workflows should also pass `npm run quality:full`.
