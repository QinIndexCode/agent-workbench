import {
  TaskDefinition,
  TaskRuntimeState,
  UserPreferenceProfile
} from '../../../domain/contracts/types';
import { NormalizedProviderFailure } from '../../adapters/providers/provider-client-helpers';
import { OperatorMessageRecord, ValidatedOutputRecord } from '../../../foundation/repository';
import { ProviderCompletionUsage } from '../../../foundation/providers/client-types';
import { TaskActionResponse } from '../types';

export interface TurnPersistenceResult {
  response: TaskActionResponse;
}

export interface ProviderFailurePersistenceInput {
  definition: TaskDefinition;
  runtime: TaskRuntimeState;
  taskId: string;
  currentUnitId: string;
  correlationId: string;
  sessionId: string;
  turnId: string;
  checkpointId: string;
  providerId: string | null;
  error: NormalizedProviderFailure;
  requestContext?: {
    rawContextMessageCount: number;
    retainedContextMessageCount: number;
    toolMessageCount: number;
    gatedContextCharacters: number;
    providerMessageCount: number;
    estimatedPromptCharacters: number;
  } | null;
}

export interface AcceptedOutputPersistenceInput {
  unitId: string;
  wrapper: ValidatedOutputRecord['wrapper'];
  raw: string;
  parsedJson: unknown;
  contractKeys: string[];
}

export interface SuccessfulTurnPersistenceInput {
  taskId: string;
  definition: TaskDefinition;
  previousRuntime: TaskRuntimeState;
  nextRuntime: TaskRuntimeState;
  currentUnitId: string;
  sessionId: string;
  correlationId: string;
  turnId: string;
  checkpointId: string;
  currentUnit: { outputContract?: string | null };
  selectedProvider: { id: string };
  resolvedProvider: { model: string };
  userMessage?: string;
  prompt: string;
  promptPolicy: unknown;
  providerOutputText: string;
  providerResponseId: string;
  providerUsage: ProviderCompletionUsage;
  existingConversationCount: number;
  latestOperatorMessages: OperatorMessageRecord[];
  pendingOperatorInputs: Array<{ messageId: string; content: string }>;
  plannedTools: {
    accepted: number;
    approvalRequired: number;
    rejected: string[];
  };
  orchestrated: {
    parsed: {
      explicitOutputs: unknown[];
      trackers: unknown[];
      toolCalls: unknown[];
    };
    acceptance: {
      acceptedOutput: {
        unitId: string;
        wrapper: ValidatedOutputRecord['wrapper'];
        raw: string;
        parsedJson: unknown;
      } | null;
      contractKeys: string[];
    };
  };
  acceptedOutputs?: AcceptedOutputPersistenceInput[];
  selectedValidatedOutputs: {
    retrievedContextCount: number;
    policyFilteredOutputCount: number;
  };
  updatedUserProfile: UserPreferenceProfile;
  interruptReason: string | null;
  precomputedToolDispatch?: {
    dispatchedInvocationIds: string[];
    approvalBlockedInvocationIds: string[];
    deniedInvocationIds: string[];
    failedInvocationIds: string[];
  };
}
