import fs from 'node:fs/promises';
import path from 'node:path';

export const DATABASE_LAB_RULES = (() => {
  const root = 'database-lab';
  const designDir = `${root}/design`;
  const prototypeDir = `${root}/prototype`;
  const requiredDesignFiles = [
    `${designDir}/README.md`,
    `${designDir}/architecture.md`,
    `${designDir}/storage-engine.md`,
    `${designDir}/sql-compatibility.md`,
    `${designDir}/benchmark-plan.md`,
  ];
  const requiredPrototypeFiles = [
    `${prototypeDir}/package.json`,
    `${prototypeDir}/README.md`,
    `${prototypeDir}/scripts/bench.js`,
  ];
  const benchRequiredModuleFiles = [
    `${prototypeDir}/src/storage-engine.js`,
    `${prototypeDir}/src/buffer-pool.js`,
    `${prototypeDir}/src/b-plus-tree-index.js`,
    `${prototypeDir}/src/wal-manager.js`,
    `${prototypeDir}/src/transaction-manager.js`,
  ];

  return {
    root,
    designDir,
    prototypeDir,
    requiredDesignFiles,
    requiredPrototypeFiles,
    benchRequiredModuleFiles,
    defaultPrototypeSrcFiles: [...benchRequiredModuleFiles],
    canonicalModuleAliases: [
      [`${prototypeDir}/src/b-plus-tree.js`, `${prototypeDir}/src/b-plus-tree-index.js`],
      [`${prototypeDir}/src/wal.js`, `${prototypeDir}/src/wal-manager.js`],
    ],
    prototypeStackTargets: [
      `${prototypeDir}/scripts/bench.js`,
      ...benchRequiredModuleFiles,
    ],
    designTopicGroups: {
      1: {
        label: 'storage/page/segment',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/storage-engine.md`,
        ],
      },
      2: {
        label: 'index/btree/hash',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/sql-compatibility.md`,
        ],
      },
      3: {
        label: 'transaction/concurrency/lock/mvcc',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/storage-engine.md`,
        ],
      },
      4: {
        label: 'wal/recovery/checkpoint',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/storage-engine.md`,
          `${designDir}/benchmark-plan.md`,
        ],
      },
      5: {
        label: 'buffer/cache',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/storage-engine.md`,
        ],
      },
      6: {
        label: 'sql/parser/planner',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/sql-compatibility.md`,
        ],
      },
      7: {
        label: 'benchmark/latency/throughput/tps',
        docs: [
          `${designDir}/README.md`,
          `${designDir}/architecture.md`,
          `${designDir}/benchmark-plan.md`,
        ],
      },
    },
    designQualityFile: 'quality/database-design.json',
    verifyQualityFile: 'quality/database-benchmark-result.json',
    benchResultFile: `${prototypeDir}/results/bench-dry-run.json`,
  };
})();

const DATABASE_LAB_CANONICAL_MODULE_ALIAS_MAP = new Map(DATABASE_LAB_RULES.canonicalModuleAliases);

const SCENARIO_REQUIRED_OUTPUT_FILES = new Map([
  ['docs-normalize-batch', [
    'normalized/index.md',
    'normalized/product-notes.md',
    'normalized/content-roadmap.md',
    'normalized/launch-retro.md',
  ]],
  ['docs-synthesize-handbook', [
    'handbook/README.md',
    'handbook/index.md',
    'handbook/summary.md',
    'handbook/decision-log.md',
  ]],
  ['system-health-audit', [
    'reports/system-health.md',
    'quality/system-audit.json',
  ]],
]);

export function canonicalizeDatabasePrototypeModulePath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    return relativePath;
  }
  return DATABASE_LAB_CANONICAL_MODULE_ALIAS_MAP.get(relativePath) ?? relativePath;
}

