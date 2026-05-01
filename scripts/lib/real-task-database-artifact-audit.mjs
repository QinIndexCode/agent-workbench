import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  DATABASE_LAB_RULES,
  getRealTaskScenarioPackId,
} from './real-task-scenario-packs.mjs';
import {
  buildDatabaseArtifactProgress,
  getBlockingDatabasePackageEntryRefs,
  getDatabaseLabBenchRequiredModuleFilesFromWorkspace,
  getDatabaseLabPackageEntryDiagnostics,
  hasDatabaseLabVerificationEvidence,
  mergeDatabaseBenchRequiredModuleFiles,
} from './real-task-database-evidence.mjs';

const DATABASE_LAB_PROTOTYPE_DIR = DATABASE_LAB_RULES.prototypeDir;
const DATABASE_LAB_REQUIRED_DESIGN_FILES = DATABASE_LAB_RULES.requiredDesignFiles;
const DATABASE_LAB_REQUIRED_PROTOTYPE_FILES = DATABASE_LAB_RULES.requiredPrototypeFiles;

async function readDesignContents(workspaceDir) {
  return Object.fromEntries(await Promise.all(
    DATABASE_LAB_REQUIRED_DESIGN_FILES.map(async (relativePath) => [
      relativePath,
      await fs.readFile(path.join(workspaceDir, ...relativePath.split('/')), 'utf8').catch(() => ''),
    ]),
  ));
}

function evaluateDatabaseDesignCoverage(designContents) {
  const combinedDesignContent = Object.values(designContents).join('\n');
  return {
    mysqlTarget: /mysql/i.test(combinedDesignContent),
    storageEngine: /(storage engine|page layout|segment|sstable|btree|buffer pool)/i.test(combinedDesignContent),
    indexes: /\bindex(?:es)?\b|btree|hash index/i.test(combinedDesignContent),
    transactions: /\btransaction|mvcc|locking|isolation/i.test(combinedDesignContent),
    recovery: /\bwal|write-ahead|recovery|checkpoint/i.test(combinedDesignContent),
    cache: /\b(buffer pool|page cache|cache|caching)\b/i.test(combinedDesignContent),
    sqlCompatibility: /\bsql\b|parser|planner|dialect|compatib/i.test(combinedDesignContent),
    benchmarkPlan: /\bbenchmark|throughput|latency|p95|workload/i.test(combinedDesignContent),
  };
}

export async function auditDatabaseScenarioArtifacts(context) {
  const {
    scenarioId,
    workspaceDir,
    workspaceRelativeFiles,
    sharedQuality,
    scenarioState,
    runNodeProjectBuild,
    runCommandCapture,
    npmCommand,
  } = context;
  const packId = getRealTaskScenarioPackId(scenarioId);
  if (packId !== 'database-design' && packId !== 'database-verify') {
    return null;
  }

  const prototypeRoot = path.join(workspaceDir, DATABASE_LAB_PROTOTYPE_DIR);
  const buildAudit = fsSync.existsSync(path.join(prototypeRoot, 'package.json'))
    ? await runNodeProjectBuild(prototypeRoot)
    : null;
  const packageEntryDiagnostics = getDatabaseLabPackageEntryDiagnostics(workspaceDir);
  const designContents = await readDesignContents(workspaceDir);
  const prototypeSrcFiles = workspaceRelativeFiles.filter((entry) => entry.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
  const hasRequiredDesignFiles = DATABASE_LAB_REQUIRED_DESIGN_FILES.every((relativePath) => workspaceRelativeFiles.includes(relativePath));
  const hasRequiredPrototypeFiles = DATABASE_LAB_REQUIRED_PROTOTYPE_FILES.every((relativePath) => workspaceRelativeFiles.includes(relativePath));
  const designCoverage = evaluateDatabaseDesignCoverage(designContents);
  const verificationScriptName =
    buildAudit?.scripts?.bench ? 'bench'
      : buildAudit?.scripts?.['dry-run'] ? 'dry-run'
        : null;
  const verificationScriptAudit =
    buildAudit?.packageJsonFound && buildAudit.install?.exitCode === 0 && verificationScriptName
      ? runCommandCapture(npmCommand(), verificationScriptName === 'bench'
        ? ['run', 'bench', '--', '--dry-run']
        : ['run', verificationScriptName], {
          cwd: prototypeRoot,
          timeoutMs: 300_000,
        })
      : null;
  const benchRequiredModuleFiles = mergeDatabaseBenchRequiredModuleFiles(
    getDatabaseLabBenchRequiredModuleFilesFromWorkspace(workspaceDir, workspaceRelativeFiles),
    { includeCoreModuleBaseline: true },
  );
  const runtimeVerificationEvidence = hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });
  const blockingMissingEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, { scenarioId });
  const optionalMissingEntryRefs = Array.isArray(packageEntryDiagnostics?.missingEntryRefs)
    ? packageEntryDiagnostics.missingEntryRefs.filter((entryRef) => !blockingMissingEntryRefs.includes(entryRef))
    : [];
  const prototypeReady = Boolean(
    buildAudit?.packageJsonFound
    && buildAudit.install?.exitCode === 0
    && hasRequiredPrototypeFiles
    && prototypeSrcFiles.length > 0
    && packageEntryDiagnostics.invalidPackageJson !== true
    && blockingMissingEntryRefs.length === 0
    && (packageEntryDiagnostics.missingRequiredEntries?.length ?? 0) === 0
    && verificationScriptName
    && verificationScriptAudit?.exitCode === 0
  );
  const designReady = hasRequiredDesignFiles && Object.values(designCoverage).every(Boolean);
  const verifyRuntimeSatisfied = packId === 'database-verify' ? runtimeVerificationEvidence : true;
  const artifactProgress = buildDatabaseArtifactProgress(workspaceRelativeFiles, {
    verificationScriptAudit,
    benchRequiredModuleFiles,
    includeVerifyQualityEvidence: packId === 'database-verify',
    packageEntryDiagnostics,
    blockingMissingEntryRefs,
    optionalMissingEntryRefs,
    scenarioId,
  });

  return {
    workspaceDir,
    workspaceRelativeFiles,
    projectRoot: buildAudit?.projectRoot ?? prototypeRoot,
    buildAudit,
    previewAudit: null,
    pass: sharedQuality.verdict === 'passed' && designReady && prototypeReady && verifyRuntimeSatisfied,
    notes: {
      hasRequiredDesignFiles,
      hasRequiredPrototypeFiles,
      prototypeSrcFileCount: prototypeSrcFiles.length,
      verificationScriptName,
      packageEntryDiagnostics,
      runtimeVerificationEvidence,
      designCoverage,
      verificationScriptAudit,
      artifactProgress,
      sharedQuality,
    },
  };
}
