import { AgentUnit } from '../../domain/contracts/types';

export type BenchmarkScenarioMode = 'PLANNER_PRIMARY' | 'SINGLE_ACTIVE_BASELINE';
export type BenchmarkValidationScenarioName =
  | 'approval-blocked-stage'
  | 'consolidation-correction-loop'
  | 'planner-fallback';

export interface RuntimeBenchmarkScenarioDefinition {
  scenario: string;
  mode: BenchmarkScenarioMode;
  forceSingleActiveFallback: boolean;
  autoApprovePendingApprovals: boolean;
  stopOnBlockingReason?: 'BATCH_BLOCKED' | 'CONSOLIDATION_BLOCKED';
  configOverrides?: {
    tools?: {
      permissionMode?: 'full' | 'ask';
    };
  };
  units: AgentUnit[];
  responses: string[];
}

export interface RuntimeBenchmarkValidationScenarioDefinition extends RuntimeBenchmarkScenarioDefinition {
  validationName: BenchmarkValidationScenarioName;
}

const SYNTHETIC_STAGE_ONE_UNIT_IDS = ['AGENT-001', 'AGENT-002', 'AGENT-003', 'AGENT-004'] as const;
const SYNTHETIC_STAGE_TWO_UNIT_IDS = ['AGENT-005', 'AGENT-006', 'AGENT-007', 'AGENT-008'] as const;
const SYNTHETIC_STAGE_THREE_UNIT_IDS = ['AGENT-009', 'AGENT-010', 'AGENT-011', 'AGENT-012'] as const;

const REALISTIC_STAGE_ONE_UNIT_IDS = ['AGENT-001', 'AGENT-002'] as const;
const REALISTIC_STAGE_TWO_UNIT_IDS = ['AGENT-003', 'AGENT-004'] as const;
const REALISTIC_STAGE_THREE_UNIT_IDS = ['AGENT-005'] as const;

function buildSummary(seed: string): string {
  return `${seed}-${'benchmark-segment-'.repeat(72)}`;
}

function createOutput(unitId: string, artifact: string, extra: Record<string, unknown> = {}): string {
  return `[${unitId}_OUTPUT]${JSON.stringify({
    summary: buildSummary(unitId),
    issues: [],
    artifact,
    ...extra
  })}[/${unitId}_OUTPUT]`;
}

function createTracker(unitId: string, nextUnit?: string | null): string {
  return JSON.stringify({
    current_unit: unitId,
    status: 'COMPLETE',
    progress_percent: 100,
    decision: 'CONTINUE',
    reason: 'benchmark stage complete',
    next_unit: nextUnit ?? null,
    files_created: []
  });
}

function createToolCall(unitId: string, filePath: string): string {
  return JSON.stringify({
    current_unit: unitId,
    tool_name: 'write_file',
    arguments: {
      path: filePath,
      content: `benchmark artifact for ${unitId}\n`
    }
  });
}

function createSyntheticUnits(): AgentUnit[] {
  const stageOne = SYNTHETIC_STAGE_ONE_UNIT_IDS.map((unitId, index) => ({
    id: unitId,
    role: `Plan ${index + 1}`,
    goal: `Produce stage one plan ${index + 1}`,
    executionProfileId: 'analyze' as const,
    outputContract: '{"summary":"string","issues":[],"artifact":"string"}',
    dependencies: []
  }));
  const stageTwo = SYNTHETIC_STAGE_TWO_UNIT_IDS.map((unitId, index) => ({
    id: unitId,
    role: `Build ${index + 1}`,
    goal: `Produce stage two build ${index + 1}`,
    executionProfileId: 'implement' as const,
    outputContract: '{"summary":"string","issues":[],"artifact":"string"}',
    dependencies: [...SYNTHETIC_STAGE_ONE_UNIT_IDS]
  }));
  const stageThree = SYNTHETIC_STAGE_THREE_UNIT_IDS.map((unitId, index) => ({
    id: unitId,
    role: `Verify ${index + 1}`,
    goal: `Produce stage three verification ${index + 1}`,
    executionProfileId: 'verify' as const,
    outputContract: '{"summary":"string","issues":[],"artifact":"string"}',
    dependencies: [...SYNTHETIC_STAGE_TWO_UNIT_IDS]
  }));
  return [...stageOne, ...stageTwo, ...stageThree];
}

