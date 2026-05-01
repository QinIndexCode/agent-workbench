const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  evaluateTaskQuality,
  getQualityProfilePromptSection,
} = require('../dist/application/validation/task-quality-profiles');

function createTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scc-quality-'));
}

function writeText(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

function writeJson(root, relativePath, value) {
  writeText(root, relativePath, JSON.stringify(value, null, 2));
}

function evaluate(root, qualityProfileId, toolInvocations = [], overrides = {}) {
  return evaluateTaskQuality({
    taskId: 'task-test',
    title: 'Quality test',
    intent: 'Evaluate task quality',
    unitId: 'AGENT-001',
    executionProfileId: 'implement',
    qualityProfileId,
    workspaceDir: root,
    artifactPaths: [],
    artifactDestinationPaths: [],
    artifactDestinationDir: null,
    toolInvocations,
    ...overrides,
  });
}

test('web_experience rejects placeholder web artifacts and accepts grounded interactive static sites', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'site/index.html', '<h1>My Blog</h1><p>Lorem ipsum sample copy</p>');
    writeText(root, 'site/app.js', 'console.log("no interaction");');
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['site/index.html'],
      supportingFiles: ['site/app.js'],
      interactionSelectors: [],
      brandingTitle: 'My Blog',
    });

    const failed = evaluate(root, 'web_experience');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.some((check) => check.startsWith('placeholder_copy:')));
    assert.ok(failed.failedChecks.includes('missing_interaction_selectors'));

    writeText(root, 'site/index.html', '<h1>Field Notes on Runtime Quality Gates</h1><input placeholder="Email address"><button id="theme-toggle">Toggle contrast</button>');
    writeText(root, 'site/styles.css', '.newsletter-input::placeholder { color: #789; }');
    writeText(root, 'site/app.js', "'use strict';\nconst label = '\\2606';\ndocument.querySelector('#theme-toggle').addEventListener('click', () => document.body.classList.toggle('high-contrast'));");
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['site/index.html'],
      supportingFiles: ['site/styles.css', 'site/app.js'],
      interactionSelectors: ['#theme-toggle'],
      brandingTitle: 'Runtime Quality Notes',
    });

    const syntaxFailed = evaluate(root, 'web_experience');
    assert.equal(syntaxFailed.verdict, 'failed');
    assert.equal(syntaxFailed.failedChecks.some((check) => check.startsWith('placeholder_copy:')), false);
    assert.equal(syntaxFailed.failedChecks.some((check) => check.startsWith('javascript_syntax_error:')), true);

    writeText(root, 'site/index.html', '<h1>Field Notes on Runtime Quality Gates</h1><input placeholder="Email address"><button id="theme-toggle">Toggle contrast</button>');
    writeText(root, 'site/app.js', 'document.querySelector("#theme-toggle").addEventListener("click", () => document.body.classList.toggle("high-contrast"));');
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['site/index.html'],
      supportingFiles: ['site/app.js'],
      interactionSelectors: ['#theme-toggle'],
      brandingTitle: 'Runtime Quality Notes',
    });

    const passed = evaluate(root, 'web_experience');
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));

    writeText(root, 'site/index.html', '<h1>Field Notes on Runtime Quality Gates</h1>textarea id="message" name="message" placeholder="What is on your mind?"></textarea><button id="theme-toggle">Toggle contrast</button>');
    const malformed = evaluate(root, 'web_experience');
    assert.equal(malformed.verdict, 'failed');
    assert.ok(malformed.failedChecks.some((check) => check.startsWith('html_malformed_tag_fragment:')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('web_experience resolves relative audit paths through delivered artifact evidence', () => {
  const root = createTempRoot();
  const externalRoot = createTempRoot();
  try {
    writeText(externalRoot, 'index.html', '<h1>Field Notes on Runtime Quality Gates</h1><button id="theme-toggle">Toggle contrast</button>');
    writeText(externalRoot, 'script.js', 'document.querySelector("#theme-toggle").addEventListener("click", () => document.body.classList.toggle("high-contrast"));');
    writeJson(root, 'quality/web-audit.json', {
      profile: 'web_experience',
      artifactKind: 'static_site',
      entryFiles: ['index.html'],
      supportingFiles: ['script.js'],
      interactionSelectors: ['#theme-toggle'],
      brandingTitle: 'Runtime Quality Notes',
    });

    const passed = evaluate(root, 'web_experience', [], {
      artifactDestinationPaths: [
        path.join(externalRoot, 'index.html'),
        path.join(externalRoot, 'script.js'),
      ],
    });
    assert.equal(passed.verdict, 'passed', JSON.stringify(passed, null, 2));
    assert.ok(passed.passedChecks.includes('visible_interaction_detected'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('docs_normalize requires source phrasing and traceable output mappings', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'incoming/product-notes.md', '# Product Notes\nLatency budget: p95 under 45ms for queue handoff.');
    writeText(root, 'normalized/product-notes.md', '# Feature 1\nRequirement A: improve performance.');
    writeJson(root, 'quality/docs-normalize-trace.json', {
      profile: 'docs_normalize',
      mappings: [{
        sourceFile: 'incoming/product-notes.md',
        outputFile: 'normalized/product-notes.md',
        sourceSnippets: ['Latency budget: p95 under 45ms for queue handoff.'],
      }],
    });

    const failed = evaluate(root, 'docs_normalize');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('template_placeholder_detected:normalized/product-notes.md'));
    assert.ok(failed.failedChecks.includes('output_lost_source_phrasing:normalized/product-notes.md'));

    writeText(root, 'normalized/product-notes.md', '# Product Notes\nLatency budget: p95 under 45ms for queue handoff.\n\n## Index\n- Source: incoming/product-notes.md');
    const passed = evaluate(root, 'docs_normalize');
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_normalize requires markdown cross-links for normalized document sets', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'incoming/product-notes.md', '# Product Notes\ninteractive elegance\nadd author spotlight');
    writeText(root, 'incoming/content-roadmap.md', '# Content Roadmap\nweekly essays\ncreator interviews');
    writeText(root, 'incoming/launch-retro.md', '# Launch Retro\nreadable layouts\nfast navigation');
    writeText(root, 'normalized/index.md', '# Documentation Index\n\n- [Product Notes](product-notes.md)\n- [Content Roadmap](content-roadmap.md)\n- [Launch Retrospective](launch-retrospective.md)');
    writeText(root, 'normalized/product-notes.md', '# Product Notes\ninteractive elegance\nadd author spotlight');
    writeText(root, 'normalized/content-roadmap.md', '# Content Roadmap\nweekly essays\ncreator interviews');
    writeText(root, 'normalized/launch-retrospective.md', '# Launch Retrospective\nreadable layouts\nfast navigation');
    writeJson(root, 'quality/docs-normalize-trace.json', {
      profile: 'docs_normalize',
      mappings: [
        {
          sourceFile: 'incoming/product-notes.md',
          outputFile: 'normalized/product-notes.md',
          sourceSnippets: ['interactive elegance', 'add author spotlight'],
        },
        {
          sourceFile: 'incoming/content-roadmap.md',
          outputFile: 'normalized/content-roadmap.md',
          sourceSnippets: ['weekly essays', 'creator interviews'],
        },
        {
          sourceFile: 'incoming/launch-retro.md',
          outputFile: 'normalized/launch-retrospective.md',
          sourceSnippets: ['readable layouts', 'fast navigation'],
        },
      ],
    });

    const failed = evaluate(root, 'docs_normalize');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('docs_normalize_missing_markdown_cross_references'));

    writeText(
      root,
      'normalized/product-notes.md',
      '# Product Notes\ninteractive elegance\nadd author spotlight\n\nSee the [content roadmap](content-roadmap.md).',
    );
    writeText(
      root,
      'normalized/launch-retrospective.md',
      '# Launch Retrospective\nreadable layouts\nfast navigation\n\nRefer back to the [product notes](product-notes.md).',
    );

    const passed = evaluate(root, 'docs_normalize');
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_synthesize rejects generic claims without source grounding', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'incoming/decision.md', '# Decision\nDecision: keep local-first approvals because remote browser control is out of scope.');
    writeText(root, 'handbook/decision-log.md', '# Decision Log\nThe platform has an enterprise-grade robust platform strategy.');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [{
        outputFile: 'handbook/decision-log.md',
        claimText: 'The platform has an enterprise-grade robust platform strategy.',
        sourceFile: 'incoming/decision.md',
        sourceSnippets: ['Decision: keep local-first approvals because remote browser control is out of scope.'],
      }],
    });

    const failed = evaluate(root, 'docs_synthesize');
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('claim_not_lexically_grounded:handbook/decision-log.md'));

    writeText(root, 'handbook/decision-log.md', '# Decision Log\nDecision: keep local-first approvals because remote browser control is out of scope.');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [{
        outputFile: 'handbook/decision-log.md',
        claimText: 'Decision: keep local-first approvals because remote browser control is out of scope.',
        sourceFile: 'incoming/decision.md',
        sourceSnippets: ['Decision: keep local-first approvals because remote browser control is out of scope.'],
      }],
    });

    const passed = evaluate(root, 'docs_synthesize');
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_synthesize accepts claim text that appears with markdown emphasis and title case in output', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'source/product-strategy.md', '# Product Strategy\n- Constraint: keep onboarding friction low');
    writeText(root, 'handbook/summary.md', '# Summary\nThe workflow must **Keep onboarding friction low**.');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [{
        outputFile: 'handbook/summary.md',
        claimText: 'keep onboarding friction low',
        sourceFile: 'source/product-strategy.md',
        sourceSnippets: ['keep onboarding friction low'],
      }],
    });

    const result = evaluate(root, 'docs_synthesize');
    assert.equal(result.verdict, 'passed');
    assert.ok(!result.failedChecks.includes('claim_missing_from_output:handbook/summary.md'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('docs_synthesize accepts claim text through normalized file-path wording and light inflection', () => {
  const root = createTempRoot();
  try {
    writeText(root, 'source/product-strategy.md', '# Product Strategy\n- Constraint: keep onboarding friction low');
    writeText(root, 'handbook/index.md', '# Handbook Index\n\n- `source/product-strategy.md`\n');
    writeText(root, 'handbook/README.md', '# Readme\n\nKey constraints include keeping onboarding friction low.\n');
    writeJson(root, 'quality/docs-synthesize-trace.json', {
      profile: 'docs_synthesize',
      claims: [
        {
          outputFile: 'handbook/index.md',
          claimText: 'Product Strategy',
          sourceFile: 'source/product-strategy.md',
          sourceSnippets: ['# Product Strategy'],
        },
        {
          outputFile: 'handbook/README.md',
          claimText: 'keep onboarding friction low',
          sourceFile: 'source/product-strategy.md',
          sourceSnippets: ['keep onboarding friction low'],
        },
      ],
    });

    const result = evaluate(root, 'docs_synthesize');
    assert.equal(result.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit checks reported facts against real tool output within tolerance', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-1',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    result: { stdout: 'FreePhysicalMemory : 8051548\nStatus : Running\n' },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nFree memory KB: 10');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [{
        name: 'free_memory_kb',
        reportedValue: 10,
        sourceInvocationId: 'tool-1',
        sourceRegex: 'FreePhysicalMemory\\s*:\\s*(\\d+)',
      }],
    });

    const failed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('fact_value_mismatch:free_memory_kb'));
    assert.ok(failed.requiredNextEvidence.some((entry) => /reportedValue for free_memory_kb/i.test(entry)));

    writeText(root, 'reports/system-health.md', '# System Health\nFree memory KB: 8051548');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [{
        name: 'free_memory_kb',
        reportedValue: 8051548,
        sourceInvocationId: 'tool-1',
        sourceRegex: 'FreePhysicalMemory\\s*:\\s*(\\d+)',
      }],
    });

    const passed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(passed.verdict, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit gives actionable repair evidence when facts cite the wrong tool output', () => {
  const root = createTempRoot();
  const invocations = [
    {
      invocationId: 'tool-memory',
      toolId: 'run_command',
      unitId: 'AGENT-001',
      status: 'SUCCEEDED',
      result: { stdout: 'FreePhysicalMemory=7302236\nTotalVisibleMemorySize=33279308\n' },
      error: null,
      metadata: {},
    },
    {
      invocationId: 'tool-disk',
      toolId: 'run_command',
      unitId: 'AGENT-001',
      status: 'SUCCEEDED',
      result: { stdout: 'FreeSpaceGb : 86.33\nSizeGb      : 351.93\n' },
      error: null,
      metadata: {},
    },
  ];

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nFree memory KB: 7302236\nC drive free: 86.33');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'free_memory_kb',
          reportedValue: 7302236,
          sourceInvocationId: 'tool-disk',
          sourceContains: ['FreePhysicalMemory=7302236'],
        },
        {
          name: 'c_drive_free_gb',
          reportedValue: 86.33,
          sourceInvocationId: 'tool-memory',
          sourceContains: ['FreeSpaceGb : 86.33'],
        },
      ],
    });

    const failed = evaluate(root, 'system_audit', invocations);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('tool_output_mismatch:free_memory_kb'));
    assert.ok(failed.failedChecks.includes('tool_output_mismatch:c_drive_free_gb'));
    assert.ok(failed.requiredNextEvidence.some((entry) => /free_memory_kb.*sourceInvocationId.*FreePhysicalMemory=7302236/i.test(entry)));
    assert.ok(failed.requiredNextEvidence.some((entry) => /c_drive_free_gb.*sourceInvocationId.*FreeSpaceGb : 86\.33/i.test(entry)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit suggests candidate invocation ids when regex evidence cites the wrong tool output', () => {
  const root = createTempRoot();
  const invocations = [
    {
      invocationId: 'tool-os',
      toolId: 'run_command',
      unitId: 'AGENT-001',
      status: 'SUCCEEDED',
      result: { stdout: 'Version        : 10.0.26200\nBuildNumber    : 26200\nOSArchitecture : 64-bit\n' },
      error: null,
      metadata: {},
    },
    {
      invocationId: 'tool-cpu',
      toolId: 'run_command',
      unitId: 'AGENT-001',
      status: 'SUCCEEDED',
      result: { stdout: 'NumberOfCores             : 16\nNumberOfLogicalProcessors : 24\nMaxClockSpeed             : 2000\n' },
      error: null,
      metadata: {},
    },
  ];

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nVersion 10.0.26200\nCores 16');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'os_version',
          reportedValue: '10.0.26200',
          sourceInvocationId: 'tool-cpu',
          sourceRegex: 'Version\\s*:\\s*(10\\.0\\.26200)',
        },
        {
          name: 'cpu_cores',
          reportedValue: 16,
          sourceInvocationId: 'tool-os',
          sourceRegex: 'NumberOfCores\\s*:\\s*(16)',
        },
      ],
    });

    const failed = evaluate(root, 'system_audit', invocations);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.requiredNextEvidence.some((entry) => /os_version.*tool-os/i.test(entry)));
    assert.ok(failed.requiredNextEvidence.some((entry) => /cpu_cores.*tool-cpu/i.test(entry)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit tolerates localized source labels when the reported value is grounded in tool output', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-systeminfo',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    result: {
      stdout: 'OS �汾:            10.0.26200 ��ȱ Build 26200\nOS Architecture: 64-bit\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nOS version: 10.0.26200 Build 26200');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [{
        name: 'os_version',
        reportedValue: '10.0.26200 Build 26200',
        sourceInvocationId: 'tool-systeminfo',
        sourceContains: ['OS 版本:            10.0.26200 暂缺 Build 26200'],
      }],
    });

    const passed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(passed.verdict, 'passed');
    assert.ok(passed.passedChecks.includes('source_contains_value_grounded:os_version'));
    assert.ok(!passed.failedChecks.includes('tool_output_mismatch:os_version'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit accepts full-match regex evidence when sourceContains and reportedValue are grounded', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-system',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    result: {
      stdout: 'Version               : 10.0.26200\nBuildNumber           : 26200\nTotalPhysicalMemoryMb : 32499.32\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nVersion 10.0.26200\nTotal memory 32499.32');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'os_version',
          reportedValue: '10.0.26200',
          sourceInvocationId: 'tool-system',
          sourceRegex: 'Version\\s*:\\s*10\\.0\\.26200',
          sourceContains: ['Version', '10.0.26200'],
        },
        {
          name: 'total_physical_memory_mb',
          reportedValue: 32499.32,
          sourceInvocationId: 'tool-system',
          sourceRegex: 'TotalPhysicalMemoryMb\\s*:\\s*32499\\.32',
          sourceContains: ['TotalPhysicalMemoryMb', '32499.32'],
        },
      ],
    });

    const passed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(passed.verdict, 'passed');
    assert.ok(passed.passedChecks.includes('source_regex_full_match_grounded:os_version'));
    assert.ok(passed.passedChecks.includes('source_regex_full_match_grounded:total_physical_memory_mb'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('system_audit rejects Win32 memory commands that divide KB values by 1MB', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-memory-bad-units',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: "Get-CimInstance -ClassName Win32_OperatingSystem | Select-Object @{Name='TotalPhysicalMemoryMb';Expression={[math]::Round($_.TotalVisibleMemorySize/1MB,2)}}, @{Name='FreePhysicalMemoryMb';Expression={[math]::Round($_.FreePhysicalMemory/1MB,2)}} | Format-List",
    },
    result: {
      stdout: 'TotalPhysicalMemoryMb : 31.74\nFreePhysicalMemoryMb  : 7.01\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/system-health.md', '# System Health\nTotal Physical Memory: 31.74 MB\nFree Physical Memory: 7.01 MB');
    writeJson(root, 'quality/system-audit.json', {
      profile: 'system_audit',
      reportFile: 'reports/system-health.md',
      facts: [
        {
          name: 'total_physical_memory_mb',
          reportedValue: 31.74,
          sourceInvocationId: 'tool-memory-bad-units',
          sourceRegex: 'TotalPhysicalMemoryMb\\s*:\\s*([\\d.]+)',
        },
        {
          name: 'free_physical_memory_mb',
          reportedValue: 7.01,
          sourceInvocationId: 'tool-memory-bad-units',
          sourceRegex: 'FreePhysicalMemoryMb\\s*:\\s*([\\d.]+)',
        },
      ],
    });

    const failed = evaluate(root, 'system_audit', [invocation]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('memory_unit_mismatch_command:total_physical_memory_mb'));
    assert.ok(failed.failedChecks.includes('memory_unit_mismatch_command:free_physical_memory_mb'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop_observation requires real desktop process evidence and source mapping', () => {
  const root = createTempRoot();
  const desktopInvocation = {
    invocationId: 'tool-desktop',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: 'Get-Process | Select-Object -First 5 ProcessName,Responding,MainWindowTitle',
    },
    result: {
      stdout: 'ProcessName : explorer\nResponding  : True\nMainWindowTitle : Documents\n',
    },
    error: null,
    metadata: {},
  };
  const genericInvocation = {
    invocationId: 'tool-generic',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: 'Get-Date',
    },
    result: {
      stdout: 'Tuesday, April 28, 2026 09:00:00\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/desktop-observation.md', '# Desktop Observation\nExplorer responding: True');
    writeJson(root, 'quality/desktop-observation.json', {
      profile: 'desktop_observation',
      reportFile: 'reports/desktop-observation.md',
      observations: [{
        name: 'explorer_responding',
        reportedValue: 'True',
        sourceInvocationId: 'tool-generic',
        sourceContains: ['explorer', 'Responding'],
      }],
    });

    const failed = evaluate(root, 'desktop_observation', [genericInvocation]);
    assert.equal(failed.verdict, 'failed');
    assert.ok(failed.failedChecks.includes('not_desktop_observation:explorer_responding'));

    writeJson(root, 'quality/desktop-observation.json', {
      profile: 'desktop_observation',
      reportFile: 'reports/desktop-observation.md',
      observations: [{
        name: 'explorer_responding',
        reportedValue: 'True',
        sourceInvocationId: 'tool-desktop',
        sourceRegex: 'Responding\\s*:\\s*(True|False)',
        sourceContains: ['ProcessName', 'explorer', 'Responding'],
      }],
    });

    const passed = evaluate(root, 'desktop_observation', [desktopInvocation]);
    assert.equal(passed.verdict, 'passed');
    assert.ok(passed.passedChecks.includes('desktop_observation_grounded:explorer_responding'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('desktop_observation accepts full-match regex evidence when the observation value is grounded', () => {
  const root = createTempRoot();
  const invocation = {
    invocationId: 'tool-desktop',
    toolId: 'run_command',
    unitId: 'AGENT-001',
    status: 'SUCCEEDED',
    arguments: {
      command: 'Get-Process chrome | Select-Object -First 1 ProcessName,Responding,MainWindowTitle',
    },
    result: {
      stdout: 'ProcessName     : chrome\nResponding      : True\nMainWindowTitle : SCC Batch Console\n',
    },
    error: null,
    metadata: {},
  };

  try {
    writeText(root, 'reports/desktop-observation.md', '# Desktop Observation\nChrome responding: True');
    writeJson(root, 'quality/desktop-observation.json', {
      profile: 'desktop_observation',
      reportFile: 'reports/desktop-observation.md',
      observations: [{
        name: 'chrome_responding',
        reportedValue: 'True',
        sourceInvocationId: 'tool-desktop',
        sourceRegex: 'Responding\\s*:\\s*True',
        sourceContains: ['ProcessName', 'chrome', 'Responding', 'True'],
      }],
    });

    const passed = evaluate(root, 'desktop_observation', [invocation]);
    assert.equal(passed.verdict, 'passed');
    assert.ok(passed.passedChecks.includes('source_regex_full_match_grounded:chrome_responding'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
