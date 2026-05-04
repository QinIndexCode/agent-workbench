const test = require('node:test');
const assert = require('node:assert/strict');
const {
  runEcommerceDeliverySuite,
  runEcommerceReadinessSuite,
} = require('../dist');

test('ecommerce delivery suite validates a layered full-chain commerce reference workspace', async () => {
  const report = await runEcommerceDeliverySuite();

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.total, 12);
  assert.equal(report.totals.passed, 12);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.artifactEvidencePassRate, 1);
  assert.equal(report.manualAudit.status, 'achieved');
  assert.equal(report.manualAudit.passed, 12);
  assert.equal(report.manualAudit.failed, 0);
  assert.equal(report.totals.byFamily['payment-webhook-idempotency-task'], 1);
  assert.equal(report.totals.byFamily['deployment-readiness-task'], 1);

  const payment = report.scenarios.find((scenario) => scenario.family === 'payment-webhook-idempotency-task');
  const inventory = report.scenarios.find((scenario) => scenario.family === 'inventory-reservation-task');
  const admin = report.scenarios.find((scenario) => scenario.family === 'admin-operator-workflow-task');

  assert.ok(payment);
  assert.ok(inventory);
  assert.ok(admin);

  assert.equal(payment.artifactEvidence.verdict, 'passed');
  assert.equal(payment.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'src/domain/payment/payment-webhook.mjs' && snapshot.exists), true);
  assert.equal(inventory.diagnostics.artifactSnapshots.some((snapshot) => snapshot.path === 'src/domain/inventory/reservation-ledger.mjs' && snapshot.exists), true);
  assert.equal(admin.manualAudit.verdict, 'passed');
});

test('ecommerce readiness suite validates high-volume delivery prerequisites', async () => {
  const report = await runEcommerceReadinessSuite();

  assert.equal(report.status, 'achieved');
  assert.equal(report.totals.total, 7);
  assert.equal(report.totals.passed, 7);
  assert.equal(report.totals.failed, 0);
  assert.equal(report.totals.successRate, 1);
  assert.equal(report.totals.byFamily['idempotency'], 1);
  assert.equal(report.totals.byFamily['migration-boundaries'], 1);
});
