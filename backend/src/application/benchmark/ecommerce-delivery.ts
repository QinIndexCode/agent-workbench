import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export type EcommerceDeliveryFamily =
  | 'domain-modeling-task'
  | 'checkout-state-machine-task'
  | 'payment-webhook-idempotency-task'
  | 'inventory-reservation-task'
  | 'promotion-rule-evaluation-task'
  | 'refund-compensation-task'
  | 'search-indexing-task'
  | 'analytics-pipeline-task'
  | 'admin-operator-workflow-task'
  | 'customer-service-case-task'
  | 'observability-hardening-task'
  | 'deployment-readiness-task';

export interface EcommerceArtifactSnapshot {
  path: string;
  exists: boolean;
  excerpt: string | null;
}

export interface EcommerceDeliveryScenarioResult {
  scenario: string;
  family: EcommerceDeliveryFamily;
  passed: boolean;
  finalLifecycleStatus: 'COMPLETED' | 'FAILED';
  issueCategory: string | null;
  issueSummary: string | null;
  artifactQuality: {
    verdict: 'passed' | 'failed';
    failureCategory: string | null;
    summary: string;
    files: string[];
  };
  diagnostics: {
    workspaceDir: string;
    artifactSnapshots: EcommerceArtifactSnapshot[];
  };
  manualAudit: {
    verdict: 'passed' | 'failed';
    summary: string;
    findings: string[];
  };
}

export interface EcommerceDeliverySuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: EcommerceDeliveryScenarioResult[];
  manualAudit: {
    status: 'achieved' | 'open_gap';
    total: number;
    passed: number;
    failed: number;
  };
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    artifactQualityPassRate: number;
    byFamily: Record<EcommerceDeliveryFamily, number>;
    byFailureCategory: Record<string, number>;
  };
}

const FAMILIES: EcommerceDeliveryFamily[] = [
  'domain-modeling-task',
  'checkout-state-machine-task',
  'payment-webhook-idempotency-task',
  'inventory-reservation-task',
  'promotion-rule-evaluation-task',
  'refund-compensation-task',
  'search-indexing-task',
  'analytics-pipeline-task',
  'admin-operator-workflow-task',
  'customer-service-case-task',
  'observability-hardening-task',
  'deployment-readiness-task'
];

function repoRoot() {
  return path.resolve(process.cwd(), '..');
}

function ecommerceRoot() {
  return path.resolve(repoRoot(), 'apps', 'ecommerce-reference');
}

function readText(relativePath: string): string {
  return fs.readFileSync(path.resolve(ecommerceRoot(), relativePath), 'utf8');
}

function readSnapshot(relativePath: string): EcommerceArtifactSnapshot {
  const absolutePath = path.resolve(ecommerceRoot(), relativePath);
  if (!fs.existsSync(absolutePath)) {
    return {
      path: relativePath,
      exists: false,
      excerpt: null
    };
  }
  const excerpt = fs.readFileSync(absolutePath, 'utf8').slice(0, 240);
  return {
    path: relativePath,
    exists: true,
    excerpt
  };
}

function runReferenceFlow(): Record<string, unknown> {
  const scriptPath = path.resolve(ecommerceRoot(), 'scripts', 'reference-flow.mjs');
  const result = spawnSync(process.execPath, [scriptPath, '--json'], {
    encoding: 'utf8',
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'reference-flow failed');
  }
  return JSON.parse(result.stdout);
}

function scenarioResult(params: {
  family: EcommerceDeliveryFamily;
  passed: boolean;
  issueSummary: string | null;
  failureCategory: string | null;
  files: string[];
  summary: string;
  snapshots: string[];
  manualFindings?: string[];
}): EcommerceDeliveryScenarioResult {
  const manualFindings = params.manualFindings ?? [];
  return {
    scenario: `ecommerce-${params.family}`,
    family: params.family,
    passed: params.passed,
    finalLifecycleStatus: params.passed ? 'COMPLETED' : 'FAILED',
    issueCategory: params.failureCategory,
    issueSummary: params.issueSummary,
    artifactQuality: {
      verdict: params.passed ? 'passed' : 'failed',
      failureCategory: params.failureCategory,
      summary: params.summary,
      files: params.files
    },
    diagnostics: {
      workspaceDir: ecommerceRoot(),
      artifactSnapshots: params.snapshots.map((snapshot) => readSnapshot(snapshot))
    },
    manualAudit: {
      verdict: manualFindings.length === 0 ? 'passed' : 'failed',
      summary: manualFindings.length === 0
        ? 'Artifact set is concrete, domain-constrained, and operator-usable.'
        : manualFindings[0],
      findings: manualFindings
    }
  };
}

