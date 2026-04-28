export const REAL_TASK_SCENARIO_PACKS = [
  {
    id: 'web',
    scenarioIds: ['path-blog-greenfield', 'path-blog-followup'],
    qualityProfileId: 'web_experience',
    requiresStrongModel: false,
  },
  {
    id: 'docs-normalize',
    scenarioIds: ['docs-normalize-batch'],
    qualityProfileId: 'docs_normalize',
    requiresStrongModel: false,
    seedFiles: {
      'incoming/raw-product-notes.md': [
        '# raw product notes',
        '',
        'release theme: interactive elegance',
        '',
        '## scattered decisions',
        '',
        '- keep motion subtle',
        '- add author spotlight',
        '- related to content-roadmap and launch-retro',
      ].join('\n'),
      'incoming/content-roadmap draft.md': [
        '# Content roadmap draft',
        '',
        'owner: editorial',
        '',
        '### priorities',
        '',
        '1. weekly essays',
        '2. creator interviews',
        '3. visual notebook',
      ].join('\n'),
      'incoming/launch-retro.MD': [
        '# launch retro',
        '',
        'What worked:',
        '- readable layouts',
        '- fast navigation',
        '',
        'What changed after launch:',
        '- clarified subscription tone',
      ].join('\n'),
    },
  },
  {
    id: 'docs-synthesize',
    scenarioIds: ['docs-synthesize-handbook'],
    qualityProfileId: 'docs_synthesize',
    requiresStrongModel: false,
    seedFiles: {
      'source/product-strategy.md': [
        '# Product Strategy',
        '',
        '- Goal: calm but memorable publishing workflow',
        '- Constraint: keep onboarding friction low',
        '- Dependency: design system refresh',
      ].join('\n'),
      'source/ops-decisions.md': [
        '# Operations Decisions',
        '',
        '- Use weekly publishing cadence',
        '- Keep post templates lightweight',
        '- Add review checklist before launch',
      ].join('\n'),
      'source/editorial-feedback.md': [
        '# Editorial Feedback',
        '',
        '- Writers want better category guidance',
        '- Readers respond to strong visual rhythm',
        '- Archive pages need a clearer index',
      ].join('\n'),
    },
  },
  {
    id: 'system-audit',
    scenarioIds: ['system-health-audit'],
    qualityProfileId: 'system_audit',
    requiresStrongModel: false,
  },
  {
    id: 'desktop-observation',
    scenarioIds: ['desktop-ops-followup'],
    qualityProfileId: 'desktop_observation',
    requiresStrongModel: false,
  },
  {
    id: 'database-design',
    scenarioIds: ['database-near-mysql-design'],
    qualityProfileId: 'database_near_mysql_design',
    requiresStrongModel: true,
    seedFiles: {
      'brief/workload-profile.md': [
        '# Workload Profile',
        '',
        '- Target shape: MySQL-like OLTP for medium-complexity catalog, checkout, and order workloads.',
        '- Read/write mix: roughly 70/30 with short point reads, bounded range scans, and transactional writes.',
        '- Common access paths: primary-key lookups, secondary index lookups on tenant_id + created_at, and inventory updates.',
        '- Concurrency envelope: hundreds of concurrent sessions with contention around hot rows and short transactions.',
      ].join('\n'),
      'brief/mysql-targets.md': [
        '# MySQL Target Envelope',
        '',
        '- Aim for MySQL-like latency on common point reads and small transactional writes.',
        '- Keep the SQL surface intentionally narrower than MySQL; document every unsupported feature explicitly.',
        '- Optimize for predictable OLTP behavior, not for analytics or full MySQL feature parity.',
        '- Benchmark plan should track throughput, p95 latency, and degraded behavior under contention.',
      ].join('\n'),
      'brief/constraints.md': [
        '# Constraints',
        '',
        '- Produce a design package and a runnable Node.js prototype scaffold only.',
        '- Do not claim measured parity with MySQL.',
        '- Use synthetic benchmark scaffolding instead of external services or Docker.',
        '- Keep the prototype easy to inspect and runnable on Windows through local npm scripts.',
      ].join('\n'),
    },
  },
  {
    id: 'database-verify',
    scenarioIds: ['database-near-mysql-verify'],
    qualityProfileId: 'database_near_mysql_verify',
    requiresStrongModel: true,
    reuseWorkspace: {
      sourceScenarioId: 'database-near-mysql-design',
      source: 'latest_design_scenario_log',
      acceptArtifactNotes(notes) {
        return Boolean(notes?.hasRequiredDesignFiles) && Number(notes?.prototypeSrcFileCount ?? 0) > 0;
      },
    },
  },
];

export function getRealTaskScenarioPack(scenarioId) {
  return REAL_TASK_SCENARIO_PACKS.find((pack) => pack.scenarioIds.includes(scenarioId)) ?? null;
}

export function getScenarioQualityProfileId(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.qualityProfileId ?? null;
}

export function scenarioRequiresStrongLiveModel(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.requiresStrongModel === true;
}

export function getScenarioSeedFiles(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.seedFiles ?? null;
}

export function getScenarioReuseWorkspace(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.reuseWorkspace ?? null;
}
