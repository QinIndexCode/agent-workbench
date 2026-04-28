---
description: Audit the repo for open-source readiness and release hygiene drift.
args: [scope]
when: Use before public release prep, packaging changes, or repo-wide hygiene work.
---
Run a release-readiness audit for ${args}.

Check:

1. public docs and quickstart accuracy
2. repo hygiene and delivery scripts
3. launcher and install flow
4. any tracked local state, secret-like files, or packaging leakage

Return concrete file-level findings and the smallest remediation path.
