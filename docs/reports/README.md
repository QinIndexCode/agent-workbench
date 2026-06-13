# Generated Reports

This directory is the output location for dated flagship revalidation reports
written by `scripts/write-flagship-report.mjs`.

Generated `*.md` reports are validation artifacts, not hand-maintained source
documentation. Keep them out of the release source tree unless a release process
explicitly asks for an attached evidence snapshot. The source of truth for
current validation remains:

- `data/test-reports/flagship-quality/quality-results.json`
- `data/test-reports/live-model-smoke/report.json`
- `data/test-reports/live-agent-http-resume/report.json`
- `data/test-reports/sensitive-artifacts/report.json`

When a flagship verdict is needed, regenerate the report from fresh artifacts
whose `sourceFingerprint` matches the current checkout.