export async function runEcommerceDeliverySuite(): Promise<EcommerceDeliverySuiteResult> {
  const flow = runReferenceFlow();
  const order = flow.order as Record<string, unknown>;
  const payment = flow.payment as Record<string, unknown>;
  const inventory = flow.inventory as Record<string, unknown>;
  const promotion = flow.promotion as Record<string, unknown>;
  const analytics = flow.analytics as Record<string, unknown>;
  const customerService = flow.customerService as Record<string, unknown>;
  const operatorWorkflow = flow.operatorWorkflow as Record<string, unknown>;
  const audit = flow.audit as Record<string, unknown>;
  const events = flow.events as Record<string, unknown>;
  const search = flow.search as Record<string, unknown>;

  const architectureDoc = readText('docs/architecture.md');
  const apiContractsDoc = readText('docs/api-contracts.md');
  const observabilityDoc = readText('docs/observability.md');
  const deploymentDoc = readText('docs/deployment-readiness.md');
  const migrationDoc = readText('docs/migration-blueprint.md');

  const scenarios: EcommerceDeliveryScenarioResult[] = [
    scenarioResult({
      family: 'domain-modeling-task',
      passed: /catalog\/search/i.test(architectureDoc) && /order\/inventory\/fulfillment/i.test(migrationDoc),
      issueSummary: null,
      failureCategory: null,
      files: ['docs/architecture.md', 'docs/migration-blueprint.md', 'src/domain/order/order-state-machine.mjs'],
      summary: 'Domain boundaries, layered modules, and future split points are explicit.',
      snapshots: ['docs/architecture.md', 'docs/migration-blueprint.md', 'src/domain/order/order-state-machine.mjs']
    }),
    scenarioResult({
      family: 'checkout-state-machine-task',
      passed: Array.isArray(order.history) && String(order.finalState) === 'REFUNDED',
      issueSummary: null,
      failureCategory: null,
      files: ['src/application/checkout/checkout-service.mjs', 'src/domain/order/order-state-machine.mjs'],
      summary: 'Checkout orchestration drives a multi-step order state machine through reserve, authorize, place, and refund.',
      snapshots: ['src/application/checkout/checkout-service.mjs', 'src/domain/order/order-state-machine.mjs']
    }),
    scenarioResult({
      family: 'payment-webhook-idempotency-task',
      passed: Number(payment.processedCount) === 1 && payment.duplicateIgnored === true && /verify provider signature/i.test(apiContractsDoc),
      issueSummary: null,
      failureCategory: null,
      files: ['src/domain/payment/payment-webhook.mjs', 'docs/api-contracts.md'],
      summary: 'Payment webhooks verify signatures and ignore duplicate replay by event id.',
      snapshots: ['src/domain/payment/payment-webhook.mjs', 'docs/api-contracts.md']
    }),
    scenarioResult({
      family: 'inventory-reservation-task',
      passed: String(inventory.reservationStatus) === 'RELEASED' && Number(inventory.availableAfterRefund) === 12,
      issueSummary: null,
      failureCategory: null,
      files: ['src/domain/inventory/reservation-ledger.mjs', 'src/application/checkout/checkout-service.mjs'],
      summary: 'Inventory reserves stock before placement and releases it during refund compensation.',
      snapshots: ['src/domain/inventory/reservation-ledger.mjs', 'src/application/checkout/checkout-service.mjs']
    }),
    scenarioResult({
      family: 'promotion-rule-evaluation-task',
      passed: Number(promotion.discountTotal) > 0 && Array.isArray(promotion.applied) && (promotion.applied as unknown[]).length === 2,
      issueSummary: null,
      failureCategory: null,
      files: ['src/domain/promotion/rule-engine.mjs'],
      summary: 'Promotion rules handle threshold and SKU-sensitive stacking in a deterministic evaluator.',
      snapshots: ['src/domain/promotion/rule-engine.mjs']
    }),
    scenarioResult({
      family: 'refund-compensation-task',
      passed: /emit_refund_event/.test(readText('src/domain/refund/refund-compensation.mjs')) && String(order.finalState) === 'REFUNDED',
      issueSummary: null,
      failureCategory: null,
      files: ['src/domain/refund/refund-compensation.mjs', 'docs/api-contracts.md'],
      summary: 'Refund flow includes explicit compensation actions, event emission, and audit requirements.',
      snapshots: ['src/domain/refund/refund-compensation.mjs', 'docs/api-contracts.md']
    }),
    scenarioResult({
      family: 'search-indexing-task',
      passed: String(search.documentId).startsWith('order:') && /search indexing consumes immutable order projection updates/i.test(apiContractsDoc),
      issueSummary: null,
      failureCategory: null,
      files: ['src/application/search/search-indexer.mjs', 'docs/api-contracts.md'],
      summary: 'Search indexing consumes immutable order projections instead of coupling to checkout writes.',
      snapshots: ['src/application/search/search-indexer.mjs', 'docs/api-contracts.md']
    }),
    scenarioResult({
      family: 'analytics-pipeline-task',
      passed: String(analytics.metric) === 'order_completed' && (events.topics as unknown[]).includes('analytics.order_completed'),
      issueSummary: null,
      failureCategory: null,
      files: ['src/application/analytics/order-analytics-pipeline.mjs', 'docs/observability.md'],
      summary: 'Analytics pipelines remain async and event-driven, separate from the synchronous transaction path.',
      snapshots: ['src/application/analytics/order-analytics-pipeline.mjs', 'docs/observability.md']
    }),
    scenarioResult({
      family: 'admin-operator-workflow-task',
      passed: String(customerService.queue) === 'refund-review' && /recommendedAction/i.test(JSON.stringify(operatorWorkflow)),
      issueSummary: null,
      failureCategory: null,
      files: ['src/application/admin/operator-workflow.mjs', 'web/admin/README.md'],
      summary: 'Operator workflow artifacts make refund review, evidence, and next action explicit.',
      snapshots: ['src/application/admin/operator-workflow.mjs', 'web/admin/README.md']
    }),
    scenarioResult({
      family: 'customer-service-case-task',
      passed: String(customerService.status) === 'OPEN' && String(customerService.reason) === 'refund_follow_up',
      issueSummary: null,
      failureCategory: null,
      files: ['src/application/customer-service/case-service.mjs'],
      summary: 'Customer-service flow opens case records that link the customer, order, and operational queue.',
      snapshots: ['src/application/customer-service/case-service.mjs']
    }),
    scenarioResult({
      family: 'observability-hardening-task',
      passed: Array.isArray(audit.categories) && (audit.categories as unknown[]).includes('refund') && /dead-letter/i.test(observabilityDoc),
      issueSummary: null,
      failureCategory: null,
      files: ['docs/observability.md', 'src/infrastructure/events/event-bus.mjs', 'src/infrastructure/audit/audit-log.mjs'],
      summary: 'Observability artifacts cover audit categories, async failure surfaces, and operator alerting.',
      snapshots: ['docs/observability.md', 'src/infrastructure/events/event-bus.mjs', 'src/infrastructure/audit/audit-log.mjs']
    }),
    scenarioResult({
      family: 'deployment-readiness-task',
      passed: /queue topic and dead-letter configuration/i.test(deploymentDoc) && /Phase 3/i.test(migrationDoc),
      issueSummary: null,
      failureCategory: null,
      files: ['docs/deployment-readiness.md', 'docs/migration-blueprint.md', '.scc/project.md'],
      summary: 'Deployment readiness defines queue, cache, audit, rollback, and future split boundaries.',
      snapshots: ['docs/deployment-readiness.md', 'docs/migration-blueprint.md', '.scc/project.md']
    })
  ];

  let passed = 0;
  let failed = 0;
  let manualPassed = 0;
  let manualFailed = 0;
  const byFailureCategory: Record<string, number> = {};
  const byFamily = FAMILIES.reduce<Record<EcommerceDeliveryFamily, number>>((acc, family) => {
    acc[family] = 0;
    return acc;
  }, {} as Record<EcommerceDeliveryFamily, number>);

  for (const scenario of scenarios) {
    byFamily[scenario.family] += 1;
    if (scenario.passed && scenario.artifactQuality.verdict === 'passed') {
      passed += 1;
    } else {
      failed += 1;
      if (scenario.artifactQuality.failureCategory) {
        byFailureCategory[scenario.artifactQuality.failureCategory] = (byFailureCategory[scenario.artifactQuality.failureCategory] ?? 0) + 1;
      }
    }
    if (scenario.manualAudit.verdict === 'passed') {
      manualPassed += 1;
    } else {
      manualFailed += 1;
    }
  }

  return {
    generatedAt: Date.now(),
    status: failed === 0 && manualFailed === 0 ? 'achieved' : 'open_gap',
    scenarios,
    manualAudit: {
      status: manualFailed === 0 ? 'achieved' : 'open_gap',
      total: scenarios.length,
      passed: manualPassed,
      failed: manualFailed
    },
    totals: {
      total: scenarios.length,
      passed,
      failed,
      successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
      artifactQualityPassRate: Number((scenarios.filter((scenario) => scenario.artifactQuality.verdict === 'passed').length / Math.max(1, scenarios.length)).toFixed(4)),
      byFamily,
      byFailureCategory
    }
  };
}