export function getDatabasePrototypePathsMentionedInText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return [];
  }
  const prototypeDir = DATABASE_LAB_RULES.prototypeDir;
  const prototypeStackTargets = DATABASE_LAB_RULES.prototypeStackTargets;
  const normalized = text.replace(/\\/g, '/');
  const paths = new Set();
  const regex = /database-lab\/prototype\/(?:scripts\/bench\.js|src\/[A-Za-z0-9._-]+\.js)/g;
  for (const match of normalized.matchAll(regex)) {
    const relativePath = canonicalizeDatabasePrototypeModulePath(match[0]);
    if (prototypeStackTargets.includes(relativePath)) {
      paths.add(relativePath);
    }
  }
  const stackText = normalized;
  const addIf = (pattern, relativePath) => {
    if (pattern.test(stackText)) {
      paths.add(relativePath);
    }
  };
  addIf(/(?:StorageEngine|storage|engine)\.(?:open|init|initialize|readPage|writePage|createFile)|StorageEngine\.|storage-engine\.js/i, `${prototypeDir}/src/storage-engine.js`);
  addIf(/(?:BufferPool|bufferPool|pool)\.(?:open|init|initialize|getPage|putPage|readPage|writePage)|BufferPool\.|buffer-pool\.js/i, `${prototypeDir}/src/buffer-pool.js`);
  addIf(/(?:WALManager|wal)\.(?:open|init|initialize|append|appendEntry|close|getFlushCount)|WALManager\.|wal-manager\.js/i, `${prototypeDir}/src/wal-manager.js`);
  addIf(/(?:TransactionManager|txManager|transactionManager)\.(?:begin|beginTransaction|commit|commitTransaction|rollback|rollbackTransaction|abort)|Transaction\s+(?:undefined|null|[^\s]+)\s+not found|transaction-manager\.js/i, `${prototypeDir}/src/transaction-manager.js`);
  if (/BPlusTreeIndex|b-plus-tree-index\.js/i.test(stackText)) {
    paths.add(`${prototypeDir}/src/b-plus-tree-index.js`);
  }
  return Array.from(paths);
}

export const REAL_TASK_SCENARIO_PACKS = [
  {
    id: 'web',
    scenarioIds: ['path-blog-greenfield', 'path-blog-followup'],
    qualityProfileId: 'web_experience',
    qualityGateId: 'web_experience',
    requiresStrongModel: false,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: ['static_site', 'node'],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'external_delivery',
    },
    timeoutPolicy: {
      maxTurns: 8,
      maxIdleCorrections: 2,
      maxRuntimeMs: 210_000,
    },
  },
  {
    id: 'docs-normalize',
    scenarioIds: ['docs-normalize-batch'],
    qualityProfileId: 'docs_normalize',
    qualityGateId: 'docs_normalize',
    requiresStrongModel: false,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: ['docs'],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'workspace_artifacts',
      label: 'documentation',
    },
    timeoutPolicy: {
      maxTurns: 8,
      maxIdleCorrections: 2,
      maxRuntimeMs: 240_000,
    },
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
    qualityGateId: 'docs_synthesize',
    requiresStrongModel: false,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: ['docs'],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'workspace_artifacts',
      label: 'documentation',
    },
    timeoutPolicy: {
      maxTurns: 8,
      maxIdleCorrections: 2,
      maxRuntimeMs: 240_000,
    },
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
    qualityGateId: 'system_audit',
    requiresStrongModel: false,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: [],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'host_observation',
    },
    timeoutPolicy: {
      maxTurns: 8,
      maxIdleCorrections: 2,
      maxRuntimeMs: 300_000,
    },
  },
  {
    id: 'desktop-observation',
    scenarioIds: ['desktop-ops-followup'],
    qualityProfileId: 'desktop_observation',
    qualityGateId: 'desktop_observation',
    requiresStrongModel: false,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: [],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'host_observation',
    },
    timeoutPolicy: {
      maxTurns: 8,
      maxIdleCorrections: 2,
      maxRuntimeMs: 240_000,
    },
  },
  {
    id: 'database-design',
    scenarioIds: ['database-near-mysql-design'],
    qualityProfileId: null,
    qualityGateId: 'database_near_mysql_design',
    requiresStrongModel: true,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: ['node'],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'prototype_design',
    },
    timeoutPolicy: {
      maxTurns: 18,
      maxIdleCorrections: 3,
      maxRuntimeMs: 45 * 60 * 1000,
    },
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
    qualityProfileId: null,
    qualityGateId: 'database_near_mysql_verify',
    requiresStrongModel: true,
    continuePolicy: {
      mode: 'runtime_truth',
      owner: 'generic_runner',
    },
    artifactAudit: {
      owner: 'scenario_pack',
      projectKinds: ['node'],
      manualReviewRequired: true,
    },
    classification: {
      kind: 'prototype_design',
    },
    timeoutPolicy: {
      maxTurns: 16,
      maxIdleCorrections: 3,
      maxRuntimeMs: 20 * 60 * 1000,
    },
    reuseWorkspace: {
      sourceScenarioId: 'database-near-mysql-design',
      source: 'latest_design_scenario_log',
      acceptArtifactNotes(notes) {
        return Boolean(notes?.hasRequiredDesignFiles) && Number(notes?.prototypeSrcFileCount ?? 0) > 0;
      },
    },
  },
];

