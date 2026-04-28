# Release Checklist

Use this checklist to coordinate the release process. Each section covers a distinct phase.

## Before Release

- [ ] Confirm all acceptance criteria are met and signed off by the responsible owners.
- [ ] Verify the release notes are complete, accurate, and reviewed.
- [ ] Ensure the deployment target environment is provisioned and accessible.
- [ ] Validate that the queue is healthy and `queueReady=true` before proceeding.
- [ ] Confirm the heartbeat endpoint is responding and reporting expected status.
- [ ] Back up any configuration or state that may need rollback.
- [ ] Notify stakeholders of the planned release window.
- [ ] Run the full test suite and confirm zero critical failures.

## During Release

- [ ] Execute the deployment steps in the documented order.
- [ ] Monitor the heartbeat signal continuously throughout the rollout.
- [ ] Watch queue health indicators; confirm `queueReady=true` remains stable.
- [ ] Verify each service instance registers successfully after deployment.
- [ ] Check application logs for errors or unexpected warnings.
- [ ] Perform smoke tests against the deployed environment.
- [ ] If any step fails, execute the rollback plan immediately.

## After Release

- [ ] Confirm all services are healthy and the heartbeat is reporting nominal.
- [ ] Verify `queueReady=true` in the post-deployment health check.
- [ ] Run regression tests against the live environment.
- [ ] Update the release log with deployment time, version, and outcome.
- [ ] Communicate release completion to stakeholders.
- [ ] Archive release artifacts and close the release ticket.
- [ ] Schedule a post-release review if any issues were encountered.
