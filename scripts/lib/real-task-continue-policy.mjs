// Scenario continuation policy lives outside the generic wave runner so the
// runner remains responsible for orchestration, not scenario-family prompt rules.
export function createRealTaskContinuePolicy(deps) {
  const {
    path,
    targetExternalPath,
    DATABASE_LAB_ROOT,
    DATABASE_LAB_DESIGN_DIR,
    DATABASE_LAB_PROTOTYPE_DIR,
    DATABASE_LAB_REQUIRED_DESIGN_FILES,
    DATABASE_LAB_REQUIRED_PROTOTYPE_FILES,
    DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,
    DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES,
    DATABASE_LAB_DESIGN_TOPIC_GROUPS,
    DATABASE_LAB_DESIGN_QUALITY_FILE,
    DATABASE_LAB_VERIFY_QUALITY_FILE,
    DATABASE_LAB_BENCH_RESULT_FILE,
    buildJsonToolCallPrelude,
    buildWriteOnlyRepairPrelude,
    createContinueInstruction,
    normalizeSlashes,
    readTextFileIfExists,
    truncateScenarioPromptText,
    collectAcceptanceRequiredNextEvidence,
    getUnitInvalidOutputErrors,
    getRuntimeCorrectionKind,
    hasDesktopObservationEvidence,
    hasDatabaseLabArtifactEvidence,
    hasSuccessfulDatabaseBenchRunEvidence,
    hasDatabaseLabVerificationEvidence,
    hasExternalBlogWriteEvidence,
    hasMeaningfulWriteProgress,
    hasObservedDatabaseBenchRunAttempt,
    buildLatestToolFailureSummary,
    parseOutputContractKeys,
    getScenarioWorkspaceFiles,
    getMissingWorkspaceFiles,
    hasWorkspaceFiles,
    countSuccessfulReadActivities,
    buildEmbeddedSourceBlocks,
    buildToolInvocationResultExcerpt,
    getSystemAuditFamiliesFromFailures,
    getRecentSuccessfulInvocationIds,
    getFailedToolActivitiesById,
    getSystemAuditRunEvidenceCoverage,
    getScenarioRequiredOutputFiles,
    getSourceFilesForDocsNormalizeOutput,
    isWebScenario,
    isDocsNormalizeScenario,
    isDocsSynthesizeScenario,
    isDocsScenario,
    isSystemAuditScenario,
    isDesktopObservationScenario,
    isHostObservationScenario,
    isDatabaseDesignScenario,
    isDatabaseVerifyScenario,
    isDatabaseScenario,
    getDatabaseLabNextDesignDocTargets,
    getDatabaseLabNextPrototypeTopLevelTargets,
    getScenarioBenchRequiredModuleFiles,
    getDatabaseLabNextPrototypeModuleTargets,
    getDatabaseLabPackageEntryDiagnostics,
    getLatestDatabaseBenchRunFailure,
    getDatabaseLabPrototypeCodeDiagnostics,
    getDatabaseLabExistingDesignFiles,
    buildDatabaseArtifactProgress,
    getBlockingDatabasePackageEntryRefs,
    getDatabasePrototypePathFromPackageEntryRef,
    getDatabaseBenchRepairAllowedOptionalPaths,
    getDatabasePrototypePathsMentionedInText,
    getPrioritizedDatabasePrototypeRepairTargets,
    hasDatabaseLabRequiredWorkspaceShape,
  } = deps;

  function buildDatabaseBenchmarkSelfCheckInstruction(reason = null) {
    return createContinueInstruction([
      buildJsonToolCallPrelude(),
      `The design docs, prototype top-level files, and prototype src modules already exist under ${DATABASE_LAB_ROOT}/.`,
      `Do not reread brief/* and do not rewrite files in this turn.`,
      reason || 'The next required evidence is a real benchmark self-check, not another speculative source rewrite.',
      `Run exactly one dry-run benchmark command from ${DATABASE_LAB_PROTOTYPE_DIR} and preserve stdout, stderr, exitCode, command, cwd, and duration as tool evidence.`,
      'Do not emit read_file, list_files, search_files, create_folder, write_file, or delegate_subtask in this turn. The only valid tool call is one run_command benchmark self-check.',
      'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
      'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',
      'If the command fails, do not claim completion. Keep the exact failure result so the next turn can repair from real execution evidence.',
      'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',
    ].filter(Boolean).join(' '), {
      phase: 'benchmark_self_check',
      phaseCursor: 'benchmark_self_check',
      targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],
      allowedTools: ['run_command'],
      uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',
    });
  }

  function getDatabaseBenchFailureImpliedPrototypePaths(failureText) {
    const text = typeof failureText === 'string' ? failureText : '';
    const paths = [];
    const push = (relativePath) => {
      if (!paths.includes(relativePath)) {
        paths.push(relativePath);
      }
    };
    if (/(?:storage|engine|StorageEngine)\.(?:open|init|initialize|readPage|writePage|createFile)\s+is\s+not\s+a\s+function/i.test(text)
      || /(?:open|init|initialize|readPage|writePage|createFile)\s+is\s+not\s+a\s+function/i.test(text)
      || /StorageEngine|storage-engine|storage_engine|storage\./i.test(text)) {
      push(`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`);
    }
    if (/(?:bufferPool|buffer-pool|BufferPool|pool\.)/i.test(text)) {
      push(`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`);
    }
    if (/\b(?:WALManager|wal-manager|wal\.)\b/i.test(text)) {
      push(`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`);
    }
    if (/\b(?:TransactionManager|transaction-manager|txManager|transaction)\b/i.test(text)) {
      push(`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`);
    }
    if (/(?:BPlusTree|b-plus-tree|pkIndex|index\.(?:search|lookup|insert|range))/i.test(text)) {
      push(`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`);
      push(`${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`);
    }
    return paths;
  }

  function getNarrowDatabaseBenchRepairTargets(candidateTargets, options = {}) {
    const benchmarkPath = `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`;
    const maxTargets = Math.max(2, Number.isFinite(options?.maxTargets) ? Number(options.maxTargets) : 3);
    const candidates = Array.from(new Set([
      benchmarkPath,
      ...(Array.isArray(candidateTargets) ? candidateTargets : []),
    ].filter((relativePath) =>
      typeof relativePath === 'string'
      && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)
    )));
    const candidateSet = new Set(candidates);
    const failureText = typeof options?.failureText === 'string' ? options.failureText : '';
    const concreteTargets = Array.from(new Set([
      benchmarkPath,
      ...getDatabasePrototypePathsMentionedInText(failureText),
      ...getDatabaseBenchFailureImpliedPrototypePaths(failureText),
      ...(Array.isArray(options?.priorityTargets) ? options.priorityTargets : []),
    ].filter((relativePath) =>
      typeof relativePath === 'string'
      && candidateSet.has(relativePath)
    )));
    if (concreteTargets.some((relativePath) => relativePath !== benchmarkPath)) {
      return concreteTargets.slice(0, maxTargets);
    }
    return candidates.slice(0, maxTargets);
  }
  
  function deriveContinueMessage(spec, scenarioState) {
    const debug = scenarioState?.debug ?? scenarioState;  
    const correctionKind = getRuntimeCorrectionKind(scenarioState);  
    const deterministicAcceptance = debug?.executionSummary?.acceptance?.deterministic ?? null;  
    const qualityAcceptance = debug?.executionSummary?.acceptance?.quality ?? null;  
    const runtimeRequiredNextEvidence = collectAcceptanceRequiredNextEvidence(debug);  
    const invalidOutputErrors = getUnitInvalidOutputErrors(scenarioState);  
    const missingVerificationEvidence =  
      deterministicAcceptance?.evidence?.failedChecks?.includes('missing_verification_evidence')  
      || deterministicAcceptance?.outcome?.failedChecks?.includes('verification_outcome_not_demonstrated');  
    const toolEvidenceSatisfied = debug?.executionSummary?.acceptance?.evidence?.toolEvidence?.satisfied === true;  
    const artifactEvidenceSatisfied = debug?.executionSummary?.acceptance?.evidence?.artifactEvidence?.satisfied === true;  
    const toolExecutionFailure = debug?.executionSummary?.issueCategory === 'tool_execution_failure';  
    const desktopEvidenceSatisfied = hasDesktopObservationEvidence(scenarioState);  
    const databaseLabArtifactSatisfied = hasDatabaseLabArtifactEvidence(scenarioState);  
    const databaseLabBenchSatisfied = hasSuccessfulDatabaseBenchRunEvidence(scenarioState);  
    const databaseLabVerificationSatisfied = hasDatabaseLabVerificationEvidence(scenarioState, { allowFailed: true });  
    const externalBlogWriteSatisfied = hasExternalBlogWriteEvidence(scenarioState);  
    const databaseLabWriteProgressObserved = hasMeaningfulWriteProgress(  
      scenarioState,  
      /^(database-lab\/|quality\/database-design\.json$)/i,  
    );  
    const databasePrototypeSrcFileCount = getScenarioWorkspaceFiles(scenarioState)  
      .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))  
      .length;  
    const shouldKeepDatabaseLabPhaseRepair =
      isDatabaseDesignScenario(spec)
      && databasePrototypeSrcFileCount >= 3  
      && hasObservedDatabaseBenchRunAttempt(scenarioState);  
    
    function buildOutputAndTrackerCorrection(detailSuffix) {  
      const outputKeys = parseOutputContractKeys(spec);  
      return [  
        'Return exactly two blocks in this order and nothing else.',  
        'Block 1 must be one [AGENT-001_OUTPUT] JSON envelope.',  
        'Block 2 must be one tracker JSON object for the current unit.',  
        'Do not emit tool calls. Do not add prose.',  
        outputKeys.length > 0  
          ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`  
          : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',  
        'The tracker JSON must include current_unit, status, progress_percent, decision, reason, next_unit, and files_created.',  
        detailSuffix,  
      ].join(' ');  
    }  
    
    function buildTrackerOnlyFinalizationInstruction() {
      const outputKeys = parseOutputContractKeys(spec);
      const latestOutput = scenarioState?.task?.latestVisibleOutput ?? scenarioState?.summary?.latestVisibleOutput ?? null;
      const workspaceArtifactCandidates = getScenarioWorkspaceFiles(scenarioState)
        .filter((relativePath) => !relativePath.startsWith('incoming/') && !relativePath.startsWith('source/') && !relativePath.startsWith('brief/'));
      const artifactPaths = Array.from(new Set([
        ...(Array.isArray(latestOutput?.artifactPaths) ? latestOutput.artifactPaths : []),
        ...(isDatabaseScenario(spec)
          ? workspaceArtifactCandidates.filter((relativePath) => isDatabaseLabDeclarableProducedFile(relativePath))
          : workspaceArtifactCandidates),
      ].filter((value) => typeof value === 'string' && value.trim().length > 0))).sort((left, right) => left.localeCompare(right));
      const existingSummary = typeof latestOutput?.summary === 'string' && latestOutput.summary.trim()  
        ? latestOutput.summary.trim()  
        : 'The required artifacts have been written and verified by runtime evidence.';  
      const existingDetails = typeof latestOutput?.details === 'string' && latestOutput.details.trim()  
        ? latestOutput.details.trim()  
        : 'Runtime acceptance evidence is present. Finalize the thread without emitting more tools.';  
      return createContinueInstruction([  
        'Runtime evidence is already sufficient except the final tracker still says the unit is in progress.',  
        'Do not emit tool calls, prose, markdown fences, or extra commentary in this turn.',  
        'Return exactly two machine-readable blocks in this order: one [AGENT-001_OUTPUT] JSON envelope, then one final tracker JSON object.',  
        'Use this exact wrapper pattern with both tags present: [AGENT-001_OUTPUT]{...}[/AGENT-001_OUTPUT].',  
        outputKeys.length > 0  
          ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`  
          : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',  
        `Use a grounded summary like: ${JSON.stringify(existingSummary)}.`,  
        `Use grounded details like: ${JSON.stringify(existingDetails)}.`,  
        artifactPaths.length > 0  
          ? `Set any file list fields to real produced files only: ${JSON.stringify(artifactPaths)}.`  
          : 'Do not invent produced files; use an empty file list if the contract asks for one.',  
        'Set issues to [] unless a real unresolved blocker remains.',  
        'The final tracker JSON must set current_unit to AGENT-001, status to COMPLETE, progress_percent to 100, decision to CONTINUE, reason to a non-empty completion sentence, next_unit to null, and files_created to the same real produced files list.',
        'Use a tracker reason like "All required artifacts and quality evidence are complete.".',
      ].join(' '), {  
        strategy: 'tracker_only_finalization',  
        phase: 'finalize',  
        allowedTools: [],  
        allowedPaths: [],  
        uniqueKey: `${spec.id}:tracker_only_finalize`,  
        requiredTrackerStatus: 'COMPLETE',  
        requiredTrackerDecision: 'CONTINUE',  
      });  
    }  
    
    function buildRuntimeRequiredEvidenceInstruction() {  
      const latestToolFailureSummary = buildLatestToolFailureSummary(scenarioState);  
      const qualityProfileId = qualityAcceptance?.profileId ?? spec?.unit?.qualityProfileId ?? 'none';  
      const evidenceLines = runtimeRequiredNextEvidence.map((entry, index) => `${index + 1}. ${entry}`);  
      const genericWarnings = [];  
      if (correctionKind === 'AWAITING_TOOL_ACTION') {  
        genericWarnings.push('This is a tool-action correction turn. Emit real tool JSON first and end with one tracker JSON.');  
        if (latestToolFailureSummary) {  
          genericWarnings.push('If you must inspect files before writing or rerunning a command, restrict inspection to the files or stack frames cited by the latest failed tool result.');  
        }  
      }  
      if (isDatabaseDesignScenario(spec)) {
        genericWarnings.push(`The existing grounded files under ${DATABASE_LAB_ROOT}/ already exist. Do not reread brief/* and do not rewrite completed design docs unless the cited evidence gap explicitly requires it.`);  
        genericWarnings.push(`Do not batch-rebuild the whole scaffold. Repair only the specific files implied by the current evidence gaps and the latest failed tool result.`);  
      }  
      if (isDatabaseVerifyScenario(spec)) {
        genericWarnings.push(`Use the existing ${DATABASE_LAB_ROOT}/ scaffold. Do not rebuild design/package files unless the cited evidence gap explicitly requires it.`);  
      }  
      return createContinueInstruction([  
        buildJsonToolCallPrelude(),  
        `Drive this turn from runtime acceptance and quality truth only. The active quality profile is ${qualityProfileId}.`,  
        'Do not restart completed phases or broad-read the workspace again unless a cited evidence gap explicitly requires a re-read.',  
        evidenceLines.length > 0  
          ? `Address only these currently required evidence gaps in this turn: ${evidenceLines.join(' ')}`  
          : 'Address only the currently reported acceptance and tool-failure gaps in this turn.',  
        latestToolFailureSummary  
          ? `Use the latest failed tool result as the repair surface instead of speculative rewrites. ${latestToolFailureSummary}`  
          : null,  
        toolExecutionFailure  
          ? 'A real tool execution failure already occurred. Repair the implicated files or command contract before rerunning the same tool.'  
          : null,  
        ...genericWarnings,  
        'Do not emit prose, markdown fences, or extra commentary. Emit only the minimum real tool actions needed for the current evidence gaps, then one tracker JSON.',  
      ].filter(Boolean).join(' '), {  
        strategy: 'runtime_required_evidence',  
        phase: 'runtime_required_evidence',  
      });  
    }  
    
    function buildDatabaseLabContinueInstruction(parts, metadata = {}) {
      const normalizedMetadata = { ...metadata };
      const phaseName = typeof normalizedMetadata.phase === 'string'
        ? normalizedMetadata.phase
        : '';
      const isRepairPhase = /repair/i.test(phaseName);
      if (
        isRepairPhase
        && normalizedMetadata.allowTargetedReadInspection !== false
        && Array.isArray(normalizedMetadata.targetPaths)
        && normalizedMetadata.targetPaths.length > 0
      ) {
        normalizedMetadata.allowTargetedReadInspection = true;
      }
      if (!Array.isArray(normalizedMetadata.allowedTools)) {
        if (normalizedMetadata.phase === 'brief_read') {
          normalizedMetadata.allowedTools = ['list_files', 'read_file'];
        } else if (normalizedMetadata.phase === 'benchmark_self_check') {
          normalizedMetadata.allowedTools = ['run_command'];
        } else if (normalizedMetadata.allowTargetedReadInspection === true && Array.isArray(normalizedMetadata.targetPaths) && normalizedMetadata.targetPaths.length > 0) {  
          normalizedMetadata.allowedTools = ['write_file', 'read_file'];  
        } else if (Array.isArray(normalizedMetadata.targetPaths) && normalizedMetadata.targetPaths.length > 0) {  
          normalizedMetadata.allowedTools = ['write_file'];  
        }  
      }  
      if (!Array.isArray(normalizedMetadata.allowedPaths) && Array.isArray(normalizedMetadata.targetPaths)) {  
        normalizedMetadata.allowedPaths = [...normalizedMetadata.targetPaths];  
      }  
      if (  
        normalizedMetadata.allowTargetedReadInspection === true
        && !Array.isArray(normalizedMetadata.allowedReadPaths)
        && Array.isArray(normalizedMetadata.targetPaths)
      ) {
        normalizedMetadata.allowedReadPaths = Array.from(new Set([
          ...normalizedMetadata.targetPaths,
          ...(Array.isArray(normalizedMetadata.allowedOptionalPaths) ? normalizedMetadata.allowedOptionalPaths : []),
        ]));
      }
      const bodyParts = parts.filter(Boolean);
      if (
        normalizedMetadata.allowTargetedReadInspection === true
        && Array.isArray(normalizedMetadata.allowedReadPaths)
        && normalizedMetadata.allowedReadPaths.length > 0
      ) {
        bodyParts.push(
          `Phase-specific exception: if one narrow inspection pass is necessary before rewriting, read_file is allowed only for these exact paths and at most once per path: ${normalizedMetadata.allowedReadPaths.join(', ')}. Do not read any other path.`,
        );
      }
      return createContinueInstruction(
        bodyParts.join(' '),
        {
          strategy: 'database_lab_scaffold',
          ...normalizedMetadata,
        },
      );  
    }  
    
    function buildDatabaseLabFinalizationInstruction(producedFiles) {  
      const outputKeys = parseOutputContractKeys(spec);  
      const normalizedProducedFiles = Array.from(new Set(  
        (Array.isArray(producedFiles) ? producedFiles : [])  
          .filter((relativePath) => typeof relativePath === 'string' && relativePath.trim().length > 0)  
          .sort((left, right) => left.localeCompare(right)),  
      ));  
      const producedFilesJson = JSON.stringify(normalizedProducedFiles);  
      const detailsText = [  
        `The design package under ${DATABASE_LAB_ROOT}/ is complete.`,  
        'The design docs, prototype scaffold, and quality manifest were written successfully.',  
        `A real benchmark self-check already passed from ${DATABASE_LAB_PROTOTYPE_DIR} via npm.cmd run bench -- --dry-run.`,  
        'Describe verified prototype behavior separately from unproven MySQL-nearness claims.',  
      ].join(' ');  
      return buildDatabaseLabContinueInstruction([  
        'Do not emit any tool calls, prose, markdown fences, or extra commentary in this turn.',  
        'Return exactly two machine-readable blocks in this order and nothing else: one [AGENT-001_OUTPUT] JSON envelope, then one final tracker JSON object.',  
        'Use this exact wrapper pattern with both tags present: [AGENT-001_OUTPUT]{...}[/AGENT-001_OUTPUT].',  
        outputKeys.length > 0  
          ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`  
          : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',  
        `Set producedFiles to exactly this real written file list: ${producedFilesJson}.`,  
        `Set details to a grounded completion summary like: ${JSON.stringify(detailsText)}.`,  
        'Keep issues as [] unless a real unresolved problem still exists.',  
        'The final tracker JSON must set current_unit to AGENT-001, status to COMPLETE, progress_percent to 100, decision to CONTINUE, next_unit to null, and files_created to the exact same producedFiles list.',  
        'The tracker reason must say that the database design package and benchmark self-check are complete.',  
        `The completion summary must not claim measured MySQL parity. Keep that distinction explicit while still marking the real scaffold work as complete.`,  
      ], {  
        phase: 'finalize',  
        phaseCursor: 'complete',  
        allowedTools: [],  
        allowedPaths: [],  
        uniqueKey: 'database_lab:finalize',  
      });  
    }  
    
    function getDatabaseLabProducedFilesForFinalization() {
      return Array.from(new Set(
        getScenarioWorkspaceFiles(scenarioState)
          .filter((relativePath) => isDatabaseLabDeclarableProducedFile(relativePath))
          .sort((left, right) => left.localeCompare(right)),
      ));
    }
  
    function isDatabaseLabDeclarableProducedFile(relativePath) {
      if (typeof relativePath !== 'string') {
        return false;
      }
      const normalized = relativePath.replace(/\\/g, '/');
      if (
        normalized === DATABASE_LAB_DESIGN_QUALITY_FILE
        || normalized === DATABASE_LAB_VERIFY_QUALITY_FILE
        || DATABASE_LAB_REQUIRED_DESIGN_FILES.includes(normalized)
        || normalized === `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`
        || normalized === `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`
        || normalized === `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`
      ) {
        return true;
      }
      const prototypeSrcPrefix = `${DATABASE_LAB_PROTOTYPE_DIR}/src/`;
      if (
        normalized.startsWith(prototypeSrcPrefix)
        && normalized.endsWith('.js')
        && !normalized.slice(prototypeSrcPrefix.length).includes('/')
      ) {
        return true;
      }
      const prototypeResultsPrefix = `${DATABASE_LAB_PROTOTYPE_DIR}/results/`;
      if (
        normalized.startsWith(prototypeResultsPrefix)
        && normalized.endsWith('.json')
        && !normalized.slice(prototypeResultsPrefix.length).includes('/')
      ) {
        return true;
      }
      return false;
    }
    
    const shouldPreferRuntimeEvidenceRepair =  
      runtimeRequiredNextEvidence.length > 0  
      || (toolExecutionFailure && databaseLabWriteProgressObserved);  
    
    const outcomeFailedChecks = Array.isArray(deterministicAcceptance?.outcome?.failedChecks)
      ? deterministicAcceptance.outcome.failedChecks
      : [];
    const outcomeOnlyNeedsCompleteTracker =
      outcomeFailedChecks.length > 0
      && outcomeFailedChecks.every((entry) => typeof entry === 'string' && entry.startsWith('tracker_not_complete'));
    const deterministicPreconditionsReadyForFinalTracker =
      deterministicAcceptance?.contract?.verdict === 'passed'
      && deterministicAcceptance?.execution?.verdict === 'passed'
      && deterministicAcceptance?.evidence?.verdict === 'passed'
      && (qualityAcceptance?.profileId == null || qualityAcceptance?.verdict === 'passed');
    const trackerOnlyFinalizationNeeded =
      deterministicPreconditionsReadyForFinalTracker
      && (
        (
          runtimeRequiredNextEvidence.length > 0
          && runtimeRequiredNextEvidence.every((entry) => entry === 'emit_complete_progress_tracker_when_work_is_done')
        )
        || outcomeOnlyNeedsCompleteTracker
      );
    
    if (trackerOnlyFinalizationNeeded) {
      if (isDatabaseDesignScenario(spec)) {
        return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());
      }
      return buildTrackerOnlyFinalizationInstruction();
    }

    const requiredScenarioFiles = getScenarioRequiredOutputFiles(spec?.id);
    const requiredScenarioFilesSatisfied =
      Array.isArray(requiredScenarioFiles)
      && requiredScenarioFiles.length > 0
      && hasWorkspaceFiles(scenarioState, requiredScenarioFiles);
    const qualitySatisfied = !qualityAcceptance?.profileId || qualityAcceptance?.verdict === 'passed';
    if (
      requiredScenarioFilesSatisfied
      && qualitySatisfied
      && invalidOutputErrors.length === 0
      && deterministicAcceptance?.verdict !== 'passed'
    ) {
      return buildTrackerOnlyFinalizationInstruction();
    }

    if (isWebScenario(spec) && correctionKind === 'AWAITING_TOOL_ACTION') {
      return buildPathBlogToolPrompt();
    }
    
    if (  
      shouldPreferRuntimeEvidenceRepair  
      && correctionKind === 'AWAITING_TOOL_ACTION'  
      && !shouldKeepDatabaseLabPhaseRepair  
      && !(  
        isDatabaseDesignScenario(spec)
        && !databaseLabWriteProgressObserved  
        && !hasObservedDatabaseBenchRunAttempt(scenarioState)  
      )  
    ) {  
      return buildRuntimeRequiredEvidenceInstruction();  
    }  
    
    const shouldFinalizeDatabaseLabDesign =  
      isDatabaseDesignScenario(spec)
      && databaseLabArtifactSatisfied  
      && databaseLabBenchSatisfied  
      && qualityAcceptance?.verdict === 'passed'  
      && deterministicAcceptance?.verdict !== 'passed';  
    
    function buildPathBlogToolPrompt() {
      const externalEntryPath = normalizeSlashes(path.join(targetExternalPath, 'index.html'));
      const externalStylePath = normalizeSlashes(path.join(targetExternalPath, 'styles.css'));
      const externalScriptPath = normalizeSlashes(path.join(targetExternalPath, 'script.js'));
      const externalRootPath = normalizeSlashes(targetExternalPath);
      const hasWorkspaceWebAudit = hasWorkspaceFiles(scenarioState, ['quality/web-audit.json']);
      const inspectedExternalBlogFiles = countSuccessfulReadActivities(
        scenarioState,
        /D:[/\\]AAA[/\\](?:index\.html|styles\.css|script\.js)/i,
      );
      const hasSuccessfulWriteEvidenceForPath = (filePath) => {
        const expected = normalizeSlashes(filePath).toLowerCase();
        const visibleToolActivities = Array.isArray(scenarioState?.summary?.visibleToolActivities)
          ? scenarioState.summary.visibleToolActivities
          : [];
        const toolInvocations = Array.isArray(scenarioState?.task?.toolInvocations)
          ? scenarioState.task.toolInvocations
          : [];
        return [...visibleToolActivities, ...toolInvocations].some((activity) => {
          const toolId = activity?.toolId ?? activity?.toolName ?? activity?.tool;
          const status = String(activity?.status ?? activity?.result?.status ?? '').toUpperCase();
          if (toolId !== 'write_file' || status !== 'SUCCEEDED') {
            return false;
          }
          const evidenceText = [
            activity?.arguments?.path,
            activity?.args?.path,
            activity?.argumentsSummary,
            activity?.resultSummary,
            activity?.result?.path,
            activity?.result?.filePath,
          ]
            .filter((value) => typeof value === 'string' && value.trim().length > 0)
            .map((value) => normalizeSlashes(value).toLowerCase())
            .join('\n');
          return evidenceText.includes(expected);
        });
      };
      const requiredDeliveryPaths = [externalEntryPath, externalStylePath, externalScriptPath];
      const allRequiredDeliveryWritesSucceeded = requiredDeliveryPaths.every((filePath) => hasSuccessfulWriteEvidenceForPath(filePath));
      const buildPathBlogFinalizationInstruction = () => {
        const outputKeys = parseOutputContractKeys(spec);
        return createContinueInstruction([
          'Do not emit any tool calls, prose, markdown fences, or extra commentary in this turn.',
          'Return exactly two machine-readable blocks in this order and nothing else: one [AGENT-001_OUTPUT] JSON envelope, then one final tracker JSON object.',
          'Use this exact wrapper pattern with both tags present: [AGENT-001_OUTPUT]{...}[/AGENT-001_OUTPUT].',
          outputKeys.length > 0
            ? `The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: ${outputKeys.join(', ')}.`
            : 'The [AGENT-001_OUTPUT] JSON must follow the declared unit output contract exactly.',
          `Base the output only on the successful write_file evidence already in this thread: ${requiredDeliveryPaths.join(', ')} and quality/web-audit.json.`,
          `Set artifactDestination to "${externalRootPath}".`,
          'Set issues to [] unless a real unresolved blocker is still visible in runtime evidence.',
          'The final tracker JSON must set current_unit to AGENT-001, status to COMPLETE, progress_percent to 100, decision to CONTINUE, next_unit to null, and files_created to the real written artifact paths.',
        ].join(' '), {
          phase: 'finalize',
          allowedTools: [],
          allowedPaths: [],
          uniqueKey: `${spec.id}:path-blog-finalize-after-write-evidence`,
          requiredTrackerStatus: 'COMPLETE',
          requiredTrackerDecision: 'CONTINUE',
        });
      };
      const webQualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];
      const hasExternalScriptSyntaxFailure = [
        ...webQualityFailedChecks,
        ...invalidOutputErrors,
      ].some((entry) => {
        const normalized = normalizeSlashes(String(entry ?? '')).toLowerCase();
        return normalized.includes('javascript_syntax_error:')
          && normalized.includes('d:/aaa/script.js');
      });
      const hasExternalMarkupOrCopyFailure = [
        ...webQualityFailedChecks,
        ...invalidOutputErrors,
      ].some((entry) => {
        const normalized = normalizeSlashes(String(entry ?? '')).toLowerCase();
        return (
          (normalized.includes('placeholder_copy:') || normalized.includes('html_malformed_tag_fragment:'))
          && normalized.includes('d:/aaa/index.html')
        );
      });
      if (externalBlogWriteSatisfied && hasWorkspaceWebAudit && hasExternalScriptSyntaxFailure) {
        const currentScript = readTextFileIfExists(path.join(targetExternalPath, 'script.js'));
        return createContinueInstruction([
          buildJsonToolCallPrelude(),
          `The delivered blog already exists in ${targetExternalPath}, but the quality gate found JavaScript syntax failure in ${externalScriptPath}.`,
          'Do not rewrite index.html, styles.css, or any quality JSON in this turn.',
          `Emit exactly one write_file tool call for "${targetExternalPath}\\script.js" with complete valid JavaScript content.`,
          'Preserve the intended interactions: theme toggle, mobile navigation, scroll reveal, newsletter submit feedback, and active nav state.',
          `After rewriting the script, emit one run_command tool call with command "node --check ${externalScriptPath}" so the next turn receives real syntax-check evidence.`,
          'End with one tracker JSON using status IN_PROGRESS and decision CONTINUE. Do not claim completion until the syntax check and quality gate pass.',
          currentScript
            ? `Current broken script.js content is embedded below. Repair it directly without reading files again:\n<<<SCRIPT_JS\n${truncateScenarioPromptText(currentScript, 4200)}\nSCRIPT_JS`
            : 'If the current script content is unavailable, still write a complete replacement script for the existing HTML selectors.',
        ].join(' '), {
          strategy: 'path_blog_script_syntax_repair',
          phase: 'web_script_syntax_repair',
          uniqueKey: `${spec.id}:script-syntax-repair`,
          allowedTools: ['write_file', 'run_command'],
          allowedPaths: [
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            `${targetExternalPath}\\script.js`,
          ],
          allowedWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            `${targetExternalPath}\\script.js`,
          ],
          forbiddenWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
            normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
            `${targetExternalPath}\\index.html`,
            `${targetExternalPath}\\styles.css`,
            `${targetExternalPath}\\quality\\web-audit.json`,
            'quality/web-audit.json',
          ],
        });
      }
      if (externalBlogWriteSatisfied && hasWorkspaceWebAudit && hasExternalMarkupOrCopyFailure) {
        const currentIndex = readTextFileIfExists(path.join(targetExternalPath, 'index.html'));
        return createContinueInstruction([
          buildJsonToolCallPrelude(),
          `The delivered blog already exists in ${targetExternalPath}, but the web_experience quality gate found malformed HTML or placeholder-like visible copy in ${externalEntryPath}.`,
          'Do not rewrite styles.css, script.js, or quality JSON in this turn.',
          `Emit exactly one write_file tool call for "${targetExternalPath}\\index.html" with complete valid HTML content.`,
          'Repair malformed form/control tags such as missing "<" before textarea/input tags. Keep form labels and controls valid HTML.',
          'Replace placeholder-like visible article or site copy with concrete blog-specific titles and summaries. Form placeholder attributes are allowed only when the surrounding HTML tag is syntactically valid.',
          'Preserve existing stylesheet/script filenames and selectors for theme toggle, filters/navigation, contact form, and back-to-top behavior.',
          'End with one tracker JSON using status IN_PROGRESS and decision CONTINUE. Do not claim completion until the quality gate passes.',
          currentIndex
            ? `Current index.html content is embedded below. Repair it directly without reading files again:\n<<<INDEX_HTML\n${truncateScenarioPromptText(currentIndex, 5200)}\nINDEX_HTML`
            : 'If the current index content is unavailable, still write a complete replacement index.html for the existing site files.',
        ].join(' '), {
          strategy: 'path_blog_markup_quality_repair',
          phase: 'web_markup_quality_repair',
          uniqueKey: `${spec.id}:markup-quality-repair`,
          allowedTools: ['write_file'],
          allowedPaths: [
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            `${targetExternalPath}\\index.html`,
          ],
          allowedWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            `${targetExternalPath}\\index.html`,
          ],
          forbiddenWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
            `${targetExternalPath}\\styles.css`,
            `${targetExternalPath}\\script.js`,
            `${targetExternalPath}\\quality\\web-audit.json`,
            'quality/web-audit.json',
          ],
        });
      }
      if (allRequiredDeliveryWritesSucceeded && hasWorkspaceWebAudit && webQualityFailedChecks.length === 0 && invalidOutputErrors.length === 0) {
        return buildPathBlogFinalizationInstruction();
      }
      if (allRequiredDeliveryWritesSucceeded && !hasWorkspaceWebAudit) {
        if (inspectedExternalBlogFiles >= 1) {
          return createContinueInstruction([
            'Return machine-readable JSON blocks only. Do not emit prose, markdown fences, or bullet lists.',
            'First emit exactly one write_file JSON object with arguments.path exactly "quality/web-audit.json". Do not emit any other tool call.',
            'Use write_file.arguments.content_json. The JSON content must include profile "web_experience", artifactKind "static_site", entryFiles ["D:/AAA/index.html"], supportingFiles ["D:/AAA/styles.css", "D:/AAA/script.js"], interactionSelectors, and brandingTitle.',
            'Do not create or write D:/AAA/quality/web-audit.json. The quality evidence file belongs in the task workspace, not the delivered website folder.',
            'After the write_file block, emit exactly one [AGENT-001_OUTPUT] JSON envelope that satisfies the output contract keys summary, details, artifactDestination, and issues.',
            'Use this exact wrapper pattern: [AGENT-001_OUTPUT]{"summary":"...","details":"...","artifactDestination":"D:/AAA","issues":[]}[/AGENT-001_OUTPUT].',
            'After the output envelope, append exactly one final tracker JSON using status IN_PROGRESS and decision CONTINUE. Do not claim completion until the runtime quality gate passes.',
          ].join(' '), {
            strategy: 'path_blog_quality_evidence_after_inspection',
            phase: 'web_audit_repair_after_inspection',
            uniqueKey: `${spec.id}:web-audit-workspace-after-inspection`,
            allowedTools: ['write_file'],
            allowedPaths: ['quality/web-audit.json'],
            allowedWritePaths: ['quality/web-audit.json'],
            forbiddenWritePaths: [
              normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
              `${targetExternalPath}\\quality\\web-audit.json`,
            ],
          });
        }
        return createContinueInstruction([
          buildJsonToolCallPrelude(),
          'The external blog files already exist. Do not rewrite D:/AAA/index.html, styles.css, or script.js in this turn.',
          'Emit exactly one write_file tool call with arguments.path set to the relative task-workspace path "quality/web-audit.json".',
          'Do not create or write D:/AAA/quality/web-audit.json. The quality evidence file belongs in the task workspace, not the delivered website folder.',
          `The JSON content must include profile "web_experience", artifactKind "static_site", entryFiles ["${externalEntryPath}"], supportingFiles ["${externalStylePath}", "${externalScriptPath}"], interactionSelectors, and brandingTitle.`,
          'End with one tracker JSON using status IN_PROGRESS and decision CONTINUE.',
        ].join(' '), {
          strategy: 'path_blog_quality_evidence',
          phase: 'web_audit_repair',
          uniqueKey: `${spec.id}:web-audit-workspace`,
          allowTargetedReadInspection: true,
          allowedTools: ['write_file', 'read_file'],
          allowedPaths: [
            'quality/web-audit.json',
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            `${targetExternalPath}\\index.html`,
            `${targetExternalPath}\\styles.css`,
            `${targetExternalPath}\\script.js`,
          ],
          allowedReadPaths: [
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            `${targetExternalPath}\\index.html`,
            `${targetExternalPath}\\styles.css`,
            `${targetExternalPath}\\script.js`,
          ],
          allowedWritePaths: ['quality/web-audit.json'],
          forbiddenWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
            `${targetExternalPath}\\quality\\web-audit.json`,
          ],
        });
      }
      if (!externalBlogWriteSatisfied && inspectedExternalBlogFiles >= 2) {
        const followupWriteTargets = [
          {
            path: externalEntryPath,
            label: 'HTML entry file',
            guidance: 'Rewrite the existing page with complete valid HTML and include one clearly visible feature or interaction improvement.',
          },
          {
            path: externalStylePath,
            label: 'stylesheet',
            guidance: 'Rewrite the stylesheet with complete CSS that supports the existing page and the visible improvement.',
          },
          {
            path: externalScriptPath,
            label: 'script',
            guidance: 'Rewrite the script with complete valid JavaScript for the existing interactions and the visible improvement.',
          },
          {
            path: 'quality/web-audit.json',
            label: 'workspace quality evidence',
            guidance: `Use write_file.arguments.content_json with profile "web_experience", artifactKind "static_site", entryFiles ["${externalEntryPath}"], supportingFiles ["${externalStylePath}", "${externalScriptPath}"], interactionSelectors, and brandingTitle.`,
          },
        ];
        const nextFollowupTarget = followupWriteTargets.find((target) => !hasSuccessfulWriteEvidenceForPath(target.path));
        if (nextFollowupTarget) {
          const isQualityTarget = nextFollowupTarget.path === 'quality/web-audit.json';
          return createContinueInstruction([
            'Return machine-readable JSON blocks only. Do not emit prose, markdown fences, or bullet lists.',
            `Emit exactly one write_file JSON object for ${nextFollowupTarget.label} with arguments.path exactly "${nextFollowupTarget.path}".`,
            isQualityTarget
              ? 'Use write_file.arguments.content_json for this JSON evidence file.'
              : 'Use write_file.arguments.content_lines for this complete file content.',
            'Do not emit create_folder, read_file, list_files, search_files, run_command, or delegate_subtask. Do not emit any second tool call in this turn.',
            'D:/AAA/quality/web-audit.json and D:\\AAA\\quality\\web-audit.json are explicitly forbidden.',
            `The existing website in ${targetExternalPath} has already been inspected in this follow-up task, but persistent write evidence is still incomplete.`,
            'Use the already-read file contents from the previous tool results as context; do not inspect again.',
            'Apply one clearly visible feature or interaction improvement while keeping the final delivery in D:/AAA.',
            nextFollowupTarget.guidance,
            'After the single write_file block, append exactly one tracker JSON using status IN_PROGRESS and decision CONTINUE. Do not claim completion until the runtime quality gate passes.',
          ].join(' '), {
            strategy: 'path_blog_followup_write_after_inspection',
            phase: 'path_blog_followup_write_after_inspection',
            uniqueKey: `${spec.id}:path-blog-write-after-inspection:${nextFollowupTarget.path}`,
            allowedTools: ['write_file'],
            allowedPaths: [nextFollowupTarget.path],
            allowedWritePaths: [nextFollowupTarget.path],
            forbiddenWritePaths: [
              normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
              `${targetExternalPath}\\quality\\web-audit.json`,
            ],
          });
        }
        return createContinueInstruction([
          'Return machine-readable JSON blocks only. Do not emit prose, markdown fences, or bullet lists.',
          'First emit exactly four write_file JSON objects, one for each of these exact paths: D:/AAA/index.html, D:/AAA/styles.css, D:/AAA/script.js, quality/web-audit.json.',
          'For large files, use write_file.arguments.content_lines. For quality/web-audit.json, use write_file.arguments.content_json.',
          'Do not emit create_folder, read_file, list_files, search_files, run_command, or delegate_subtask in this turn.',
          'Do not emit write_file for any other path. D:/AAA/quality/web-audit.json and D:\\AAA\\quality\\web-audit.json are explicitly forbidden.',
          `The existing website in ${targetExternalPath} has already been inspected in this follow-up task, but no persistent write evidence was produced.`,
          'Use the already-read file contents from the previous tool results as context; do not inspect again.',
          'Apply one clearly visible feature or interaction improvement now. Keep the final delivery in D:/AAA and do not move the website into the task workspace.',
          'Rewrite D:/AAA/index.html, D:/AAA/styles.css, and D:/AAA/script.js with complete file contents that preserve the site and add the visible improvement.',
          `Also write quality/web-audit.json in the task workspace with profile "web_experience", artifactKind "static_site", entryFiles ["${externalEntryPath}"], supportingFiles ["${externalStylePath}", "${externalScriptPath}"], interactionSelectors, and brandingTitle.`,
          'After the four write_file blocks, emit exactly one [AGENT-001_OUTPUT] JSON envelope that satisfies the output contract keys summary, details, artifactDestination, and issues.',
          'Use this exact wrapper pattern: [AGENT-001_OUTPUT]{"summary":"...","details":"...","artifactDestination":"D:/AAA","issues":[]}[/AGENT-001_OUTPUT].',
          'After the output envelope, append exactly one final tracker JSON using status IN_PROGRESS and decision CONTINUE. Do not claim completion until the runtime quality gate passes.',
        ].join(' '), {
          strategy: 'path_blog_followup_write_after_inspection',
          phase: 'path_blog_followup_write_after_inspection',
          uniqueKey: `${spec.id}:path-blog-write-after-inspection`,
          allowedTools: ['write_file'],
          allowedPaths: [
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            'quality/web-audit.json',
          ],
          allowedWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'index.html')),
            normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
            normalizeSlashes(path.join(targetExternalPath, 'script.js')),
            'quality/web-audit.json',
          ],
          forbiddenWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
            `${targetExternalPath}\\quality\\web-audit.json`,
          ],
        });
      }
      const deliveryTargets = [
        {
          path: externalEntryPath,
          label: 'HTML entry file',
          guidance: 'Write a complete valid HTML document for an elegant interactive blog site. Link to styles.css and script.js. Use concrete blog-specific visible copy, not placeholder article text.',
        },
        {
          path: externalStylePath,
          label: 'stylesheet',
          guidance: 'Write complete CSS for the blog site, including responsive layout, typography, states, and polished interaction affordances.',
        },
        {
          path: externalScriptPath,
          label: 'script',
          guidance: 'Write complete valid JavaScript for theme toggle, mobile navigation, scroll reveal, newsletter submit feedback, and active nav state.',
        },
      ];
      const nextDeliveryTarget = deliveryTargets.find((target) => !hasSuccessfulWriteEvidenceForPath(target.path));
      if (nextDeliveryTarget) {
        return createContinueInstruction([
          'Return machine-readable JSON blocks only. Do not emit prose, markdown fences, or bullet lists.',
          `Emit exactly one write_file JSON object for the ${nextDeliveryTarget.label} with arguments.path exactly "${nextDeliveryTarget.path}".`,
          'Use write_file.arguments.content_lines for the complete file content.',
          'write_file automatically creates missing parent directories. Do not emit create_folder.',
          'Do not emit read_file, list_files, search_files, run_command, or delegate_subtask. Do not emit any second tool call in this turn.',
          nextDeliveryTarget.guidance,
          'After the single write_file block, append exactly one tracker JSON using status IN_PROGRESS and decision CONTINUE.',
          'The next turn will request the next missing file or quality evidence after this write succeeds.',
        ].join(' '), {
          strategy: 'path_blog_delivery',
          phase: 'path_blog_delivery',
          uniqueKey: `${spec.id}:path-blog-delivery:${nextDeliveryTarget.path}`,
          allowTargetedReadInspection: false,
          allowedTools: ['write_file'],
          allowedPaths: [nextDeliveryTarget.path],
          allowedWritePaths: [nextDeliveryTarget.path],
          forbiddenWritePaths: [
            normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
            `${targetExternalPath}\\quality\\web-audit.json`,
          ],
        });
      }
      return createContinueInstruction([
        buildJsonToolCallPrelude(),
        'Use real external-path writes for the website files, not workspace writes.',
        `Emit one create_folder for "${targetExternalPath}" only if it does not already exist.`,
        `Then emit one write_file for each of "${targetExternalPath}\\index.html", "${targetExternalPath}\\styles.css", and "${targetExternalPath}\\script.js" with full file contents.`,
        'Also emit one write_file with arguments.path exactly "quality/web-audit.json" in the task workspace.',
        'Do not create or write D:/AAA/quality/web-audit.json; that is the wrong location for quality evidence.',
        'The workspace quality JSON must include profile, artifactKind, entryFiles, supportingFiles, interactionSelectors, and brandingTitle.',
        `Set entryFiles to ["${externalEntryPath}"] and supportingFiles to ["${externalStylePath}", "${externalScriptPath}"].`,
        'The next turn can summarize only after those write_file calls succeed.',
      ].join(' '), {
        strategy: 'path_blog_delivery',
        phase: 'path_blog_delivery',
        uniqueKey: `${spec.id}:path-blog-delivery`,
        allowTargetedReadInspection: true,
        allowedTools: ['create_folder', 'write_file', 'read_file', 'list_files', 'search_files'],
        allowedPaths: [
          normalizeSlashes(path.join(targetExternalPath, 'index.html')),
          normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
          normalizeSlashes(path.join(targetExternalPath, 'script.js')),
          `${targetExternalPath}\\index.html`,
          `${targetExternalPath}\\styles.css`,
          `${targetExternalPath}\\script.js`,
          'quality/web-audit.json',
        ],
        allowedReadPaths: [
          normalizeSlashes(path.join(targetExternalPath, 'index.html')),
          normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
          normalizeSlashes(path.join(targetExternalPath, 'script.js')),
          `${targetExternalPath}\\index.html`,
          `${targetExternalPath}\\styles.css`,
          `${targetExternalPath}\\script.js`,
        ],
        allowedWritePaths: [
          normalizeSlashes(path.join(targetExternalPath, 'index.html')),
          normalizeSlashes(path.join(targetExternalPath, 'styles.css')),
          normalizeSlashes(path.join(targetExternalPath, 'script.js')),
          `${targetExternalPath}\\index.html`,
          `${targetExternalPath}\\styles.css`,
          `${targetExternalPath}\\script.js`,
          'quality/web-audit.json',
        ],
        forbiddenWritePaths: [
          normalizeSlashes(path.join(targetExternalPath, 'quality', 'web-audit.json')),
          `${targetExternalPath}\\quality\\web-audit.json`,
        ],
      });
    }
    
    function buildDocsNormalizeToolPrompt() {
      const requiredFiles = getScenarioRequiredOutputFiles(spec.id);
      const missingDocs = getMissingWorkspaceFiles(scenarioState, requiredFiles);
      const traceMissing = !hasWorkspaceFiles(scenarioState, ['quality/docs-normalize-trace.json']);  
      const sourceAlreadyRead = countSuccessfulReadActivities(scenarioState, /^incoming\//i) >= 3;  
      const ungroundedTraceOutputs = invalidOutputErrors  
        .filter((entry) => entry.startsWith('quality_gate_failed:trace_not_grounded:'))  
        .map((entry) => entry.split('quality_gate_failed:trace_not_grounded:')[1])  
        .filter(Boolean);  
      const lostPhrasingOutputs = invalidOutputErrors  
        .filter((entry) => entry.startsWith('quality_gate_failed:output_lost_source_phrasing:'))  
        .map((entry) => entry.split('quality_gate_failed:output_lost_source_phrasing:')[1])  
        .filter(Boolean);  
      const missingMarkdownCrossLinks = invalidOutputErrors.includes('quality_gate_failed:docs_normalize_missing_markdown_cross_references')  
        || invalidOutputErrors.includes('quality_gate_failed:docs_normalize_index_missing_links')  
        || invalidOutputErrors.includes('quality_gate_failed:missing_docs_normalize_index');  
      const targetedRepairOutputs = Array.from(new Set([  
        ...ungroundedTraceOutputs,  
        ...lostPhrasingOutputs,  
      ]));  
      if (targetedRepairOutputs.length > 0) {  
        const sourceFiles = Array.from(new Set(targetedRepairOutputs.flatMap((entry) => getSourceFilesForDocsNormalizeOutput(entry))));  
        const sourceBlocks = buildEmbeddedSourceBlocks(scenarioState, sourceFiles);  
        return [  
          buildWriteOnlyRepairPrelude([...targetedRepairOutputs, 'quality/docs-normalize-trace.json']),  
          `The docs_normalize quality gate is still failing for these exact outputs: ${targetedRepairOutputs.join(', ')}.`,  
          `The needed source files are already known from earlier successful reads: ${sourceFiles.join(', ')}.`,  
          `Repair these exact normalized files in the same turn: ${targetedRepairOutputs.join(', ')}.`,  
          'Then rewrite the entire quality/docs-normalize-trace.json in the same turn so every mapping reflects the repaired files and uses fresh verbatim sourceSnippets[].',  
          'The needed source excerpts are embedded below. Do not emit read_file in this turn.',  
          'Every repaired normalized file must stay within source-backed facts and headings. If a current bullet is unsupported by the source excerpt, delete it instead of broadening it.',  
          'Do not invent Q1/Q2 plans, launch dates, metrics, team sizes, dashboards, collaboration features, accessibility claims, offline support, or analytics requirements unless those exact details appear in the cited source file.',  
          'Every mappings[].sourceSnippets[] entry must be copied verbatim from the cited source file. Do not paraphrase, broaden, or synthesize extra details.',  
          'At least one sourceSnippets[] entry for each mapping must also appear verbatim in the rewritten output file. Preserve original casing and wording from the source instead of title-casing or broad paraphrase.',  
          'Use real markdown links such as [Content Roadmap](content-roadmap.md) or [Product Notes](product-notes.md) when a normalized file needs a cross-reference. Plain text like "related to content-roadmap" does not satisfy the cross-reference requirement.',  
          'Never use a file name or path as a sourceSnippets[] entry. Strings like "raw-product-notes.md", "content-roadmap draft.md", or "launch-retro.MD" are invalid snippets.',  
          'For normalized/index.md, keep only short grounded cross-references that reuse exact phrases from the source files. Delete generic labels such as feature specifications, editorial calendar, delivery timeline, lessons learned, or action items when those exact phrases are absent from source.',  
          'Keep outputFile values aligned with the repaired normalized/*.md files.',  
          ...sourceBlocks,  
        ].join(' ');  
      }  
      if (missingDocs.length === 0 && missingMarkdownCrossLinks) {  
        return [  
          buildWriteOnlyRepairPrelude([...requiredFiles, 'quality/docs-normalize-trace.json']),
          'The normalized files and trace exist, but the docs_normalize quality gate still requires real markdown cross-links.',  
          'Do not emit read_file in this turn. Repair only normalized/index.md, normalized/product-notes.md, normalized/content-roadmap.md, normalized/launch-retro.md, and quality/docs-normalize-trace.json.',  
          'normalized/index.md must link to every sibling normalized markdown file.',  
          'At least two normalized markdown files must contain real sibling markdown links such as [Content Roadmap](content-roadmap.md) or [Product Notes](product-notes.md).',  
          'Plain text mentions like "related to content-roadmap" are not enough.',  
          'Keep all source-backed wording grounded and rewrite quality/docs-normalize-trace.json so its mappings still match the repaired outputs and use exact sourceSnippets[].',  
        ].join(' ');  
      }  
      if (missingDocs.length === 0 && traceMissing) {  
        return [  
          buildWriteOnlyRepairPrelude(['quality/docs-normalize-trace.json']),  
          'The normalized Markdown files already exist under normalized/. Do not spend another turn re-reading the whole incoming/ folder.',  
          'Do not emit read_file in this turn. Emit the missing quality/docs-normalize-trace.json write_file now.',  
          'Write quality/docs-normalize-trace.json with mappings[]. Each mapping must contain sourceFile, outputFile, and sourceSnippets[] copied exactly from the real incoming files.',  
          'Each mapping must point to one of normalized/index.md, normalized/product-notes.md, normalized/content-roadmap.md, or normalized/launch-retro.md.',  
          'Do not use template placeholders such as Feature 1 or Requirement A.',  
        ].join(' ');  
      }  
      return [  
        buildJsonToolCallPrelude(),  
        sourceAlreadyRead  
          ? 'The source files under incoming/ were already read successfully in this thread. Do not repeat broad read_file calls on incoming/ before writing.'  
          : 'First read incoming/raw-product-notes.md, incoming/content-roadmap draft.md, and incoming/launch-retro.MD.',  
        'Use create_folder for normalized/ and quality/ if needed.',  
        `Create or repair these exact documentation files: ${(missingDocs.length > 0 ? missingDocs : requiredFiles).join(', ')}.`,
        traceMissing  
          ? 'Also write quality/docs-normalize-trace.json with mappings containing sourceFile, outputFile, and exact sourceSnippets[] from the real incoming files.'  
          : 'Keep quality/docs-normalize-trace.json consistent with the written normalized files.',  
        'normalized/index.md must link to every sibling normalized markdown file, and at least two normalized markdown files must contain real sibling markdown links.',  
        'Each normalized output must preserve concrete source wording instead of Feature 1 or Requirement A placeholders.',  
        'The next turn can summarize only after the required write_file calls succeed.',  
      ].join(' ');  
    }  
    
    function buildDocsSynthesizeToolPrompt() {
      const requiredFiles = getScenarioRequiredOutputFiles(spec.id);
      const missingDocs = getMissingWorkspaceFiles(scenarioState, requiredFiles);
      const traceMissing = !hasWorkspaceFiles(scenarioState, ['quality/docs-synthesize-trace.json']);  
      const sourceAlreadyRead = countSuccessfulReadActivities(scenarioState, /^source\//i) >= 3;  
      const missingGroundingClaims = invalidOutputErrors.filter((entry) => entry.startsWith('quality_gate_failed:claim_missing_source_grounding:'));  
      const missingOutputClaims = invalidOutputErrors.filter((entry) => entry.startsWith('quality_gate_failed:claim_missing_from_output:'));  
      const missingGroundingEvidence = invalidOutputErrors.filter((entry) => entry.startsWith('quality_required_evidence:add grounded sourceSnippets for '));  
      if (missingGroundingClaims.length > 0 || missingOutputClaims.length > 0 || missingGroundingEvidence.length > 0) {  
        const groundedTargets = Array.from(new Set([  
          ...missingGroundingClaims.map((entry) => entry.split('quality_gate_failed:claim_missing_source_grounding:')[1]),  
          ...missingOutputClaims.map((entry) => entry.split('quality_gate_failed:claim_missing_from_output:')[1]),  
        ].filter(Boolean)));  
        const sourceBlocks = buildEmbeddedSourceBlocks(scenarioState, [  
          'source/product-strategy.md',  
          'source/ops-decisions.md',  
          'source/editorial-feedback.md',  
        ]);  
        return [  
          buildWriteOnlyRepairPrelude([  
            ...(groundedTargets.length > 0 ? groundedTargets : ['handbook/README.md', 'handbook/summary.md', 'handbook/decision-log.md']),  
            'quality/docs-synthesize-trace.json',  
          ]),  
          `Repair these handbook files so every claim is grounded in source wording: ${groundedTargets.join(', ') || 'handbook/README.md, handbook/summary.md, handbook/decision-log.md'}.`,  
          'Delete unsupported claims instead of trying to justify them. If a claim is not explicitly present in source/, remove it from both the handbook output and the trace JSON.',  
          'Do not leave generic abstractions such as "strategy direction set", "operational approach chosen", or "editorial refinements applied" unless those exact phrases exist in source/.',  
          'Do not mention project management tools, PostgreSQL, AWS, SSO, team sizes, MVP dates, reporting dashboards, automated PR testing gates, or any other noun phrase that does not appear in the source excerpts below.',  
          'Rewrite the handbook files to preserve concrete source phrases and constraints from source/product-strategy.md, source/ops-decisions.md, and source/editorial-feedback.md.',  
          'Then rewrite quality/docs-synthesize-trace.json so each claim includes sourceSnippets[] copied verbatim from the cited source file.',  
          'Every claimText in quality/docs-synthesize-trace.json must also appear verbatim in the corresponding handbook outputFile.',  
          'Prefer short grounded summaries over broad synthesized prose. Every handbook claim must stay traceable to real source bullets or lines.',  
          ...sourceBlocks,  
        ].join(' ');  
      }  
      if (missingDocs.length === 0 && traceMissing) {  
        return [  
          buildWriteOnlyRepairPrelude(['quality/docs-synthesize-trace.json']),  
          'The handbook Markdown files already exist under handbook/. Do not spend another turn re-reading the whole source/ folder.',  
          'Do not emit read_file in this turn. Emit the missing quality/docs-synthesize-trace.json write_file now.',  
          'Write quality/docs-synthesize-trace.json with claims[]. Each claim must include outputFile, claimText, sourceFile, and sourceSnippets[] copied exactly from the cited source file.',  
          'Every summary or decision claim must be grounded in cited source text, not generic enterprise wording.',  
        ].join(' ');  
      }  
      return [  
        buildJsonToolCallPrelude(),  
        sourceAlreadyRead  
          ? 'The source files under source/ were already read successfully in this thread. Do not repeat broad read_file calls on source/ before writing.'  
          : 'First read source/product-strategy.md, source/ops-decisions.md, and source/editorial-feedback.md.',  
        'Use create_folder for handbook/ and quality/ if needed.',  
        `Create or repair these exact handbook files: ${(missingDocs.length > 0 ? missingDocs : requiredFiles).join(', ')}.`,
        traceMissing  
          ? 'Also write quality/docs-synthesize-trace.json with grounded claims for the handbook outputs.'  
          : 'Keep quality/docs-synthesize-trace.json aligned with the real handbook outputs.',  
        'Every summary or decision claim must be grounded in cited source text, not generic enterprise wording.',  
        'The next turn can summarize only after successful write_file evidence exists.',  
      ].join(' ');  
    }  
    
    function buildSystemAuditToolPrompt() {
      const systemAuditCoverage = getSystemAuditRunEvidenceCoverage(scenarioState);
      const successfulRunIds = systemAuditCoverage.successfulRunIds.slice(-6);
      const reportsMissing = getMissingWorkspaceFiles(scenarioState, getScenarioRequiredOutputFiles(spec.id));
      const qualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];  
      const evidenceFailures = invalidOutputErrors.filter((entry) => /^quality_gate_failed:(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry));  
      const reportFailures = invalidOutputErrors.filter((entry) => entry.startsWith('quality_gate_failed:report_missing_fact:'));  
      const invalidJsonFailures = qualityFailedChecks.filter((entry) => entry === 'invalid_system_audit_json');  
      const fileRepairFailures = qualityFailedChecks.filter((entry) => /^missing_system_audit_(report|report_file|facts)$/i.test(entry));  
      const targetedFamilies = Array.from(  
        new Set([  
          ...systemAuditCoverage.missingFamilies,  
          ...getSystemAuditFamiliesFromFailures(evidenceFailures),  
          ...getSystemAuditFamiliesFromFailures(qualityFailedChecks.filter((entry) => /^(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry))),  
        ]),  
      );  
      const qualityEvidenceMismatchFailures = [
        ...evidenceFailures,
        ...qualityFailedChecks.filter((entry) => /^(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry)),
      ];
      const evidenceMismatchNeedsFreshRun = qualityEvidenceMismatchFailures.length > 0
        && !hasFreshSuccessfulToolEvidenceAfterWrite(scenarioState, 'run_command');

      if (successfulRunIds.length > 0 && targetedFamilies.length > 0 && (systemAuditCoverage.missingFamilies.length > 0 || evidenceMismatchNeedsFreshRun)) {
        const familyExcerpts = targetedFamilies  
          .map((family) => systemAuditCoverage.latestByFamily[family])  
          .filter(Boolean)  
          .map((invocationId) => buildToolInvocationResultExcerpt(scenarioState, invocationId))  
          .filter(Boolean);  
        const familyInstructions = [];  
        if (targetedFamilies.includes('memory')) {  
          familyInstructions.push('Run one command that prints TotalPhysicalMemoryMb and FreePhysicalMemoryMb in plain text using Get-CimInstance Win32_OperatingSystem with PowerShell-calculated MB fields and Format-List. Win32_OperatingSystem memory fields are already in KB, so convert to MB by dividing by 1024, not by 1MB.');  
        }  
        if (targetedFamilies.includes('cpu')) {  
          familyInstructions.push('Run one command that prints NumberOfCores, NumberOfLogicalProcessors, and MaxClockSpeed in plain text using Get-CimInstance Win32_Processor | Select-Object -First 1 ... | Format-List.');  
        }  
        if (targetedFamilies.includes('disk')) {  
          familyInstructions.push('Run one command that prints DeviceID, FreeSpaceGb, and SizeGb for drive C: in plain text using Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'" | Select-Object DeviceID, @{N=\'FreeSpaceGb\';E={[math]::Round($_.FreeSpace/1GB,2)}}, @{N=\'SizeGb\';E={[math]::Round($_.Size/1GB,2)}} | Format-List.');  
        }  
        return [  
          buildJsonToolCallPrelude(),  
          `Successful host-observation invocation ids already exist in this thread: ${successfulRunIds.join(', ')}.`,  
          systemAuditCoverage.missingFamilies.length > 0  
            ? `Required fact coverage is incomplete. Missing command groups: ${systemAuditCoverage.missingFamilies.join(', ')}.`  
            : `Existing command evidence does not satisfy these fact families: ${targetedFamilies.join(', ')}.`,  
          ...familyExcerpts,  
          'Emit fresh Windows-only run_command JSON tool objects now. Do not use uname, free, df, cat /proc, systeminfo fallback chains, or wmic.',  
          'Do not emit write_file yet. First repair the missing or failed host-evidence command groups below.',  
          ...familyInstructions,  
          'After memory, cpu, and disk evidence all exist as successful run_command invocations in this thread, then emit write_file for reports/system-health.md and quality/system-audit.json.',  
          'Use fresh sourceInvocationId values from the new successful commands. sourceRegex values must match the new field names exactly, such as TotalPhysicalMemoryMb, FreePhysicalMemoryMb, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed, FreeSpaceGb, and SizeGb.',  
          'reportedValue must equal the numeric value observed in the cited command output. Do not estimate or silently convert units unless the command output already uses that unit. For Win32_OperatingSystem memory fields, the command must print MB by dividing the KB source values by 1024.',  
          `Repair these exact quality failures: ${qualityEvidenceMismatchFailures.join('; ') || 'system audit evidence coverage is incomplete'}.`,
        ].filter(Boolean).join(' ');  
      }  
      if (successfulRunIds.length > 0 && targetedFamilies.length > 0) {
        const candidateRepairHints = qualityEvidenceMismatchFailures.length > 0
          ? `Use the candidate sourceInvocationId hints from these quality failures when rewriting the quality JSON: ${qualityEvidenceMismatchFailures.join('; ')}.`
          : null;
        return [
          buildWriteOnlyRepairPrelude(['reports/system-health.md', 'quality/system-audit.json']),
          `You already have fresh successful host-observation evidence in this thread from invocation ids: ${successfulRunIds.join(', ')}.`,
          'Do not emit more run_command calls in this turn. The remaining failure is evidence mapping, not missing host observation.',
          'Rewrite reports/system-health.md and quality/system-audit.json so every fact cites a successful invocation whose output contains or matches the reported value.',
          'Prefer the latest successful command for each fact family when multiple candidate invocations exist, and keep reportedValue equal to the cited output.',
          candidateRepairHints,
        ].filter(Boolean).join(' ');
      }

      if (successfulRunIds.length > 0 && systemAuditCoverage.missingFamilies.length === 0 && (reportsMissing.length > 0 || reportFailures.length > 0 || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0)) {
        return [  
          buildWriteOnlyRepairPrelude([  
            ...(reportsMissing.includes('reports/system-health.md') || reportFailures.length > 0 || fileRepairFailures.includes('missing_system_audit_report_file') ? ['reports/system-health.md'] : []),  
            ...(reportsMissing.includes('quality/system-audit.json') || reportFailures.length > 0 || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0 ? ['quality/system-audit.json'] : []),  
          ]),  
          `You already have successful host-observation evidence in this thread from invocation ids: ${successfulRunIds.join(', ')}.`,  
          'Do not emit run_command or broad read_file calls in this turn. The required memory, cpu, and disk evidence already exists, so emit only write_file calls now.',  
          ...(reportsMissing.includes('reports/system-health.md')  
            ? ['Write or repair reports/system-health.md with grounded findings and practical recommendations tied to those real command results.']  
            : []),  
          ...(reportsMissing.includes('quality/system-audit.json') || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0  
            ? ['Write or repair quality/system-audit.json with reportFile, facts[], sourceInvocationId, and sourceRegex or sourceContains values that match the successful command output. The file must be valid JSON, and every backslash inside sourceRegex must be escaped so JSON.parse succeeds.']  
            : []),  
          reportFailures.length > 0 || invalidJsonFailures.length > 0 || fileRepairFailures.length > 0  
            ? `Repair these exact quality failures in the rewritten report or quality JSON: ${[...reportFailures, ...invalidJsonFailures, ...fileRepairFailures].join('; ')}.`  
            : null,  
        ].join(' ');  
      }  
      return [  
        buildJsonToolCallPrelude(),  
        'Use direct PowerShell command text, not nested "powershell -Command".',  
        'Do not use Linux-only commands such as uname, free, df, ps, or cat /proc on this Windows host.',  
        'Do not use systeminfo fallback chains or wmic. Use Windows PowerShell / Get-CimInstance commands only.',  
        'Run real Windows host-observation commands first, and do not use write_file until all three evidence families exist: memory, cpu, and disk.',  
        'Emit JSON run_command tool objects for three command groups: (1) Win32_OperatingSystem with TotalPhysicalMemoryMb and FreePhysicalMemoryMb printed via Format-List after converting the Win32 KB values to MB by dividing by 1024, (2) Win32_Processor with NumberOfCores, NumberOfLogicalProcessors, and MaxClockSpeed via Format-List, and (3) Win32_LogicalDisk for C: with FreeSpaceGb and SizeGb via Format-List.',  
        'The quality JSON must include reportFile, facts[], sourceInvocationId, and sourceRegex or sourceContains values that match the successful command output.',  
        'quality/system-audit.json must be valid JSON. Escape backslashes inside sourceRegex values, for example use "\\\\s" instead of "\\s".',  
        'reportedValue must match the exact observed numeric value from the cited command output. If the fact name says _mb, make the command output print MB first instead of converting silently in the report. For Win32_OperatingSystem memory fields, never divide by 1MB; divide the KB values by 1024.',  
        'The next turn can summarize after successful command and write_file evidence exists.',  
      ].join(' ');  
    }  
    
    function getVisibleActivitiesForContinue(state) {
      return Array.isArray(state?.summary?.visibleToolActivities) ? state.summary.visibleToolActivities : [];
    }

    function getLatestSuccessfulActivityCursor(state, toolId) {
      const normalizedToolId = String(toolId ?? '').trim().toLowerCase();
      let latest = null;
      getVisibleActivitiesForContinue(state).forEach((activity, index) => {
        if (activity?.status !== 'SUCCEEDED' || String(activity?.toolId ?? '').trim().toLowerCase() !== normalizedToolId) {
          return;
        }
        const timestamps = [activity.endedAt, activity.startedAt, activity.updatedAt, activity.createdAt]
          .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));
        latest = {
          index,
          timestamp: Math.max(...timestamps),
        };
      });
      return latest;
    }

    function isActivityCursorAfter(left, right) {
      if (!left) {
        return false;
      }
      if (!right) {
        return true;
      }
      if (left.timestamp > 0 || right.timestamp > 0) {
        return left.timestamp > right.timestamp;
      }
      return left.index > right.index;
    }

    function hasFreshSuccessfulToolEvidenceAfterWrite(state, toolId) {
      return isActivityCursorAfter(
        getLatestSuccessfulActivityCursor(state, toolId),
        getLatestSuccessfulActivityCursor(state, 'write_file'),
      );
    }

    function hasQualityEvidenceMismatch(errors) {
      return errors.some((entry) => /quality_gate_failed:(missing_tool_evidence|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch):/i.test(entry));
    }


    function buildDesktopObservationToolPrompt() {
      const successfulRunIds = getRecentSuccessfulInvocationIds(scenarioState, 'run_command', 6);  
      const blockedCommands = getFailedToolActivitiesById(scenarioState, 'run_command')  
        .filter((activity) => /blocked by the builtin run_command safety policy/i.test(activity?.detail ?? ''))  
        .map((activity) => activity?.argumentsSummary ?? '')  
        .filter(Boolean);  
      const reportRepairNeeded = invalidOutputErrors.some((entry) => /quality_gate_failed:(report_missing_(?:fact|observation)|tool_output_mismatch|tool_regex_unmatched|fact_value_mismatch|missing_desktop_observations|invalid_desktop_observation_json):/i.test(entry));
      const evidenceMismatchNeedsFreshRun = hasQualityEvidenceMismatch(invalidOutputErrors)
        && !hasFreshSuccessfulToolEvidenceAfterWrite(scenarioState, 'run_command');
      if (hasDesktopObservationEvidence(scenarioState) && successfulRunIds.length > 0 && evidenceMismatchNeedsFreshRun) {
        const latestEvidenceExcerpt = buildToolInvocationResultExcerpt(
          scenarioState,
          successfulRunIds[successfulRunIds.length - 1],
        );
        return createContinueInstruction([
          buildJsonToolCallPrelude(),
          `Existing desktop-observation evidence did not satisfy the quality gate after the latest report write. Successful run_command invocation ids already exist: ${successfulRunIds.join(', ')}.`,
          latestEvidenceExcerpt,
          'Do not rewrite reports/desktop-observation.md or quality/desktop-observation.json yet.',
          'Emit fresh, narrow Windows run_command JSON tool objects first so the next turn can cite short, untruncated output.',
          'Use direct PowerShell command text, not nested "powershell -Command".',
          'Do not use a broad Get-Process dump unless it is filtered or limited enough that every value you plan to cite is visible in the stored tool output.',
          'Use observed values exactly as printed, including localization and casing. Do not translate window titles, process names, or field values before citing them.',
          'Good command shapes include filtering to desktop-facing processes, filtering to non-empty MainWindowTitle values, or sorting top processes with Select-Object -First.',
          `Repair these exact quality failures after fresh evidence exists: ${invalidOutputErrors.join('; ') || 'desktop observation evidence mismatch'}.`,
        ].filter(Boolean).join(' '), {
          phase: 'desktop_observation_refresh_evidence',
          targetPaths: ['reports/desktop-observation.md', 'quality/desktop-observation.json'],
          allowedTools: ['run_command'],
          uniqueKey: 'desktop_observation:refresh-evidence-after-mismatch',
        });
      }
      if (hasDesktopObservationEvidence(scenarioState) && successfulRunIds.length > 0) {
        return [
          buildWriteOnlyRepairPrelude(['reports/desktop-observation.md', 'quality/desktop-observation.json']),
          `You already have successful desktop-observation evidence in this thread from invocation ids: ${successfulRunIds.join(', ')}.`,
          'Do not emit run_command or broad read_file calls in this turn. Use the fresh evidence that already exists in this thread and emit write_file for reports/desktop-observation.md and quality/desktop-observation.json now.',
          'The quality JSON must contain observations[] with sourceInvocationId mappings that cite the real run_command invocation ids.',
          reportRepairNeeded
            ? `Repair these exact quality failures in the rewritten report or quality JSON: ${invalidOutputErrors.join('; ')}.`
            : null,
        ].join(' ');  
      }  
      return [  
        buildJsonToolCallPrelude(),  
        'Use direct PowerShell command text, not nested "powershell -Command".',  
        'Use commands that still succeed when some applications are absent.',  
        ...(blockedCommands.length > 0  
          ? [`Do not repeat blocked commands such as: ${blockedCommands.slice(0, 2).join(' ; ')}.`]  
          : []),  
        'Do not use Linux-only commands such as uname on this Windows host.',  
        'Example objects:',  
        '{"tool":"run_command","command":"Get-Process | Where-Object { $_.ProcessName -in @(\'explorer\',\'Code\',\'msedge\',\'chrome\') } | Select-Object -First 10 ProcessName,Responding,CPU,WS,MainWindowTitle","timeout_ms":30000}',  
        '{"tool":"run_command","command":"Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object -First 10 ProcessName,MainWindowTitle,Responding","timeout_ms":30000}',
        '{"tool":"run_command","command":"Get-Process | Sort-Object CPU -Descending | Select-Object -First 12 ProcessName,Id,CPU,WS,MainWindowTitle","timeout_ms":30000}',
        'After successful commands exist, emit write_file for reports/desktop-observation.md and quality/desktop-observation.json with observations[] mappings that cite the real invocation ids.',
        'quality/desktop-observation.json must remain valid JSON; escape backslashes inside sourceRegex values.',
        'Use observation names tied to real desktop/application evidence, such as visible_window_processes, responding_desktop_processes, or top_processes_with_window_titles. Do not invent memory, CPU, or disk facts for this desktop follow-up.',
        'The next turn can summarize after successful command evidence exists.',
      ].join(' ');
    }
  
    function buildDatabaseLabScaffoldPrompt() {
      const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);
      const existingDesignDocCount = DATABASE_LAB_REQUIRED_DESIGN_FILES
        .filter((relativePath) => workspaceFiles.includes(relativePath))
        .length;
      const designDocBatchSize = 1;
      const prototypeTopLevelBatchSize = 1;
      const prototypeModuleBatchSize = 1;
      const missingDesignFiles = getMissingWorkspaceFiles(scenarioState, DATABASE_LAB_REQUIRED_DESIGN_FILES);  
      const nextDesignDocTargets = getDatabaseLabNextDesignDocTargets(scenarioState, designDocBatchSize);  
      const existingPrototypeSrcFiles = workspaceFiles  
        .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));  
      const missingPrototypeFiles = getMissingWorkspaceFiles(scenarioState, DATABASE_LAB_REQUIRED_PROTOTYPE_FILES);  
      const nextPrototypeTopLevelTargets = getDatabaseLabNextPrototypeTopLevelTargets(scenarioState, prototypeTopLevelBatchSize)  
        .slice(0, prototypeTopLevelBatchSize);  
      const benchRequiredModuleFiles = getScenarioBenchRequiredModuleFiles(scenarioState, {  
        fallbackToDefaultWhenEmpty: !hasWorkspaceFiles(scenarioState, [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]),  
        includeCoreModuleBaseline: true,  
      });  
      const missingBenchDependencyModules = benchRequiredModuleFiles.length > 0  
        ? getMissingWorkspaceFiles(scenarioState, benchRequiredModuleFiles)  
        : [];  
      const nextPrototypeModuleTargets = (  
        missingBenchDependencyModules.length > 0  
          ? missingBenchDependencyModules  
          : getDatabaseLabNextPrototypeModuleTargets(scenarioState, prototypeModuleBatchSize, benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES)  
      ).slice(0, prototypeModuleBatchSize);  
      const prototypeNeedsMoreDepth = existingPrototypeSrcFiles.length < 2 || missingBenchDependencyModules.length > 0;  
      const qualityFileMissing = !hasWorkspaceFiles(scenarioState, [DATABASE_LAB_DESIGN_QUALITY_FILE]);  
      const briefAlreadyRead = countSuccessfulReadActivities(scenarioState, /^brief\//i) >= 3;  
      const qualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];  
      const shallowModuleChecks = qualityFailedChecks.filter((entry) =>  
        entry.startsWith('module_too_shallow:')  
        || entry.startsWith('stub_module:')  
        || entry.startsWith('manifest_references_missing_implemented_module:')  
      );  
      const shallowModuleTargets = shallowModuleChecks  
        .map((entry) => entry.split(':').slice(1).join(':'))  
        .filter((value) => typeof value === 'string' && value.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));  
      const benchmarkMetricKeysRepairNeeded =  
        invalidOutputErrors.includes('quality_gate_failed:benchmark_scaffold_missing_required_metric_keys')  
        || qualityFailedChecks.includes('benchmark_scaffold_missing_required_metric_keys');  
      const manifestMissing =  
        invalidOutputErrors.includes('quality_gate_failed:missing_database_design_manifest')  
        || qualityFailedChecks.includes('missing_database_design_manifest');  
      const implementedModulesInsufficient =  
        invalidOutputErrors.includes('quality_gate_failed:insufficient_implemented_modules')  
        || qualityFailedChecks.includes('insufficient_implemented_modules');  
      const manifestReferenceRepairChecks = qualityFailedChecks.filter((entry) =>  
        entry.startsWith('manifest_references_missing_file:')  
        || entry.startsWith('manifest_references_missing_implemented_module:')  
      );  
      const manifestReferenceRepairTargets = manifestReferenceRepairChecks  
        .map((entry) => entry.split(':').slice(1).join(':'))  
        .filter(Boolean);  
      const benchNotWiredToPrototypeModules = hasWorkspaceFiles(scenarioState, [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`])
        && existingPrototypeSrcFiles.length > 0
        && benchRequiredModuleFiles.length === 0;
      const latestBenchFailure = getLatestDatabaseBenchRunFailure(scenarioState);
      const packageEntryDiagnostics = getDatabaseLabPackageEntryDiagnostics(scenarioState.workspaceDir);
      const prototypeCodeDiagnostics = getDatabaseLabPrototypeCodeDiagnostics(scenarioState);
      const existingDesignDocFiles = getDatabaseLabExistingDesignFiles(scenarioState);
      const artifactProgress = buildDatabaseArtifactProgress(workspaceFiles, {
        benchRequiredModuleFiles,
        packageEntryDiagnostics,
        scenarioId: spec.id,
      });
      const benchmarkSelfCheckAttempted = artifactProgress?.benchmarkSelfCheck?.attempted === true;
      const benchmarkSelfCheckPassed = artifactProgress?.benchmarkSelfCheck?.passed === true;
      const successfulBenchRunSatisfied =
        hasSuccessfulDatabaseBenchRunEvidence(scenarioState)
        || benchmarkSelfCheckPassed;
      const brokenPackageEntryRefs = Array.isArray(packageEntryDiagnostics.missingEntryRefs)  
        ? packageEntryDiagnostics.missingEntryRefs  
        : [];  
      const blockingPackageEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {  
        scenarioId: spec.id,  
      });  
      const missingRequiredPackageEntries = Array.isArray(packageEntryDiagnostics.missingRequiredEntries)  
        ? packageEntryDiagnostics.missingRequiredEntries  
        : [];  
      const manifestRepairNeeded =  
        qualityFileMissing  
        || manifestMissing  
        || implementedModulesInsufficient  
        || manifestReferenceRepairChecks.length > 0;  
      const benchmarkSelfCheckFailureSignalsPresent =  
        latestBenchFailure !== null  
        || qualityFailedChecks.includes('benchmark_self_check_failed')  
        || qualityFailedChecks.includes('benchmark_self_check_output_invalid')  
        || qualityFailedChecks.includes('benchmark_self_check_stale')  
        || invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_failed')  
        || invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_output_invalid')  
        || invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_stale');  
      const benchmarkSelfCheckObservedInThread = hasObservedDatabaseBenchRunAttempt(scenarioState);  
      const benchmarkSelfCheckObserved =  
        benchmarkSelfCheckAttempted  
        || benchmarkSelfCheckFailureSignalsPresent  
        || benchmarkSelfCheckObservedInThread;  
      const prototypeCodeRepairTargets = Array.from(new Set([  
        ...prototypeCodeDiagnostics.failedChecks  
          .filter((entry) => entry.startsWith('javascript_syntax_error:'))  
          .map((entry) => entry.split(':').slice(1).join(':'))  
          .filter(Boolean),  
        ...prototypeCodeDiagnostics.failedChecks  
          .filter((entry) => entry.startsWith('undeclared_node_builtin:'))  
          .map((entry) => entry.split(':').slice(1, 2).join(':'))  
          .filter(Boolean),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch')  
          ? [  
            `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
            ...benchRequiredModuleFiles,  
          ]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_'))  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]  
          : []),  
        ...prototypeCodeDiagnostics.failedChecks  
          .filter((entry) => entry.startsWith('bench_module_export_mismatch:'))  
          .flatMap((entry) => {  
            const relativePath = entry.split(':').slice(1).join(':');  
            return relativePath ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, relativePath] : [];  
          }),  
        ...prototypeCodeDiagnostics.failedChecks  
          .filter((entry) => entry.startsWith('bench_module_export_name_mismatch:') || entry.startsWith('bench_module_api_mismatch:'))  
          .flatMap((entry) => {  
            const relativePath = entry.split(':').slice(1, 2).join(':');  
            return relativePath ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, relativePath] : [];  
          }),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.some((entry) =>  
          entry.startsWith('bench_storage_engine_async_usage_mismatch:')  
          || entry === 'bench_storage_engine_open_missing'  
          || entry === 'bench_storage_engine_initialize_missing'
          || entry === 'bench_storage_page_size_mismatch'
          || entry === 'bench_storage_table_lifecycle_missing'
          || entry.startsWith('bench_storage_engine_arg_mismatch:')
          || entry.startsWith('bench_storage_engine_table_name_mismatch:')
        )
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
          : []),

        ...(prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')  
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))  
          ? [  
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,  
          ]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]  
          : []),  
        ...prototypeCodeDiagnostics.failedChecks  
          .filter((entry) => entry.startsWith('prototype_undeclared_external_dependency_source:'))  
          .flatMap((entry) => {  
            const relativePath = entry.split(':').slice(1, 2).join(':');  
            return relativePath  
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`, relativePath]  
              : [];  
          }),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')  
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))  
          ? [  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`,  
          ]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')  
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))  
          ? [  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,  
          ]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js`]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]  
          : []),  
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')  
          || prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')  
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]  
          : []),  
        ...(benchmarkMetricKeysRepairNeeded
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]
          : []),
      ]));
      const syntaxRepairTargets = Array.from(new Set(
        prototypeCodeDiagnostics.failedChecks
          .filter((entry) => entry.startsWith('javascript_syntax_error:'))
          .map((entry) => entry.split(':').slice(1).join(':'))
          .filter(Boolean),
      ));
      const buildPrototypeRepairSourceBlocks = (relativePaths, limit = 6) => buildEmbeddedSourceBlocks(  
        scenarioState,  
        Array.from(new Set(  
          (Array.isArray(relativePaths) ? relativePaths : [])  
            .filter((relativePath) => typeof relativePath === 'string' && /\.(?:js|json|md)$/i.test(relativePath))  
            .slice(0, limit),  
        )),  
      );  
      const prototypePreBenchmarkDependencyRepairNeeded = prototypeCodeDiagnostics.failedChecks  
        .some((entry) => entry.startsWith('prototype_undeclared_external_dependency_source:'));  
      const prototypePreBenchmarkOutputRepairNeeded =
        prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_output_extra_stdout_logs')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
        || benchmarkMetricKeysRepairNeeded;
      const prototypePreBenchmarkHardBlocker =
        syntaxRepairTargets.length > 0
        || prototypePreBenchmarkDependencyRepairNeeded
        || prototypePreBenchmarkOutputRepairNeeded
        || prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch')
        || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('undeclared_node_builtin:'));
      const corePrototypeReadyForRepair =  
        artifactProgress.prototypeModules.completed  
        && hasDatabaseLabRequiredWorkspaceShape(scenarioState)  
        && missingBenchDependencyModules.length === 0;  
      const hasFocusedDatabaseRepairSignal =  
        corePrototypeReadyForRepair  
        && (  
          prototypeCodeDiagnostics.failedChecks.length > 0  
          || latestBenchFailure !== null  
          || successfulBenchRunSatisfied  
          || qualityFailedChecks.some((entry) =>  
            typeof entry === 'string'  
            && !entry.startsWith('missing_core_module:')  
            && !entry.startsWith('benchmark_dependency_missing:')  
            && entry !== 'insufficient_implemented_modules'  
            && entry !== 'missing_database_design_manifest'  
          )  
          || invalidOutputErrors.some((entry) =>  
            typeof entry === 'string'  
            && !entry.startsWith('quality_gate_failed:missing_core_module:')  
            && !entry.startsWith('quality_gate_failed:benchmark_dependency_missing:')  
            && entry !== 'quality_gate_failed:insufficient_implemented_modules'  
            && entry !== 'quality_gate_failed:missing_database_design_manifest'  
          )  
        );  
      const prototypeRepairOrBenchmarkReady =  
        corePrototypeReadyForRepair || hasFocusedDatabaseRepairSignal;  
      const buildPrototypeModulesInstruction = () => {  
        const targetPaths = Array.from(new Set(nextPrototypeModuleTargets));  
        const deferPackageEntryRepairs = missingBenchDependencyModules.length > 0;  
        const deferredPrototypeModulePaths = Array.from(new Set(  
          (benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES)  
            .filter((relativePath) => !targetPaths.includes(relativePath)),  
        ));  
        const companionPrototypeEntryTargets = (deferPackageEntryRepairs ? [] : blockingPackageEntryRefs)  
          .map((entryRef) => getDatabasePrototypePathFromPackageEntryRef(entryRef))  
          .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));  
        const repairPaths = Array.from(new Set([  
          ...targetPaths,  
          ...companionPrototypeEntryTargets,  
          ...(!deferPackageEntryRepairs && blockingPackageEntryRefs.length > 0 ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`] : []),  
        ]));  
        return buildDatabaseLabContinueInstruction([  
          buildWriteOnlyRepairPrelude(repairPaths, {  
            forbiddenWritePaths: manifestRepairNeeded ? [] : [DATABASE_LAB_DESIGN_QUALITY_FILE],  
          }),  
          'The design docs and prototype top-level files already exist. Do not rewrite them in this turn.',  
          'Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',  
          `Write only these concrete implementation modules now so ${DATABASE_LAB_PROTOTYPE_DIR}/src/ reaches real runnable depth: ${targetPaths.join(', ')}.`,  
          `This batch is selected from the benchmark-critical prototype modules: ${(benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : targetPaths).join(', ')}.`,  
          `Use the exact canonical prototype module filenames listed in this batch. Do not substitute legacy aliases such as ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal.js or ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree.js.`,  
          deferredPrototypeModulePaths.length > 0  
            ? `Do not rewrite design docs or jump to every remaining src module in one turn. Leave these remaining benchmark-related src files for the next repair pass unless you must touch one to keep the constructor or method contract coherent with the targeted files: ${deferredPrototypeModulePaths.join(', ')}.`  
            : 'If you need to touch any other src file beyond this batch, do it only to keep a constructor or method contract coherent with the targeted files.',  
          'Each module must contain runnable logic, not placeholders or TODO stubs.',  
          'Keep the module APIs simple and directly usable by the benchmark scaffold.',  
          `Export each prototype module with named CommonJS bindings, for example module.exports = { StorageEngine }, module.exports = { BufferPool }, and keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js aligned with those named imports.`,  
          !deferPackageEntryRepairs && blockingPackageEntryRefs.length > 0  
            ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json so these blocking entry refs no longer point at missing files: ${blockingPackageEntryRefs.join(', ')}.`  
            : null,  
          manifestRepairNeeded  
            ? `If runtime acceptance still requires ${DATABASE_LAB_DESIGN_QUALITY_FILE} after this batch, you may also write or repair it in this turn, but only if designFiles, prototypeFiles, and implementedModules match the real files already on disk after the current module writes.`  
            : `Do not write ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn. The design manifest belongs to the next phase only, after the core prototype modules are complete and the benchmark self-check succeeds.`,  
          'Because this batch lands only part of the remaining core module set, the final tracker must use exactly status IN_PROGRESS and decision CONTINUE. Do not use COMPLETE until every required core module exists and the benchmark self-check has passed.',  
        ], {  
          phase: 'prototype_modules',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: repairPaths,  
          allowedWritePaths: repairPaths,  
          forbiddenWritePaths: manifestRepairNeeded ? [] : [DATABASE_LAB_DESIGN_QUALITY_FILE],  
          allowedOptionalPaths: manifestRepairNeeded ? [DATABASE_LAB_DESIGN_QUALITY_FILE] : [],  
          requiredTrackerStatus: 'IN_PROGRESS',  
          requiredTrackerDecision: 'CONTINUE',  
          uniqueKey: `database_lab:prototype_modules:${repairPaths.join('|')}`,  
        });  
      };  
      if (briefAlreadyRead && !artifactProgress.designDocs.completed) {  
        const targetPaths = nextDesignDocTargets;  
        const optionalDesignDocPaths = DATABASE_LAB_REQUIRED_DESIGN_FILES  
          .filter((relativePath) => !targetPaths.includes(relativePath));  
        return buildDatabaseLabContinueInstruction([  
          buildWriteOnlyRepairPrelude(nextDesignDocTargets),  
          'The seeded brief files were already read successfully. Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',  
          `Write only this next narrow batch of missing design docs now under ${DATABASE_LAB_DESIGN_DIR}/: ${nextDesignDocTargets.join(', ')}.`,  
          missingDesignFiles.length > nextDesignDocTargets.length  
            ? `Do not try to finish all remaining design docs in this turn. Leave the remaining files for the next repair pass: ${missingDesignFiles.slice(nextDesignDocTargets.length).join(', ')}.`  
            : 'This batch covers all remaining required design docs. If it succeeds, the next turn must continue with prototype top-level files.',  
          existingDesignDocCount === 0
            ? 'This is the first design-doc write turn. Land only the listed file content and do not move into prototype files in this turn.'
            : 'Keep this batch narrow. Land only the listed file contents in this turn.',
          'Ground every claim in the already-read brief files.',
          'Cover only the sections that belong in the targeted file(s). Leave prototype files and the design manifest for later turns.',
          `Do not invent additional design document filenames. Put transaction, concurrency, recovery, index, and SQL notes inside the canonical target files only: ${DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}.`,
          'Do not claim measured MySQL parity. Keep it as a target profile and keep unproven areas explicit.',
        ], {
          phase: 'design_docs',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths,  
          allowedOptionalPaths: optionalDesignDocPaths,  
          uniqueKey: `database_lab:design_docs:${targetPaths.join('|')}`,  
        });  
      }
      if (briefAlreadyRead && !artifactProgress.prototypeModules.completed && benchmarkSelfCheckObserved) {
        return buildPrototypeModulesInstruction();
      }
      if (briefAlreadyRead && !artifactProgress.prototypeTopLevel.completed) {
        const targetPaths = missingRequiredPackageEntries.length > 0
          ? Array.from(new Set([
            `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,
            ...(workspaceFiles.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`) ? [] : [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]),
          ])).slice(0, prototypeTopLevelBatchSize)
          : blockingPackageEntryRefs.length > 0
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`]
          : nextPrototypeTopLevelTargets.length > 0
            ? nextPrototypeTopLevelTargets
            : artifactProgress.prototypeTopLevel.missing
              .filter((entry) => !entry.startsWith('package-entry:') && !entry.startsWith('package-entry-ref:'))
              .slice(0, prototypeTopLevelBatchSize);
        const topLevelAllowedOptionalPaths = Array.from(new Set([  
          ...(manifestRepairNeeded ? [DATABASE_LAB_DESIGN_QUALITY_FILE] : []),  
          ...(targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)  
            ? (benchRequiredModuleFiles.length > 0 ? benchRequiredModuleFiles : DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES)  
            : []),  
        ]));  
        return buildDatabaseLabContinueInstruction([  
          buildWriteOnlyRepairPrelude(targetPaths),  
          'The required design docs already exist under database-lab/design/. Do not rewrite them in this turn.',  
          'Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',  
          `Write only this next narrow batch of missing prototype top-level files now under ${DATABASE_LAB_PROTOTYPE_DIR}/: ${targetPaths.join(', ')}.`,  
          missingPrototypeFiles.length > targetPaths.length  
            ? `Do not try to finish all remaining prototype top-level files in this turn. Leave the remaining files for the next repair pass: ${missingPrototypeFiles.slice(targetPaths.length).join(', ')}.`  
            : 'If this batch succeeds, the next turn can continue with the remaining prototype files or src modules.',  
          'The prototype package.json must not point main, build, or dry-run at invented files such as src/index.js unless those files are written in the same turn.',  
          'package.json must declare either scripts.bench or scripts["dry-run"], and that script must point to a real prototype entrypoint such as node scripts/bench.js.',  
          'If package.json declares bench or dry-run scripts, they must reference real prototype files only.',  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`)  
            ? `When writing ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, prefer write_file.arguments.content_json so the runtime can pretty-print a real JSON object instead of relying on one large escaped string.`  
            : null,  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/README.md`)  
            ? `When writing ${DATABASE_LAB_PROTOTYPE_DIR}/README.md, prefer write_file.arguments.content_lines as an array of markdown lines instead of one large escaped string.`  
            : null,  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)  
            ? `When writing ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js, prefer write_file.arguments.content_lines as an array of source lines instead of one giant escaped script string.`  
            : null,  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)  
            ? `When ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js imports benchmark-critical modules, use these exact canonical files only: ${DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES.join(', ')}. Do not create or import legacy alias files such as ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal.js or ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree.js.`  
            : null,  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)  
            ? `The dry-run scaffold must exercise the full core prototype module set, not only storage and buffer helpers. Keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js aligned with all five canonical runtime modules: ${DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES.join(', ')}.`  
            : null,  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)  
            ? `When ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js imports prototype modules, use named CommonJS destructuring that matches module.exports = { ClassName }, for example const { StorageEngine } = require('../src/storage-engine.js'). Do not default-import a module that exports named bindings.`  
            : null,  
          missingRequiredPackageEntries.length > 0
            ? `Repair these package entry requirements now: ${missingRequiredPackageEntries.join(', ')}.`
            : null,
          blockingPackageEntryRefs.length > 0
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json so declared package entries point only at real files or are removed: ${blockingPackageEntryRefs.join(', ')}.`
            : null,
          'Keep the README honest about what is implemented versus still unproven about MySQL-nearness.',  
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
            ? `If you write ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js in this turn, export a dryRun-capable entrypoint that returns top-level status, summary, and metrics keys. metrics must include at least pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
            : null,
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)
            ? 'The bench CLI must print exactly one JSON.stringify(result) payload to stdout for --dry-run. Do not print banner logs, phase logs, or explanatory prose before or after the JSON payload.'
            : null,
          targetPaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`)  
            ? 'Do not aggregate worker results by spread-pushing large latency arrays or using Math.max(...largeArray). Aggregate incrementally so the dry-run scaffold cannot blow the stack.'  
            : null,  
          manifestRepairNeeded  
            ? `If runtime acceptance still requires ${DATABASE_LAB_DESIGN_QUALITY_FILE} after this top-level batch, you may also write or repair it in this turn, but only if it stays honest about the still-missing prototype src modules and matches the real files on disk.`  
            : `Do not write ${DATABASE_LAB_DESIGN_QUALITY_FILE} yet. Finish the prototype src module phase first, then write the design manifest in the next phase.`,  
        ], {  
          phase: 'prototype_top_level',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths,  
          allowedOptionalPaths: topLevelAllowedOptionalPaths,  
          uniqueKey: `database_lab:prototype_top_level:${targetPaths.join('|')}`,  
        });  
      }  
      if (briefAlreadyRead && !artifactProgress.prototypeModules.completed && !prototypeRepairOrBenchmarkReady) {  
        return buildPrototypeModulesInstruction();  
      }  
      if (briefAlreadyRead && artifactProgress.prototypeModules.completed && benchNotWiredToPrototypeModules) {  
        const repairPaths = Array.from(new Set([  
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
          ...(brokenPackageEntryRefs.length > 0 ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`] : []),  
        ]));  
        return buildDatabaseLabContinueInstruction([  
          buildWriteOnlyRepairPrelude(repairPaths),  
          'The prototype source modules already exist, but the current benchmark scaffold is still placeholder-only and does not call them.',  
          'Do not emit run_command, read_file, search_files, or list_files in this turn.',  
          `Rewrite ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it imports and exercises these real modules: ${existingPrototypeSrcFiles.join(', ')}.`,  
          'Remove placeholder-only in-memory store logic. The dry-run benchmark must execute the real prototype module APIs that already exist.',  
          `The dryRun result must expose top-level status, summary, and metrics. metrics must include pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`,  
          'Aggregate incrementally. Do not spread-push large latency arrays or use Math.max(...largeArray) over worker output.',  
          brokenPackageEntryRefs.length > 0  
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json in the same turn so these broken entry refs are removed or pointed at real files: ${brokenPackageEntryRefs.join(', ')}.`  
            : null,  
          `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless a module path changed. Keep the next repair focused on the benchmark scaffold itself.`,  
        ], {  
          phase: 'bench_scaffold_repair',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: repairPaths,  
          uniqueKey: `database_lab:bench_scaffold_repair:${repairPaths.join('|')}`,  
        });  
      }  
      if (briefAlreadyRead && manifestRepairNeeded && artifactProgress.prototypeModules.completed && successfulBenchRunSatisfied) {  
        const prototypeManifestTargets = Array.from(new Set([  
          ...workspaceFiles.filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),  
        ]));  
        return buildDatabaseLabContinueInstruction([  
          buildWriteOnlyRepairPrelude([DATABASE_LAB_DESIGN_QUALITY_FILE]),
          'The design docs and prototype scaffold already exist. Do not rewrite them in this turn.',
          'The dry-run benchmark already passed; the remaining blocker is the grounded design manifest.',
          'Do not emit read_file, create_folder, search_files, list_files, or run_command in this turn.',
          `Write only ${DATABASE_LAB_DESIGN_QUALITY_FILE} now. It must include designFiles, prototypeFiles, implementedModules, and claimBoundaries that match the real files currently present under database-lab/.`,
          manifestReferenceRepairTargets.length > 0  
            ? `Remove or repair these stale manifest references now: ${manifestReferenceRepairTargets.join(', ')}. Do not invent files that are not on disk.`  
            : null,  
          `designFiles must be a subset of the real design markdown files already on disk under ${DATABASE_LAB_DESIGN_DIR}/: ${existingDesignDocFiles.join(', ') || 'none yet'}. Do not invent extra design files such as indexing.md, transactions.md, wal-recovery.md, or buffer-pool.md unless you actually wrote them in the same turn, which this repair does not allow.`,  
          `prototypeFiles must match only the real files currently present under ${DATABASE_LAB_PROTOTYPE_DIR}/: ${prototypeManifestTargets.join(', ') || 'none yet'}.`,  
          `implementedModules must point only to real files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/: ${existingPrototypeSrcFiles.join(', ') || 'none yet'}. Do not claim ${DATABASE_LAB_PROTOTYPE_DIR}/src/engine.js unless that file truly exists on disk.`,  
        ], {  
          phase: 'design_manifest',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],  
          uniqueKey: 'database_lab:design_manifest:quality/database-design.json',  
        });  
      }  
      if (briefAlreadyRead && artifactProgress.prototypeModules.completed && successfulBenchRunSatisfied && shallowModuleTargets.length > 0) {  
        const shallowBenchModules = shallowModuleTargets.filter((relativePath) => benchRequiredModuleFiles.includes(relativePath));  
        const manifestOnlyTargets = shallowModuleTargets.filter((relativePath) => !benchRequiredModuleFiles.includes(relativePath));  
        const repairPaths = Array.from(new Set([  
          DATABASE_LAB_DESIGN_QUALITY_FILE,  
          ...shallowBenchModules,  
        ]));  
        return buildDatabaseLabContinueInstruction([  
          buildWriteOnlyRepairPrelude(repairPaths),  
          'The dry-run benchmark already succeeded. Do not rerun it in this turn unless you change database-lab/prototype/scripts/bench.js or one of the benchmark-imported prototype modules.',  
          `Repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} now so implementedModules only claims real runtime modules that are non-stub and non-shallow.`,  
          manifestOnlyTargets.length > 0  
            ? `These cited modules are currently too shallow for implementedModules and are not required by the benchmark import chain: ${manifestOnlyTargets.join(', ')}. If they are only barrel exports or thin wrappers, remove them from implementedModules instead of padding them with filler code.`  
            : null,  
          shallowBenchModules.length > 0  
            ? `These cited modules are benchmark-critical and still too shallow: ${shallowBenchModules.join(', ')}. Expand them into real runnable logic in this turn and keep ${DATABASE_LAB_DESIGN_QUALITY_FILE} aligned with the repaired files.`  
            : null,  
          'Do not rewrite the design docs or the full scaffold in this turn.',  
          'Keep prototypeFiles accurate, but use implementedModules only for the src files that actually contain substantive runnable database behavior.',  
          `If ${DATABASE_LAB_DESIGN_QUALITY_FILE} currently lists a shallow index/barrel file such as ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js, drop it from implementedModules unless you genuinely expand it into real runtime logic in this same turn.`,  
        ], {  
          phase: 'design_quality_repair',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: repairPaths,  
          uniqueKey: `database_lab:design_quality_repair:${repairPaths.join('|')}`,  
        });  
      }  
      if (  
        briefAlreadyRead  
        && hasDatabaseLabRequiredWorkspaceShape(scenarioState)  
        && artifactProgress.prototypeModules.completed  
        && !successfulBenchRunSatisfied  
        && (missingBenchDependencyModules.length === 0 || hasFocusedDatabaseRepairSignal)  
      ) {  
        const benchFailureExcerpt = latestBenchFailure
          ? buildToolInvocationResultExcerpt(scenarioState, latestBenchFailure.activityId)  
          : null;  
        const prototypeModuleSystemMismatch =  
          prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch');  
        if (!benchmarkSelfCheckObserved && syntaxRepairTargets.length > 0) {  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(syntaxRepairTargets);  
          return buildDatabaseLabContinueInstruction([  
            buildWriteOnlyRepairPrelude(syntaxRepairTargets),  
            'The current prototype scaffold is blocked by JavaScript syntax errors in files that already exist on disk.',  
            `Repair only these syntax-broken files now so they parse as valid CommonJS JavaScript: ${syntaxRepairTargets.join(', ')}.`,  
            `Do not emit read_file, list_files, search_files, create_folder, or run_command in this turn. Use the embedded file contents directly and rewrite only the cited files.`,  
            ...prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) =>  
              syntaxRepairTargets.some((relativePath) => entry.includes(relativePath)),  
            ),  
            ...(repairSourceBlocks.length > 0  
              ? [  
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',  
                ...repairSourceBlocks,  
              ]  
              : []),  
            `Keep constructor signatures, exports, and benchmark-facing method names coherent while you repair syntax. Do not invent new module paths.`,  
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files.`,  
            'Do not emit run_command in this repair turn. After the syntax errors are fixed, the next turn can continue the narrower prototype contract or benchmark repair flow.',  
          ], {  
            phase: 'prototype_syntax_repair',  
            phaseCursor: artifactProgress.nextStage,  
            targetPaths: syntaxRepairTargets,  
            allowedOptionalPaths: syntaxRepairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))  
              ? [DATABASE_LAB_DESIGN_QUALITY_FILE]  
              : [],  
            uniqueKey: `database_lab:prototype_syntax_repair:${syntaxRepairTargets.join('|')}`,  
          });  
        }  
        if (!benchmarkSelfCheckObserved && prototypeModuleSystemMismatch) {  
          const repairTargets = Array.from(new Set([  
            `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
            ...benchRequiredModuleFiles,  
          ]));  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);  
          return buildDatabaseLabContinueInstruction([  
            buildWriteOnlyRepairPrelude(repairTargets),  
            'The benchmark scaffold is blocked by a prototype package and JavaScript module-system mismatch before a meaningful dry-run can execute.',  
            `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json and the cited benchmark files so the scaffold uses one coherent module system end-to-end before the next benchmark self-check.`,  
            `Prefer CommonJS for this scaffold: remove "type": "module" from ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, keep module.exports in the prototype src files, and keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js on named require destructuring such as const { StorageEngine } = require('../src/storage-engine.js').`,  
            'If you choose ESM instead, then convert every cited file consistently to import/export syntax and keep package scripts pointing at the real entrypoint files. Do not leave a mixed contract.',  
            prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')  
              ? `While repairing ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js, also instantiate and call the real StorageEngine and BufferPool modules instead of placeholder counter loops. A benchmark that only imports modules but never exercises them is not acceptable.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')  
              ? `Keep the dryRun result machine-readable with top-level status, summary, and metrics keys after the module-system fix.`  
              : null,  
            benchmarkMetricKeysRepairNeeded  
              ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so the result metrics include exactly pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`  
              : null,  
            ...(repairSourceBlocks.length > 0  
              ? [  
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',  
                ...repairSourceBlocks,  
              ]  
              : []),  
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the package and benchmark contract first.`,  
            'Do not emit run_command in this repair turn. After the module-system fix lands, the next turn can rerun the dry-run benchmark.',  
          ].filter(Boolean), {
            phase: 'bench_module_system_repair',
            phaseCursor: artifactProgress.nextStage,
            targetPaths: repairTargets,
            allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {
              artifactProgress,  
              packageEntryDiagnostics,  
              scenarioId: spec.id,  
            }),  
            uniqueKey: `database_lab:bench_module_system_repair:${repairTargets.join('|')}`,  
          });  
        }  
        if (
          !benchmarkSelfCheckObserved
          && !prototypePreBenchmarkHardBlocker
        ) {
          return buildDatabaseLabContinueInstruction([
            buildJsonToolCallPrelude(),
            `The design docs, prototype top-level files, and initial src modules already exist under ${DATABASE_LAB_ROOT}/.`,  
            `Do not reread brief/* and do not rewrite the scaffold in this turn.`,  
            'Run one real benchmark self-check now before any speculative prototype contract repair.',  
            `Run the dry-run benchmark from ${DATABASE_LAB_PROTOTYPE_DIR} and keep the exact stdout/stderr. The next repair turn must use the real command result instead of static guesswork.`,  
            prototypeCodeDiagnostics.failedChecks.length > 0  
              ? `Static inspection already sees likely prototype issues (${prototypeCodeDiagnostics.failedChecks.join(', ')}), but do not repair them yet in this turn. First capture the real benchmark failure surface.`  
              : null,  
            'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
            'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
            'If the dry-run fails, keep the exact stderr and do not claim design completion.',  
            'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',  
          ], {  
            phase: 'benchmark_self_check',  
            phaseCursor: artifactProgress.nextStage,  
            targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],  
            uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',  
          });  
        }  
        if (prototypeCodeDiagnostics.failedChecks.length > 0 && !latestBenchFailure) {  
          if (syntaxRepairTargets.length > 0) {  
            const repairSourceBlocks = buildPrototypeRepairSourceBlocks(syntaxRepairTargets);  
            return buildDatabaseLabContinueInstruction([  
              buildWriteOnlyRepairPrelude(syntaxRepairTargets),  
              'The current prototype scaffold is blocked by JavaScript syntax errors in files that already exist on disk.',  
              `Repair only these syntax-broken files now so they parse as valid CommonJS JavaScript: ${syntaxRepairTargets.join(', ')}.`,  
              `Do not emit read_file, list_files, search_files, create_folder, or run_command in this turn. Use the embedded file contents directly and rewrite only the cited files.`,  
              ...prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) =>  
                syntaxRepairTargets.some((relativePath) => entry.includes(relativePath)),  
              ),  
              ...(repairSourceBlocks.length > 0  
                ? [  
                  'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',  
                  ...repairSourceBlocks,  
                ]  
                : []),  
              `Keep constructor signatures, exports, and benchmark-facing method names coherent while you repair syntax. Do not invent new module paths.`,  
              `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files.`,  
              'Do not emit run_command in this repair turn. After the syntax errors are fixed, the next turn can continue the narrower prototype contract or benchmark repair flow.',  
            ], {  
              phase: 'prototype_syntax_repair',  
              phaseCursor: artifactProgress.nextStage,  
              targetPaths: syntaxRepairTargets,  
              allowedOptionalPaths: syntaxRepairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))  
                ? [DATABASE_LAB_DESIGN_QUALITY_FILE]  
                : [],  
              uniqueKey: `database_lab:prototype_syntax_repair:${syntaxRepairTargets.join('|')}`,  
            });  
          }  
          const rowFormatRepairNeeded = prototypeCodeDiagnostics.failedChecks.includes('storage_engine_row_format_mismatch');  
          const allPrototypeContractRepairTargets = getPrioritizedDatabasePrototypeRepairTargets(  
            prototypeCodeDiagnostics,  
            prototypeCodeRepairTargets,  
          );  
          const prototypeContractRepairBatchSize = prototypeCodeDiagnostics.failedChecks.some((entry) =>
            entry.startsWith('bench_module_')
            || entry.startsWith('bench_buffer_pool_')
            || entry.startsWith('bench_wal_manager_')
            || entry.startsWith('bench_transaction_')
            || entry.includes('_api_mismatch')
            || entry.includes('_missing_method:')
          )
            ? 3
            : 3;
          const prototypeContractRepairTargets = allPrototypeContractRepairTargets.slice(0, prototypeContractRepairBatchSize);
          const prototypeContractInspectionPaths = Array.from(new Set([  
            ...prototypeContractRepairTargets,  
            ...prototypeCodeDiagnostics.failedChecks  
              .filter((entry) =>  
                entry.startsWith('bench_module_export_mismatch:')  
                || entry.startsWith('bench_module_export_name_mismatch:')  
                || entry.startsWith('bench_module_api_mismatch:')  
              )  
              .map((entry) => entry.split(':').slice(1, 2).join(':'))  
              .filter((relativePath) => typeof relativePath === 'string' && relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`)),  
            ...benchRequiredModuleFiles,  
          ]));  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(  
            prototypeContractRepairTargets,  
            Math.max(3, prototypeContractRepairTargets.length),  
          );  
          const allowPrototypeContractTargetedReads =
            prototypeContractRepairTargets.length > 0;
          const prototypeContractAllowedOptionalPaths = Array.from(new Set([  
            DATABASE_LAB_DESIGN_QUALITY_FILE,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
            ...DATABASE_LAB_BENCH_REQUIRED_MODULE_FILES,  
            ...allPrototypeContractRepairTargets,  
          ]));  
          if (prototypeContractRepairTargets.length > 0) {
            return buildDatabaseLabContinueInstruction([
              buildWriteOnlyRepairPrelude(prototypeContractRepairTargets, {
                allowTargetedReads: allowPrototypeContractTargetedReads,
                allowedReadPaths: prototypeContractInspectionPaths,
              }),
              'The design docs, prototype top-level files, and initial src modules already exist. Do not rewrite them broadly in this turn.',
              `Static inspection already found real prototype contract defects: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`,
              `Repair only this next narrow prototype batch now: ${prototypeContractRepairTargets.join(', ')}.`,
              allPrototypeContractRepairTargets.length > prototypeContractRepairTargets.length
                ? `Leave the remaining prototype files for later repair turns after this batch lands: ${allPrototypeContractRepairTargets.filter((relativePath) => !prototypeContractRepairTargets.includes(relativePath)).join(', ')}.`
                : null,
              benchmarkMetricKeysRepairNeeded
                ? `The benchmark scaffold must emit metrics with exactly these numeric keys: pagesWritten, pagesRead, writeDurationMs, readDurationMs, totalDurationMs. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so the top-level JSON result includes all five keys.`
                : null,
              benchmarkMetricKeysRepairNeeded || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_output_'))
                ? `The dry-run stdout contract is strict: ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must print exactly one JSON.stringify(result) object and nothing else. Required shape: {"status":"ok","summary":{"writeCount":1,"readCount":1},"metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":0,"readDurationMs":0,"totalDurationMs":0}}. Put all banner/debug text on stderr or remove it.`
                : null,
              ...prototypeCodeDiagnostics.requiredNextEvidence,
              ...(repairSourceBlocks.length > 0
                ? [
                  allowPrototypeContractTargetedReads
                    ? 'Current file contents for the cited repair targets are embedded below. Prefer them directly. If one narrow re-read is still necessary before rewriting, use only the explicitly allowed read paths from this repair batch.'
                    : 'Current file contents for the cited repair targets are embedded below. Use them directly and do not emit read_file in this turn.',
                  ...repairSourceBlocks,
                ]
                : []),
              rowFormatRepairNeeded
                ? 'Use one explicit row wire format across _serializeRow, _deserializeRow, readRow, scanTable, and any page-header bookkeeping. A length-prefixed JSON payload per row is acceptable if the same format is read back consistently.'
                : null,
              rowFormatRepairNeeded
                ? 'scanTable and readRow must skip page header bytes, respect row boundaries exactly, and never decode string-bearing rows as fixed-width doubles.'
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
                ? `If bench.js already calls engine methods that do not exist, either align bench.js to the real StorageEngine API or implement those exact methods in ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js.`
                : null,
              prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_missing_method:'))
                ? `Static inspection already identified missing StorageEngine methods called by ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js: ${prototypeCodeDiagnostics.failedChecks.filter((entry) => entry.startsWith('bench_storage_engine_missing_method:')).map((entry) => entry.split(':').slice(1).join(':')).join(', ')}. Fix the API mismatch in the cited files now; do not spend this turn rereading them.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
                ? `StorageEngine and BPlusTreeIndex currently disagree on the index API. If storage-engine.js calls pkIndex.search(...), then ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js must implement search coherently or storage-engine.js must call the real lookup/range method that BPlusTreeIndex already exposes.`
                : null,
              prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_async_usage_mismatch:'))
                ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js exposes Promise-based methods such as open, readPage, writePage, or close, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must await them. Do not treat Promise-returning I/O as synchronous benchmark work.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_open_missing')
                ? `If the storage engine uses fd-backed page I/O, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must open or initialize it before calling readPage/writePage.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_initialize_missing')
                ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js uses init() or initialize() to create its data directory or metadata paths, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must await that setup before the first readPage/writePage call. Alternatively, make storage-engine.js ensure the data directory exists inside writePage before fs.writeFileSync. Do not benchmark against an uninitialized data path.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_storage_page_size_mismatch')
                ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js enforces fixed-size pages, then ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must allocate page-sized buffers or the storage engine must expose a coherent page-serialization helper. Do not pass short Buffer.from(...) payloads into writePage unchanged.`
                : null,
              prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('undeclared_node_builtin:'))
                ? `Add missing CommonJS require declarations for Node builtins before using them. For example, if ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js uses path.join or os.tmpdir, it must include const path = require('path') and const os = require('os') before those calls.`
                : null,
              prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_arg_mismatch:'))
                ? `Make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js call StorageEngine methods with the same required argument shape implemented by ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js, or simplify storage-engine.js to the benchmark's actual method contract. Do not leave writePage/readPage calls with missing fileId/pageId/data parameters.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing')
                ? `Make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js createTable/loadTable the benchmark table before any readPage/writePage call when ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js keeps table metadata in memory. Do not write pages to a table that has not been loaded into StorageEngine.tables.`
                : null,
              prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_table_name_mismatch:'))
                ? `Make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js use the named table identifier expected by ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js before calling writePage/readPage. If storage-engine.js exposes writePage(tableName, pageNum, pageBuffer), then bench.js must create/open a string-named benchmark table and pass that table name; do not pass DEFAULT_TABLE_ID = 0 or another numeric id into a table-name API.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch')
                ? `If bench.js constructs StorageEngine with an options object, either make storage-engine.js accept { dataDir, ... } explicitly or change bench.js to pass the string path that StorageEngine actually expects. Do not leave path.join(...) receiving a raw object.`
                : null,
              prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_module_export_mismatch:'))
                ? `Use one canonical CommonJS contract before rerunning the benchmark: prototype modules should export named bindings such as module.exports = { StorageEngine }, and bench.js should import them with destructuring such as const { StorageEngine } = require('../src/storage-engine.js').`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
                ? `Rewrite ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js to use direct named CommonJS imports for the canonical modules instead of MODULE_DEFS/loadModules/loaded.* indirection. Direct imports are required so static quality and repair diagnostics can verify the module contract before rerunning the benchmark.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
                ? `Align ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js on one method contract before any benchmark rerun.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
                ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so the dry-run no longer calls pool.initialize() unless BufferPool implements that exact async setup method. If BufferPool has no setup phase, remove the await pool.initialize() line and use its real getPage/putPage/readPage/writePage contract directly.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
                ? `BufferPool and StorageEngine currently disagree on the page API. If buffer-pool.js calls this.storage.readPage/writePage, then storage-engine.js must implement those exact methods or buffer-pool.js must be rewritten to use the real key-value engine API. Do not leave buffer-pool.js delegating to non-existent storage methods.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
                ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so npm run bench -- --dry-run prints one machine-readable JSON object to stdout with top-level status, summary, and metrics keys. Human-readable banner logs alone are not acceptable for the benchmark self-check.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_output_extra_stdout_logs')
                ? `Remove non-JSON console.log banner and phase output from ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js. The dry-run command stdout must contain exactly one JSON.stringify(result) payload and no extra prose before or after it.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')
                ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so dryRun returns and prints a top-level object with status, summary, and metrics keys. Printing raw metrics alone is not acceptable.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
                ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so direct WAL calls use the real WALManager API. Do not keep wal.getFlushCount() unless WALManager implements that method.`
                : null,
              prototypeCodeDiagnostics.failedChecks.includes('wal_timestamp_uint32_overflow_risk')
                ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WAL record serialization does not write Date.now() into a UInt32 field. Date.now() is larger than 4294967295 and will fail the dry-run benchmark; use BigUInt64LE, a relative timestamp, or a JSON payload timestamp instead.`
                : null,
              `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Pure constructor, export, and method-contract repairs should stay scoped to the cited prototype files only.`,
              'Do not emit run_command in this repair turn. After the prototype contract defects are fixed, the next turn can run the dry-run benchmark.',
            ], {
              phase: 'prototype_contract_repair',
              phaseCursor: artifactProgress.nextStage,
              targetPaths: prototypeContractRepairTargets,
              allowTargetedReadInspection: allowPrototypeContractTargetedReads,
              allowedReadPaths: prototypeContractInspectionPaths,
              allowedOptionalPaths: prototypeContractAllowedOptionalPaths,
              uniqueKey: `database_lab:prototype_contract_repair:${prototypeContractRepairTargets.join('|')}`,
            });
          }
        }  
        if (benchFailureExcerpt && /maximum call stack size exceeded/i.test(benchFailureExcerpt)) {  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks([`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`], 1);  
          return buildDatabaseLabContinueInstruction([  
            buildWriteOnlyRepairPrelude([`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`]),  
            `The design docs, prototype top-level files, and initial src modules already exist. Do not rewrite them in this turn.`,  
            'The benchmark dry-run already failed. Repair only database-lab/prototype/scripts/bench.js now.',  
            benchFailureExcerpt,  
            ...(repairSourceBlocks.length > 0  
              ? [  
                'The current benchmark scaffold is embedded below. Use it directly and do not emit read_file in this turn.',  
                ...repairSourceBlocks,  
              ]  
              : []),  
            'Fix the benchmark aggregator so it does not spread-push large latency arrays from worker results into one array. Aggregate incrementally instead.',  
            'Keep the benchmark result shape compatible with dry-run verification: emit summary and metrics data without blowing the stack.',  
            'Do not emit run_command in this repair turn. After bench.js is repaired, the next turn can rerun the dry-run benchmark.',  
          ], {  
            phase: 'bench_stack_repair',  
            phaseCursor: artifactProgress.nextStage,  
            targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],  
            uniqueKey: `database_lab:bench_stack_repair:${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
          });  
        }  
        if (  
          prototypeModuleSystemMismatch  
          || (benchFailureExcerpt && /(require is not defined in ES module scope|module is not defined in ES module scope|exports is not defined in ES module scope|ERR_REQUIRE_ESM|Cannot use import statement outside a module|Unexpected token 'export')/i.test(benchFailureExcerpt))  
        ) {  
          const repairTargets = Array.from(new Set([  
            `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,  
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
            ...benchRequiredModuleFiles,  
          ]));  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);  
          return buildDatabaseLabContinueInstruction([  
            buildWriteOnlyRepairPrelude(repairTargets),  
            'The benchmark dry-run already failed because the prototype package and JavaScript files are using conflicting module systems.',  
            ...(benchFailureExcerpt ? [benchFailureExcerpt] : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('prototype_module_system_mismatch')  
              ? [`Static inspection also found a module-system mismatch: ${prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) => /module system is consistent/i.test(entry)).join(' ')}`]  
              : []),  
            `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json and the cited benchmark files so the scaffold uses one coherent module system end-to-end.`,  
            `Prefer CommonJS for this scaffold: remove "type": "module" from ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, keep module.exports in the prototype src files, and keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js on named require destructuring such as const { StorageEngine } = require('../src/storage-engine.js').`,  
            'If you choose ESM instead, then convert every cited file consistently to import/export syntax and keep package scripts pointing at the real entrypoint files. Do not leave a mixed contract.',  
            prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')  
              ? `While repairing ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js, also instantiate and call the real StorageEngine and BufferPool modules instead of placeholder counter loops. A benchmark that only imports modules but never exercises them is not acceptable.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope')  
              ? `Keep the dryRun result machine-readable with top-level status, summary, and metrics keys after the module-system fix.`  
              : null,  
            benchmarkMetricKeysRepairNeeded  
              ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so the result metrics include exactly pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`  
              : null,  
            ...(repairSourceBlocks.length > 0  
              ? [  
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',  
                ...repairSourceBlocks,  
              ]  
              : []),  
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the package and benchmark contract first.`,  
            'Do not emit run_command in this repair turn. After the module-system fix lands, the next turn can rerun the dry-run benchmark.',  
          ].filter(Boolean), {  
            phase: 'bench_module_system_repair',  
            phaseCursor: artifactProgress.nextStage,  
            targetPaths: repairTargets,  
            allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {  
              artifactProgress,  
              packageEntryDiagnostics,  
              scenarioId: spec.id,  
            }),  
            uniqueKey: `database_lab:bench_module_system_repair:${repairTargets.join('|')}`,
          });
        }
        if (
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch')
          || (benchFailureExcerpt && /(ERR_OUT_OF_RANGE|out of range|Received\s+-\d+)/i.test(benchFailureExcerpt) && /writeUInt32BE/i.test(benchFailureExcerpt))
        ) {
          const repairTargets = Array.from(new Set([
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ]));
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
          return buildDatabaseLabContinueInstruction([
            buildWriteOnlyRepairPrelude(repairTargets),
            'The benchmark dry-run already failed because the storage engine passed a negative or out-of-range value into Buffer.writeUInt32BE.',
            ...(benchFailureExcerpt ? [benchFailureExcerpt] : []),
            prototypeCodeDiagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch')
              ? `Static inspection also found signed bitwise coercion before writeUInt32BE in ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js. JavaScript bitwise operators return signed 32-bit numbers, so expressions like Date.now() & 0xFFFFFFFF can become negative.`
              : null,
            `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so every value passed to Buffer.writeUInt32BE is guaranteed to be an unsigned integer in the range 0..4294967295. Prefer (value >>> 0) for 32-bit fields or an explicit clamp helper. Do not use signed bitwise & 0xFFFFFFFF without unsigned conversion.`,
            `Keep ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js aligned with the storage page format and do not claim benchmark success until a later run_command captures a successful dry-run.`,
            ...(repairSourceBlocks.length > 0
              ? [
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
                ...repairSourceBlocks,
              ]
              : []),
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the storage integer encoding contract.`,
            'Do not emit run_command in this repair turn. After the uint32 encoding repair lands, the next turn can rerun the dry-run benchmark.',
          ].filter(Boolean), {
            phase: 'bench_uint32_repair',
            phaseCursor: artifactProgress.nextStage,
            targetPaths: repairTargets,
            allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {
              artifactProgress,
              packageEntryDiagnostics,
              scenarioId: spec.id,
            }),
            uniqueKey: `database_lab:bench_uint32_repair:${repairTargets.join('|')}`,
          });
        }
        if (benchFailureExcerpt && /(ENOENT|no such file or directory)/i.test(benchFailureExcerpt)) {
          const repairTargets = Array.from(new Set([
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
          ]));  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);  
          return buildDatabaseLabContinueInstruction([  
            buildWriteOnlyRepairPrelude(repairTargets),  
            'The benchmark dry-run already failed because prototype file-backed I/O started before the data path or page-file contract was ready.',  
            benchFailureExcerpt,
            prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_initialize_missing')
              ? `Static inspection also found that ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js is calling readPage/writePage without awaiting storageEngine init()/initialize() or otherwise ensuring the data directory exists.`
              : null,
            `Repair only ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js now.`,
            `Ensure ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js constructs StorageEngine with a real data directory, awaits storageEngine.init()/initialize() before the first readPage/writePage call or makes writePage create its directory safely, and awaits any Promise-based storage methods before printing success JSON.`,
            `Ensure ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js creates or verifies the parent data directory before it opens tablespace files such as default.dat. Do not assume the directory already exists.`,  
            'If the benchmark writes page data, keep the page-write contract coherent: either pass page-sized buffers into writePage or expose one storage helper that serializes benchmark payloads into valid pages before disk I/O.',  
            ...(repairSourceBlocks.length > 0  
              ? [  
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',  
                ...repairSourceBlocks,  
              ]  
              : []),  
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the benchmark I/O contract.`,  
            'Do not emit run_command in this repair turn. After the I/O contract is repaired, the next turn can rerun the dry-run benchmark.',  
          ].filter(Boolean), {  
            phase: 'bench_runtime_io_repair',  
            phaseCursor: artifactProgress.nextStage,  
            targetPaths: repairTargets,  
            allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],  
            uniqueKey: `database_lab:bench_runtime_io_repair:${repairTargets.join('|')}`,
          });
        }
        if (benchFailureExcerpt && /Table\s+(?:(?:0|\d+)|['"`][^'"`]+['"`])\s+not\s+(?:found|loaded)/i.test(benchFailureExcerpt)) {
          const repairTargets = Array.from(new Set([
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,
          ]));
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
          return buildDatabaseLabContinueInstruction([
            buildWriteOnlyRepairPrelude(repairTargets),
            /not\s+loaded/i.test(benchFailureExcerpt)
              ? 'The benchmark dry-run already failed because page I/O ran before the benchmark table was created or loaded into the storage engine.'
              : 'The benchmark dry-run already failed because the benchmark passed a numeric table id into a storage API that expects a named table identifier.',
            benchFailureExcerpt,
            prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_storage_engine_table_name_mismatch:'))
              ? `Static inspection also found that ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js is calling StorageEngine readPage/writePage with a numeric table id while ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js expects tableName/table identifiers.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing')
              ? `Static inspection also found that ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js uses table page I/O without a createTable/loadTable/openTable lifecycle step, while ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js tracks loaded table metadata.`
              : null,
            `Repair only ${repairTargets.join(', ')} now so the benchmark, buffer pool, and storage engine share one table identity and table lifecycle contract.`,
            `Preferred fix: make ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js create or load a string-named benchmark table such as "benchmark_table" before page writes, then call writePage/readPage with that table name and the page number. If BufferPool evicts dirty pages, ensure its flush path cannot write to a table missing from StorageEngine.tables. If you instead change storage-engine.js to lazy-create/load tables, keep create/open/read/write/delete behavior coherent and update the benchmark accordingly.`,
            'Do not leave DEFAULT_TABLE_ID = 0 flowing into a table-name lookup. Do not claim benchmark success until a later run_command captures a successful dry-run.',
            ...(repairSourceBlocks.length > 0
              ? [
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
                ...repairSourceBlocks,
              ]
              : []),
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to the benchmark table identity contract.`,
            'Do not emit run_command in this repair turn. After the table identity contract is repaired, the next turn can rerun the dry-run benchmark.',
          ].filter(Boolean), {
            phase: 'bench_table_identity_repair',
            phaseCursor: artifactProgress.nextStage,
            targetPaths: repairTargets,
            allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
            uniqueKey: `database_lab:bench_table_identity_repair:${repairTargets.join('|')}`,
          });
        }
        if (benchFailureExcerpt && /(?:Buffer pool is full|no evictable page found|no evictable frame|all pages pinned)/i.test(benchFailureExcerpt)) {
          const repairTargets = Array.from(new Set([
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,
          ]));
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
          return buildDatabaseLabContinueInstruction([
            buildWriteOnlyRepairPrelude(repairTargets),
            'The benchmark dry-run already failed because the buffer pool reached capacity and could not evict a frame.',
            benchFailureExcerpt,
            'Repair the benchmark and buffer-pool contract so read/write benchmark operations release pages after use and eviction can flush dirty unpinned frames safely.',
            `Preferred fix: update ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js to unpin or release every page fetched during read and scan phases, and update ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so its eviction path never treats already-finished reads as permanently pinned.`,
            `If the storage engine participates in flushes, keep ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js writePage/readPage behavior coherent with the buffer-pool frame contract.`,
            'Do not reduce the benchmark to a fake no-op. Keep a real dry-run workload, but make the benchmark bounded enough to finish and emit the required machine-readable JSON metrics.',
            ...(repairSourceBlocks.length > 0
              ? [
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',
                ...repairSourceBlocks,
              ]
              : []),
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Keep this repair scoped to benchmark resource lifecycle.`,
            'Do not emit run_command in this repair turn. After the buffer-pool lifecycle repair lands, the next turn can rerun the dry-run benchmark.',
          ].filter(Boolean), {
            phase: 'bench_buffer_pool_capacity_repair',
            phaseCursor: artifactProgress.nextStage,
            targetPaths: repairTargets,
            allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
            uniqueKey: `database_lab:bench_buffer_pool_capacity_repair:${repairTargets.join('|')}`,
          });
        }
        const benchPrototypeContractMismatchDetected =
          prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
          || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_data_root_missing')
          || prototypeCodeDiagnostics.failedChecks.includes('storage_engine_uint32_signed_bitwise_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_storage_table_lifecycle_missing')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('wal_timestamp_uint32_overflow_risk')
          || prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')  
          || prototypeCodeDiagnostics.failedChecks.some((entry) =>  
            entry.startsWith('storage_engine_missing_method:')
            || entry.startsWith('storage_engine_index_missing_method:')
            || entry.startsWith('bench_storage_engine_table_name_mismatch:')
            || entry.startsWith('bench_wal_manager_missing_method:')
            || entry.startsWith('bench_buffer_pool_missing_method:')
            || entry.startsWith('buffer_pool_storage_engine_missing_method:')
            || entry.startsWith('bench_transaction_missing_method:')
            || entry.startsWith('bench_transaction_manager_argument_mismatch:')
            || entry.startsWith('transaction_manager_wal_missing_method:')
            || entry.startsWith('transaction_manager_storage_missing_method:')
            || entry.startsWith('transaction_manager_constructor_option_alias_mismatch:')
          );
        if (  
          benchFailureExcerpt  
          && (  
            /(ERR_INVALID_ARG_TYPE|TypeError)/i.test(benchFailureExcerpt)
              || (
                benchPrototypeContractMismatchDetected
              && /(storage_engine_init|buffer_pool_init|wal_init|tx_manager_init|bplus_tree_init|The \"path\" argument|ENOENT|no such file or directory|Received an instance of Object|BufferPool requires options\.storageEngine|pool\.initialize is not a function|Transaction\s+(?:undefined|null|[^\s]+)\s+not found)/i.test(benchFailureExcerpt)
            )
          )
        ) {
          const failureMentionedPrototypePaths = getDatabasePrototypePathsMentionedInText(benchFailureExcerpt);
          const failureImpliesStorageRepair =
            /(storage|engine|StorageEngine)\.(?:open|init|initialize|readPage|writePage|createFile)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt)
            || /(?:open|init|initialize|readPage|writePage|createFile)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt);
          const failureImpliesWalRepair =
            /\bwal\.(?:open|init|initialize|append|appendEntry|close|getFlushCount)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt);
          const failureImpliesBufferRepair =
            /(?:bufferPool|pool)\.(?:open|init|initialize|readPage|writePage|getPage|putPage)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt);
          const failureImpliesTransactionRepair =
            /(?:txManager|transactionManager)\.(?:begin|beginTransaction|commit|commitTransaction|rollback|rollbackTransaction|abort)\s+is\s+not\s+a\s+function/i.test(benchFailureExcerpt)
            || /Transaction\s+(?:undefined|null|[^\s]+)\s+not found/i.test(benchFailureExcerpt);
          const failureMentionsStorageRepair =
            failureImpliesStorageRepair
            || failureMentionedPrototypePaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`);
          const failureMentionsBufferRepair =
            failureImpliesBufferRepair
            || failureMentionedPrototypePaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`);
          const failureMentionsTransactionRepair =
            failureImpliesTransactionRepair
            || failureMentionedPrototypePaths.includes(`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`);
          const repairCandidates = Array.from(new Set([
            `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
            ...failureMentionedPrototypePaths,
            ...(failureImpliesStorageRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`] : []),
            ...(failureImpliesWalRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`] : []),
            ...(failureImpliesBufferRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`] : []),
            ...(failureImpliesTransactionRepair ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`] : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_missing_method:'))
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_constructor_'))
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]  
              : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'))
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`]
              : []),

            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
              || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
              || prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
              || prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('wal_timestamp_uint32_overflow_risk')
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))  
              ? [  
                `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,  
                `${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`,  
              ]  
              : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
              || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')  
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))  
              ? [  
                `${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`,  
                `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,  
              ]  
              : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')  
              ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js`]  
              : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')  
              || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))  
              ? [  
                `${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`,  
                `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,  
              ]  
              : []),  
            ...prototypeCodeDiagnostics.failedChecks  
              .filter((entry) => entry.startsWith('bench_module_export_mismatch:') || entry.startsWith('bench_module_export_name_mismatch:') || entry.startsWith('bench_module_api_mismatch:'))  
              .map((entry) => entry.split(':').slice(1, 2).join(':'))  
              .filter(Boolean),  
            ...prototypeCodeDiagnostics.benchImportedModuleFiles.filter((relativePath) => benchFailureExcerpt.includes(relativePath.split('/').slice(-1)[0])),  
          ]));  
          const repairTargets = getNarrowDatabaseBenchRepairTargets(repairCandidates, {
            failureText: benchFailureExcerpt,
            priorityTargets: [
              ...(failureMentionsStorageRepair && (
                prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
                || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'))
              )
                ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`]
                : []),
              ...(failureMentionsBufferRepair && (
                prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')
                || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('buffer_pool_storage_engine_missing_method:'))
              )
                ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
                : []),
              ...(failureMentionsTransactionRepair && (
                prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')
                || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_wal_missing_method:'))
              )
                ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
                : []),
              ...(failureMentionsTransactionRepair && (
                prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')
                || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_storage_missing_method:'))
              )
                ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
                : []),
            ],
            maxTargets: 4,
          });
          const repairInspectionPaths = Array.from(new Set([
            ...repairTargets,
            ...prototypeCodeDiagnostics.benchImportedModuleFiles,
          ]));
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);
          return buildDatabaseLabContinueInstruction([
            buildWriteOnlyRepairPrelude(repairTargets, {
              allowTargetedReads: true,
              allowedReadPaths: repairInspectionPaths,
            }),
            `The benchmark dry-run already failed because the benchmark scaffold and the prototype module APIs do not agree on constructor or method signatures.`,
            benchFailureExcerpt,
            failureImpliesStorageRepair
              ? `The concrete benchmark failure points at the StorageEngine contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so the method named in stderr actually exists and is awaited when async.`
              : null,
            failureImpliesWalRepair
              ? `The concrete benchmark failure points at the WALManager contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so the method named in stderr actually exists or the benchmark calls the real WAL API.`
              : null,
            failureImpliesBufferRepair
              ? `The concrete benchmark failure points at the BufferPool contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so read/write methods align.`
              : null,
            failureImpliesTransactionRepair
              ? `The concrete benchmark failure points at the TransactionManager contract. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so begin/commit/rollback calls use one coherent transaction id or object contract.`
              : null,
            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')  
              ? ['Static inspection also found a direct bench/buffer-pool API mismatch: bench.js is calling bufferPool.writePage/readPage while buffer-pool.js currently exposes putPage/getPage.']  
              : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
              ? ['Static inspection also found a direct bench/buffer-pool constructor mismatch: bench.js is passing an options object, but buffer-pool.js still expects positional constructor arguments like (storageEngine, poolSize).']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
              ? ['Static inspection also found a direct bench/buffer-pool constructor mismatch: bench.js calls new BufferPool() without the required options.storageEngine dependency.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
              ? ['Static inspection also found a direct bench/buffer-pool API mismatch: bench.js calls pool.initialize(), but buffer-pool.js does not implement initialize. Remove that call or implement the method before rerunning the benchmark.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')  
              ? [  
                'Static inspection also found a deeper prototype contract mismatch: buffer-pool.js is delegating page I/O to this.storage.readPage/writePage, but storage-engine.js does not implement the same page API.',  
              ]  
              : []),  
            ...(prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
              ? ['Static inspection also found a WAL constructor mismatch: bench.js is passing an options object, but wal-manager.js still treats its constructor input as a base directory string for path.join(...).']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('wal_timestamp_uint32_overflow_risk')
              ? ['Static inspection also found a WAL timestamp overflow risk: wal-manager.js writes Date.now() into a UInt32 field, which will fail once the benchmark appends WAL records.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
              ? ['Static inspection also found a direct bench/WAL API mismatch: bench.js is calling WALManager methods that wal-manager.js does not implement.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
              ? ['Static inspection also found a TransactionManager constructor mismatch: bench.js is passing alias keys such as wal/storage/index, but transaction-manager.js expects storageEngine/bufferPool/walManager/indexManager.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
              ? ['Static inspection also found a TransactionManager option alias mismatch: bench.js passes a short alias such as wal, but transaction-manager.js consumes a canonical option key such as walManager, leaving the dependency undefined at runtime.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
              ? ['Static inspection also found a TransactionManager call argument mismatch: bench.js passes a transaction object to commit/rollback, but transaction-manager.js appears to expect a transaction id lookup key.']
              : []),
            ...(prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')  
              ? ['Static inspection also found a query-executor contract mismatch: bench.js is constructing QueryExecutor with a loose object literal, but query-executor.js expects a richer database facade that exposes methods like getTable and insertRow.']  
              : []),  
            ...prototypeCodeDiagnostics.requiredNextEvidence.filter((entry) =>
              /named CommonJS export exists|direct named CommonJS destructuring|exposes the methods bench\.js is calling|StorageEngine\.(?:readPage|writePage)|these engine methods line up|pool\.initialize|BufferPool actually implements initialize|BufferPool only calls storage methods|WALManager exposes the methods bench\.js is calling|TransactionManager only calls WALManager methods|TransactionManager only calls StorageEngine methods/i.test(entry)
            ),
            `Repair only the cited files now so ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js constructs and calls the real prototype modules correctly.`,  
            'Use the current module APIs or repair those module exports in the same turn; do not leave constructor arguments or method names mismatched.',  
            prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')  
              ? `If ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js calls StorageEngine page methods such as readPage or writePage, then ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js must implement those exact methods or ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js must stop calling them. Do not leave page-method calls pointing at a key-value-only engine API.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_data_root_missing')  
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so StorageEngine receives a real dataRoot path before it calls path.join(...). Do not leave new StorageEngine() with an undefined base directory.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('storage_engine_constructor_arg_mismatch')  
              ? `If bench.js constructs StorageEngine with an options object, either make ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js accept that object shape explicitly or change ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js to pass the string path that StorageEngine actually expects.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_storage_engine_contract_mismatch')  
              ? `If bench.js is meant to benchmark page-oriented storage, then implement readPage/writePage coherently in ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and keep ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js delegating to that contract. If the real storage engine is key-value only, then rewrite buffer-pool.js and bench.js together to use one coherent key/value contract instead of page calls.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_arg_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js so BufferPool construction is coherent. Do not keep new BufferPool({ ... }) if buffer-pool.js still expects positional arguments.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('buffer_pool_constructor_dependency_missing')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so BufferPool receives the real StorageEngine dependency it requires. Do not keep new BufferPool() when ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js throws unless options.storageEngine is provided.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_missing_initialize')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it no longer calls pool.initialize() against a BufferPool class that does not expose initialize(). If setup is needed, add the exact initialize method to ${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js and keep it coherent with the existing constructor and storage dependency.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('wal_manager_constructor_arg_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WALManager receives a real directory string before path.join(...). Do not keep new WALManager({ ... }) if wal-manager.js still expects a base directory string.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('wal_timestamp_uint32_overflow_risk')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so WAL record serialization no longer writes Date.now() through writeUInt32LE. Use BigUInt64LE for epoch milliseconds, store a bounded relative timestamp, or move timestamp into the JSON payload before rerunning the benchmark.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so direct WAL calls are coherent. Do not keep wal.getFlushCount() unless WALManager implements getFlushCount(); using wal.flushCount or adding a real getFlushCount() method are both acceptable if the benchmark result remains machine-readable.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_constructor_arg_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so TransactionManager uses one coherent option contract. Do not keep new TransactionManager({ wal, storage, index }) if the real constructor expects keys such as storageEngine, bufferPool, walManager, and indexManager.`
              : null,
            prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('transaction_manager_constructor_option_alias_mismatch:'))
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so aliases such as wal are not silently accepted when the constructor consumes walManager. Prefer one explicit options contract and keep bench.js aligned with it.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_wal_contract_mismatch')  
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js so transaction begin/commit logic only calls WAL methods that really exist. If transaction-manager.js calls this.wal.currentLsn() or append-style methods, wal-manager.js must expose them, or transaction-manager.js must switch to the actual exported WAL API before any benchmark rerun.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('transaction_manager_storage_contract_mismatch')  
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so transaction lifecycle code only calls StorageEngine methods that really exist. Do not leave transaction-manager.js calling allocatePage, put, or other methods that storage-engine.js does not export.`  
              : null,  
            prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so the object returned by begin() exposes the methods bench.js actually calls. If the real transaction API is read/write/delete, then bench.js must stop calling insert/lookup and switch to those coherent method names before any benchmark rerun.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js so commit/rollback calls pass the expected id or the manager methods accept the transaction object consistently. Do not leave txManager.commit(tx) if commit(txnId) looks up activeTxns by id.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('query_executor_database_contract_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and/or ${DATABASE_LAB_PROTOTYPE_DIR}/src/query-executor.js so QueryExecutor operates on one coherent database facade. Either instantiate the exported Database wrapper from ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js or provide an equivalent object with the methods query-executor.js actually calls.`
              : null,
            prototypeCodeDiagnostics.failedChecks.includes('bench_dynamic_module_loader_contract_mismatch')
              ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it uses direct named CommonJS require statements for the benchmark-critical modules. Do not keep MODULE_DEFS/loadModules/loaded.* dynamic indirection because it hides import/export mismatches from the quality gate.`
              : null,
            benchmarkMetricKeysRepairNeeded
              ? `Keep the repaired benchmark result machine-readable and include metrics keys pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`
              : null,
            `The repaired benchmark CLI must print exactly one JSON.stringify(result) object and no banner logs. Required stdout shape: {"status":"ok","summary":{"writeCount":1,"readCount":1},"metrics":{"pagesWritten":1,"pagesRead":1,"writeDurationMs":0,"readDurationMs":0,"totalDurationMs":0}}.`,
            ...(repairSourceBlocks.length > 0
              ? [
                'The current cited files are embedded below. Prefer them directly. If one narrow re-read is necessary before rewriting, use only the explicitly allowed read paths from this repair batch.',
                ...repairSourceBlocks,
              ]
              : []),
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Pure constructor and method repairs should stay scoped to the cited prototype files only.`,  
            'Do not emit run_command in this repair turn. After the API mismatch is fixed, the next turn can rerun the dry-run benchmark.',  
          ], {  
            phase: 'bench_api_repair',
            phaseCursor: artifactProgress.nextStage,
            targetPaths: repairTargets,
            allowTargetedReadInspection: true,
            allowedReadPaths: repairInspectionPaths,
            allowedOptionalPaths: getDatabaseBenchRepairAllowedOptionalPaths(repairTargets, {
              artifactProgress,
              packageEntryDiagnostics,
              scenarioId: spec.id,
              includeBenchmarkCompanions: true,
              companionPrototypePaths: prototypeCodeDiagnostics.benchImportedModuleFiles,
            }),
            uniqueKey: `database_lab:bench_api_repair:${repairTargets.join('|')}`,
          });
        }
        if (benchFailureExcerpt && /(Unexpected non-whitespace character after JSON|SyntaxError)/i.test(benchFailureExcerpt)) {  
          const repairTargets = Array.from(new Set([  
            `${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`,  
            ...(benchFailureExcerpt.includes('bench.js') ? [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`] : []),  
          ]));  
          const repairSourceBlocks = buildPrototypeRepairSourceBlocks(repairTargets);  
          return buildDatabaseLabContinueInstruction([  
            buildWriteOnlyRepairPrelude(repairTargets),  
            'The benchmark dry-run failed because the storage engine row serialization contract is internally inconsistent, so scanTable or readRow could not recover the rows they wrote.',  
            benchFailureExcerpt,  
            ...(prototypeCodeDiagnostics.failedChecks.length > 0  
              ? [`Static inspection also found: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`]  
              : []),  
            `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js so insertRow, readRow, scanTable, updateRow, and close all follow one coherent storage-engine contract.`,  
            'Use one explicit row wire format across _serializeRow and _deserializeRow. If rows can contain strings, do not write variable-length UTF-8 bytes into fixed 8-byte numeric slots and then decode them back with readDoubleBE.',  
            'scanTable and readRow must skip page header bytes, respect stored row boundaries exactly, and never concatenate adjacent rows into one payload.',  
            'If bench.js assumes a conflicting row or engine API, repair bench.js in the same turn so it uses the real storage-engine API without inventing an alternate record layout.',  
            benchmarkMetricKeysRepairNeeded  
              ? `Keep the repaired benchmark output machine-readable and include metrics keys pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`  
              : null,  
            ...(repairSourceBlocks.length > 0  
              ? [  
                'The current cited files are embedded below. Use them directly and do not emit read_file in this turn.',  
                ...repairSourceBlocks,  
              ]  
              : []),  
            `Do not rewrite ${DATABASE_LAB_DESIGN_QUALITY_FILE} in this turn unless you actually add, remove, or rename prototype src files. Pure serialization fixes should stay scoped to the cited prototype files only.`,  
            'Do not emit run_command in this repair turn. After the scan/serialization bug is fixed, the next turn can rerun the dry-run benchmark.',  
          ], {  
            phase: 'storage_engine_repair',  
            phaseCursor: artifactProgress.nextStage,  
            targetPaths: repairTargets,  
            allowedOptionalPaths: repairTargets.some((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`))  
              ? [DATABASE_LAB_DESIGN_QUALITY_FILE]  
              : [],  
            uniqueKey: `database_lab:storage_engine_repair:${repairTargets.join('|')}`,  
          });  
        }  
        return buildDatabaseLabContinueInstruction([  
          buildJsonToolCallPrelude(),  
          `The design docs, prototype top-level files, and initial src modules already exist under ${DATABASE_LAB_ROOT}/.`,  
          `Do not reread brief/* and do not rewrite the full scaffold in this turn.`,  
          `Run a real dry-run benchmark self-check from ${DATABASE_LAB_PROTOTYPE_DIR} now.`,  
          'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
          'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"npm run build","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
          'If the dry-run fails, keep the exact stderr and do not claim design completion.',  
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',  
        ], {  
          phase: 'benchmark_self_check',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],  
          uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',  
        });  
      }  
      if (briefAlreadyRead && artifactProgress.prototypeModules.completed && artifactProgress.nextStage === 'benchmark_self_check') {  
        return buildDatabaseLabContinueInstruction([  
          buildJsonToolCallPrelude(),  
          `The design docs, prototype top-level files, and initial src modules already exist under ${DATABASE_LAB_ROOT}/.`,  
          `Do not reread brief/* and do not rewrite design docs in this turn.`,  
          `Stay in benchmark self-check mode. Run a real dry-run benchmark command from ${DATABASE_LAB_PROTOTYPE_DIR} now instead of restarting the scaffold phases.`,  
          'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
          'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
          'If the dry-run fails, keep the exact stderr and do not claim design completion.',  
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the self-check or repair work remains.',  
        ], {  
          phase: 'benchmark_self_check',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: [`${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`],  
          uniqueKey: 'database_lab:benchmark_self_check:npm run bench -- --dry-run',  
        });  
      }  
      if (briefAlreadyRead && !artifactProgress.prototypeModules.completed) {  
        return buildPrototypeModulesInstruction();  
      }  
      if (  
        briefAlreadyRead  
        && databaseLabArtifactSatisfied  
        && successfulBenchRunSatisfied  
        && qualityAcceptance?.verdict === 'passed'  
      ) {  
        const producedFiles = Array.from(new Set([  
          ...workspaceFiles.filter((relativePath) =>  
            relativePath.startsWith(`${DATABASE_LAB_ROOT}/`) || relativePath === DATABASE_LAB_DESIGN_QUALITY_FILE  
          ),  
        ]));  
        return buildDatabaseLabFinalizationInstruction(producedFiles);  
      }  
      if (!briefAlreadyRead) {  
        return buildDatabaseLabContinueInstruction([  
          buildJsonToolCallPrelude(),  
          `Create the design package under ${DATABASE_LAB_DESIGN_DIR}/ and the prototype scaffold under ${DATABASE_LAB_PROTOTYPE_DIR}/, but do not start writing files in this turn.`,  
          'First read brief/workload-profile.md, brief/mysql-targets.md, and brief/constraints.md only.',  
          'Do not emit write_file, create_folder, list_files, search_files, or run_command in this turn after the three read_file calls.',  
          'Return exactly three machine-readable blocks in this order: one [AGENT-001_OUTPUT] JSON envelope, then the three read_file JSON objects, then one final tracker JSON.',  
          'Use this exact explicit output wrapper pattern with both tags present: [AGENT-001_OUTPUT]{"summary":"...","details":"...","producedFiles":[],"issues":[]}[/AGENT-001_OUTPUT]. Do not omit the closing [/AGENT-001_OUTPUT] tag.',  
          'The [AGENT-001_OUTPUT] JSON must use exactly these top-level keys: summary, details, producedFiles, issues.',  
          'In this read-only grounding phase, producedFiles must be [] and the output must say that the brief files were read successfully and the design-doc write phase is next.',  
          'Append exactly one final tracker JSON after the three read_file objects using this shape: {"current_unit":"AGENT-001","status":"IN_PROGRESS","progress_percent":20,"decision":"CONTINUE","reason":"Read the grounded brief files; next turn will write the design docs.","next_unit":null,"files_created":[]}.',  
          'Do not leave the read phase open-ended. The tracker is required so the next turn can start the design-doc write phase with the grounded brief contents already in context.',  
        ], {  
          phase: 'brief_read',  
          phaseCursor: artifactProgress.nextStage,  
          targetPaths: ['brief/workload-profile.md', 'brief/mysql-targets.md', 'brief/constraints.md'],  
          uniqueKey: 'database_lab:brief_read',  
        });  
      }  
        return buildDatabaseLabContinueInstruction([  
          buildJsonToolCallPrelude(),  
          `Create the design package under ${DATABASE_LAB_DESIGN_DIR}/ and the prototype scaffold under ${DATABASE_LAB_PROTOTYPE_DIR}/.`,  
          briefAlreadyRead  
            ? 'The seeded brief files were already read successfully in this thread. Do not spend another turn re-reading brief/*.'  
            : 'First read brief/workload-profile.md, brief/mysql-targets.md, and brief/constraints.md.',  
          'write_file automatically creates missing parent directories. Do not spend a turn emitting create_folder before the real file writes.',  
        `Write only this next design-doc batch now: ${(missingDesignFiles.length > 0 ? nextDesignDocTargets : getDatabaseLabNextDesignDocTargets(scenarioState, designDocBatchSize)).join(', ')}.`,  
        missingDesignFiles.length > nextDesignDocTargets.length  
          ? `Do not try to finish the full design corpus in one turn. Leave these remaining design docs for later turns: ${missingDesignFiles.slice(nextDesignDocTargets.length).join(', ')}.`  
          : 'If the design-doc batch succeeds, the next turn can continue with prototype scaffold work.',  
        `After the design-doc phase, continue with prototype top-level files, then prototype src modules, then ${DATABASE_LAB_DESIGN_QUALITY_FILE}, and only then run the dry-run benchmark.`,  
        'Do not claim measured MySQL parity. Keep it as a target profile only.',  
        'The next turn can summarize only after the required write_file calls succeed.',  
      ], {  
        phase: artifactProgress.nextStage ?? 'design_docs',  
        phaseCursor: artifactProgress.nextStage,  
        targetPaths: nextDesignDocTargets,  
        uniqueKey: `database_lab:fallback:${artifactProgress.nextStage ?? 'design_docs'}:${nextDesignDocTargets.join('|')}`,  
      });  
    }  
    
    function buildDatabaseLabVerificationPrompt() {  
      const missingFiles = getMissingWorkspaceFiles(  
        scenarioState,  
        [...DATABASE_LAB_REQUIRED_DESIGN_FILES, ...DATABASE_LAB_REQUIRED_PROTOTYPE_FILES],  
      );  
      const workspaceFiles = getScenarioWorkspaceFiles(scenarioState);  
      const existingDesignDocFiles = getScenarioWorkspaceFiles(scenarioState)  
        .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_DESIGN_DIR}/`));  
      const existingPrototypeSrcFiles = getScenarioWorkspaceFiles(scenarioState)
        .filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/src/`));
      const prototypeCodeDiagnostics = getDatabaseLabPrototypeCodeDiagnostics(scenarioState);
      const successfulRunIds = getRecentSuccessfulInvocationIds(scenarioState, 'run_command', 4);
      const benchmarkRunSucceeded = hasSuccessfulDatabaseBenchRunEvidence(scenarioState);
      const latestSuccessfulRunId = successfulRunIds.length > 0
        ? successfulRunIds[successfulRunIds.length - 1]
        : null;
      const latestSuccessfulRunExcerpt = latestSuccessfulRunId
        ? buildToolInvocationResultExcerpt(scenarioState, latestSuccessfulRunId)
        : null;
      const latestVerifyBenchFailure = getLatestDatabaseBenchRunFailure(scenarioState);
      const benchmarkDocRepairTargets = invalidOutputErrors  
        .filter((entry) => entry.startsWith('quality_gate_failed:doc_not_updated_with_benchmark:'))  
        .map((entry) => entry.split('quality_gate_failed:doc_not_updated_with_benchmark:')[1])  
        .filter(Boolean);  
      const qualityFailedChecks = Array.isArray(qualityAcceptance?.failedChecks) ? qualityAcceptance.failedChecks : [];  
      const designManifestMissing =  
        invalidOutputErrors.includes('quality_gate_failed:missing_database_design_manifest')  
        || qualityFailedChecks.includes('missing_database_design_manifest');  
      const benchmarkResultMissing =  
        invalidOutputErrors.includes('quality_gate_failed:missing_database_benchmark_result')  
        || qualityFailedChecks.includes('missing_database_benchmark_result');  
      const benchmarkToolEvidenceMissing =  
        invalidOutputErrors.includes('quality_gate_failed:missing_benchmark_tool_evidence')  
        || qualityFailedChecks.includes('missing_benchmark_tool_evidence');  
      const benchmarkMetricsMissing =  
        invalidOutputErrors.includes('quality_gate_failed:benchmark_result_missing_metrics')  
        || qualityFailedChecks.includes('benchmark_result_missing_metrics');  
      const benchmarkMetricKeysRepairNeeded =  
        invalidOutputErrors.includes('quality_gate_failed:benchmark_scaffold_missing_required_metric_keys')  
        || qualityFailedChecks.includes('benchmark_scaffold_missing_required_metric_keys')  
        || qualityFailedChecks.includes('benchmark_self_check_missing_required_metrics');  
      const benchmarkOutputContractRepairNeeded =  
        benchmarkMetricKeysRepairNeeded
        || qualityFailedChecks.includes('benchmark_self_check_output_invalid')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_output_not_machine_readable')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_output_extra_stdout_logs')
        || prototypeCodeDiagnostics.failedChecks.includes('bench_output_missing_result_envelope');
      const benchmarkRepairNeeded =  
        benchmarkResultMissing  
        || benchmarkToolEvidenceMissing  
        || benchmarkMetricsMissing;  
      const benchmarkSelfCheckStale =
        invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_stale')
        || qualityFailedChecks.includes('benchmark_self_check_stale');
      const benchmarkSelfCheckNotGrounded =
        invalidOutputErrors.includes('quality_gate_failed:benchmark_self_check_not_grounded')
        || qualityFailedChecks.includes('benchmark_self_check_not_grounded');
      const benchmarkNotWiredToPrototypeModules =
        invalidOutputErrors.includes('quality_gate_failed:benchmark_not_wired_to_prototype_modules')
        || qualityFailedChecks.includes('benchmark_not_wired_to_prototype_modules');
      const benchmarkNotGroundedRepairNeeded =
        benchmarkSelfCheckNotGrounded
        || benchmarkNotWiredToPrototypeModules;
      const verifyBenchmarkSelfCheckObserved = hasObservedDatabaseBenchRunAttempt(scenarioState);
      const packageEntryDiagnostics = getDatabaseLabPackageEntryDiagnostics(scenarioState.workspaceDir);
      const blockingPackageEntryRefs = getBlockingDatabasePackageEntryRefs(packageEntryDiagnostics, {
        scenarioId: spec.id,
      }) ?? [];
      const missingCorePrototypeModules = DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES
        .filter((relativePath) => !workspaceFiles.includes(relativePath));
      const benchmarkDependencyUntrackedTargets = Array.from(new Set([
        ...qualityFailedChecks
          .filter((entry) => entry.startsWith('benchmark_dependency_untracked:'))
          .map((entry) => entry.split(':').slice(1).join(':')),
        ...invalidOutputErrors
          .filter((entry) => entry.startsWith('quality_gate_failed:benchmark_dependency_untracked:'))
          .map((entry) => entry.split(':').slice(2).join(':')),
      ].filter(Boolean)));
      const designManifestGroundingTargets = Array.from(new Set([
        ...benchmarkDependencyUntrackedTargets,
        ...qualityFailedChecks
          .filter((entry) => entry.startsWith('core_module_untracked:'))
          .map((entry) => entry.split(':').slice(1).join(':')),
        ...invalidOutputErrors
          .filter((entry) => entry.startsWith('quality_gate_failed:core_module_untracked:'))
          .map((entry) => entry.split(':').slice(2).join(':')),
      ].filter(Boolean)));
      const designManifestGroundingRepairNeeded =
        designManifestGroundingTargets.length > 0
        || qualityFailedChecks.some((entry) => entry.startsWith('implemented_module_outside_prototype_src:'))
        || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:implemented_module_outside_prototype_src:'));
      const designCoverageGapIndexes = Array.from(new Set(  
        qualityFailedChecks  
          .filter((entry) => entry.startsWith('design_coverage_gap:'))  
          .map((entry) => Number.parseInt(entry.split(':')[1] ?? '', 10))  
          .filter((value) => Number.isInteger(value) && value > 0),  
      ));  
      const designCoverageRepairTargets = Array.from(new Set(  
        designCoverageGapIndexes  
          .flatMap((index) => DATABASE_LAB_DESIGN_TOPIC_GROUPS[index]?.docs ?? DATABASE_LAB_REQUIRED_DESIGN_FILES),  
      ));  
      const designCoverageRepairTopics = designCoverageGapIndexes  
        .map((index) => `group ${index}: ${DATABASE_LAB_DESIGN_TOPIC_GROUPS[index]?.label ?? 'unknown topic group'}`);  
      const seededScaffoldPresent = missingFiles.length === 0 && hasDatabaseLabRequiredWorkspaceShape(scenarioState);  
      const targetedInspectionPaths = Array.from(new Set([  
        `${DATABASE_LAB_PROTOTYPE_DIR}/package.json`,  
        `${DATABASE_LAB_PROTOTYPE_DIR}/README.md`,  
        `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,  
        ...existingPrototypeSrcFiles.slice(0, 2),  
        DATABASE_LAB_DESIGN_QUALITY_FILE,  
      ].filter((relativePath) => workspaceFiles.includes(relativePath))));  
      const buildVerifyPrototypeRepairSourceBlocks = (relativePaths, limit = 3) => buildEmbeddedSourceBlocks(
        scenarioState,
        Array.from(new Set(
          (Array.isArray(relativePaths) ? relativePaths : [])
            .filter((relativePath) => typeof relativePath === 'string' && /\.(?:js|json|md)$/i.test(relativePath))
            .slice(0, limit),
        )),
      );
      const verifyBenchFailureExcerpt = latestVerifyBenchFailure
        ? buildToolInvocationResultExcerpt(scenarioState, latestVerifyBenchFailure.activityId)
        : null;
      if (verifyBenchmarkSelfCheckObserved && missingCorePrototypeModules.length > 0) {
        const repairTargets = Array.from(new Set([
          ...missingCorePrototypeModules,
          ...(blockingPackageEntryRefs.length > 0 ? [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`] : []),
        ]));
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          'A benchmark-related command already ran, but the required prototype src modules are still missing. Do not rerun the benchmark and do not write benchmark result evidence in this turn.',
          `Write the missing benchmark-critical implementation modules now: ${missingCorePrototypeModules.join(', ')}.`,
          `Each module must contain runnable CommonJS logic with named exports, not placeholders or TODO stubs. Keep the APIs simple and coherent with ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js.`,
          blockingPackageEntryRefs.length > 0
            ? `Also repair ${DATABASE_LAB_PROTOTYPE_DIR}/package.json so declared entry refs no longer point at missing files: ${blockingPackageEntryRefs.join(', ')}. Removing an unnecessary main entry is acceptable; do not point it at an unwritten src/index.js.`
            : null,
          `Do not write ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE} yet. After these modules exist, the next turn must rerun the dry-run benchmark against the current files and only then write fresh evidence files.`,
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the prototype module recovery is in progress.',
        ].filter(Boolean), {
          phase: 'prototype_modules',
          phaseCursor: 'prototype_modules',
          targetPaths: repairTargets,
          allowedWritePaths: repairTargets,
          requiredTrackerStatus: 'IN_PROGRESS',
          requiredTrackerDecision: 'CONTINUE',
          uniqueKey: `database_lab:verify_prototype_modules_after_benchmark:${repairTargets.join('|')}`,
        });
      }
      if (blockingPackageEntryRefs.length > 0) {
        const repairTargets = [`${DATABASE_LAB_PROTOTYPE_DIR}/package.json`];
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          `The prototype package declares entry refs that point at missing files: ${blockingPackageEntryRefs.join(', ')}.`,
          `Repair only ${DATABASE_LAB_PROTOTYPE_DIR}/package.json now. Remove optional main/start entries that point at unwritten files such as src/index.js, or point them only at files that already exist.`,
          `Keep scripts.bench pointing at ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js. Do not write ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js in this phase unless it is explicitly targeted in a later prototype module repair.`,
          `Do not write ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE}, and do not rerun the benchmark until package entry refs are coherent.`,
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while package entry repair remains.',
        ], {
          phase: 'verify_package_entry_repair',
          phaseCursor: 'verify_package_entry_repair',
          targetPaths: repairTargets,
          allowedWritePaths: repairTargets,
          allowedTools: ['write_file'],
          allowTargetedReadInspection: false,
          requiredTrackerStatus: 'IN_PROGRESS',
          requiredTrackerDecision: 'CONTINUE',
          uniqueKey: `database_lab:verify_package_entry_repair:${blockingPackageEntryRefs.join('|')}`,
        });
      }
      const verifyPrototypeApiRepairCandidates = Array.from(new Set([
        `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
        ...getDatabasePrototypePathsMentionedInText(verifyBenchFailureExcerpt),
        ...prototypeCodeDiagnostics.failedChecks
          .filter((entry) =>
            entry.startsWith('bench_module_api_mismatch:')
            || entry.startsWith('bench_module_export_mismatch:')
            || entry.startsWith('bench_module_export_name_mismatch:')
          )
          .map((entry) => entry.split(':').slice(1, 2).join(':'))
          .filter(Boolean),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
          ? prototypeCodeDiagnostics.benchImportedModuleFiles
          : []),
        ...(benchmarkNotGroundedRepairNeeded
          ? DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
          : []),
        ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
          || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
          ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
          : []),
      ].filter(Boolean)));
      const verifyPrototypeApiRepairTargets = getNarrowDatabaseBenchRepairTargets(
        verifyPrototypeApiRepairCandidates,
        {
          failureText: verifyBenchFailureExcerpt,
          maxTargets: 4,
        },
      );
      const benchmarkEvidenceWriteReady =
        missingFiles.length === 0
        && successfulRunIds.length > 0
        && benchmarkRunSucceeded
        && !benchmarkSelfCheckStale
        && !benchmarkSelfCheckNotGrounded
        && !benchmarkNotWiredToPrototypeModules
        && !verifyBenchFailureExcerpt
        && !benchmarkOutputContractRepairNeeded
        && (
          benchmarkDocRepairTargets.length > 0
          || designManifestMissing
          || benchmarkRepairNeeded
          || designManifestGroundingRepairNeeded
        );
      const verifyPrototypeApiRepairNeeded =
        seededScaffoldPresent
        && verifyPrototypeApiRepairTargets.length > 1
        && !benchmarkEvidenceWriteReady
        && (
          Boolean(verifyBenchFailureExcerpt)
          || successfulRunIds.length > 0
          || benchmarkSelfCheckStale
          || benchmarkSelfCheckNotGrounded
          || verifyBenchmarkSelfCheckObserved
        );
      const buildVerifyBenchmarkOutputContractRepairInstruction = () => {
        const repairTargets = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
            : []),
        ]));
        const repairSourceBlocks = buildVerifyPrototypeRepairSourceBlocks(repairTargets, repairTargets.length);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets),
          `A benchmark-related command already executed in this thread. Reuse one of these invocation ids later only if the repaired benchmark output is actually successful: ${successfulRunIds.join(', ')}.`,
          'Do not rerun the benchmark in this turn. The remaining blocker is the benchmark scaffold output/API contract, not missing execution evidence.',
          `Repair only ${repairTargets.join(', ')} now so npm run bench -- --dry-run prints exactly one machine-readable success JSON object to stdout.`,
          `That JSON object must have top-level status, summary, and metrics keys. metrics must include pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`,
          'Do not print banner logs, phase logs, or any extra prose before or after the JSON object. stdout must be parseable as one benchmark result payload.',
          'Do not leave workload, total_ops, elapsed_ms, throughput_ops_per_sec, latency_avg_ms, latency_p50_ms, latency_p99_ms, or errors as top-level fields. If useful, put those values under summary or metrics.',
          'A valid dry-run payload can be: {"status":"success","summary":{"workload":"insert","totalOps":10000},"metrics":{"pagesWritten":10000,"pagesRead":10000,"writeDurationMs":0,"readDurationMs":0,"totalDurationMs":0}}.',
          'It is acceptable to log human-readable progress to stderr, but stdout must contain only that single JSON result object.',
          `This output repair is still required to stay grounded in the prototype modules. Keep or add direct CommonJS imports from ${DATABASE_LAB_PROTOTYPE_DIR}/src, including StorageEngine, BufferPool, BPlusTreeIndex, WALManager, and TransactionManager when those files exist.`,
          'Do not replace the benchmark with placeholder-only loops. The dry-run path should instantiate the real modules and perform at least one small guarded operation through their real methods before building the status/summary/metrics JSON.',
          `Do not rewrite ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, ${DATABASE_LAB_PROTOTYPE_DIR}/README.md, design docs, or quality files in this output repair phase.`,
          prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
            ? `Static inspection also found a bench/WAL API mismatch. Do not keep wal.getFlushCount() unless ${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js implements getFlushCount(); using an existing flushCount property is acceptable if the benchmark result remains successful and machine-readable.`
            : null,
          'Keep the existing real module execution path intact. This turn is only for repairing the benchmark output contract, not for rewriting design docs or result files.',
          ...(repairSourceBlocks.length > 0
            ? [
              'The current benchmark scaffold is embedded below. Use it directly and do not emit read_file in this turn.',
              ...repairSourceBlocks,
            ]
            : []),
          `Do not write ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE} in this turn. After bench.js is repaired, the next turn can rerun the dry-run benchmark and then write the result artifacts against the new successful invocation id.`,
        ].filter(Boolean), {
          phase: 'verify_bench_scaffold_repair',
          phaseCursor: 'verify_bench_scaffold_repair',
          targetPaths: repairTargets,
          allowTargetedReadInspection: false,
          uniqueKey: `database_lab:verify_bench_scaffold_repair:${repairTargets.join('|')}`,
        });
      };
      const buildBenchmarkEvidenceWriteInstruction = () => {
        const repairPaths = [DATABASE_LAB_BENCH_RESULT_FILE, DATABASE_LAB_VERIFY_QUALITY_FILE];
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairPaths),
          'The dry-run benchmark already succeeded and the required design/prototype files already exist. The remaining work is evidence finalization only.',
          latestSuccessfulRunId
            ? `Use this successful run_command invocation id as sourceInvocationId: ${latestSuccessfulRunId}.`
            : 'Use the latest successful benchmark run_command invocation id as sourceInvocationId.',
          latestSuccessfulRunExcerpt,
          `Emit exactly two write_file calls for these exact paths in this order: ${DATABASE_LAB_BENCH_RESULT_FILE}, ${DATABASE_LAB_VERIFY_QUALITY_FILE}.`,
          'Do not emit read_file, list_files, search_files, create_folder, run_command, or delegate_subtask in this turn.',
          `Write ${DATABASE_LAB_BENCH_RESULT_FILE} from the observed successful benchmark result. The JSON must contain top-level status, summary, and metrics keys. metrics must include pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs.`,
          `Then write ${DATABASE_LAB_VERIFY_QUALITY_FILE} with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary. resultFile must be ${DATABASE_LAB_BENCH_RESULT_FILE}.`,
          `implementedModules must name real runnable files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/: ${existingPrototypeSrcFiles.join(', ') || DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.join(', ')}.`,
          'After these two evidence files are written, end with one tracker JSON using status IN_PROGRESS and decision CONTINUE so the runtime can re-evaluate and finalize on the next pass.',
        ], {
          phase: 'verify_benchmark_evidence_write',
          phaseCursor: 'verify_benchmark_evidence_write',
          targetPaths: repairPaths,
          allowedWritePaths: repairPaths,
          allowedTools: ['write_file'],
          allowTargetedReadInspection: false,
          requiredTrackerStatus: 'IN_PROGRESS',
          requiredTrackerDecision: 'CONTINUE',
          uniqueKey: `database_lab:verify_benchmark_evidence_write:${latestSuccessfulRunId ?? 'latest'}`,
        });
      };
      if (
        missingFiles.length === 0
        && successfulRunIds.length > 0
        && benchmarkOutputContractRepairNeeded
      ) {
        return buildVerifyBenchmarkOutputContractRepairInstruction();
      }
      if (missingFiles.length === 0 && successfulRunIds.length > 0 && benchmarkSelfCheckStale && !verifyBenchFailureExcerpt) {
        return buildDatabaseBenchmarkSelfCheckInstruction([
          `A benchmark-related command succeeded earlier in this thread, but that evidence is now stale because ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js or prototype/src changed afterward.`,
          `Do not reuse the old invocation ids yet: ${successfulRunIds.join(', ')}.`,
          `Before writing ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE}, rerun one real dry-run benchmark command from ${DATABASE_LAB_PROTOTYPE_DIR} now and capture a fresh run_command invocation id.`,
          'If the rerun succeeds, the next turn can write fresh benchmark result artifacts against the new successful invocation id. If it fails, preserve the exact command failure for targeted repair.',
        ].join(' '));
      }
      if (
        benchmarkEvidenceWriteReady
        && benchmarkRepairNeeded
        && benchmarkDocRepairTargets.length === 0
        && !designManifestMissing
        && !designManifestGroundingRepairNeeded
      ) {
        return buildBenchmarkEvidenceWriteInstruction();
      }
      if (verifyPrototypeApiRepairNeeded) {
        const verifyPrototypeApiInspectionPaths = Array.from(new Set([
          ...verifyPrototypeApiRepairTargets,
          ...prototypeCodeDiagnostics.benchImportedModuleFiles,
        ]));
        const repairSourceBlocks = buildVerifyPrototypeRepairSourceBlocks(
          verifyPrototypeApiRepairTargets,
          verifyPrototypeApiRepairTargets.length,
        );
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(verifyPrototypeApiRepairTargets, {
            allowTargetedReads: true,
            allowedReadPaths: verifyPrototypeApiInspectionPaths,
          }),
          'The benchmark scaffold and the current prototype APIs are not aligned. Repair the cited prototype files before rerunning or writing benchmark result evidence.',
          ...(verifyBenchFailureExcerpt ? [verifyBenchFailureExcerpt] : []),
          `Static prototype inspection found: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`,
          prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_module_api_mismatch:'))
            ? 'If bench.js calls methods that the imported database facade does not expose, either change bench.js to the real method names or add coherent methods to the imported module. Do not leave calls such as engine.rangeScan when the module only exposes rangeQuery.'
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
            ? `Static inspection found an internal StorageEngine/BPlusTreeIndex API mismatch. Align ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js with ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js before rerunning the benchmark; do not leave calls such as pkIndex.search when the index module only exposes lookup.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('bench_scaffold_missing_storage_engine_entrypoint')
            ? 'The benchmark should exercise real prototype modules directly or through a substantive facade. If it imports src/index.js, that file must contain real runtime behavior and must be listed in the design manifest after the repair.'
            : null,
          benchmarkNotWiredToPrototypeModules
            ? `The quality gate says the benchmark is not wired to prototype modules. Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it imports and exercises the real modules under ${DATABASE_LAB_PROTOTYPE_DIR}/src/ instead of placeholder-only or simulated workload logic.`
            : null,
          benchmarkSelfCheckNotGrounded
            ? 'The previous benchmark success is not grounded enough to write verification evidence. After repairing the benchmark wiring, the next turn must rerun the dry-run benchmark and only then write fresh result evidence.'
            : null,
          `Keep the repair scoped to: ${verifyPrototypeApiRepairTargets.join(', ')}.`,
          `Do not write ${DATABASE_LAB_BENCH_RESULT_FILE} or ${DATABASE_LAB_VERIFY_QUALITY_FILE} in this turn. After this API repair, the next turn must rerun the dry-run benchmark against the current files.`,
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Prefer them directly. If one narrow re-read is necessary before rewriting, use only the explicitly allowed read paths from this repair batch.',
              ...repairSourceBlocks,
            ]
            : []),
        ].filter(Boolean), {
          phase: 'verify_bench_api_repair',
          phaseCursor: 'verify_bench_api_repair',
          targetPaths: verifyPrototypeApiRepairTargets,
          allowTargetedReadInspection: true,
          allowedReadPaths: verifyPrototypeApiInspectionPaths,
          allowedOptionalPaths: [DATABASE_LAB_DESIGN_QUALITY_FILE],
          uniqueKey: `database_lab:verify_bench_api_repair:${verifyPrototypeApiRepairTargets.join('|')}`,
        });
      }
      if (seededScaffoldPresent && successfulRunIds.length === 0 && verifyBenchFailureExcerpt) {
        const repairCandidates = Array.from(new Set([
          `${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js`,
          ...getDatabasePrototypePathsMentionedInText(verifyBenchFailureExcerpt),
          ...prototypeCodeDiagnostics.failedChecks
            .filter((entry) =>
              entry.startsWith('bench_module_api_mismatch:')
              || entry.startsWith('bench_module_export_mismatch:')
              || entry.startsWith('bench_module_export_name_mismatch:')
            )
            .map((entry) => entry.split(':').slice(1, 2).join(':'))
            .filter(Boolean),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_wal_manager_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_wal_manager_missing_method:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/wal-manager.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.includes('bench_transaction_manager_argument_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_missing_method:'))
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_transaction_manager_argument_mismatch:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_storage_engine_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_missing_method:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('storage_engine_index_missing_method:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js`, `${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js`]
            : []),
          ...(prototypeCodeDiagnostics.failedChecks.includes('bench_buffer_pool_api_mismatch')
            || prototypeCodeDiagnostics.failedChecks.some((entry) => entry.startsWith('bench_buffer_pool_missing_method:'))
            ? [`${DATABASE_LAB_PROTOTYPE_DIR}/src/buffer-pool.js`]
            : []),
          ...prototypeCodeDiagnostics.benchImportedModuleFiles.filter((relativePath) =>
            verifyBenchFailureExcerpt.includes(relativePath.split('/').slice(-1)[0])
          ),
        ]));
        const repairTargets = getNarrowDatabaseBenchRepairTargets(repairCandidates, {
          failureText: verifyBenchFailureExcerpt,
          maxTargets: 4,
        });
        const verifyBenchFailureInspectionPaths = Array.from(new Set([
          ...repairTargets,
          ...prototypeCodeDiagnostics.benchImportedModuleFiles,
        ]));
        const repairSourceBlocks = buildVerifyPrototypeRepairSourceBlocks(repairTargets, repairTargets.length);
        return buildDatabaseLabContinueInstruction([
          buildWriteOnlyRepairPrelude(repairTargets, {
            allowTargetedReads: true,
            allowedReadPaths: verifyBenchFailureInspectionPaths,
          }),
          'The benchmark command already ran and failed with concrete stderr. Do not run another benchmark and do not recreate the scaffold in this turn.',
          verifyBenchFailureExcerpt,
          prototypeCodeDiagnostics.failedChecks.length > 0
            ? `Static prototype inspection also found: ${prototypeCodeDiagnostics.failedChecks.join(', ')}.`
            : null,
          /ReferenceError:\s+[A-Za-z_$][A-Za-z0-9_$]*\s+is not defined/i.test(verifyBenchFailureExcerpt)
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js so it has no undeclared variables. Replace stray aliases with the actual declared benchmark objects, or declare the variable from the real prototype module before use.`
            : null,
          prototypeCodeDiagnostics.failedChecks.includes('storage_engine_index_contract_mismatch')
            ? `Static inspection also found an internal StorageEngine/BPlusTreeIndex API mismatch. If the failed stack mentions pkIndex.search or another index method, repair ${DATABASE_LAB_PROTOTYPE_DIR}/src/storage-engine.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/b-plus-tree-index.js together so the benchmark can execute the real modules.`
            : null,
          /Transaction\s+(?:undefined|null|[^\s]+)\s+not found/i.test(verifyBenchFailureExcerpt)
            ? `Repair ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js and ${DATABASE_LAB_PROTOTYPE_DIR}/src/transaction-manager.js only as needed so commit/rollback calls pass the expected transaction id or the manager methods accept the transaction object consistently.`
            : null,
          `Keep the repair scoped to the cited prototype files: ${repairTargets.join(', ')}.`,
          'Do not write benchmark result JSON or quality verification JSON in this turn. The next turn must rerun the dry-run benchmark after this repair and only then write fresh evidence files.',
          ...(repairSourceBlocks.length > 0
            ? [
              'The current cited files are embedded below. Prefer them directly. If one narrow re-read is necessary before rewriting, use only the explicitly allowed read paths from this repair batch.',
              ...repairSourceBlocks,
            ]
            : []),
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while the failed benchmark is being repaired.',
        ].filter(Boolean), {
          phase: 'verify_bench_failure_repair',
          phaseCursor: 'verify_bench_failure_repair',
          targetPaths: repairTargets,
          allowTargetedReadInspection: true,
          allowedReadPaths: verifyBenchFailureInspectionPaths,
          uniqueKey: `database_lab:verify_bench_failure_repair:${repairTargets.join('|')}`,
        });
      }
      if (seededScaffoldPresent && successfulRunIds.length === 0) {
        return buildDatabaseLabContinueInstruction([
          'An existing database-lab design and prototype scaffold is already present in this workspace from the earlier design phase.',
          `Do not recreate folders and do not rewrite existing files under ${DATABASE_LAB_DESIGN_DIR} or ${DATABASE_LAB_PROTOTYPE_DIR} in this turn unless a targeted inspection or failed benchmark command proves a specific defect.`,
          `The existing scaffold already includes these key files: ${[  
            ...existingDesignDocFiles,  
            ...targetedInspectionPaths.filter((relativePath) => relativePath.startsWith(`${DATABASE_LAB_PROTOTYPE_DIR}/`)),  
          ].join(', ')}.`,  
          'A brief inventory pass is allowed if needed before the benchmark attempt, but keep it narrow.',  
          targetedInspectionPaths.length > 0  
            ? `If you truly need inspection before the benchmark attempt, emit read_file only for these exact paths and at most once per path: ${targetedInspectionPaths.join(', ')}.`  
            : 'Do not emit broad read_file calls in this turn.',  
          `Your first real action must be one benchmark-related run_command from ${DATABASE_LAB_PROTOTYPE_DIR}.`,  
          'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
          'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
          'Do not emit create_folder in this turn.',  
          'Do not emit write_file in this turn unless the benchmark fails and the exact failing file is first confirmed by read_file or command stderr.',  
          `After a successful benchmark command, the next turn can write ${DATABASE_LAB_BENCH_RESULT_FILE} and ${DATABASE_LAB_VERIFY_QUALITY_FILE} with the real invocation id and observed result.`,  
          'If the runtime requires a tracker after tool calls, use exactly status IN_PROGRESS and decision CONTINUE while verification work remains.',  
        ], {  
          phase: 'verify_benchmark_first',  
          phaseCursor: 'verify_benchmark_first',  
          allowedTools: ['run_command', 'read_file', 'list_files'],  
          allowedPaths: targetedInspectionPaths,  
          targetPaths: targetedInspectionPaths,  
          uniqueKey: `database_lab:verify_benchmark_first:${targetedInspectionPaths.join('|')}`,  
        });  
      }  
      if (missingFiles.length === 0 && successfulRunIds.length > 0 && benchmarkOutputContractRepairNeeded) {
        return buildVerifyBenchmarkOutputContractRepairInstruction();
      }
      if (
        missingFiles.length === 0
        && successfulRunIds.length > 0
        && (
          benchmarkDocRepairTargets.length > 0
          || designManifestMissing
          || benchmarkRepairNeeded
          || designManifestGroundingRepairNeeded
        )
      ) {
        const repairPaths = Array.from(new Set([
          ...benchmarkDocRepairTargets,
          ...(designManifestMissing || designManifestGroundingRepairNeeded ? [DATABASE_LAB_DESIGN_QUALITY_FILE] : []),
          ...(benchmarkRepairNeeded ? [DATABASE_LAB_VERIFY_QUALITY_FILE, DATABASE_LAB_BENCH_RESULT_FILE] : []),
        ]));
        return [  
          buildWriteOnlyRepairPrelude(repairPaths),  
          `A benchmark-related command already succeeded in this thread. Reuse one of these invocation ids: ${successfulRunIds.join(', ')}.`,  
          'Do not rerun the benchmark first. This is a write-first verification repair pass.',  
          benchmarkDocRepairTargets.length > 0  
            ? `Repair these exact design docs so they include the observed benchmark or dry-run result: ${benchmarkDocRepairTargets.join(', ')}.`  
            : null,  
          'Do not emit read_file or run_command in this turn unless one of those files is actually missing. This is a write-first repair pass.',  
          designManifestMissing
            ? `Write or repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} with designFiles, prototypeFiles, implementedModules, and claimBoundaries that match the real files already present under ${DATABASE_LAB_ROOT}/.`
            : null,
          designManifestGroundingRepairNeeded
            ? `Also repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} so implementedModules lists the real substantive prototype src modules used by the benchmark: ${(designManifestGroundingTargets.length > 0 ? designManifestGroundingTargets : existingPrototypeSrcFiles).join(', ')}. Do not leave those files in pendingModules, and do not list ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js as an implemented module.`
            : null,
          designManifestMissing
            ? `designFiles must be a subset of the real design markdown files already on disk under ${DATABASE_LAB_DESIGN_DIR}: ${existingDesignDocFiles.join(', ') || DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}. Do not invent indexing.md, transactions.md, wal-recovery.md, or buffer-pool.md unless those files were actually written in the same turn.`
            : null,
          benchmarkRepairNeeded  
            ? `Write or repair ${DATABASE_LAB_VERIFY_QUALITY_FILE} with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary. sourceInvocationId must equal one of these literal successful run_command ids: ${successfulRunIds.join(', ')}. Do not use placeholders such as pending_command_result or result_pending. resultFile should be ${DATABASE_LAB_BENCH_RESULT_FILE}.`  
            : null,  
          benchmarkRepairNeeded  
            ? `Write or repair ${DATABASE_LAB_BENCH_RESULT_FILE} in the same turn. The JSON must contain top-level status, summary, and metrics keys. metrics must include at least pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs. You may keep extra fields such as config, operations, or mysqlParity, but status/summary/metrics are mandatory.`  
            : null,  
          `implementedModules must name real runnable files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/: ${existingPrototypeSrcFiles.join(', ') || DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.join(', ')}.`,  
          'Keep the updated docs explicit about what the prototype actually verified versus what remains unproven about MySQL-nearness.',  
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while verification or repair work remains.',  
        ].join(' ');
      }
      if (missingFiles.length === 0 && successfulRunIds.length > 0 && benchmarkDependencyUntrackedTargets.length > 0) {
        return [
          buildWriteOnlyRepairPrelude([DATABASE_LAB_DESIGN_QUALITY_FILE]),
          `A benchmark-related command already succeeded, but quality cannot treat it as grounded because these benchmark-imported modules are missing from ${DATABASE_LAB_DESIGN_QUALITY_FILE}: ${benchmarkDependencyUntrackedTargets.join(', ')}.`,
          'Do not rerun the benchmark in this turn and do not rewrite design docs. This is a manifest-only grounding repair.',
          `Repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} so implementedModules includes every real benchmark dependency module under ${DATABASE_LAB_PROTOTYPE_DIR}/src that contains substantive runnable behavior.`,
          `The current real src files are: ${existingPrototypeSrcFiles.join(', ') || 'none'}.`,
          `If ${DATABASE_LAB_PROTOTYPE_DIR}/src/index.js is only a thin barrel export, change the benchmark to import substantive modules directly in a separate bench API repair instead of listing the barrel as implemented behavior.`,
          'After the manifest is repaired, the next turn must rerun the dry-run benchmark if any benchmark or imported src file changed after the last successful command.',
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while grounding repair remains.',
        ].join(' ');
      }
      if (missingFiles.length === 0 && successfulRunIds.length > 0 && designCoverageGapIndexes.length > 0) {
        return [
          buildWriteOnlyRepairPrelude(designCoverageRepairTargets),
          `A benchmark-related command already succeeded in this thread. Reuse one of these invocation ids: ${successfulRunIds.join(', ')}.`,  
          `The remaining quality failure is design coverage, not benchmark execution: ${designCoverageRepairTopics.join(', ')}.`,  
          'Do not rerun the benchmark and do not emit broad read_file calls in this turn. This is a write-only design repair pass.',  
          `Rewrite only these design docs now: ${designCoverageRepairTargets.join(', ')}.`,  
          'Add explicit sections or bullets that cover the missing topic groups in concrete architectural language.',  
          'For wal/recovery/checkpoint, describe the intended write-ahead log flow, checkpoint trigger, crash-recovery replay order, and what remains unproven in the current prototype.',  
          'Keep all MySQL-nearness statements honest. The docs must distinguish implemented prototype behavior from target design and unproven areas.',  
          'Do not remove the existing benchmark evidence. Keep references to the successful dry-run benchmark and keep limitations explicit.',  
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE while these doc repairs are being written.',  
        ].join(' ');  
      }  
      if (missingFiles.length > 0) {  
        const repairPaths = Array.from(new Set([  
          ...missingFiles,  
          DATABASE_LAB_DESIGN_QUALITY_FILE,  
        ]));  
        return [  
          buildWriteOnlyRepairPrelude(repairPaths),  
          `These required files are still missing and must be repaired before any benchmark command can run: ${missingFiles.join(', ')}.`,  
          `Do not emit create_folder or run_command in this turn. First write the missing database design and prototype files under ${DATABASE_LAB_ROOT}/.`,  
          `Also write or repair ${DATABASE_LAB_DESIGN_QUALITY_FILE} so it lists designFiles, prototypeFiles, implementedModules, and claimBoundaries that match the real files you just wrote.`,  
          `designFiles must be a subset of the real design markdown files already on disk under ${DATABASE_LAB_DESIGN_DIR}: ${existingDesignDocFiles.join(', ') || DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}.`,  
          `implementedModules must point to real files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/, such as: ${DATABASE_LAB_DEFAULT_PROTOTYPE_SRC_FILES.join(', ')}.`,  
          'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE. Do not use BLOCKED.',  
          'The next turn can execute the benchmark only after these files exist.',  
        ].join(' ');  
      }  
      return [  
        buildJsonToolCallPrelude(),  
        `The database design package must live under ${DATABASE_LAB_ROOT}/. Produce real verification evidence now.`,  
        `Read these exact files first only if you need to confirm their contents: ${DATABASE_LAB_REQUIRED_DESIGN_FILES.join(', ')}, ${DATABASE_LAB_PROTOTYPE_DIR}/package.json, ${DATABASE_LAB_PROTOTYPE_DIR}/README.md, and ${DATABASE_LAB_PROTOTYPE_DIR}/scripts/bench.js.`,  
        `Then execute a real benchmark-related command from ${DATABASE_LAB_PROTOTYPE_DIR}. Do not use ${DATABASE_LAB_ROOT}/package.json; the Node project root is ${DATABASE_LAB_PROTOTYPE_DIR}.`,  
        'Preferred command object: {"tool":"run_command","command":"npm run bench -- --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
        'Fallback command objects: {"tool":"run_command","command":"npm run dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"npm run build","workingDirectory":"database-lab/prototype","timeout_ms":30000} {"tool":"run_command","command":"node scripts/bench.js --dry-run","workingDirectory":"database-lab/prototype","timeout_ms":30000}.',  
        'If the prototype scripts are missing or broken, repair the real files first and then execute the verification command.',  
        successfulRunIds.length > 0  
          ? `If a benchmark-related command already succeeded in this thread, cite one of these invocation ids in the result file and quality report: ${successfulRunIds.join(', ')}.`  
          : 'After the benchmark command succeeds, capture the real invocation id and cite it in the result file and quality report.',  
        `sourceInvocationId must be the literal tool_... id of the successful run_command. Do not use placeholders such as pending_command_result or result_pending.`,  
        `After the benchmark command succeeds, write ${DATABASE_LAB_BENCH_RESULT_FILE} with top-level status, summary, and metrics keys. metrics must include at least pagesWritten, pagesRead, writeDurationMs, readDurationMs, and totalDurationMs. You may keep extra fields such as config, operations, engineStats, or mysqlParity.`,  
        `Then write ${DATABASE_LAB_VERIFY_QUALITY_FILE} with benchmarkCommand, sourceInvocationId, resultFile, updatedDocs, implementedModules, and verificationSummary. resultFile should be ${DATABASE_LAB_BENCH_RESULT_FILE}.`,  
        `implementedModules must point to real files under ${DATABASE_LAB_PROTOTYPE_DIR}/src/. Do not claim verification success while ${DATABASE_LAB_PROTOTYPE_DIR}/src/ is empty or stub-only.`,  
        'If the runtime requires a tracker, use exactly status IN_PROGRESS and decision CONTINUE until the benchmark and evidence files are complete. Do not use BLOCKED.',  
        'After command results exist, the next turn can summarize what was actually verified and what remains unproven about MySQL-nearness.',  
      ].join(' ');  
    }  
    
    if (correctionKind === 'AWAITING_TRACKER') {  
      if (isDocsNormalizeScenario(spec)) {
        return buildOutputAndTrackerCorrection('The output must list only files that were actually written under normalized/, and files_created must match that exact written set.');  
      }  
      if (isDocsSynthesizeScenario(spec)) {
        return buildOutputAndTrackerCorrection('The output must list only handbook files that were actually written, and the details must reference the real source filenames you used.');  
      }  
      if (isWebScenario(spec)) {
        if (!externalBlogWriteSatisfied) {  
          return buildPathBlogToolPrompt();  
        }  
        return buildOutputAndTrackerCorrection(`The output must reflect only files that were really written into ${targetExternalPath}; do not describe planned work as completed work.`);  
      }  
      if (isHostObservationScenario(spec)) {
        return buildOutputAndTrackerCorrection('Base every system or application claim strictly on successful run_command evidence from this thread.');  
      }  
      if (isDatabaseScenario(spec)) {
        return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, and separate verified prototype behavior from unproven MySQL-nearness claims.`);
      }
      return buildOutputAndTrackerCorrection('Base every artifact path and claim on successful tool results from this thread.');
    }
    
    if (correctionKind === 'AWAITING_OUTPUT_CORRECTION') {
      if (isDocsNormalizeScenario(spec)) {
        const hasDocsQualityIssue =
          qualityAcceptance?.verdict === 'failed'
          || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));
        if (hasDocsQualityIssue) {
          return buildDocsNormalizeToolPrompt();
        }
        return buildOutputAndTrackerCorrection(`producedFiles must list only files that were actually written under normalized/, files_created must match that exact written set, and issues must mention any remaining quality failures: ${invalidOutputErrors.join('; ') || 'none'}.`);
      }
      if (isDocsSynthesizeScenario(spec)) {
        const hasDocsQualityIssue =
          qualityAcceptance?.verdict === 'failed'
          || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));
        if (hasDocsQualityIssue) {
          return buildDocsSynthesizeToolPrompt();
        }
        return buildOutputAndTrackerCorrection(`producedFiles must list only handbook files that were actually written, the details must reference the real source filenames you used, and issues must mention any remaining quality failures: ${invalidOutputErrors.join('; ') || 'none'}.`);
      }
      if (isSystemAuditScenario(spec)) {
        const hasSystemAuditQualityIssue =  
          qualityAcceptance?.verdict === 'failed'  
          || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));  
        if (hasSystemAuditQualityIssue) {  
          return buildSystemAuditToolPrompt();  
        }  
        return buildOutputAndTrackerCorrection(`Base every system claim strictly on successful run_command evidence from this thread, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);  
      }  
      if (isDatabaseDesignScenario(spec)) {
        if (shouldFinalizeDatabaseLabDesign) {  
          return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());  
        }  
        const hasDatabaseQualityIssue =  
          qualityAcceptance?.verdict === 'failed'  
          || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));  
        if (hasDatabaseQualityIssue) {  
          return buildDatabaseLabScaffoldPrompt();  
        }  
        return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, separate verified scaffold work from unproven MySQL-nearness claims, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);  
      }  
      if (isDatabaseVerifyScenario(spec)) {
        const hasDatabaseQualityIssue =  
          qualityAcceptance?.verdict === 'failed'  
          || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));  
        if (hasDatabaseQualityIssue) {  
          return buildDatabaseLabVerificationPrompt();  
        }  
        return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, separate verified prototype behavior from unproven MySQL-nearness claims, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);  
      }
      if (isWebScenario(spec)) {
        const hasWebQualityIssue =
          qualityAcceptance?.verdict === 'failed'
          || invalidOutputErrors.some((entry) => entry.startsWith('quality_gate_failed:') || entry.startsWith('quality_required_evidence:'));
        if (!externalBlogWriteSatisfied || hasWebQualityIssue) {
          return buildPathBlogToolPrompt();
        }
        return buildOutputAndTrackerCorrection(`The output must reflect the files that were really written into ${targetExternalPath}; do not describe planned work as completed work.`);
      }
      if (isHostObservationScenario(spec)) {
        return buildOutputAndTrackerCorrection(`Base every system or application claim strictly on successful run_command evidence from this thread, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);  
      }  
      if (isDatabaseScenario(spec)) {
        return buildOutputAndTrackerCorrection(`Keep the produced file list aligned with real files under ${DATABASE_LAB_ROOT}/, separate verified prototype behavior from unproven MySQL-nearness claims, and list unresolved quality failures explicitly in issues: ${invalidOutputErrors.join('; ') || 'none'}.`);
      }
      return buildOutputAndTrackerCorrection('Base every artifact path and claim on successful tool results from this thread.');
    }
    
    const qualityNeedsEvidence =  
      qualityAcceptance?.profileId  
      && qualityAcceptance.verdict === 'failed'  
      && (qualityAcceptance.requiredNextEvidence?.length ?? 0) > 0;  
    if (qualityNeedsEvidence) {  
      if (isWebScenario(spec)) {
        return buildPathBlogToolPrompt();  
      }  
      if (isDocsNormalizeScenario(spec)) {
        return buildDocsNormalizeToolPrompt();  
      }  
      if (isDocsSynthesizeScenario(spec)) {
        return buildDocsSynthesizeToolPrompt();  
      }  
      if (isSystemAuditScenario(spec)) {
        return buildSystemAuditToolPrompt();  
      }  
      if (isDesktopObservationScenario(spec)) {
        return buildDesktopObservationToolPrompt();  
      }  
      if (isDatabaseDesignScenario(spec)) {
        if (shouldFinalizeDatabaseLabDesign) {  
          return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());  
        }  
        return buildDatabaseLabScaffoldPrompt();  
      }  
      if (isDatabaseVerifyScenario(spec)) {
        return buildDatabaseLabVerificationPrompt();  
      }  
    }  
    
    if (qualityAcceptance?.profileId && qualityAcceptance.verdict === 'failed' && correctionKind !== 'AWAITING_TOOL_ACTION') {
      if (isDatabaseDesignScenario(spec)) {
        return buildDatabaseLabScaffoldPrompt();
      }

      if (isDatabaseVerifyScenario(spec)) {
        return buildDatabaseLabVerificationPrompt();
      }
      if (isSystemAuditScenario(spec)) {
        return buildSystemAuditToolPrompt();  
      }  
      const failedChecks = (Array.isArray(qualityAcceptance.failedChecks) ? qualityAcceptance.failedChecks : []).join(', ') || 'quality gate failed';
      const nextEvidence = (Array.isArray(qualityAcceptance.requiredNextEvidence) ? qualityAcceptance.requiredNextEvidence : []).join(', ') || 'no additional evidence was projected';
      return buildOutputAndTrackerCorrection(  
        `Fix these structured quality failures before claiming completion: ${failedChecks}. Required next evidence: ${nextEvidence}.`  
      );  
    }  
    
    if (isDatabaseVerifyScenario(spec) && databaseLabVerificationSatisfied && deterministicAcceptance?.verdict === 'passed') {
      return undefined;  
    }  
    
    if (shouldFinalizeDatabaseLabDesign) {  
      return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());  
    }  
    
    if (isDatabaseDesignScenario(spec) && databaseLabArtifactSatisfied && databaseLabBenchSatisfied && deterministicAcceptance?.verdict === 'passed') {
      return undefined;  
    }  
    
    if (isDesktopObservationScenario(spec) && desktopEvidenceSatisfied && deterministicAcceptance?.verdict === 'passed') {
      return undefined;  
    }  
    
    if (isDesktopObservationScenario(spec) && !desktopEvidenceSatisfied) {
      return buildDesktopObservationToolPrompt();  
    }  
    
    if (isDatabaseDesignScenario(spec) && !databaseLabArtifactSatisfied) {
      return buildDatabaseLabScaffoldPrompt();  
    }  
    
    if (isDatabaseDesignScenario(spec) && !hasDatabaseLabRequiredWorkspaceShape(scenarioState)) {
      return buildDatabaseLabScaffoldPrompt();  
    }  
    
    if (isDatabaseDesignScenario(spec) && !databaseLabBenchSatisfied) {
      return buildDatabaseLabScaffoldPrompt();  
    }  
    
    if (isDatabaseVerifyScenario(spec) && (!hasDatabaseLabRequiredWorkspaceShape(scenarioState) || !databaseLabVerificationSatisfied)) {
      return buildDatabaseLabVerificationPrompt();  
    }  
    
    if (isDatabaseVerifyScenario(spec) && toolExecutionFailure) {
      return buildOutputAndTrackerCorrection(`Quote the exact benchmark or prototype execution blocker, keep producedFiles limited to real files written under ${DATABASE_LAB_ROOT}/, and state clearly what was verified versus still unproven.`);  
    }  
    
    if (correctionKind === 'AWAITING_TOOL_ACTION') {  
      if (isDocsScenario(spec)) {
        if (isDocsNormalizeScenario(spec)) {
          return buildDocsNormalizeToolPrompt();  
        }  
        return buildDocsSynthesizeToolPrompt();  
      }  
      if (isHostObservationScenario(spec)) {
        if (isSystemAuditScenario(spec)) {
          return buildSystemAuditToolPrompt();  
        }  
        return buildDesktopObservationToolPrompt();  
      }  
      if (isDatabaseDesignScenario(spec)) {
        if (shouldFinalizeDatabaseLabDesign) {  
          return buildDatabaseLabFinalizationInstruction(getDatabaseLabProducedFilesForFinalization());  
        }  
        return buildDatabaseLabScaffoldPrompt();  
      }  
      if (isDatabaseVerifyScenario(spec)) {
        return buildDatabaseLabVerificationPrompt();  
      }  
      return buildPathBlogToolPrompt();  
    }  
    
    if (isWebScenario(spec) && !toolEvidenceSatisfied && !artifactEvidenceSatisfied) {
      return buildPathBlogToolPrompt();  
    }  
    
    if (missingVerificationEvidence) {  
      if (isSystemAuditScenario(spec)) {
        return buildSystemAuditToolPrompt();  
      }  
      if (isDesktopObservationScenario(spec)) {
        return buildDesktopObservationToolPrompt();  
      }  
      if (isDatabaseVerifyScenario(spec)) {
        return buildDatabaseLabVerificationPrompt();  
      }  
    }  
    
    if (isDatabaseVerifyScenario(spec) && !databaseLabVerificationSatisfied) {
      return buildDatabaseLabVerificationPrompt();  
    }  
    
    return undefined;  
  }

  return {
    buildDatabaseBenchmarkSelfCheckInstruction,
    deriveContinueMessage,
  };
}
