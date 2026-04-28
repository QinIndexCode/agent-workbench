import { TaskDefinition, TaskRuntimeState } from '../../../domain/contracts/types';
import { PlannerTurnComputation, createPlannerTurn, toActiveStageDiagnostics } from '../../../domain/planning/planner-turn';
import {
  ExecutionPlan,
  PlannerDiagnosticsSummary,
  createExecutionPlan,
  createPlannerDiagnosticsSummary,
  validateExecutionPlan
} from '../../../domain/runtime/execution-plan';
import { createTopologyGraph } from '../../../domain/runtime/topology-graph';

export class TaskPlannerService {
  createPlan(definition: TaskDefinition): ExecutionPlan {
    const topology = createTopologyGraph(definition);
    return createExecutionPlan(definition, topology);
  }

  assertValidPlan(definition: TaskDefinition): ExecutionPlan {
    const topology = createTopologyGraph(definition);
    const plan = createExecutionPlan(definition, topology);
    const validation = validateExecutionPlan(plan, topology);
    if (!validation.ok) {
      throw new Error(
        `backend_new task error: INVALID_EXECUTION_PLAN. ${validation.issues.map((issue) => issue.message).join(' ')}`
      );
    }
    return plan;
  }

  summarize(definition: TaskDefinition, runtime: TaskRuntimeState): PlannerDiagnosticsSummary {
    const topology = createTopologyGraph(definition);
    const plan = createExecutionPlan(definition, topology);
    return createPlannerDiagnosticsSummary(definition, runtime, topology, plan);
  }

  createTurn(definition: TaskDefinition, runtime: TaskRuntimeState): PlannerTurnComputation {
    return createPlannerTurn({ definition, runtime });
  }

  summarizeTurn(definition: TaskDefinition, runtime: TaskRuntimeState): {
    planner: PlannerDiagnosticsSummary;
    activeStage: ReturnType<typeof toActiveStageDiagnostics>;
  } {
    const computation = this.createTurn(definition, runtime);
    const planner = createPlannerDiagnosticsSummary(
      definition,
      runtime,
      computation.topology,
      computation.plan,
      computation.output.fallbackReasons
    );
    return {
      planner,
      activeStage: toActiveStageDiagnostics(computation.output.activeStage)
    };
  }
}
