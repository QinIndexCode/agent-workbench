# Manual Artifact Audit

This document records the current manual-artifact audit gate as of April 5, 2026.

The manual audit consumes the same outputs produced by the public-capability parity suite and checks whether the artifacts are actually solving the intended task instead of only satisfying a shallow structural check.

## Current Result

- suite command: `npm run manual-artifact-audit`
- current status: `achieved`
- current pass rate: `12 / 12`
- report file: `.codex-run/logs/manual-artifact-audit.json`

## Audit Rubric

Each entry must confirm:

- the produced artifact addresses the intended repo task rather than echoing a template
- referenced repo files and task facts remain accurate
- provider / MCP / skill / permission / subagent choices stay visible in the summary model
- hook and recovery behavior remain aligned with task events
- no hidden `unknown` failure category or silent execution gap survives review

## Interpretation

- `manual_artifact_audit = achieved` means SCC's mixed-public parity artifacts survived evidence-based review, not just automated pass/fail checks.
- This gate is part of the default `engineering_floor`, so a future automated false positive should be caught here instead of being silently treated as a flagship pass.