function createRealisticUnits(): AgentUnit[] {
  return [
    {
      id: 'AGENT-001',
      role: 'Requirements Analyst',
      goal: 'Extract requirements',
      executionProfileId: 'analyze',
      taskScope: 'Capture requirements and constraints.',
      inputContract: '{"includeGlobalMemory":true}',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      exitCondition: '{"status":"COMPLETE","report":"required"}',
      dependencies: []
    },
    {
      id: 'AGENT-002',
      role: 'Risk Analyst',
      goal: 'Identify implementation risks',
      executionProfileId: 'analyze',
      taskScope: 'Summarize risks and boundaries.',
      inputContract: '{"includeGlobalMemory":true,"memoryKinds":["MILESTONE","DECISION"]}',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      exitCondition: '{"status":"COMPLETE","report":"required"}',
      dependencies: []
    },
    {
      id: 'AGENT-003',
      role: 'Implementation Planner',
      goal: 'Plan implementation tasks',
      executionProfileId: 'implement',
      taskScope: 'Convert requirements into task graph.',
      inputContract: '{"units":["AGENT-001","AGENT-002"],"outputKeys":{"AGENT-001":["summary","report"],"AGENT-002":["summary","report"]},"memoryUnits":["AGENT-001","AGENT-002"],"memoryKinds":["DECISION"],"includeGlobalMemory":false}',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      exitCondition: '{"status":"COMPLETE","report":"required"}',
      dependencies: ['AGENT-001', 'AGENT-002']
    },
    {
      id: 'AGENT-004',
      role: 'Execution Planner',
      goal: 'Prepare toolable execution outputs',
      executionProfileId: 'implement',
      taskScope: 'Prepare execution artifacts and tool work.',
      inputContract: '{"units":["AGENT-001","AGENT-002"],"outputKeys":{"AGENT-001":["summary"],"AGENT-002":["summary","report"]},"memoryUnits":["AGENT-002"],"memoryKinds":["MILESTONE"],"includeGlobalMemory":false}',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      exitCondition: '{"status":"COMPLETE","report":"required"}',
      dependencies: ['AGENT-001', 'AGENT-002']
    },
    {
      id: 'AGENT-005',
      role: 'Consolidator',
      goal: 'Consolidate stage outputs into final report',
      executionProfileId: 'verify',
      taskScope: 'Merge validated stage outputs into final answer.',
      inputContract: '{"units":["AGENT-003","AGENT-004"],"outputKeys":{"AGENT-003":["summary","report"],"AGENT-004":["summary","artifact","report"]},"memoryUnits":["AGENT-003","AGENT-004"],"memoryKinds":["DECISION"],"includeGlobalMemory":true}',
      outputContract: '{"summary":"string","issues":[],"artifact":"string","report":"string"}',
      exitCondition: '{"status":"COMPLETE","report":"required"}',
      dependencies: ['AGENT-003', 'AGENT-004']
    }
  ];
}

function createSyntheticPlannerPrimaryResponses(): string[] {
  return [
    [
      ...SYNTHETIC_STAGE_ONE_UNIT_IDS.flatMap((unitId, index) => [
        createOutput(unitId, `stage-1-${index + 1}`),
        createTracker(unitId)
      ])
    ].join('\n'),
    [
      ...SYNTHETIC_STAGE_TWO_UNIT_IDS.flatMap((unitId, index) => {
        const rows = [createOutput(unitId, `stage-2-${index + 1}`)];
        if (index < 3) {
          rows.push(createToolCall(unitId, `benchmark-stage2-${index + 1}.txt`));
        }
        rows.push(createTracker(unitId));
        return rows;
      })
    ].join('\n'),
    [
      ...SYNTHETIC_STAGE_THREE_UNIT_IDS.flatMap((unitId, index) => [
        createOutput(unitId, `stage-3-${index + 1}`),
        createTracker(unitId)
      ])
    ].join('\n')
  ];
}

function createSyntheticSingleActiveResponses(): string[] {
  return [
    ...SYNTHETIC_STAGE_ONE_UNIT_IDS.map((unitId, index) => [
      createOutput(unitId, `stage-1-${index + 1}`),
      createTracker(unitId)
    ].join('\n')),
    ...SYNTHETIC_STAGE_TWO_UNIT_IDS.map((unitId, index) => {
      const rows = [createOutput(unitId, `stage-2-${index + 1}`)];
      if (index < 3) {
        rows.push(createToolCall(unitId, `benchmark-stage2-${index + 1}.txt`));
      }
      rows.push(createTracker(unitId));
      return rows.join('\n');
    }),
    ...SYNTHETIC_STAGE_THREE_UNIT_IDS.map((unitId, index) => [
      createOutput(unitId, `stage-3-${index + 1}`),
      createTracker(unitId)
    ].join('\n'))
  ];
}

function createRealisticPlannerPrimaryResponses(): string[] {
  return [
    [
      createOutput('AGENT-001', 'requirements.md', { report: 'requirements captured' }),
      createTracker('AGENT-001'),
      createOutput('AGENT-002', 'risk.md', { report: 'risks captured' }),
      createTracker('AGENT-002')
    ].join('\n'),
    [
      createOutput('AGENT-003', 'plan.md', { report: 'implementation plan ready' }),
      createTracker('AGENT-003'),
      createOutput('AGENT-004', 'execution.md', { report: 'execution artifacts ready' }),
      createToolCall('AGENT-004', 'realistic-stage2-artifact.txt'),
      createTracker('AGENT-004')
    ].join('\n'),
    [
      createOutput('AGENT-005', 'final.md', { report: 'final consolidated report' }),
      createTracker('AGENT-005')
    ].join('\n')
  ];
}

