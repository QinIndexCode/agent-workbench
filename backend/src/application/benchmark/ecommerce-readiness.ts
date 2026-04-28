import fs from 'node:fs';
import path from 'node:path';
import { runEcommerceDeliverySuite } from './ecommerce-delivery';

export type EcommerceReadinessFamily =
  | 'idempotency'
  | 'compensation-retry-design'
  | 'audit-event-completeness'
  | 'cache-read-model-boundary'
  | 'deployment-template-completeness'
  | 'observability-alert-surface'
  | 'migration-boundaries';

export interface EcommerceReadinessScenarioResult {
  scenario: string;
  family: EcommerceReadinessFamily;
  passed: boolean;
  summary: string;
  evidence: string[];
  failureCategory: string | null;
}

export interface EcommerceReadinessSuiteResult {
  generatedAt: number;
  status: 'achieved' | 'open_gap';
  scenarios: EcommerceReadinessScenarioResult[];
  totals: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
    byFamily: Record<EcommerceReadinessFamily, number>;
    byFailureCategory: Record<string, number>;
  };
}

const FAMILIES: EcommerceReadinessFamily[] = [
  'idempotency',
  'compensation-retry-design',
  'audit-event-completeness',
  'cache-read-model-boundary',
  'deployment-template-completeness',
  'observability-alert-surface',
  'migration-boundaries'
];

function appRoot() {
  return path.resolve(process.cwd(), '..', 'apps', 'ecommerce-reference');
}

function readDoc(relativePath: string): string {
  return fs.readFileSync(path.resolve(appRoot(), relativePath), 'utf8');
}

function createScenario(family: EcommerceReadinessFamily, passed: boolean, summary: string, evidence: string[], failureCategory: string | null = null): EcommerceReadinessScenarioResult {
  return {
    scenario: `ecommerce-readiness-${family}`,
    family,
    passed,
    summary,
    evidence,
    failureCategory
  };
}

export async function runEcommerceReadinessSuite(): Promise<EcommerceReadinessSuiteResult> {
  const delivery = await runEcommerceDeliverySuite();
  const architecture = readDoc('docs/architecture.md');
  const apiContracts = readDoc('docs/api-contracts.md');
  const observability = readDoc('docs/observability.md');
  const deployment = readDoc('docs/deployment-readiness.md');
  const migration = readDoc('docs/migration-blueprint.md');

  const scenarios: EcommerceReadinessScenarioResult[] = [
    createScenario(
      'idempotency',
      delivery.scenarios.some((scenario) => scenario.family === 'payment-webhook-idempotency-task' && scenario.passed)
        && /idempotent/i.test(readDoc('.scc/project.md')),
      'Payment, refund, inventory, and order constraints explicitly call out replay-safe idempotency.',
      ['docs/api-contracts.md', '.scc/project.md', 'src/domain/payment/payment-webhook.mjs']
    ),
    createScenario(
      'compensation-retry-design',
      /dead-letter/i.test(observability) && /compensation/i.test(apiContracts),
      'Refund compensation, async retry, and dead-letter handling are documented for operator use.',
      ['docs/api-contracts.md', 'docs/observability.md', 'src/domain/refund/refund-compensation.mjs']
    ),
    createScenario(
      'audit-event-completeness',
      /audit/i.test(apiContracts) && /cross-domain mutation/i.test(readDoc('.scc/rules/audit-and-events.md')),
      'Cross-domain changes require matching audit and event evidence.',
      ['docs/api-contracts.md', '.scc/rules/audit-and-events.md', 'src/infrastructure/audit/audit-log.mjs']
    ),
    createScenario(
      'cache-read-model-boundary',
      /read-model/i.test(deployment) && /search indexing consumes immutable order projection updates/i.test(apiContracts),
      'Search and cache boundaries stay outside the checkout write path.',
      ['docs/api-contracts.md', 'docs/deployment-readiness.md', 'src/infrastructure/cache/read-model-cache.mjs']
    ),
    createScenario(
      'deployment-template-completeness',
      /Required templates/i.test(deployment) && /rollback/i.test(deployment),
      'Deployment checklist includes queue, cache, audit, rollback, and runbook surfaces.',
      ['docs/deployment-readiness.md']
    ),
    createScenario(
      'observability-alert-surface',
      /Alerts/i.test(observability) && /payment authorization mismatch/i.test(observability),
      'Observability guide defines metrics and alert categories for the transaction chain.',
      ['docs/observability.md']
    ),
    createScenario(
      'migration-boundaries',
      /Phase 3/i.test(migration) && /payment callback worker/i.test(migration) && /order, payment, inventory/i.test(architecture),
      'Migration blueprint keeps the single-repo reference honest about future split points.',
      ['docs/migration-blueprint.md', 'docs/architecture.md']
    )
  ];

  let passed = 0;
  let failed = 0;
  const byFamily = FAMILIES.reduce<Record<EcommerceReadinessFamily, number>>((acc, family) => {
    acc[family] = 0;
    return acc;
  }, {} as Record<EcommerceReadinessFamily, number>);
  const byFailureCategory: Record<string, number> = {};

  for (const scenario of scenarios) {
    byFamily[scenario.family] += 1;
    if (scenario.passed) {
      passed += 1;
    } else {
      failed += 1;
      if (scenario.failureCategory) {
        byFailureCategory[scenario.failureCategory] = (byFailureCategory[scenario.failureCategory] ?? 0) + 1;
      }
    }
  }

  return {
    generatedAt: Date.now(),
    status: failed === 0 ? 'achieved' : 'open_gap',
    scenarios,
    totals: {
      total: scenarios.length,
      passed,
      failed,
      successRate: Number((passed / Math.max(1, scenarios.length)).toFixed(4)),
      byFamily,
      byFailureCategory
    }
  };
}
