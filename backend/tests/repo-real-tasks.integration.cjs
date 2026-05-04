const test = require('node:test');
const assert = require('node:assert/strict');
const { runRepoRealTaskSuite } = require('../dist');

test('repo real task suite validates actual repository task completion coverage', async () => {
  let report = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    report = await runRepoRealTaskSuite();
    if (report.status === 'achieved') {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  assert.equal(report.status, 'achieved');
  assert.equal(report.scenarios.length, 10);
  assert.equal(report.totals.total, 10);
  assert.equal(report.totals.passed, 10);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.artifactEvidencePassRate, 1);
  assert.equal(report.totals.byFamily['plan-build-split-task'], 1);
  assert.equal(report.totals.byFamily['provider-variant-task'], 1);
  assert.equal(report.totals.byFamily['mcp-readiness-gated-task'], 1);
  assert.equal(report.totals.byFamily['runtime-skill-integration-task'], 1);
  assert.equal(report.totals.byFamily['instruction-skill-guided-review'], 1);
  assert.equal(report.totals.byFamily['workspace-rule-review-task'], 1);
  assert.equal(report.totals.byFamily['permission-blocked-task'], 1);
  assert.equal(report.totals.byFamily['hook-observable-recovery-task'], 1);
  assert.equal(report.totals.byFamily['swebench-issue-resolution-task'], 1);
  assert.equal(report.totals.byFamily['subagent-specialized-review-task'], 1);

  const planBuild = report.scenarios.find((scenario) => scenario.family === 'plan-build-split-task');
  const providerVariant = report.scenarios.find((scenario) => scenario.family === 'provider-variant-task');
  const mcpReadiness = report.scenarios.find((scenario) => scenario.family === 'mcp-readiness-gated-task');
  const runtimeSkill = report.scenarios.find((scenario) => scenario.family === 'runtime-skill-integration-task');
  const instructionSkill = report.scenarios.find((scenario) => scenario.family === 'instruction-skill-guided-review');
  const workspaceRule = report.scenarios.find((scenario) => scenario.family === 'workspace-rule-review-task');
  const permissionBlocked = report.scenarios.find((scenario) => scenario.family === 'permission-blocked-task');
  const hookRecovery = report.scenarios.find((scenario) => scenario.family === 'hook-observable-recovery-task');
  const swebenchIssue = report.scenarios.find((scenario) => scenario.family === 'swebench-issue-resolution-task');
  const subagent = report.scenarios.find((scenario) => scenario.family === 'subagent-specialized-review-task');

  assert.ok(planBuild);
  assert.ok(providerVariant);
  assert.ok(mcpReadiness);
  assert.ok(runtimeSkill);
  assert.ok(instructionSkill);
  assert.ok(workspaceRule);
  assert.ok(permissionBlocked);
  assert.ok(hookRecovery);
  assert.ok(swebenchIssue);
  assert.ok(subagent);

  assert.equal(planBuild.artifactEvidence.verdict, 'passed');
  assert.equal(planBuild.executionSummary.stageDurations.length >= 3, true);

  assert.equal(providerVariant.artifactEvidence.verdict, 'passed');
  assert.equal(providerVariant.executionSummary.providerSummary.variantId, 'reasoning');
  assert.equal(providerVariant.executionSummary.providerSummary.readiness, 'ready');

  assert.equal(mcpReadiness.artifactEvidence.verdict, 'passed');
  assert.equal(mcpReadiness.executionSummary.mcpSummary.selectedTools.includes('mcp.real/summarize'), true);
  assert.equal(mcpReadiness.executionSummary.mcpSummary.selectedResources.includes('mcp.real/provider-guide'), true);
  assert.equal(mcpReadiness.executionSummary.mcpSummary.selectedPrompts.includes('mcp.real/review-prompt'), true);

  assert.equal(runtimeSkill.artifactEvidence.verdict, 'passed');
  assert.equal(runtimeSkill.executionSummary.skillSummary.recent[0].status, 'SUCCEEDED');

  assert.equal(instructionSkill.artifactEvidence.verdict, 'passed');
  assert.equal(instructionSkill.executionSummary.instructionSkillSummary.selectedCount, 1);
  assert.equal(instructionSkill.executionSummary.instructionSkillSummary.selected[0].name, 'ui-review-guidance');

  assert.equal(workspaceRule.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceRule.executionSummary.ruleSummary.matchedRuleNames.includes('provider-review'), true);

  assert.equal(permissionBlocked.artifactEvidence.verdict, 'passed');
  assert.equal(permissionBlocked.executionSummary.permissionSummary.approvalRequiredCount >= 1, true);

  assert.equal(hookRecovery.artifactEvidence.verdict, 'passed');
  assert.equal((hookRecovery.executionSummary.hookSummary.failedCount + hookRecovery.executionSummary.hookSummary.executedCount) >= 1, true);
  assert.equal(hookRecovery.executionSummary.mcpSummary.recent[0].status, 'FAILED');

  assert.equal(swebenchIssue.artifactEvidence.verdict, 'passed');
  assert.equal(swebenchIssue.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/issue-resolution.patch' && snapshot.exists), true);
  assert.equal(swebenchIssue.executionSummary.stageDurations.length >= 3, true);

  assert.equal(subagent.artifactEvidence.verdict, 'passed');
  assert.equal(subagent.executionSummary.agentSummary.selectedAgent, 'review');

  for (const scenario of report.scenarios) {
    assert.equal(scenario.finalLifecycleStatus, 'COMPLETED');
    assert.equal(scenario.executionSummary.queueRuntimeAlignment.consistent, true);
    assert.notEqual(scenario.issueCategory, 'unknown');
  }
});
