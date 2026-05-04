import {
  TaskDefinition,
  TaskRuntimeState,
  requiresToolEvidenceForExecutionProfile
} from '../../domain/contracts/types';
import {
  selectNextReadyUnit,
  applyLifecycleTransition
} from '../../domain/runtime/state-transition-applier';
import { canEarlyTerminateCurrentUnit } from '../../domain/runtime/execution-plan';
import { orchestrateTurn } from '../../domain/runtime/turn-orchestrator';
import { parseTurn } from '../../domain/parser/unit-output-parser';
import { createLlmContextMessage } from '../../domain/runtime/context-manager';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { createCheckpointId, createExecutionCorrelation } from '../../foundation/correlation/create-correlation';
import { createConfigSnapshotRecord, shouldReloadConfig } from '../../foundation/config/reload-policy';
import { createRuntimeEventEnvelope } from '../../foundation/projection/event-envelope';
import { createToolApprovalRecord } from '../../foundation/tools/approval-record';
import { createToolExecutionAuditDetails } from '../../foundation/tools/execution-audit';
import { createToolInvocationRecord } from '../../foundation/tools/create-invocation-record';
import { evaluateToolExecutionPolicy } from '../../foundation/tools/execution-policy';
import { validateToolInvocationRequest } from '../../foundation/tools/validate-invocation';
import { ValidatedOutputRecord } from '../../foundation/repository';
import { ToolDispatchOrchestrator } from './tools/tool-dispatch-orchestrator';
import { TaskActionResponse } from './types';
import { TaskRecordService } from './task-record-service';
import { normalizeProviderFailure } from '../adapters/providers/provider-client-helpers';
import { InterruptController } from './control/interrupt-controller';
import { OperatorCommandService } from './control/operator-command-service';
import { TaskTurnRuntimeControl } from './control/task-turn-runtime-control';
import { assembleTurnContext } from './turns/turn-context-assembly';
import { assembleStageTurnContext } from './turns/stage-turn-context-assembly';
import { executeTurnProvider } from './turns/turn-provider-execution';
import { TurnResultPersistence } from './turn-result-persistence';
import { TaskPlannerService } from './planning/task-planner-service';
import { TurnPlannerExecution } from './turns/turn-planner-execution';
import { ToolBatchExecutorService } from './tools/tool-batch-executor-service';
import { shouldMarkInvocationAsVerification } from './tools/tool-verification';
import { TurnBatchExecution } from './turns/turn-batch-execution';
import { TurnConsolidation } from './turns/turn-consolidation';
import { mapFallbackTurnOutcome, mapPlannerStageOutcome } from './turns/turn-outcome-mapper';
import { PlannedToolSummary } from './turns/turn-phase-types';
import { buildTurnRuntimeState } from './turns/turn-runtime-state-builder';
import { getExecutionProfile } from '../runtime/execution-profiles';
import { validateHostObservationRunCommandBoundary } from '../runtime/host-observation-policy';
import { runWorkspaceHooks } from '../runtime/workspace-hook-runner';
import { deriveTaskArtifactRoutingSummary } from './artifact-routing';
import { isProductRuntimeTask } from './task-definition';
import {
  DELEGATE_SUBTASK_TOOL_ID,
  extractDelegationMetadata,
  filterAllowedToolIdsForDelegation,
  getActiveDelegatedChildrenForParent,
  isDelegationRequiredForUnit
} from './delegation/delegation';

interface UnitToolEvidenceSummary {
  toolEvidenceCount: number;
  delegationEvidenceCount: number;
  verificationEvidenceCount: number;
  writeEvidencePaths: string[];
}

interface TaskSkillExtensionRequest {
  unitId: string | null;
  skillId: string;
  payload: Record<string, unknown>;
}

