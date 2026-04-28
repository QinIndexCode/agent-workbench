---
description: Run the frontend smoke stack and summarize any actionable failures.
args: [extra npm args]
when: Use after UI work or when validating public operator flows.
---
Run `npm.cmd run smoke:frontend ${args}` from the repository root.

If it fails:

1. capture the first real failure instead of shell noise
2. identify whether it is a frontend regression, backend truth drift, or test-stack cleanup issue
3. propose the narrowest follow-up fix