export function buildRealTaskScenarioSpecs(options = {}) {
  const targetExternalPath = options.targetExternalPath ?? 'D:\\AAA';
  const databaseRoot = DATABASE_LAB_RULES.root;
  const databaseDesignDir = DATABASE_LAB_RULES.designDir;
  const databasePrototypeDir = DATABASE_LAB_RULES.prototypeDir;
  return [
    {
      id: 'path-blog-greenfield',
      title: 'Real Task Wave: Path Blog Greenfield',
      intent: [
        `Create a blog website directly in ${targetExternalPath}.`,
        'The result should feel elegant, fast to interact with, and visually memorable.',
        `Write real files into ${targetExternalPath}. At minimum deliver index.html, styles.css, and script.js in that external path.`,
        'Quality evidence must be written to the task-workspace relative path quality/web-audit.json, not inside the delivered website folder.',
        'Task-workspace output is allowed only as an intermediate step and does not count as the final delivery.',
        'If the live runtime cannot really deliver files to that path, state the blocker explicitly instead of pretending the task succeeded.',
      ].join(' '),
      pathPolicy: 'ask_if_unclear',
      timeoutMs: 210_000,
      stopOnArtifactUnresolved: true,
      unit: {
        role: 'BlogArchitect',
        goal: `Create the requested blog site directly in ${targetExternalPath} and make the final delivery path explicit.`,
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'web_experience',
        taskScope: `The final website must live in ${targetExternalPath}. Workspace-only artifacts are not an acceptable final answer. The minimum external deliverables are index.html, styles.css, and script.js. Write quality evidence only to the task-workspace path quality/web-audit.json; do not create ${targetExternalPath}\\quality.`,
      },
    },
    {
      id: 'path-blog-followup',
      title: 'Real Task Wave: Path Blog Followup',
      intent: [
        `Continue iterating on the blog website in ${targetExternalPath}.`,
        'Add at least one clearly visible feature or interaction improvement.',
        'Quality evidence must be written to the task-workspace relative path quality/web-audit.json, not inside the delivered website folder.',
        'Do not switch the final delivery back into task workspace and do not answer with prose-only change descriptions.',
        `Keep using ${targetExternalPath} as the final destination. If the previous scenario did not really land there, say so explicitly and describe the blocker.`,
      ].join(' '),
      pathPolicy: 'ask_if_unclear',
      timeoutMs: 210_000,
      stopOnArtifactUnresolved: true,
      unit: {
        role: 'BlogEnhancer',
        goal: `Apply a real follow-up improvement directly in ${targetExternalPath}.`,
        outputContract: '{"summary":"string","details":"string","artifactDestination":"string","issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'web_experience',
        taskScope: `Do not switch back to task workspace as the final destination. The website must still live in ${targetExternalPath}. Write quality evidence only to the task-workspace path quality/web-audit.json; do not create ${targetExternalPath}\\quality.`,
      },
    },
    {
      id: 'docs-normalize-batch',
      title: 'Real Task Wave: Docs Normalize Batch',
      intent: [
        'The task workspace contains a batch of messy Markdown files under incoming/.',
        'Read the real seeded files incoming/raw-product-notes.md, incoming/content-roadmap draft.md, and incoming/launch-retro.MD.',
        'Normalize them into a coherent documentation set under normalized/.',
        'Write normalized/index.md plus at least three additional normalized Markdown files with consistent headings, naming, and cross references.',
        'Do not claim files that were not actually written.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 240_000,
      unit: {
        role: 'DocNormalizer',
        goal: 'Normalize the seeded Markdown batch into normalized/ with a stable index and cross references.',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'docs_normalize',
        taskScope: 'Read only from incoming/ and write the cleaned documentation set into normalized/. The output must be real files, not a plan.',
      },
    },
    {
      id: 'docs-synthesize-handbook',
      title: 'Real Task Wave: Docs Synthesize Handbook',
      intent: [
        'The task workspace contains a small structured document set under source/.',
        'Read the real seeded files source/product-strategy.md, source/ops-decisions.md, and source/editorial-feedback.md.',
        'Synthesize them into handbook/README.md, handbook/index.md, handbook/summary.md, and handbook/decision-log.md.',
        'Your conclusions must be grounded in those exact source files. Do not invent filenames or references.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 240_000,
      unit: {
        role: 'KnowledgeSynthesizer',
        goal: 'Synthesize the seeded Markdown set into a small handbook package under handbook/.',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        qualityProfileId: 'docs_synthesize',
        taskScope: 'Read only from source/ and write the synthesized handbook outputs into handbook/.',
      },
    },
    {
      id: 'system-health-audit',
      title: 'Real Task Wave: System Health Audit',
      intent: [
        'Inspect the current computer state and provide practical recommendations.',
        'Every claim must be grounded in real host-observation evidence, such as processes, memory, services, disk, or operating-system status.',
        'Use Windows-friendly real commands. If live runtime lacks host observation capability, state that blocker explicitly instead of inventing results.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 180_000,
      stopOnAwaitingTool: true,
      unit: {
        role: 'SystemAuditor',
        goal: 'Audit the current machine state with real host observations and give grounded advice.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'verify',
        qualityProfileId: 'system_audit',
        taskScope: 'Do not claim any system fact unless it comes from real host-observation evidence.',
      },
    },
    {
      id: 'desktop-ops-followup',
      title: 'Real Task Wave: Desktop Ops Followup',
      intent: [
        'Perform a stronger follow-up desktop or application-level observation task based on the system audit.',
        'At minimum, inspect real desktop-facing processes or application state on this Windows machine.',
        'If live runtime cannot do desktop or application observation, explain that capability boundary clearly instead of fabricating actions.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 180_000,
      stopOnAwaitingTool: true,
      unit: {
        role: 'DesktopOperator',
        goal: 'Perform or explicitly block a stronger desktop-level follow-up task with real evidence.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'verify',
        qualityProfileId: 'desktop_observation',
        taskScope: 'This task requires real desktop or application observation. Do not fabricate desktop actions.',
      },
    },
    {
      id: 'database-near-mysql-design',
      title: 'Real Task Wave: Database Near MySQL Design',
      intent: [
        'Design a MySQL-like relational OLTP database system in the task workspace.',
        'Treat near-MySQL performance as a target profile, not as a proven measured claim.',
        `Write the design package into ${databaseDesignDir}/ and a runnable Node.js prototype scaffold into ${databasePrototypeDir}/.`,
        'Read the seeded brief files under brief/ and ground the design in those exact workload, target, and constraint notes.',
        'The design must explicitly cover storage layout, indexes, transactions or concurrency control, WAL or recovery, cache or buffer-pool behavior, SQL compatibility scope, and benchmark dimensions.',
        'The prototype must include a real package.json, source files, and a synthetic benchmark scaffold.',
        `Write ${DATABASE_LAB_RULES.designQualityFile} with designFiles, prototypeFiles, implementedModules, and claimBoundaries for the scenario quality gate.`,
        'Run a real benchmark dry-run or self-check command after prototype writes and keep that tool evidence available.',
        'Do not claim that the system already matches MySQL performance. Only describe the target envelope, architecture choices, and how the prototype would be measured.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 420_000,
      unit: {
        role: 'DatabaseArchitect',
        goal: 'Produce a grounded database design package and a runnable Node.js prototype scaffold under database-lab/.',
        outputContract: '{"summary":"string","details":"string","producedFiles":[],"issues":[]}',
        executionProfileId: 'implement',
        taskScope: `Write the design package into ${databaseRoot}/. The work must stay grounded in brief/ and include both design documents and a prototype scaffold with a benchmark entrypoint. The database-specific quality gate lives in the scenario harness: write ${DATABASE_LAB_RULES.designQualityFile} with designFiles, prototypeFiles, implementedModules, and claimBoundaries.`,
      },
    },
    {
      id: 'database-near-mysql-verify',
      title: 'Real Task Wave: Database Near MySQL Verify',
      intent: [
        'Continue by validating and tightening the MySQL-like database design and prototype in the task workspace.',
        `Use the existing files under ${databaseRoot}/, execute a real synthetic benchmark scaffold or a dry-run benchmark command, and then update the design notes with the observed result.`,
        `Write ${DATABASE_LAB_RULES.verifyQualityFile} with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary.`,
        'Clearly separate verified prototype behavior from unproven MySQL-nearness claims.',
        'Do not invent benchmark success. Use real command output and keep any limitation explicit.',
      ].join(' '),
      pathPolicy: 'task_workspace',
      timeoutMs: 240_000,
      stopOnAwaitingTool: true,
      unit: {
        role: 'DatabaseVerifier',
        goal: 'Verify the benchmark scaffold and tighten the MySQL-like database design with real execution evidence.',
        outputContract: '{"summary":"string","details":"string","issues":[]}',
        executionProfileId: 'verify',
        taskScope: `Validate the design honestly with real command evidence from ${databasePrototypeDir}. A textual guess is not enough. The database-specific quality gate lives in the scenario harness: write ${DATABASE_LAB_RULES.verifyQualityFile} and cite the real benchmark invocation.`,
      },
    },
  ];
}

export function getRealTaskScenarioPack(scenarioId) {
  return REAL_TASK_SCENARIO_PACKS.find((pack) => pack.scenarioIds.includes(scenarioId)) ?? null;
}

export function getRealTaskScenarioPackId(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.id ?? null;
}

export function getScenarioIdsForPack(packId) {
  return REAL_TASK_SCENARIO_PACKS.find((pack) => pack.id === packId)?.scenarioIds ?? [];
}

export function scenarioBelongsToPack(scenarioId, packId) {
  return getRealTaskScenarioPackId(scenarioId) === packId;
}

export function scenarioBelongsToAnyPack(scenarioId, packIds) {
  return packIds.includes(getRealTaskScenarioPackId(scenarioId));
}

export function getScenarioQualityProfileId(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.qualityProfileId ?? null;
}

export function getScenarioQualityGateId(scenarioId) {
  const pack = getRealTaskScenarioPack(scenarioId);
  return pack?.qualityGateId ?? pack?.qualityProfileId ?? null;
}

export function getScenarioContinuePolicy(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.continuePolicy ?? {
    mode: 'runtime_truth',
    owner: 'generic_runner',
  };
}

export function getScenarioArtifactAuditPolicy(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.artifactAudit ?? {
    owner: 'generic_runner',
    projectKinds: [],
    manualReviewRequired: true,
  };
}

export function getScenarioClassificationPolicy(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.classification ?? {
    kind: 'generic',
  };
}

function passedIfRuntimeAndAuditPass(facts) {
  return Boolean(
    facts.lifecycleStatus === 'COMPLETED'
      && facts.acceptanceVerdict === 'passed'
      && (facts.qualityVerdict == null || facts.qualityVerdict === 'passed')
      && facts.artifactPass === true,
  );
}

export function classifyScenarioWithPolicy(scenarioId, facts = {}) {
  const policy = getScenarioClassificationPolicy(scenarioId);
  const environmentBlocked = facts.environmentBlocked === true;

  if (facts.surfacesPass === false) {
    return {
      classification: 'surface_drift',
      reason: 'Web, Human CLI, and Agent CLI did not all show the expected diagnostics truth for this task.',
    };
  }

  if (policy.kind === 'external_delivery') {
    if (passedIfRuntimeAndAuditPass(facts)) {
      return {
        classification: 'passed',
        reason: `${facts.targetExternalPath ?? 'the requested external path'} contains a real project artifact, the project audit passed, and runtime acceptance truth is clean.`,
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: 'The scenario hit a real provider or network blocker before the external-path delivery flow could complete.',
      };
    }
    const externalFileCount = Number(facts.externalFileCount ?? 0);
    return {
      classification: externalFileCount > 0 ? 'artifact_failure' : 'product_gap',
      reason: externalFileCount > 0
        ? `Real files landed in ${facts.targetExternalPath ?? 'the requested external path'}, but the runtime quality gate or artifact audit did not converge cleanly for this scenario.`
        : `The runtime did not deliver real files into ${facts.targetExternalPath ?? 'the requested external path'}; task-workspace output is not enough for this scenario.`,
    };
  }

  if (policy.kind === 'workspace_artifacts') {
    if (passedIfRuntimeAndAuditPass(facts)) {
      return {
        classification: 'passed',
        reason: `The ${policy.label ?? 'workspace'} outputs were written into the task workspace, passed the structure audit, and runtime acceptance truth is clean.`,
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: `The ${policy.label ?? 'workspace'} scenario hit a real provider or network blocker before the artifact set converged.`,
      };
    }
    return {
      classification: 'artifact_failure',
      reason: `The task did not finish with a clean completed acceptance state and a passing ${policy.label ?? 'workspace'} artifact audit.`,
    };
  }

  if (policy.kind === 'host_observation') {
    if (
      facts.artifactPass === true
      && facts.acceptanceVerdict === 'passed'
      && facts.qualityVerdict === 'passed'
      && facts.hasHostObservationEvidence === true
    ) {
      return {
        classification: 'passed',
        reason: 'The task provided host-grounded evidence, the audit matched it to real machine truth, and runtime acceptance truth is clean.',
      };
    }
    if (environmentBlocked) {
      return {
        classification: 'environment_blocker',
        reason: 'The host-observation scenario hit a real provider or network blocker before the evidence chain converged.',
      };
    }
    if (facts.honestBlocker === true) {
      return {
        classification: 'product_gap',
        reason: 'The task surfaced the lack of real host or desktop tooling instead of fabricating a result.',
      };
    }
    return {
      classification: 'artifact_failure',
      reason: 'The task produced system claims that were not backed by host evidence.',
    };
  }

  if (policy.kind === 'prototype_design') {
    if (passedIfRuntimeAndAuditPass(facts)) {
      return {
        classification: 'passed',
        reason: 'The database design package and prototype scaffold passed audit, and runtime acceptance truth is clean.',
      };
    }
    if (environmentBlocked) {
      const providerFailure = facts.providerFailureSummary ? ` Provider failure: ${facts.providerFailureSummary}.` : '';
      return {
        classification: 'environment_blocker',
        reason: `The prototype-design scenario hit a real provider or network blocker before the design package fully converged. Current artifact progress: ${facts.artifactProgressSummary ?? 'unknown'}.${providerFailure}`,
      };
    }
    if (facts.requiresRuntimeVerificationEvidence === true && facts.runtimeVerificationEvidence !== true) {
      return {
        classification: 'artifact_failure',
        reason: 'The verify scenario did not leave real benchmark or prototype execution evidence in the runtime tool trace.',
      };
    }
    if (facts.verificationScriptExitCode != null && facts.verificationScriptExitCode !== 0) {
      return {
        classification: 'artifact_failure',
        reason: `The prototype exists, but the benchmark or verification script did not execute cleanly. Current artifact progress: ${facts.artifactProgressSummary ?? 'unknown'}.`,
      };
    }
    return {
      classification: 'artifact_failure',
      reason: `The design package did not satisfy the required document, prototype, or verification audit bar. Current artifact progress: ${facts.artifactProgressSummary ?? 'unknown'}.`,
    };
  }

  if (facts.lifecycleStatus === 'COMPLETED' && facts.acceptanceVerdict === 'passed' && facts.artifactPass === true) {
    return {
      classification: 'passed',
      reason: 'The task reached a completed state and the artifact audit passed.',
    };
  }

  return {
    classification: 'artifact_failure',
    reason: 'The task did not satisfy the required completion or artifact quality bar.',
  };
}

function workspacePath(root, relativePath) {
  return path.join(root, ...String(relativePath).split('/'));
}

async function auditDocsNormalizeArtifacts(context) {
  const { workspaceDir, workspaceRelativeFiles, sharedQuality } = context;
  const normalizedFiles = workspaceRelativeFiles.filter((entry) => entry.startsWith('normalized/') && entry.endsWith('.md') && entry !== 'normalized/index.md');
  const indexContent = await fs.readFile(workspacePath(workspaceDir, 'normalized/index.md'), 'utf8').catch(() => '');
  const normalizedContents = await Promise.all(
    normalizedFiles.map(async (relativePath) => ({
      relativePath,
      content: await fs.readFile(workspacePath(workspaceDir, relativePath), 'utf8').catch(() => ''),
    })),
  );
  const allHaveHeading = normalizedContents.every((entry) => /^#\s+/m.test(entry.content));
  const indexReferencesAll = normalizedFiles.every((relativePath) => indexContent.includes(path.basename(relativePath)));
  const crossReferenceCount = normalizedContents.filter((entry) => /\[.*\]\(.*\.md\)/.test(entry.content)).length;
  return {
    workspaceDir,
    workspaceRelativeFiles,
    normalizedFiles,
    pass:
      sharedQuality.verdict === 'passed'
      && normalizedFiles.length >= 3
      && allHaveHeading
      && indexContent.includes('#')
      && indexReferencesAll
      && crossReferenceCount >= 2,
    notes: {
      allHaveHeading,
      indexReferencesAll,
      crossReferenceCount,
      sharedQuality,
    },
  };
}

async function auditDocsSynthesizeArtifacts(context) {
  const { workspaceDir, workspaceRelativeFiles, sharedQuality } = context;
  const requiredFiles = [
    'handbook/README.md',
    'handbook/index.md',
    'handbook/summary.md',
    'handbook/decision-log.md',
  ];
  const contents = {};
  for (const relativePath of requiredFiles) {
    contents[relativePath] = await fs.readFile(workspacePath(workspaceDir, relativePath), 'utf8').catch(() => '');
  }
  const hasAllFiles = requiredFiles.every((relativePath) => workspaceRelativeFiles.includes(relativePath));
  const combinedContent = Object.values(contents).join('\n');
  const sourceMentions =
    /Product Strategy|source\/product-strategy\.md/i.test(combinedContent)
    && /(Operations Decisions|Operational Decisions|source\/ops-decisions\.md)/i.test(combinedContent)
    && /(Editorial Feedback|source\/editorial-feedback\.md)/i.test(combinedContent);
  return {
    workspaceDir,
    workspaceRelativeFiles,
    requiredFiles,
    pass: sharedQuality.verdict === 'passed' && hasAllFiles && sourceMentions,
    notes: {
      hasAllFiles,
      sourceMentions,
      sharedQuality,
    },
  };
}

function auditHostObservationArtifacts(context) {
  const {
    workspaceDir,
    workspaceRelativeFiles,
    sharedQuality,
    hostObservation = {},
  } = context;
  const summaryText = hostObservation.summaryText ?? '';
  const hostTruth = hostObservation.hostTruth ?? {};
  const successfulDesktopEvidence = hostObservation.successfulDesktopEvidence === true;
  const mentionsHostFacts =
    summaryText.includes(hostTruth.system?.csName ?? '')
    || summaryText.includes('CPU')
    || summaryText.includes('memory');
  const qualityGroundedHostFacts =
    sharedQuality.verdict === 'passed'
    && Array.isArray(sharedQuality.passedChecks)
    && sharedQuality.passedChecks.some((check) => /^fact_grounded:/i.test(String(check)));
  const mentionsApplicationFacts =
    /\b(explorer|code|msedge|chrome|window|responding|mainwindowtitle)\b/i.test(summaryText);
  const honestBlocker = /cannot|unable|unavailable|no (?:system|desktop|host) tool|blocked/i.test(summaryText)
    || String(hostObservation.issueSummary ?? '').toLowerCase().includes('tool');
  return {
    workspaceDir,
    workspaceRelativeFiles,
    toolEvidenceCount: Number(hostObservation.toolEvidenceCount ?? 0),
    pass: sharedQuality.verdict === 'passed' && successfulDesktopEvidence && (mentionsHostFacts || mentionsApplicationFacts || qualityGroundedHostFacts),
    notes: {
      honestBlocker,
      successfulDesktopEvidence,
      mentionsHostFacts,
      qualityGroundedHostFacts,
      mentionsApplicationFacts,
      hostTruthSummary: {
        csName: hostTruth.system?.csName,
      },
      sharedQuality,
    },
  };
}

export async function runScenarioPackArtifactAudit(scenarioId, context) {
  const packId = getRealTaskScenarioPackId(scenarioId);
  if (packId === 'docs-normalize') {
    return auditDocsNormalizeArtifacts(context);
  }
  if (packId === 'docs-synthesize') {
    return auditDocsSynthesizeArtifacts(context);
  }
  if (packId === 'system-audit' || packId === 'desktop-observation') {
    return auditHostObservationArtifacts(context);
  }
  return null;
}

export function getScenarioProjectKinds(scenarioId) {
  return getScenarioArtifactAuditPolicy(scenarioId).projectKinds ?? [];
}

export function scenarioRequiresStrongLiveModel(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.requiresStrongModel === true;
}

export function getScenarioSeedFiles(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.seedFiles ?? null;
}

export function getScenarioRequiredOutputFiles(scenarioId) {
  return SCENARIO_REQUIRED_OUTPUT_FILES.get(scenarioId) ?? [];
}

export function getSourceFileForDocsNormalizeOutput(relativePath) {
  if (relativePath.endsWith('product-notes.md')) {
    return 'incoming/raw-product-notes.md';
  }
  if (relativePath.endsWith('content-roadmap.md')) {
    return 'incoming/content-roadmap draft.md';
  }
  if (relativePath.endsWith('launch-retro.md') || relativePath.endsWith('launch-retrospective.md')) {
    return 'incoming/launch-retro.MD';
  }
  return 'incoming/raw-product-notes.md';
}

export function getSourceFilesForDocsNormalizeOutput(relativePath) {
  if (relativePath.endsWith('index.md')) {
    return [
      'incoming/raw-product-notes.md',
      'incoming/content-roadmap draft.md',
      'incoming/launch-retro.MD',
    ];
  }
  return [getSourceFileForDocsNormalizeOutput(relativePath)];
}

export function getScenarioReuseWorkspace(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.reuseWorkspace ?? null;
}

export function getScenarioTimeoutPolicy(scenarioId) {
  return getRealTaskScenarioPack(scenarioId)?.timeoutPolicy ?? null;
}
