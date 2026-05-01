const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadManualReviewModule() {
  const modulePath = path.resolve(__dirname, '..', '..', 'scripts', 'generate-real-task-manual-review.mjs');
  return import(pathToFileURL(modulePath).href);
}

test('real task manual review bundle treats script verdicts as evidence requiring human signoff', async () => {
  const { generateRealTaskManualReview } = await loadManualReviewModule();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scc-manual-review-'));
  try {
    const reportPath = path.join(root, 'real-task-wave-report.json');
    const jsonPath = path.join(root, 'real-task-manual-review.json');
    const markdownPath = path.join(root, 'real-task-manual-review.md');
    const artifactBundleRoot = path.join(root, 'manual-review-artifacts');
    const workspaceDir = path.join(root, 'workspace', 'task_manual_1');
    const auditEvidenceRoot = path.join(root, 'audit', 'path-blog-greenfield');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(auditEvidenceRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'index.html'), '<main>Path Blog</main>', 'utf8');
    fs.writeFileSync(path.join(auditEvidenceRoot, 'artifact-audit.json'), '{"pass":true}', 'utf8');
    fs.writeFileSync(reportPath, JSON.stringify({
      paths: { reportJsonPath: reportPath },
      verificationMode: 'submit_only_manual_review',
      scenarios: [{
        id: 'path-blog-greenfield',
        title: 'Path Blog',
        taskId: 'task_manual_1',
        lifecycleStatus: 'COMPLETED',
        verificationMode: 'submit_only_manual_review',
        manualReviewRequired: true,
        classification: 'passed',
        acceptanceVerdict: 'passed',
        qualityVerdict: 'passed',
        workspaceDir,
        auditEvidenceRoot,
        artifactAudit: {
          pass: true,
          externalRelativeFiles: ['index.html', 'styles.css'],
        },
      }],
    }), 'utf8');

    const { review } = await generateRealTaskManualReview({
      reportPath,
      jsonPath,
      markdownPath,
      artifactBundleRoot,
    });
    assert.equal(review.status, 'manual_review_required');
    assert.equal(review.totals.total, 1);
    assert.equal(review.totals.scriptPassed, 1);
    assert.equal(review.artifactBundleRoot, artifactBundleRoot);
    assert.equal(review.scenarios[0].verificationMode, 'submit_only_manual_review');
    assert.equal(review.scenarios[0].manualReview.required, true);
    assert.ok(review.scenarios[0].artifactCopies.some((copy) => copy.kind === 'workspace' && copy.copied));
    assert.ok(fs.existsSync(path.join(artifactBundleRoot, 'path-blog-greenfield', 'workspace', 'index.html')));
    assert.ok(fs.existsSync(path.join(artifactBundleRoot, 'path-blog-greenfield', 'auditEvidenceRoot', 'artifact-audit.json')));
    assert.equal(review.scenarios[0].manualReview.verdict, null);
    assert.ok(review.scenarios[0].checklist.some((item) => /browser/i.test(item)));
    const markdown = fs.readFileSync(markdownPath, 'utf8');
    assert.match(markdown, /Verification mode: submit_only_manual_review/);
    assert.match(markdown, /Artifact copies:/);
    assert.match(markdown, /Manual sign-off/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