interface TaskMcpExtensionRequest {
  unitId: string | null;
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

interface ExecutedTaskExtensions {
  skillResults: Array<{
    skillId: string;
    status: 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE';
    message: string | null;
  }>;
  mcpResults: Array<{
    serverId: string;
    toolName: string;
    status: 'SUCCEEDED' | 'FAILED' | 'UNAVAILABLE' | 'CAPABILITY_MISMATCH';
    message: string | null;
  }>;
  contextMessages: ReturnType<typeof createLlmContextMessage>[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseTaskSkillExtensions(metadata: Record<string, unknown>, currentUnitId: string): TaskSkillExtensionRequest[] {
  const extensions = isRecord(metadata.extensions) ? metadata.extensions : null;
  const skills = Array.isArray(extensions?.skills) ? extensions.skills : [];
  return skills
    .filter(isRecord)
    .map((entry) => ({
      unitId: typeof entry.unitId === 'string' ? entry.unitId : null,
      skillId: typeof entry.skillId === 'string' ? entry.skillId.trim() : '',
      payload: isRecord(entry.payload) ? entry.payload : {}
    }))
    .filter((entry) => entry.skillId && (!entry.unitId || entry.unitId === currentUnitId));
}

function parseTaskMcpExtensions(metadata: Record<string, unknown>, currentUnitId: string): TaskMcpExtensionRequest[] {
  const extensions = isRecord(metadata.extensions) ? metadata.extensions : null;
  const servers = Array.isArray(extensions?.mcp) ? extensions.mcp : [];
  return servers
    .filter(isRecord)
    .map((entry) => ({
      unitId: typeof entry.unitId === 'string' ? entry.unitId : null,
      serverId: typeof entry.serverId === 'string' ? entry.serverId.trim() : '',
      toolName: typeof entry.toolName === 'string' ? entry.toolName.trim() : '',
      arguments: isRecord(entry.arguments) ? entry.arguments : {}
    }))
    .filter((entry) => entry.serverId && entry.toolName && (!entry.unitId || entry.unitId === currentUnitId));
}

function normalizeWorkspaceRelativePath(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function normalizeToolId(toolId: string): string {
  return toolId.trim().toLowerCase().replace(/-/g, '_');
}

function isWriteEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'write_file' || normalized === 'create_folder' || normalized === 'run_command';
}

function isVerificationEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'read_file'
    || normalized === 'inspect_file'
    || normalized === 'search_files'
    || normalized === 'list_files'
    || normalized === 'run_command';
}

function isFailedInspectionEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === 'read_file'
    || normalized === 'inspect_file'
    || normalized === 'search_files'
    || normalized === 'list_files';
}

function isDelegationEvidenceTool(toolId: string): boolean {
  const normalized = normalizeToolId(toolId);
  return normalized === DELEGATE_SUBTASK_TOOL_ID.replace(/-/g, '_');
}

function collectInvocationEvidencePaths(invocation: { arguments: Record<string, unknown>; result: Record<string, unknown> | null }): string[] {
  const candidates = [
    invocation.result?.path,
    invocation.result?.file,
    invocation.result?.output_path,
    invocation.result?.output && typeof invocation.result.output === 'object' && !Array.isArray(invocation.result.output)
      ? (invocation.result.output as Record<string, unknown>).path
      : undefined,
    invocation.result?.output && typeof invocation.result.output === 'object' && !Array.isArray(invocation.result.output)
      ? (invocation.result.output as Record<string, unknown>).file
      : undefined,
    invocation.arguments.path,
    invocation.arguments.file,
    invocation.arguments.file_path,
    invocation.arguments.output
  ];
  return candidates
    .map((value) => normalizeWorkspaceRelativePath(value))
    .filter((value): value is string => !!value);
}

function buildToolEvidenceByUnit(latestToolInvocations: Array<{
  unitId: string;
  toolId: string;
  status: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown> | null;
}>): Map<string, UnitToolEvidenceSummary> {
  const summaries = new Map<string, {
    toolEvidenceCount: number;
    delegationEvidenceCount: number;
    verificationEvidenceCount: number;
    writeEvidencePaths: Set<string>;
  }>();
  for (const invocation of latestToolInvocations) {
    if (invocation.status !== 'SUCCEEDED' && invocation.status !== 'FAILED') {
      continue;
    }
    const summary = summaries.get(invocation.unitId) ?? {
      toolEvidenceCount: 0,
      delegationEvidenceCount: 0,
      verificationEvidenceCount: 0,
      writeEvidencePaths: new Set<string>()
    };
    summary.toolEvidenceCount += 1;
    if (invocation.status === 'SUCCEEDED' && isDelegationEvidenceTool(invocation.toolId)) {
      summary.delegationEvidenceCount += 1;
    }
    if (
      (invocation.status === 'SUCCEEDED' && isVerificationEvidenceTool(invocation.toolId))
      || (invocation.status === 'FAILED' && isFailedInspectionEvidenceTool(invocation.toolId))
    ) {
      summary.verificationEvidenceCount += 1;
    }
    if (invocation.status === 'SUCCEEDED' && isWriteEvidenceTool(invocation.toolId)) {
      for (const evidencePath of collectInvocationEvidencePaths(invocation)) {
        summary.writeEvidencePaths.add(evidencePath);
      }
    }
    summaries.set(invocation.unitId, summary);
  }
  return new Map(
    Array.from(summaries.entries()).map(([unitId, summary]) => [
      unitId,
      {
        toolEvidenceCount: summary.toolEvidenceCount,
        delegationEvidenceCount: summary.delegationEvidenceCount,
        verificationEvidenceCount: summary.verificationEvidenceCount,
        writeEvidencePaths: Array.from(summary.writeEvidencePaths)
      }
    ])
  );
}

function countDelegationEvidenceForUnit(params: {
  runtimes: Array<{
    definition: TaskDefinition;
  }>;
  parentTaskId: string;
  unitId: string;
}): number {
  return params.runtimes.reduce((total, record) => {
    const delegation = extractDelegationMetadata(record.definition);
    if (!delegation) {
      return total;
    }
    return delegation.parentTaskId === params.parentTaskId && delegation.parentUnitId === params.unitId
      ? total + 1
      : total;
  }, 0);
}

function collectAppliedArtifactEvidencePaths(params: {
  destinationDir: string | null;
  destinationPaths: string[];
  status: 'APPLIED' | 'CONFLICT' | 'FAILED' | null;
}): string[] {
  if (params.status !== 'APPLIED') {
    return [];
  }
  const evidence = new Set<string>();
  const normalizedDestinationDir = normalizeWorkspaceRelativePath(params.destinationDir);
  if (normalizedDestinationDir) {
    evidence.add(normalizedDestinationDir);
  }
  for (const destinationPath of params.destinationPaths) {
    const normalized = normalizeWorkspaceRelativePath(destinationPath);
    if (normalized) {
      evidence.add(normalized);
    }
  }
  return [...evidence];
}

function buildAcceptanceCorrectionContext(
  runtime: TaskRuntimeState,
  unitId: string,
  validatedOutputs: ValidatedOutputRecord[]
) {
  const pendingCorrection = runtime.pendingCorrection;
  if (pendingCorrection !== 'AWAITING_TRACKER' && pendingCorrection !== 'AWAITING_TOOL_ACTION') {
    return undefined;
  }
  const latestValidatedOutput = validatedOutputs
    .filter((record) => record.unitId === unitId)
    .at(-1);
  if (!latestValidatedOutput) {
    return undefined;
  }
  return {
    pendingCorrection,
    priorAcceptedOutput: {
      unitId,
      wrapper: latestValidatedOutput.wrapper,
      raw: latestValidatedOutput.raw,
      parsedJson: latestValidatedOutput.parsed
    },
    priorContractKeys: [...latestValidatedOutput.contractKeys]
  };
}

export class TaskTurnRunner {
  private readonly runtimeControl: TaskTurnRuntimeControl;
  private readonly resultPersistence: TurnResultPersistence;
  private readonly plannerService: TaskPlannerService;
  private readonly plannerExecution: TurnPlannerExecution;
  private readonly batchExecutor: TurnBatchExecution;
  private readonly consolidation: TurnConsolidation;

  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly records: TaskRecordService,
    private readonly toolDispatch: ToolDispatchOrchestrator,
    private readonly interruptController: InterruptController,
    private readonly commandService: OperatorCommandService
  ) {
    this.runtimeControl = new TaskTurnRuntimeControl(foundation, records);
    this.plannerService = new TaskPlannerService();
    this.plannerExecution = new TurnPlannerExecution(foundation, this.plannerService);
    this.batchExecutor = new TurnBatchExecution(new ToolBatchExecutorService(foundation, toolDispatch));
    this.consolidation = new TurnConsolidation(foundation);
    this.resultPersistence = new TurnResultPersistence(
      foundation,
      records,
      this.runtimeControl,
      toolDispatch,
      commandService
    );
  }

