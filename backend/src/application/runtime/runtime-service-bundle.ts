import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { BackendNewPlatformApplication } from '../platform';
import { BackendNewTaskApplication } from '../tasks/lifecycle/task-application';
import { QueueWorkerService, RecoveryService } from '../worker';
import { ExtensionRuntimeService } from './extension-runtime-service';
import { RuntimeAnalysisService } from './runtime-analysis-service';

export interface RuntimeServiceBundle {
  analysis: RuntimeAnalysisService;
  extensionRuntime: ExtensionRuntimeService;
  taskApplication: BackendNewTaskApplication;
  platformApplication: BackendNewPlatformApplication;
  worker: QueueWorkerService | null;
  recovery: RecoveryService | null;
}

export function createRuntimeServiceBundle(
  foundation: BackendNewFoundation
): RuntimeServiceBundle {
  return {
    analysis: new RuntimeAnalysisService(foundation),
    extensionRuntime: new ExtensionRuntimeService(foundation),
    taskApplication: new BackendNewTaskApplication(foundation),
    platformApplication: new BackendNewPlatformApplication(foundation),
    recovery: new RecoveryService(foundation),
    worker: foundation.queue ? new QueueWorkerService(foundation) : null
  };
}

export function startManagedRuntimeServices(
  foundation: BackendNewFoundation,
  services: RuntimeServiceBundle
): void {
  if (services.worker && foundation.config.worker.enabled) {
    services.worker.start();
  }
}
