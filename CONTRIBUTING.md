# Contributing to SCC-Batch

Thanks for spending time on SCC-Batch.

This repository is still **experimental / pre-1.0**, so contributions are most helpful when they keep the backend runtime, CLI, and web workbench aligned instead of improving only one surface in isolation.

## Before you open a change

1. Read the current repo quickstart in [`README.md`](./README.md).
2. Check the workspace guidance in [`.scc/project.md`](./.scc/project.md).
3. Prefer a focused change over a broad speculative refactor.

## Development expectations

- Keep changes evidence-backed.
- Favor explicit runtime truth over stale docs or assumptions.
- If a change affects UI, verify the underlying backend or CLI truth too.
- If you edit command, workflow, or operator-facing behavior, update docs in the same pull request.

## Local verification

Run the narrowest useful set first, then widen as needed:

```bash
npm run test
npm run build
npm run smoke:frontend
npm run e2e:frontend
```

When working on repo hygiene or release prep, also run:

```bash
npm run repo-hygiene
npm run repo-delivery
```

## Pull request guidance

Good pull requests usually include:

- the concrete problem being solved
- the files or surfaces affected
- what was verified locally
- any remaining risks or known follow-ups

## Scope discipline

Please avoid bundling unrelated cleanup into the same change. SCC-Batch has a large surface area, and narrow diffs are much easier to validate across backend, CLI, and web.
