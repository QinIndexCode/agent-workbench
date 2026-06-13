# Security Policy

## Supported Versions

Agent Workbench is currently pre-1.0. Security fixes are applied to the latest
commit on the default branch. Older snapshots and forks are not maintained.

## Reporting a Vulnerability

Do not open a public issue for vulnerabilities involving secret exposure,
permission bypass, path traversal, command execution, authentication, or
encrypted SQLite storage.

Use GitHub's private vulnerability reporting feature for
`QinIndexCode/agent-workbench`. Include:

- affected version or commit;
- reproduction steps;
- expected and observed behavior;
- impact and reachable attack surface;
- any suggested mitigation.

Do not include real API keys, private user data, or destructive payloads. A
maintainer should acknowledge a complete report within seven days. Disclosure
timing will be coordinated after a fix and verification path are available.

## Secrets

Do not store provider keys, token-plan keys, webhook secrets, SQLite databases,
model traces, or private task artifacts in Markdown files or source-controlled
fixtures. Use environment variables, the encrypted provider store, or local
ignored files. Rotate any credential that was copied into a prompt, report, or
local scratch file during validation.

## Security Boundary

Agent Workbench is a local-first application. The default HTTP server binds to
loopback and its session bootstrap endpoint is intended for trusted local use.
Do not expose the server directly to an untrusted network. Tool execution,
provider credentials, MCP servers, integrations, and imported files should all
be treated as security-sensitive inputs.
