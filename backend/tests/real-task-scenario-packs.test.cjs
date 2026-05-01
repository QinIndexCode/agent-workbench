const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadScenarioPacksModule() {
  const modulePath = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'real-task-scenario-packs.mjs');
  return import(pathToFileURL(modulePath).href);
}

async function loadProjectDetectorsModule() {
  const modulePath = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'real-task-project-detectors.mjs');
  return import(pathToFileURL(modulePath).href);
}

test('real task scenario pack predicates own task-family routing', async () => {
  const {
    getScenarioArtifactAuditPolicy,
    buildRealTaskScenarioSpecs,
    classifyScenarioWithPolicy,
    getScenarioClassificationPolicy,
    getScenarioContinuePolicy,
    getScenarioQualityGateId,
    getRealTaskScenarioPackId,
    getScenarioQualityProfileId,
    getScenarioProjectKinds,
    getScenarioRequiredOutputFiles,
    runScenarioPackArtifactAudit,
    getScenarioIdsForPack,
  } = await loadScenarioPacksModule();

  assert.equal(getRealTaskScenarioPackId('path-blog-greenfield'), 'web');
  assert.equal(getRealTaskScenarioPackId('docs-normalize-batch'), 'docs-normalize');
  assert.equal(getRealTaskScenarioPackId('system-health-audit'), 'system-audit');
  assert.deepEqual(getScenarioIdsForPack('web'), ['path-blog-greenfield', 'path-blog-followup']);

  assert.equal(getScenarioContinuePolicy('docs-normalize-batch').mode, 'runtime_truth');
  assert.equal(getScenarioArtifactAuditPolicy('path-blog-greenfield').owner, 'scenario_pack');
  assert.equal(getScenarioClassificationPolicy('path-blog-greenfield').kind, 'external_delivery');
  assert.equal(getScenarioClassificationPolicy('docs-normalize-batch').kind, 'workspace_artifacts');
  assert.equal(getScenarioClassificationPolicy('system-health-audit').kind, 'host_observation');
  assert.equal(getScenarioQualityGateId('docs-normalize-batch'), 'docs_normalize');
  assert.deepEqual(getScenarioProjectKinds('path-blog-greenfield'), ['static_site', 'node']);
  assert.deepEqual(getScenarioProjectKinds('docs-normalize-batch'), ['docs']);
  assert.deepEqual(getScenarioRequiredOutputFiles('docs-normalize-batch'), [
    'normalized/index.md',
    'normalized/product-notes.md',
    'normalized/content-roadmap.md',
    'normalized/launch-retro.md',
  ]);
  assert.deepEqual(getScenarioRequiredOutputFiles('system-health-audit'), [
    'reports/system-health.md',
    'quality/system-audit.json',
  ]);

  const specs = buildRealTaskScenarioSpecs({ targetExternalPath: 'D:\\AAA' });
  const genericScenarioIds = [
    'path-blog-greenfield',
    'path-blog-followup',
    'docs-normalize-batch',
    'docs-synthesize-handbook',
    'system-health-audit',
    'desktop-ops-followup',
  ];
  const genericSpecs = specs.filter((spec) => genericScenarioIds.includes(spec.id));
  assert.deepEqual(genericSpecs.map((spec) => spec.id), genericScenarioIds);
  assert.equal(genericSpecs
    .every((spec) => spec.unit?.qualityProfileId === getScenarioQualityProfileId(spec.id)), true);

  assert.equal(classifyScenarioWithPolicy('path-blog-greenfield', {
    surfacesPass: true,
    lifecycleStatus: 'COMPLETED',
    acceptanceVerdict: 'passed',
    qualityVerdict: 'passed',
    artifactPass: true,
    targetExternalPath: 'D:\\AAA',
  }).classification, 'passed');
  assert.equal(classifyScenarioWithPolicy('path-blog-greenfield', {
    surfacesPass: true,
    lifecycleStatus: 'COMPLETED',
    acceptanceVerdict: 'passed',
    qualityVerdict: 'failed',
    artifactPass: false,
    externalFileCount: 0,
    targetExternalPath: 'D:\\AAA',
  }).classification, 'product_gap');
  assert.equal(classifyScenarioWithPolicy('system-health-audit', {
    surfacesPass: true,
    artifactPass: false,
    acceptanceVerdict: 'failed',
    qualityVerdict: 'failed',
    honestBlocker: true,
  }).classification, 'product_gap');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-pack-audit-'));
  try {
    fs.mkdirSync(path.join(workspace, 'normalized'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'normalized', 'index.md'), '# Index\n\n- product-notes.md\n- content-roadmap.md\n- launch-retro.md\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'normalized', 'product-notes.md'), '# Product Notes\n\nSee [roadmap](content-roadmap.md).\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'normalized', 'content-roadmap.md'), '# Content Roadmap\n\nSee [retro](launch-retro.md).\n', 'utf8');
    fs.writeFileSync(path.join(workspace, 'normalized', 'launch-retro.md'), '# Launch Retro\n\nComplete.\n', 'utf8');
    const audit = await runScenarioPackArtifactAudit('docs-normalize-batch', {
      workspaceDir: workspace,
      workspaceRelativeFiles: [
        'normalized/index.md',
        'normalized/product-notes.md',
        'normalized/content-roadmap.md',
        'normalized/launch-retro.md',
      ],
      sharedQuality: { verdict: 'passed' },
    });
    assert.equal(audit.pass, true);
    assert.equal(audit.notes.crossReferenceCount, 2);
    const hostAudit = await runScenarioPackArtifactAudit('system-health-audit', {
      workspaceDir: workspace,
      workspaceRelativeFiles: [],
      sharedQuality: { verdict: 'passed' },
      hostObservation: {
        summaryText: 'CPU and memory look healthy on TESTBOX.',
        successfulDesktopEvidence: true,
        toolEvidenceCount: 1,
        hostTruth: { system: { csName: 'TESTBOX' } },
      },
    });
    assert.equal(hostAudit.pass, true);
    assert.equal(hostAudit.notes.hostTruthSummary.csName, 'TESTBOX');

    const qualityGroundedHostAudit = await runScenarioPackArtifactAudit('system-health-audit', {
      workspaceDir: workspace,
      workspaceRelativeFiles: ['reports/system-health.md', 'quality/system-audit.json'],
      sharedQuality: {
        verdict: 'passed',
        passedChecks: ['system_audit_report_present', 'fact_grounded:hostname', 'fact_grounded:cpu_name'],
      },
      hostObservation: {
        summaryText: 'Final report written successfully.',
        successfulDesktopEvidence: true,
        toolEvidenceCount: 3,
        hostTruth: { system: { csName: 'TESTBOX' } },
      },
    });
    assert.equal(qualityGroundedHostAudit.pass, true);
    assert.equal(qualityGroundedHostAudit.notes.qualityGroundedHostFacts, true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('project detector supports non-node projects without assuming package.json', async () => {
  const { detectWorkspaceProjects, selectPrimaryProject } = await loadProjectDetectorsModule();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-project-detector-'));
  try {
    fs.mkdirSync(path.join(workspace, 'python-tool'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'python-tool', 'pyproject.toml'), '[project]\nname = "demo"\n', 'utf8');
    fs.mkdirSync(path.join(workspace, 'static-site'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'static-site', 'index.html'), '<h1>Demo</h1>\n', 'utf8');
    fs.mkdirSync(path.join(workspace, 'go-service'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'go-service', 'go.mod'), 'module example.com/demo\n', 'utf8');

    const projects = await detectWorkspaceProjects(workspace, { maxDepth: 3 });
    assert.deepEqual(
      projects.map((project) => project.kind).sort(),
      ['go', 'python', 'static_site'],
    );
    assert.equal(selectPrimaryProject(projects, { preferredKinds: ['python'] }).kind, 'python');
    assert.equal(selectPrimaryProject(projects, { preferredKinds: ['static_site'] }).kind, 'static_site');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
