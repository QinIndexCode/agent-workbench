const test = require('node:test');
const assert = require('node:assert/strict');
const { runTaskGeneralComplexScenarioSuite } = require('../dist');

async function runStableGeneralComplexScenarioSuite() {
  const first = await runTaskGeneralComplexScenarioSuite();
  if (first.status === 'achieved') {
    return first;
  }
  return runTaskGeneralComplexScenarioSuite();
}

test('general complex scenario suite validates broader engineering task families', async () => {
  const report = await runStableGeneralComplexScenarioSuite();
  const failedScenarios = report.scenarios
    .filter((scenario) => !scenario.passed)
    .map((scenario) => `${scenario.scenario}:${scenario.artifactEvidence.failureCategory ?? 'unknown'}`);

  assert.equal(report.status, 'achieved', failedScenarios.join(', '));
  assert.equal(report.scenarios.length, 31);
  assert.equal(report.totals.total, 31);
  assert.equal(report.totals.passed, 31);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.artifactEvidencePassRate, 1);
  assert.equal(report.totals.byFamily['config-migration'], 1);
  assert.equal(report.totals.byFamily['script-repair'], 1);
  assert.equal(report.totals.byFamily['data-transformation'], 1);
  assert.equal(report.totals.byFamily['workspace-maintenance'], 1);
  assert.equal(report.totals.byFamily['long-running-correction-churn'], 1);
  assert.equal(report.totals.byFamily['checkpoint-recovery-task'], 1);
  assert.equal(report.totals.byFamily['provider-failure-streak-task'], 1);
  assert.equal(report.totals.byFamily['extension-failure-stability-task'], 1);
  assert.equal(report.totals.byFamily['workspace-bootstrap'], 1);
  assert.equal(report.totals.byFamily['workspace-docs-import'], 1);
  assert.equal(report.totals.byFamily['workspace-command-driven-task'], 1);
  assert.equal(report.totals.byFamily['workspace-index-rebuild'], 1);
  assert.equal(report.totals.byFamily['workspace-bulk-maintenance'], 1);
  assert.equal(report.totals.byFamily['rule-constrained-implementation'], 1);
  assert.equal(report.totals.byFamily['hook-observable-task'], 1);
  assert.equal(report.totals.byFamily['agent-assisted-review'], 1);
  assert.equal(report.totals.byFamily['workspace-command-with-doc-memory'], 1);
  assert.equal(report.totals.byFamily['skill-driven-task'], 1);
  assert.equal(report.totals.byFamily['mcp-tool-assisted-task'], 1);
  assert.equal(report.totals.byFamily['skill-failure-diagnostics'], 1);
  assert.equal(report.totals.byFamily['mcp-failure-recovery'], 1);
  assert.equal(report.totals.byFamily['instruction-skill-guided-task'], 1);
  assert.equal(report.totals.byFamily['instruction-skill-with-assets'], 1);
  assert.equal(report.totals.byFamily['mixed-runtime-and-instruction-skill-task'], 1);
  assert.equal(report.totals.byFamily['diagnostic-triage'], 1);
  assert.equal(report.totals.byFamily['policy-sensitive-change'], 1);
  assert.equal(report.totals.byFamily['rich-doc-output'], 1);
  assert.equal(report.totals.byFamily['complex-docs-bundle'], 1);
  assert.equal(report.totals.byFamily['decision-log-synthesis'], 1);
  assert.equal(report.totals.byFamily['decision-doc-from-imported-sources'], 1);
  assert.equal(report.totals.byFamily['multi-artifact-bundle'], 1);

  const configMigration = report.scenarios.find((scenario) => scenario.scenario === 'general-config-migration');
  const workspaceBootstrap = report.scenarios.find((scenario) => scenario.scenario === 'general-workspace-bootstrap');
  const correctionChurn = report.scenarios.find((scenario) => scenario.scenario === 'general-long-running-correction-churn');
  const checkpointRecovery = report.scenarios.find((scenario) => scenario.scenario === 'general-checkpoint-recovery-task');
  const providerFailureStreak = report.scenarios.find((scenario) => scenario.scenario === 'general-provider-failure-streak-task');
  const extensionFailureStability = report.scenarios.find((scenario) => scenario.scenario === 'general-extension-failure-stability-task');
  const workspaceDocsImport = report.scenarios.find((scenario) => scenario.scenario === 'general-workspace-docs-import');
  const workspaceCommandDriven = report.scenarios.find((scenario) => scenario.scenario === 'general-workspace-command-driven-task');
  const ruleConstrained = report.scenarios.find((scenario) => scenario.scenario === 'general-rule-constrained-implementation');
  const hookObservable = report.scenarios.find((scenario) => scenario.scenario === 'general-hook-observable-task');
  const agentAssistedReview = report.scenarios.find((scenario) => scenario.scenario === 'general-agent-assisted-review');
  const workspaceCommandWithDocMemory = report.scenarios.find((scenario) => scenario.scenario === 'general-workspace-command-with-doc-memory');
  const skillDrivenTask = report.scenarios.find((scenario) => scenario.scenario === 'general-skill-driven-task');
  const mcpToolAssistedTask = report.scenarios.find((scenario) => scenario.scenario === 'general-mcp-tool-assisted-task');
  const skillFailureDiagnostics = report.scenarios.find((scenario) => scenario.scenario === 'general-skill-failure-diagnostics');
  const mcpFailureRecovery = report.scenarios.find((scenario) => scenario.scenario === 'general-mcp-failure-recovery');
  const instructionSkillGuided = report.scenarios.find((scenario) => scenario.scenario === 'general-instruction-skill-guided-task');
  const instructionSkillAssets = report.scenarios.find((scenario) => scenario.scenario === 'general-instruction-skill-with-assets');
  const mixedSkillTask = report.scenarios.find((scenario) => scenario.scenario === 'general-mixed-runtime-and-instruction-skill-task');
  const policySensitive = report.scenarios.find((scenario) => scenario.scenario === 'general-policy-sensitive-change');
  const richDoc = report.scenarios.find((scenario) => scenario.scenario === 'general-rich-doc-output');
  const workspaceIndexRebuild = report.scenarios.find((scenario) => scenario.scenario === 'general-workspace-index-rebuild');
  const complexDocsBundle = report.scenarios.find((scenario) => scenario.scenario === 'general-complex-docs-bundle');
  const decisionLogSynthesis = report.scenarios.find((scenario) => scenario.scenario === 'general-decision-log-synthesis');
  const importedDecisionDoc = report.scenarios.find((scenario) => scenario.scenario === 'general-decision-doc-from-imported-sources');

  assert.ok(configMigration);
  assert.ok(workspaceBootstrap);
  assert.ok(correctionChurn);
  assert.ok(checkpointRecovery);
  assert.ok(providerFailureStreak);
  assert.ok(extensionFailureStability);
  assert.ok(workspaceDocsImport);
  assert.ok(workspaceCommandDriven);
  assert.ok(ruleConstrained);
  assert.ok(hookObservable);
  assert.ok(agentAssistedReview);
  assert.ok(workspaceCommandWithDocMemory);
  assert.ok(skillDrivenTask);
  assert.ok(mcpToolAssistedTask);
  assert.ok(skillFailureDiagnostics);
  assert.ok(mcpFailureRecovery);
  assert.ok(instructionSkillGuided);
  assert.ok(instructionSkillAssets);
  assert.ok(mixedSkillTask);
  assert.ok(policySensitive);
  assert.ok(richDoc);
  assert.ok(workspaceIndexRebuild);
  assert.ok(complexDocsBundle);
  assert.ok(decisionLogSynthesis);
  assert.ok(importedDecisionDoc);

  assert.equal(configMigration.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceBootstrap.artifactEvidence.verdict, 'passed');
  assert.equal(correctionChurn.artifactEvidence.verdict, 'passed');
  assert.equal(checkpointRecovery.artifactEvidence.verdict, 'passed');
  assert.equal(providerFailureStreak.artifactEvidence.verdict, 'passed');
  assert.equal(extensionFailureStability.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceDocsImport.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceCommandDriven.artifactEvidence.verdict, 'passed');
  assert.equal(ruleConstrained.artifactEvidence.verdict, 'passed');
  assert.equal(hookObservable.artifactEvidence.verdict, 'passed');
  assert.equal(agentAssistedReview.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceCommandWithDocMemory.artifactEvidence.verdict, 'passed');
  assert.equal(skillDrivenTask.artifactEvidence.verdict, 'passed');
  assert.equal(mcpToolAssistedTask.artifactEvidence.verdict, 'passed');
  assert.equal(skillFailureDiagnostics.artifactEvidence.verdict, 'passed');
  assert.equal(mcpFailureRecovery.artifactEvidence.verdict, 'passed');
  assert.equal(instructionSkillGuided.artifactEvidence.verdict, 'passed');
  assert.equal(instructionSkillAssets.artifactEvidence.verdict, 'passed');
  assert.equal(mixedSkillTask.artifactEvidence.verdict, 'passed');
  assert.equal(policySensitive.artifactEvidence.verdict, 'passed');
  assert.equal(richDoc.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceIndexRebuild.artifactEvidence.verdict, 'passed');
  assert.equal(complexDocsBundle.artifactEvidence.verdict, 'passed');
  assert.equal(decisionLogSynthesis.artifactEvidence.verdict, 'passed');
  assert.equal(importedDecisionDoc.artifactEvidence.verdict, 'passed');
  assert.equal(workspaceBootstrap.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === '.scc/project.md' && snapshot.exists), true);
  assert.equal(correctionChurn.executionSummary.correctionDepth >= 2, true);
  assert.equal(checkpointRecovery.executionSummary.lastSafeCheckpointAt !== null, true);
  assert.equal(providerFailureStreak.executionSummary.providerFailureStreak >= 2, true);
  assert.equal(extensionFailureStability.executionSummary.skillFailureStreak >= 1, true);
  assert.equal(extensionFailureStability.executionSummary.mcpFailureStreak >= 1, true);
  assert.equal(workspaceDocsImport.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/workspace-docs-import.md' && snapshot.exists), true);
  assert.equal(workspaceCommandDriven.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/ship-check.json' && snapshot.exists), true);
  assert.equal(ruleConstrained.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'src/service.cjs' && snapshot.exists), true);
  assert.equal(hookObservable.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/hook-status.md' && snapshot.exists), true);
  assert.equal(
    hookObservable.executionSummary.hookSummary.failedCount >= 1
      || hookObservable.executionSummary.hookSummary.executedCount >= 1,
    true
  );
  assert.equal(agentAssistedReview.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/review-findings.md' && snapshot.exists), true);
  assert.equal(workspaceCommandWithDocMemory.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/ship-check.json' && snapshot.exists), true);
  assert.equal(skillDrivenTask.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/skill-output.md' && snapshot.exists), true);
  assert.equal(mcpToolAssistedTask.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/mcp-output.json' && snapshot.exists), true);
  assert.equal(skillFailureDiagnostics.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/skill-failure.md' && snapshot.exists), true);
  assert.equal(mcpFailureRecovery.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/mcp-fallback.md' && snapshot.exists), true);
  assert.equal(instructionSkillGuided.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/instruction-guided.md' && snapshot.exists), true);
  assert.equal(instructionSkillAssets.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/asset-guided.md' && snapshot.exists), true);
  assert.equal(mixedSkillTask.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/mixed-skill.md' && snapshot.exists), true);
  assert.equal(policySensitive.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'policies/restricted.json' && snapshot.exists), true);
  assert.equal(richDoc.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'docs/overview.html' && snapshot.exists), true);
  assert.equal(workspaceIndexRebuild.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'workspace/index.json' && snapshot.exists), true);
  assert.equal(complexDocsBundle.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'docs/toc.json' && snapshot.exists), true);
  assert.equal(decisionLogSynthesis.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/decision-log.json' && snapshot.exists), true);
  assert.equal(importedDecisionDoc.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'reports/imported-decision-actions.json' && snapshot.exists), true);
});
