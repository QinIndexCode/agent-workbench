# Security Policy

## Reporting a vulnerability

If you believe you have found a security issue in SCC-Batch, please do **not** open a public issue with exploit details.

Until a dedicated security mailbox is published, open a private report through the repository host if available, or contact the maintainers through the private coordination channel already in use for this project.

## What to include

Please include:

- affected version or commit
- reproduction steps
- impact summary
- any suggested mitigation or workaround

## Scope notes

SCC-Batch currently includes:

- backend runtime and worker processes
- CLI and TUI surfaces
- web operator interfaces
- provider, skill, MCP, and workspace workflow integrations

Please mention which surface is affected so triage can start from the right subsystem.

## Secret handling

Do not commit provider API keys, local `.env` files, runtime state, or generated secret stores. The repository hygiene gate includes `npm run secret-hygiene`, which scans tracked files for high-confidence provider tokens, private keys, and local runtime/secret paths before release or CI promotion.

Use provider secret commands or local ignored environment files for live validation keys. Test fixtures must use short placeholder values that cannot be confused with real provider credentials.
