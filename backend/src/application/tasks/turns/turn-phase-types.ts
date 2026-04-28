import { TaskRuntimeState } from '../../../domain/contracts/types';
import { orchestrateTurn } from '../../../domain/runtime/turn-orchestrator';
import { BatchAdmissionDecision, BatchGuardrailState } from '../../../domain/validation';

export interface PlannedToolSummary {
  accepted: number;
  approvalRequired: number;
  rejected: string[];
  acceptedInvocationIds: string[];
  approvalInvocationIds: string[];
}

export type OrchestratedTurnResult = ReturnType<typeof orchestrateTurn>;
export type AcceptedTrackerResult = NonNullable<OrchestratedTurnResult['acceptance']['acceptedTracker']>;

export interface TurnPhaseOutcome {
  plannedTools: PlannedToolSummary;
  orchestrated: OrchestratedTurnResult;
  diagnosticsAcceptance: OrchestratedTurnResult['acceptance'] | null;
  acceptedOutputs?: Array<{
    unitId: string;
    wrapper: NonNullable<OrchestratedTurnResult['acceptance']['acceptedOutput']>['wrapper'];
    raw: string;
    parsedJson: unknown;
    contractKeys: string[];
  }>;
  acceptedTrackers: AcceptedTrackerResult[];
  correctionUnitId: string;
  pendingToolBatches: TaskRuntimeState['pendingToolBatches'];
  consolidationState: TaskRuntimeState['consolidationState'];
  batchAdmissionDecisions?: BatchAdmissionDecision[];
  batchGuardrail?: BatchGuardrailState;
  precomputedToolDispatch?: {
    dispatchedInvocationIds: string[];
    approvalBlockedInvocationIds: string[];
    deniedInvocationIds: string[];
    failedInvocationIds: string[];
  };
}