  private async planToolInvocations(params: {
    taskId: string;
    currentUnitId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
    parsedToolCalls: ReturnType<typeof parseTurn>['toolCalls'];
    parseWarnings?: string[];
    toolCallFormat: 'json-or-xml' | 'json';
    allowedToolIds: string[] | null;
  }): Promise<PlannedToolSummary> {
    const rejected: string[] = [];
    const acceptedInvocationIds: string[] = [];
    const approvalInvocationIds: string[] = [];
    let accepted = 0;
    let approvalRequired = 0;
    const invalidToolWarnings = (params.parseWarnings ?? []).filter((warning) => /invalid_tool_json/i.test(warning));
    if (invalidToolWarnings.length > 0) {
      rejected.push(...invalidToolWarnings);
      return {
        accepted,
        approvalRequired,
        rejected,
        acceptedInvocationIds,
        approvalInvocationIds
      };
    }

    const latestApprovals = await this.foundation.approvals.listLatest(params.taskId);

    for (const call of params.parsedToolCalls) {
      if (params.toolCallFormat === 'json' && call.source === 'xml') {
        rejected.push(`${call.toolName}: XML tool wrappers are not allowed for the current JSON-only provider policy. Emit a canonical JSON tool object instead.`);
        continue;
      }
      const request = {
        taskId: params.taskId,
        unitId: call.unitId === 'UNKNOWN' ? params.currentUnitId : call.unitId,
        toolName: call.toolName,
        arguments: call.parameters
      };
      const validation = validateToolInvocationRequest(this.foundation.extensions, request);
      if (!validation.ok) {
        rejected.push(`${request.toolName}: ${validation.errors.join(' ')}`);
        continue;
      }
      if (params.allowedToolIds && !params.allowedToolIds.includes(validation.tool.id)) {
        rejected.push(`${request.toolName}: tool is not allowed for the current execution profile.`);
        continue;
      }
      const hostObservationBoundaryError = validateHostObservationRunCommandBoundary({
        allowedToolIds: params.allowedToolIds,
        toolId: validation.tool.id,
        argumentsRecord: validation.normalizedArguments
      });
      if (hostObservationBoundaryError) {
        rejected.push(`${request.toolName}: ${hostObservationBoundaryError}`);
        continue;
      }

      const policy = evaluateToolExecutionPolicy({
        config: this.foundation.config,
        tool: validation.tool,
        argumentsRecord: validation.normalizedArguments,
        taskApprovals: latestApprovals
      });
      const invocation = createToolInvocationRecord({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        request: {
          ...request,
          arguments: validation.normalizedArguments
        },
        status: policy.decision === 'DENY'
          ? 'DENIED'
          : (policy.decision === 'REQUIRE_APPROVAL' ? 'WAITING_APPROVAL' : 'PLANNED'),
        error: policy.decision === 'DENY' ? policy.reason : null,
        metadata: {
          source: 'llm_response',
          parserSource: call.source,
          permissionDecision: policy.decision,
          permissionReason: policy.reason,
          riskCategory: policy.riskCategory,
          permissionGrantMatched: policy.grantMatched,
          verification: shouldMarkInvocationAsVerification({
            toolName: request.toolName,
            argumentsRecord: validation.normalizedArguments
          }),
          toolEffect: validation.tool.effect,
          toolRiskLevel: validation.tool.riskLevel
        }
      });
      await this.foundation.toolInvocations.append(invocation);

      if (policy.decision === 'DENY') {
        rejected.push(`${request.toolName}: ${policy.reason}`);
      } else if (policy.decision === 'REQUIRE_APPROVAL') {
        accepted += 1;
        approvalRequired += 1;
        approvalInvocationIds.push(invocation.invocationId);
        await this.foundation.approvals.append(
          createToolApprovalRecord({
            invocation,
            reason: policy.reason,
            metadata: {
              permissionDecision: policy.decision,
              riskCategory: policy.riskCategory,
              grantScope: 'task_risk_category'
            }
          })
        );
      } else {
        accepted += 1;
        acceptedInvocationIds.push(invocation.invocationId);
      }

      await this.foundation.logs.recordAudit({
        timestamp: Date.now(),
        severity: policy.decision === 'DENY' ? 'WARN' : (policy.decision === 'REQUIRE_APPROVAL' ? 'INFO' : 'DEBUG'),
        event: policy.decision === 'DENY'
          ? 'tool_invocation_denied'
          : (policy.decision === 'REQUIRE_APPROVAL' ? 'tool_invocation_waiting_approval' : 'tool_invocation_planned'),
        taskId: params.taskId,
        unitId: request.unitId,
        correlationId: params.correlationId,
        turnId: params.turnId,
        checkpointId: params.checkpointId,
        details: createToolExecutionAuditDetails({
          taskId: params.taskId,
          unitId: request.unitId,
          toolName: request.toolName,
          sessionId: params.sessionId,
          correlationId: params.correlationId,
          turnId: params.turnId,
          checkpointId: params.checkpointId,
          policy
        })
      });
    }

    return {
      accepted,
      approvalRequired,
      rejected,
      acceptedInvocationIds,
      approvalInvocationIds
    };
  }

