# Release Checklist

Agent Workbench is not release-ready until every required item below is complete.

## Legal And Governance

- [x] Select and add an open-source `LICENSE`.
- [ ] Confirm bundled icons, images, fonts, and copied material permit redistribution.
- [ ] Review `SECURITY.md`, `CONTRIBUTING.md`, and `CODE_OF_CONDUCT.md`.
- [ ] Rotate any credentials used during release validation.

## Repository

- [ ] Working tree is clean and all intended CLI, Web, server, core, docs, and test files are committed.
- [ ] No runtime databases, traces, attachments, checkpoints, plaintext secret notes, or generated reports are tracked.
- [ ] `npm run clean:release-artifacts` has been run after the last E2E or release validation pass.
- [ ] `npm run check:release-source` passes. This is also part of `quality:full`.
- [ ] `docs/reports/` contains only `README.md` before creating the release source snapshot.
- [ ] README and quick start accurately describe the current product and supported platforms.
- [x] Repository metadata points at the final public repository.
- [ ] Version and release notes are updated.

## Verification

- [ ] A clean clone succeeds with `npm ci`.
- [ ] `npm run audit:prod` reports zero vulnerabilities.
- [ ] `npm audit` has no unresolved high or critical vulnerabilities.
- [ ] `npm run quality:full` passes.
- [ ] Required live model and live HTTP agent checks pass against the release source fingerprint.
- [ ] The dated release report matches the release source fingerprint.

## Distribution

- [ ] Decide whether the first release is source-only or includes npm packages/binaries.
- [ ] If publishing npm packages, remove `private: true` only from intended packages and add `files`, `license`, and `publishConfig`.
- [ ] Create a signed or annotated version tag and attach release notes.
