# Public Capability Parity

This document records the current SCC public-baseline parity gate as of April 5, 2026.

The parity suite does **not** claim to run OpenCode or Claude Code directly. Instead, it reconstructs publicly documented task shapes on top of SCC's own `.scc + task runtime + tri-surface summary + capability hub` mainline.

## Baseline Mix

- `claude-code`
  - project instructions / memory style task
  - custom slash-command / workspace command task
  - subagent-specialized review task
  - hook-observable recovery task
  - MCP-managed capability selection task
- `opencode`
  - build/plan split task
  - provider/model/variant selection task
  - permission allow/ask/deny task
  - runtime-skill loading task
  - MCP server capability task
  - provider readiness / fallback task
- `anthropic-swebench`
  - repo issue resolution flow with analysis, patch, and verification artifacts

## Current Result

- suite command: `npm run public-capability-parity`
- current status: `achieved`
- current pass rate: `12 / 12`
- current artifact-quality pass rate: `1`
- report file: `.codex-run/logs/public-capability-parity.json`

## Interpretation

- This gate proves SCC can reconstruct publicly documented task shapes without importing `.claude` or `.opencode` as a runtime authority.
- This gate does **not** prove a direct vendor-to-vendor benchmark with matched hidden prompts, private task sets, or billing/account telemetry.
- This gate is part of the default `engineering_floor`, so regressions here count as mainline regressions rather than optional benchmark drift.