function createRealisticSingleActiveResponses(): string[] {
  return [
    [
      createOutput('AGENT-001', 'requirements.md', { report: 'requirements captured' }),
      createTracker('AGENT-001')
    ].join('\n'),
    [
      createOutput('AGENT-002', 'risk.md', { report: 'risks captured' }),
      createTracker('AGENT-002')
    ].join('\n'),
    [
      createOutput('AGENT-003', 'plan.md', { report: 'implementation plan ready' }),
      createTracker('AGENT-003')
    ].join('\n'),
    [
      createOutput('AGENT-004', 'execution.md', { report: 'execution artifacts ready' }),
      createToolCall('AGENT-004', 'realistic-stage2-artifact.txt'),
      createTracker('AGENT-004')
    ].join('\n'),
    [
      createOutput('AGENT-005', 'final.md', { report: 'final consolidated report' }),
      createTracker('AGENT-005')
    ].join('\n')
  ];
}

export function createSyntheticBenchmarkDefinitions(): {
  plannerPrimary: RuntimeBenchmarkScenarioDefinition;
  singleActiveBaseline: RuntimeBenchmarkScenarioDefinition;
} {
  const units = createSyntheticUnits();
  return {
    plannerPrimary: {
      scenario: 'fixed-complex-dag',
      mode: 'PLANNER_PRIMARY',
      forceSingleActiveFallback: false,
      autoApprovePendingApprovals: false,
      units,
      responses: createSyntheticPlannerPrimaryResponses()
    },
    singleActiveBaseline: {
      scenario: 'fixed-complex-dag',
      mode: 'SINGLE_ACTIVE_BASELINE',
      forceSingleActiveFallback: true,
      autoApprovePendingApprovals: false,
      units,
      responses: createSyntheticSingleActiveResponses()
    }
  };
}

export function createRealisticBenchmarkDefinitions(): {
  plannerPrimary: RuntimeBenchmarkScenarioDefinition;
  singleActiveBaseline: RuntimeBenchmarkScenarioDefinition;
} {
  const units = createRealisticUnits();
  return {
    plannerPrimary: {
      scenario: 'realistic-complex-dag',
      mode: 'PLANNER_PRIMARY',
      forceSingleActiveFallback: false,
      autoApprovePendingApprovals: false,
      units,
      responses: createRealisticPlannerPrimaryResponses()
    },
    singleActiveBaseline: {
      scenario: 'realistic-complex-dag',
      mode: 'SINGLE_ACTIVE_BASELINE',
      forceSingleActiveFallback: true,
      autoApprovePendingApprovals: false,
      units,
      responses: createRealisticSingleActiveResponses()
    }
  };
}

export function createValidationBenchmarkDefinitions(): RuntimeBenchmarkValidationScenarioDefinition[] {
  return [
    {
      validationName: 'approval-blocked-stage',
      scenario: 'approval-blocked-stage',
      mode: 'PLANNER_PRIMARY',
      forceSingleActiveFallback: false,
      autoApprovePendingApprovals: false,
      stopOnBlockingReason: 'CONSOLIDATION_BLOCKED',
      configOverrides: {
        tools: {
          permissionMode: 'ask'
        }
      },
      units: createRealisticUnits(),
      responses: [
        [
          createOutput('AGENT-001', 'requirements.md', { report: 'requirements captured' }),
          createTracker('AGENT-001'),
          createOutput('AGENT-002', 'risk.md', { report: 'risks captured' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'plan.md', { report: 'implementation plan ready' }),
          createTracker('AGENT-003'),
          createOutput('AGENT-004', 'execution.md', { report: 'execution artifacts ready' }),
          createToolCall('AGENT-004', 'blocked-stage-artifact.txt'),
          createTracker('AGENT-004')
        ].join('\n')
      ]
    },
    {
      validationName: 'consolidation-correction-loop',
      scenario: 'consolidation-correction-loop',
      mode: 'PLANNER_PRIMARY',
      forceSingleActiveFallback: false,
      autoApprovePendingApprovals: true,
      units: createRealisticUnits(),
      responses: [
        [
          createOutput('AGENT-001', 'requirements.md', { report: 'requirements captured' }),
          createTracker('AGENT-001'),
          createOutput('AGENT-002', 'risk.md', { report: 'risks captured' }),
          createTracker('AGENT-002')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'plan.md', { report: 'implementation plan ready' }),
          createTracker('AGENT-003'),
          createOutput('AGENT-004', 'execution.md'),
          createTracker('AGENT-004')
        ].join('\n'),
        [
          createOutput('AGENT-003', 'plan.md', { report: 'implementation plan ready' }),
          createTracker('AGENT-003'),
          createOutput('AGENT-004', 'execution.md', { report: 'execution artifacts corrected' }),
          createTracker('AGENT-004')
        ].join('\n'),
        [
          createOutput('AGENT-005', 'final.md', { report: 'final consolidated report' }),
          createTracker('AGENT-005')
        ].join('\n')
      ]
    },
    {
      validationName: 'planner-fallback',
      scenario: 'planner-fallback',
      mode: 'PLANNER_PRIMARY',
      forceSingleActiveFallback: true,
      autoApprovePendingApprovals: false,
      units: createRealisticUnits(),
      responses: createRealisticSingleActiveResponses()
    }
  ];
}