  private async executeTaskExtensions(params: {
    definition: TaskDefinition;
    taskId: string;
    currentUnitId: string;
    sessionId: string;
    correlationId: string;
    turnId: string;
    checkpointId: string;
  }): Promise<ExecutedTaskExtensions> {
    const skillRequests = parseTaskSkillExtensions(params.definition.metadata, params.currentUnitId);
    const mcpRequests = parseTaskMcpExtensions(params.definition.metadata, params.currentUnitId);
    const results: ExecutedTaskExtensions = {
      skillResults: [],
      mcpResults: [],
      contextMessages: []
    };

    for (const request of skillRequests) {
      const skill = this.foundation.extensions.findSkill(request.skillId);
      const runtime = skill ? this.foundation.skillRuntimes.resolve(skill) : null;
      const invocationResult = !skill
        ? {
          ok: false,
          output: null,
          error: `backend_new skill error: skill "${request.skillId}" was not found.`,
          metadata: {}
        }
        : !runtime
          ? {
            ok: false,
            output: null,
            error: `backend_new skill error: no runtime registered for "${skill.id}".`,
            metadata: {}
          }
          : await runtime.invoke({
            skill,
            input: request.payload,
            context: {
              taskId: params.taskId,
              unitId: params.currentUnitId,
              sessionId: params.sessionId,
              correlationId: params.correlationId,
              turnId: params.turnId,
              checkpointId: params.checkpointId
            }
          });
      const status = !skill || !runtime
        ? 'UNAVAILABLE' as const
        : invocationResult.ok
          ? 'SUCCEEDED' as const
          : 'FAILED' as const;
      results.skillResults.push({
        skillId: request.skillId,
        status,
        message: invocationResult.error ?? null
      });
      results.contextMessages.push(createLlmContextMessage({
        role: 'tool',
        content: invocationResult.ok
          ? `Skill ${request.skillId} result: ${JSON.stringify(invocationResult.output ?? {})}`
          : `Skill ${request.skillId} failed: ${invocationResult.error ?? 'unknown error'}`,
        metadata: {
          unitId: params.currentUnitId,
          source: 'task_extension_skill',
          skillId: request.skillId,
          status
        }
      }));
      await this.foundation.events.append(createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'SKILL_EXECUTED',
        payload: {
          skillId: request.skillId,
          status,
          ok: invocationResult.ok,
          error: invocationResult.error ?? null,
          metadata: invocationResult.metadata
        }
      }));
    }

    for (const request of mcpRequests) {
      const server = this.foundation.extensions.findMcpServer(request.serverId);
      const client = server ? this.foundation.mcpClients.resolve(server) : null;
      const capability = server ? this.foundation.mcpClients.resolveCapability(server) : null;
      const result = !server
        ? {
          ok: false,
          output: null,
          error: `backend_new mcp error: server "${request.serverId}" was not found.`,
          metadata: {}
        }
        : !client
          ? {
            ok: false,
            output: null,
            error: `backend_new mcp error: no client registered for "${server.id}".`,
            metadata: {}
          }
          : capability && capability.supportsTools === false
            ? {
              ok: false,
              output: null,
              error: `backend_new mcp error: server "${server.id}" does not support tools.`,
              metadata: {}
            }
            : await client.callTool({
              server,
              toolName: request.toolName,
              arguments: request.arguments,
              context: {
                taskId: params.taskId,
                sessionId: params.sessionId,
                correlationId: params.correlationId,
                turnId: params.turnId
              }
            });
      const status = !server || !client
        ? 'UNAVAILABLE' as const
        : capability && capability.supportsTools === false
          ? 'CAPABILITY_MISMATCH' as const
          : result.ok
            ? 'SUCCEEDED' as const
            : 'FAILED' as const;
      results.mcpResults.push({
        serverId: request.serverId,
        toolName: request.toolName,
        status,
        message: result.error ?? null
      });
      results.contextMessages.push(createLlmContextMessage({
        role: 'tool',
        content: result.ok
          ? `MCP ${request.serverId}/${request.toolName} result: ${JSON.stringify(result.output ?? {})}`
          : `MCP ${request.serverId}/${request.toolName} failed: ${result.error ?? 'unknown error'}`,
        metadata: {
          unitId: params.currentUnitId,
          source: 'task_extension_mcp',
          serverId: request.serverId,
          toolName: request.toolName,
          status
        }
      }));
      await this.foundation.events.append(createRuntimeEventEnvelope({
        correlationId: params.correlationId,
        sessionId: params.sessionId,
        turnId: params.turnId,
        taskId: params.taskId,
        unitId: params.currentUnitId,
        checkpointId: params.checkpointId,
        type: 'MCP_TOOL_EXECUTED',
        payload: {
          serverId: request.serverId,
          toolName: request.toolName,
          status,
          ok: result.ok,
          error: result.error ?? null,
          capability,
          metadata: result.metadata
        }
      }));
      if (status !== 'SUCCEEDED') {
        await runWorkspaceHooks({
          foundation: this.foundation,
          event: 'mcp.failure',
          taskId: params.taskId,
          unitId: params.currentUnitId,
          correlationId: params.correlationId,
          sessionId: params.sessionId,
          turnId: params.turnId,
          checkpointId: params.checkpointId,
          metadata: {
            serverId: request.serverId,
            toolName: request.toolName,
            status,
            error: result.error ?? null
          }
        });
      }
    }

    return results;
  }

  async runTurn(taskId: string, userMessage: string | undefined): Promise<TaskActionResponse> {
    await this.foundation.logs.initialize();
    const runtimeRecord = await this.records.loadRuntimeRecord(taskId);
    const [latestToolInvocations, latestCommands, validatedOutputs, latestApprovals] = await Promise.all([
      this.foundation.toolInvocations.listLatest(taskId),
      this.foundation.commands.listLatest(taskId),
      this.foundation.validatedOutputs.list(taskId),
      this.foundation.approvals.listLatest(taskId)
    ]);
    this.records.assertLifecycleAllowed(runtimeRecord.runtime, ['RUNNING'], 'run turn');
    const plannerPreview = this.plannerService.createTurn(runtimeRecord.definition, runtimeRecord.runtime).output;
    const plannerPreferred = !!plannerPreview.activeStage
      && !plannerPreview.fallbackToSingleActive;
    const currentUnitId = plannerPreferred
      ? (plannerPreview.readyStageUnitIds[0] ?? plannerPreview.activeStage!.unitIds[0] ?? null)
      : (runtimeRecord.runtime.currentUnitId
        ?? selectNextReadyUnit(runtimeRecord.definition, runtimeRecord.runtime));
    if (!currentUnitId) {
      throw new Error(`backend_new task error: task "${taskId}" has no runnable unit.`);
    }
    const currentUnit = runtimeRecord.definition.units.find(unit => unit.id === currentUnitId);
    if (!currentUnit) {
      throw new Error(`backend_new task error: unit "${currentUnitId}" not found in task definition.`);
    }
    const latestValidatedOutputForCurrentUnit = validatedOutputs
      .filter((record) => record.unitId === currentUnitId)
      .at(-1) ?? null;
    const historicalToolEvidenceByUnitId = buildToolEvidenceByUnit(latestToolInvocations);
    const artifactRouting = deriveTaskArtifactRoutingSummary({
      definition: runtimeRecord.definition,
      invocations: latestToolInvocations,
      commands: latestCommands
    });
    const appliedArtifactEvidencePaths = collectAppliedArtifactEvidencePaths({
      destinationDir: artifactRouting.lastArtifactApplyResult?.destinationDir ?? null,
      destinationPaths: artifactRouting.artifactDestinationPaths,
      status: artifactRouting.lastArtifactApplyResult?.status ?? null
    });
    const productRuntime = isProductRuntimeTask(runtimeRecord.definition);
    const currentExecutionProfile = productRuntime
      ? null
      : getExecutionProfile(currentUnit.executionProfileId);
    const delegationRuntimeLookupNeeded = this.foundation.config.runtime.delegation.enabled
      && (
        currentExecutionProfile?.allowedToolIds?.includes(DELEGATE_SUBTASK_TOOL_ID)
        || runtimeRecord.definition.units.some((unit) => unit.delegationRequired === true)
      );
    const delegationTaskRuntimes = delegationRuntimeLookupNeeded
      ? await this.foundation.taskRuntimes.list()
      : [];
    const pendingApprovalCount = latestApprovals.filter((approval) => approval.status === 'PENDING').length;
    const hasRecoveryBlocker = runtimeRecord.runtime.lifecycleStatus === 'FAILED'
      || runtimeRecord.runtime.lifecycleStatus === 'CANCELLED'
      || Boolean(runtimeRecord.runtime.lastError);
    const activeChildCount = getActiveDelegatedChildrenForParent(delegationTaskRuntimes, taskId).length;
    const historicalDelegationEvidenceByUnitId = new Map(
      runtimeRecord.definition.units.map((unit) => [
        unit.id,
        countDelegationEvidenceForUnit({
          runtimes: delegationTaskRuntimes,
          parentTaskId: taskId,
          unitId: unit.id
        })
      ])
    );
    const currentAllowedToolIds = filterAllowedToolIdsForDelegation({
      definition: runtimeRecord.definition,
      runtime: runtimeRecord.runtime,
      config: this.foundation.config,
      pendingApprovalCount,
      hasRecoveryBlocker,
      commands: latestCommands,
      invocations: latestToolInvocations,
      baseAllowedToolIds: productRuntime ? null : currentExecutionProfile?.allowedToolIds ?? null,
      activeChildCount
    });
    const plannerStageUnits = plannerPreview.activeStage
      ? plannerPreview.activeStage.unitIds
        .map((unitId) => runtimeRecord.runtime.schedulerUnits[unitId])
        .filter((unit): unit is NonNullable<(typeof runtimeRecord.runtime.schedulerUnits)[string]> => !!unit)
      : [];
    const trackerPolicy = {
      profileId: currentUnit.executionProfileId ?? null,
      allowEarlyTerminate: canEarlyTerminateCurrentUnit(runtimeRecord.runtime, currentUnitId),
      requireToolEvidence: requiresToolEvidenceForExecutionProfile(currentUnit.executionProfileId),
      emittedToolEvidenceCount: historicalToolEvidenceByUnitId.get(currentUnitId)?.toolEvidenceCount ?? 0,
      requireDelegationEvidence: isDelegationRequiredForUnit({
        definition: runtimeRecord.definition,
        unitId: currentUnitId
      }),
      emittedDelegationEvidenceCount:
        (historicalToolEvidenceByUnitId.get(currentUnitId)?.delegationEvidenceCount ?? 0)
        + (historicalDelegationEvidenceByUnitId.get(currentUnitId) ?? 0),
      requireArtifactWriteEvidence: currentUnit.executionProfileId === 'implement',
      emittedWriteEvidencePaths: [
        ...(historicalToolEvidenceByUnitId.get(currentUnitId)?.writeEvidencePaths ?? []),
        ...appliedArtifactEvidencePaths
      ],
      requireVerificationEvidence: currentUnit.executionProfileId === 'verify',
      emittedVerificationEvidenceCount: historicalToolEvidenceByUnitId.get(currentUnitId)?.verificationEvidenceCount ?? 0
    };

    const correlation = createExecutionCorrelation(taskId, currentUnitId);
    const checkpointId = createCheckpointId(correlation.turnId);
    const plannerTurn = await this.plannerExecution.execute({
      taskId,
      definition: runtimeRecord.definition,
      runtime: runtimeRecord.runtime,
      correlationId: correlation.correlationId,
      sessionId: correlation.sessionId,
      turnId: correlation.turnId,
      checkpointId
    });
    const activeConfig = await this.foundation.configSnapshots.getActive();
    if (shouldReloadConfig(activeConfig, this.foundation.config)) {
      const snapshot = createConfigSnapshotRecord(this.foundation.config);
      await this.foundation.configSnapshots.save(snapshot);
    }
    const assembled = plannerPreferred && plannerPreview.activeStage && plannerStageUnits.length > 1
      ? await assembleStageTurnContext({
        foundation: this.foundation,
        runtimeRecord,
        stageUnits: plannerStageUnits,
        stageUnitIds: plannerPreview.activeStage.unitIds,
        taskId,
        userMessage
      })
      : await assembleTurnContext({
        foundation: this.foundation,
        runtimeRecord,
        currentUnit,
        currentUnitId,
        taskId,
        userMessage
      });

    const lease = this.interruptController.begin(taskId);
    let leaseReleased = false;
    const releaseLease = () => {
      if (!leaseReleased) {
        this.interruptController.end(taskId, lease.leaseId);
        leaseReleased = true;
      }
    };
    try {
    const leasedRuntime: TaskRuntimeState = {
      ...runtimeRecord.runtime,
      planner: {
        ...(runtimeRecord.runtime.planner ?? this.plannerService.summarize(runtimeRecord.definition, runtimeRecord.runtime)),
        executionPhase: plannerPreferred ? 'PLANNING' : 'FALLBACK_SINGLE_ACTIVE'
        ,
        fallbackReasons: [...plannerPreview.fallbackReasons]
      },
      activeStage: plannerTurn.activeStage ? {
        stageIndex: plannerTurn.activeStage.stageIndex,
        unitIds: [...plannerTurn.activeStage.unitIds],
        entryUnitIds: [...plannerTurn.activeStage.entryUnitIds],
        exitUnitIds: [...plannerTurn.activeStage.exitUnitIds],
        batchGroupingHint: plannerTurn.activeStage.batchGroupingHint
      } : runtimeRecord.runtime.activeStage,
      consolidationState: {
        ...runtimeRecord.runtime.consolidationState,
        status: plannerPreferred ? 'REQUIRED' : runtimeRecord.runtime.consolidationState.status,
        stageIndex: plannerTurn.activeStage?.stageIndex ?? runtimeRecord.runtime.consolidationState.stageIndex
      },
      executionLease: {
        active: true,
        phase: 'ACTIVE',
        leaseId: lease.leaseId,
        startedAt: Date.now(),
        replayable: true
      },
      updatedAt: Date.now()
    };
    await this.runtimeControl.saveRuntimeState({
      definition: runtimeRecord.definition,
      runtime: leasedRuntime,
      activeProviderId: assembled.selectedProvider.id
    });
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: correlation.correlationId,
        sessionId: correlation.sessionId,
        turnId: correlation.turnId,
        taskId,
        unitId: currentUnitId,
        checkpointId,
        type: 'TURN_STARTED',
        payload: {
          currentUnitId
        }
      })
    );
    await this.foundation.events.append(
      createRuntimeEventEnvelope({
        correlationId: correlation.correlationId,
        sessionId: correlation.sessionId,
        turnId: correlation.turnId,
        taskId,
        unitId: currentUnitId,
        checkpointId,
        type: 'TURN_PROMPT_BUILT',
        payload: {
          currentUnitId
        }
      })
    );
    await this.runtimeControl.recordSafePoint({
      taskId,
      definition: runtimeRecord.definition,
      runtime: leasedRuntime,
      activeProviderId: assembled.selectedProvider.id,
      stage: 'BEFORE_PROVIDER',
      interruptible: true,
      correlationId: correlation.correlationId,
      sessionId: correlation.sessionId,
      turnId: correlation.turnId,
      checkpointId
    });
    const runtimeBeforeProvider = await this.records.loadRuntimeRecord(taskId);
    const beforeProviderInterrupt = await this.runtimeControl.resolveInterruptAtSafePoint({
        taskId,
        definition: runtimeRecord.definition,
        runtime: runtimeBeforeProvider.runtime,
        activeProviderId: assembled.selectedProvider.id,
        message: 'Task stopped before provider call.'
      });
    if (beforeProviderInterrupt) {
      releaseLease();
      return beforeProviderInterrupt;
    }

    const executedExtensions = await this.executeTaskExtensions({
      definition: runtimeRecord.definition,
      taskId,
      currentUnitId,
      sessionId: correlation.sessionId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      checkpointId
    });
    const providerContextMessages = {
      ...assembled.contextMessages,
      messages: [
        ...assembled.contextMessages.messages,
        ...executedExtensions.contextMessages
      ]
    };
    const runtimeImmediatelyBeforeProvider = await this.records.loadRuntimeRecord(taskId);
    const latestBeforeProviderInterrupt = await this.runtimeControl.resolveInterruptAtSafePoint({
        taskId,
        definition: runtimeRecord.definition,
        runtime: runtimeImmediatelyBeforeProvider.runtime,
        activeProviderId: assembled.selectedProvider.id,
        message: 'Task stopped before provider call.'
      });
    if (latestBeforeProviderInterrupt) {
      return latestBeforeProviderInterrupt;
    }

    let providerResponse;
    try {
      providerResponse = (await executeTurnProvider({
        providerClient: assembled.providerClient,
        resolvedProvider: assembled.resolvedProvider,
        prompt: assembled.prompt,
        contextMessages: providerContextMessages.messages.map((message) => ({
          role: message.role,
          content: message.content,
          metadata: message.metadata
        })),
        taskId,
        currentUnitId,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        turnId: correlation.turnId,
        checkpointId,
        abortSignal: lease.signal,
        requestTimeoutMs: this.foundation.config.providers.requestTimeoutMs,
        maxRetries: this.foundation.config.providers.maxRetries,
        retryBackoffMs: this.foundation.config.providers.retryBackoffMs
      })).response;
    } catch (error) {
      const interruptedRuntimeRecord = await this.records.loadRuntimeRecord(taskId);
      if (lease.signal.aborted || interruptedRuntimeRecord.runtime.interrupt.interruptRequested || interruptedRuntimeRecord.runtime.interrupt.pauseRequested) {
        const interrupted = await this.runtimeControl.resolveInterruptAtSafePoint({
          taskId,
          definition: runtimeRecord.definition,
          runtime: {
            ...interruptedRuntimeRecord.runtime,
            safePoint: {
              stage: 'AFTER_PROVIDER',
              reachedAt: Date.now(),
              interruptible: true
            }
          },
          activeProviderId: assembled.selectedProvider.id,
          message: 'Task interrupted during provider execution.'
        });
        if (interrupted) {
          return interrupted;
        }
      }
      const failure = normalizeProviderFailure(error);
      const failureRuntimeSnapshot: TaskRuntimeState = {
        ...leasedRuntime,
        contextGating: {
          ...assembled.contextGatingSummary,
          reasons: [...assembled.contextGatingSummary.reasons]
        },
        promptBudget: {
          ...leasedRuntime.promptBudget,
          estimatedPromptCharacters: assembled.estimatedPromptCharacters,
          estimatedPromptTokens: Math.ceil(assembled.estimatedPromptCharacters / 4),
          estimatedBaselineCharacters: assembled.estimatedBaselineCharacters,
          estimatedBaselineTokens: Math.ceil(assembled.estimatedBaselineCharacters / 4),
          estimatedReductionRatio: assembled.estimatedReductionRatio,
          rawContextCharacters: assembled.contextGatingSummary.rawContextCharacters,
          gatedContextCharacters: assembled.contextGatingSummary.gatedContextCharacters,
          rawContextTokens: Math.ceil(assembled.contextGatingSummary.rawContextCharacters / 4),
          gatedContextTokens: Math.ceil(assembled.contextGatingSummary.gatedContextCharacters / 4),
          estimatedHistoryReductionRatio: assembled.contextGatingSummary.estimatedContextReductionRatio,
          estimatedSectionReductionRatio: assembled.promptResult.budget.estimatedSectionReductionRatio,
          cacheablePrefixChars: assembled.promptResult.budget.cacheablePrefixChars,
          stablePrefixChars: assembled.promptResult.budget.stablePrefixChars,
          volatileSuffixChars: assembled.promptResult.budget.volatileSuffixChars,
          stablePrefixRatio: assembled.promptResult.budget.stablePrefixRatio,
          retrievedContextCount: assembled.selectedValidatedOutputs.retrievedContextCount,
          policyFilteredOutputCount: assembled.selectedValidatedOutputs.policyFilteredOutputCount,
          operatorInputCount: assembled.pendingOperatorInputs.length
        },
        stageMemorySummary: assembled.stageMemorySummary,
        capabilitySelectionSummary: assembled.capabilitySelectionSummary,
        retrievalSelectionSummary: assembled.retrievalSelectionSummary,
        safePoint: {
          stage: 'AFTER_PROVIDER',
          reachedAt: Date.now(),
          interruptible: true
        },
        selectedProviderId: assembled.selectedProvider.id,
        latestSessionId: correlation.sessionId,
        latestCorrelationId: correlation.correlationId,
        latestTurnId: correlation.turnId,
        latestCheckpointId: checkpointId
      };
      await this.resultPersistence.persistProviderFailure({
        definition: runtimeRecord.definition,
        runtime: failureRuntimeSnapshot,
        taskId,
        currentUnitId,
        correlationId: correlation.correlationId,
        sessionId: correlation.sessionId,
        turnId: correlation.turnId,
        checkpointId,
        providerId: assembled.selectedProvider.id,
        error: failure,
        requestContext: {
          rawContextMessageCount: assembled.contextGatingSummary.rawContextMessageCount,
          retainedContextMessageCount: assembled.contextGatingSummary.retainedContextMessageCount,
          toolMessageCount: assembled.contextGatingSummary.toolMessageCount,
          gatedContextCharacters: assembled.contextGatingSummary.gatedContextCharacters,
          providerMessageCount: 1 + providerContextMessages.messages.length,
          estimatedPromptCharacters: assembled.estimatedPromptCharacters
        }
      });
      return {
        command: this.records.createCommandResult(taskId, 'FAILED', `Provider failed: ${failure.message}`, false),
        task: await this.records.buildTaskQuery(taskId)
      };
    }

    const parsed = parseTurn(providerResponse.outputText);
    let phaseOutcome;

    if (plannerPreferred && plannerTurn.activeStage) {
      const stageUnitDefinitions = plannerTurn.activeStage.unitIds
        .map((unitId) => runtimeRecord.definition.units.find((unit) => unit.id === unitId))
        .filter((unit): unit is NonNullable<typeof currentUnit> => !!unit);
      const batchExecution = await this.batchExecutor.execute({
        taskId,
        currentUnitId,
        runtime: leasedRuntime,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        turnId: correlation.turnId,
        checkpointId,
        activeStage: plannerTurn.activeStage,
        plannedToolBatches: plannerTurn.plannedToolBatches,
        toolCallFormat: assembled.promptResult.policy.toolCallFormat,
        allowedToolIdsByUnitId: Object.fromEntries(
          stageUnitDefinitions.map((unit) => [
            unit.id,
            filterAllowedToolIdsForDelegation({
              definition: runtimeRecord.definition,
              runtime: runtimeRecord.runtime,
              config: this.foundation.config,
              pendingApprovalCount,
              hasRecoveryBlocker,
              commands: latestCommands,
              invocations: latestToolInvocations,
              baseAllowedToolIds: productRuntime ? null : getExecutionProfile(unit.executionProfileId)?.allowedToolIds ?? null,
              activeChildCount
            })
          ])
        ),
        parsed
      });
      const latestToolInvocationsAfterBatch = await this.foundation.toolInvocations.listLatest(taskId);
      const stageToolEvidenceByUnitId = buildToolEvidenceByUnit(latestToolInvocationsAfterBatch);
      const consolidation = await this.consolidation.execute({
        taskId,
        currentUnitId,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        turnId: correlation.turnId,
        checkpointId,
        stageIndex: plannerTurn.activeStage.stageIndex,
        parsed,
        outputContract: currentUnit.outputContract,
        exitCondition: currentUnit.exitCondition,
        stageUnits: stageUnitDefinitions.map((unit) => ({
          unitId: unit.id,
          outputContract: unit.outputContract,
          exitCondition: unit.exitCondition,
          trackerPolicy: {
            allowEarlyTerminate: canEarlyTerminateCurrentUnit(runtimeRecord.runtime, unit.id),
            requireToolEvidence: requiresToolEvidenceForExecutionProfile(unit.executionProfileId),
            profileId: unit.executionProfileId ?? null,
            requireDelegationEvidence: isDelegationRequiredForUnit({
              definition: runtimeRecord.definition,
              unitId: unit.id
            }),
            requireArtifactWriteEvidence: unit.executionProfileId === 'implement',
            requireVerificationEvidence: unit.executionProfileId === 'verify',
            emittedToolEvidenceCount: stageToolEvidenceByUnitId.get(unit.id)?.toolEvidenceCount ?? 0,
            emittedDelegationEvidenceCount:
              (stageToolEvidenceByUnitId.get(unit.id)?.delegationEvidenceCount ?? 0)
              + (historicalDelegationEvidenceByUnitId.get(unit.id) ?? 0),
            emittedWriteEvidencePaths: [
              ...(stageToolEvidenceByUnitId.get(unit.id)?.writeEvidencePaths ?? []),
              ...(unit.id === currentUnitId ? appliedArtifactEvidencePaths : [])
            ],
            emittedVerificationEvidenceCount: stageToolEvidenceByUnitId.get(unit.id)?.verificationEvidenceCount ?? 0
          },
          correctionContext: unit.id === currentUnitId
            ? buildAcceptanceCorrectionContext(runtimeRecord.runtime, unit.id, validatedOutputs)
            : undefined
        })),
        batchExecutionResults: batchExecution.batchExecutionResults,
        trackerPolicy
      });
      phaseOutcome = mapPlannerStageOutcome({
        currentUnitId,
        plannerTurn,
        batchExecution,
        consolidation,
        parsed
      });
    } else {
      const plannedTools = await this.planToolInvocations({
        taskId,
        currentUnitId,
        sessionId: correlation.sessionId,
        correlationId: correlation.correlationId,
        turnId: correlation.turnId,
        checkpointId,
        parsedToolCalls: parsed.toolCalls,
        parseWarnings: parsed.warnings,
        toolCallFormat: assembled.promptResult.policy.toolCallFormat,
        allowedToolIds: currentAllowedToolIds
      });
      phaseOutcome = mapFallbackTurnOutcome({
        currentUnitId,
        parsed,
        outputContract: currentUnit.outputContract,
        exitCondition: currentUnit.exitCondition,
        trackerPolicy,
        correctionContext: buildAcceptanceCorrectionContext(
          runtimeRecord.runtime,
          currentUnitId,
          latestValidatedOutputForCurrentUnit ? [latestValidatedOutputForCurrentUnit] : []
        ),
        plannedTools: {
          acceptedInvocationIds: plannedTools.acceptedInvocationIds,
          approvalInvocationIds: plannedTools.approvalInvocationIds,
          rejected: plannedTools.rejected
        },
        runtime: {
          pendingToolBatches: runtimeRecord.runtime.pendingToolBatches,
          consolidationState: runtimeRecord.runtime.consolidationState
        }
      });
      phaseOutcome = {
        ...phaseOutcome,
        precomputedToolDispatch: await this.toolDispatch.dispatchReadyInvocations({
          taskId,
          sessionId: correlation.sessionId,
          correlationId: correlation.correlationId,
          turnId: correlation.turnId,
          checkpointId
        })
      };
    }
    const [latestRuntimeAfterProvider, latestToolInvocationsAfterProvider] = await Promise.all([
      this.records.loadRuntimeRecord(taskId),
      this.foundation.toolInvocations.listLatest(taskId)
    ]);
    const { nextRuntime, updatedUserProfile } = buildTurnRuntimeState({
      foundation: this.foundation,
      plannerService: this.plannerService,
      definition: runtimeRecord.definition,
      previousRuntime: runtimeRecord.runtime,
      assembled,
      userMessage,
      currentUnitId,
      checkpointId,
      correlationId: correlation.correlationId,
      sessionId: correlation.sessionId,
      turnId: correlation.turnId,
      providerResponseText: providerResponse.outputText,
      plannerPreferred,
      phaseOutcome,
      latestRuntimeAfterProvider: latestRuntimeAfterProvider.runtime,
      latestToolInvocations: latestToolInvocationsAfterProvider
    });

    return (await this.resultPersistence.persistSuccessfulTurn({
      taskId,
      definition: runtimeRecord.definition,
      previousRuntime: runtimeRecord.runtime,
      nextRuntime,
      currentUnitId,
      sessionId: correlation.sessionId,
      correlationId: correlation.correlationId,
      turnId: correlation.turnId,
      checkpointId,
      currentUnit,
      selectedProvider: assembled.selectedProvider,
      resolvedProvider: assembled.resolvedProvider,
      userMessage,
      prompt: assembled.prompt,
      promptPolicy: assembled.promptResult.policy,
      providerOutputText: providerResponse.outputText,
      providerResponseId: providerResponse.responseId,
      providerUsage: providerResponse.usage,
      existingConversationCount: assembled.existingConversations.length,
      latestOperatorMessages: assembled.latestOperatorMessages,
      pendingOperatorInputs: assembled.pendingOperatorInputs,
      plannedTools: phaseOutcome.plannedTools,
      orchestrated: phaseOutcome.orchestrated,
      acceptedOutputs: phaseOutcome.acceptedOutputs,
      selectedValidatedOutputs: assembled.selectedValidatedOutputs,
      updatedUserProfile,
      interruptReason: latestRuntimeAfterProvider.runtime.interrupt.reason,
      precomputedToolDispatch: phaseOutcome.precomputedToolDispatch
    })).response;
    } catch (error) {
      const failure = normalizeProviderFailure(error);
      await this.foundation.events.append(
        createRuntimeEventEnvelope({
          correlationId: correlation.correlationId,
          sessionId: correlation.sessionId,
          turnId: correlation.turnId,
          taskId,
          unitId: currentUnitId,
          checkpointId,
          type: 'TASK_FAILED',
          payload: {
            taskId,
            error: failure.message,
            kind: failure.kind,
            category: failure.category,
            statusCode: failure.statusCode,
            retryable: failure.retryable,
            providerId: assembled.selectedProvider.id,
            timeoutOrigin: failure.timeoutOrigin,
            elapsedMs: failure.elapsedMs,
            requestTimeoutMs: failure.requestTimeoutMs,
            retryAttempt: failure.retryAttempt,
            requestContext: null
          }
        })
      );
      throw error;
    } finally {
      releaseLease();
    }
  }
}
