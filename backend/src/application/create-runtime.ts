import {
  BackendNewTaskApplication
} from './tasks/lifecycle/task-application';
import { BackendNewPlatformApplication } from './platform';
import { BackendNewConfig, BackendNewConfigInput } from '../foundation/config/types';
import { createBackendNewFoundation } from '../foundation/bootstrap/create-foundation';
import { BackendNewFoundation } from '../foundation/bootstrap/types';
import { StorageAdapter } from '../foundation/storage/types';
import { loadExtensionManifests } from '../foundation/extensions/manifest-loader';
import { loadSkillPlaceholders } from '../foundation/extensions/skill-loader';
import { loadProviderManifest } from '../foundation/providers/manifest-loader';
import { registerDefaultRuntimeAdapters } from './adapters/register-default-runtime-adapters';
import {
  BackendNewAnalysisFacade,
  BackendNewExtensionsFacade,
  BackendNewPlatformFacade,
  BackendNewTasksFacade,
  BackendNewWorkerFacade,
  createAnalysisFacade,
  createExtensionsFacade,
  createPlatformFacade,
  createTasksFacade,
  createWorkerFacade,
  createRuntimeServiceBundle,
  RuntimeServiceBundle,
  startManagedRuntimeServices
} from './runtime';
import { loadUserPreferenceProfile } from './runtime/memory-store';
import { QueueWorkerService, RecoveryService } from './worker';

export interface BackendNewRuntimeOptions {
  config?: BackendNewConfigInput;
  resolvedConfig?: BackendNewConfig;
  storage?: StorageAdapter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  foundation?: BackendNewFoundation;
}

export class BackendNewRuntime {
  readonly config: BackendNewConfig;
  readonly tasks: BackendNewTasksFacade;
  readonly platform: BackendNewPlatformFacade;
  readonly analysis: BackendNewAnalysisFacade;
  readonly extensions: BackendNewExtensionsFacade;
  readonly worker: BackendNewWorkerFacade;

  private readonly foundation: BackendNewFoundation;
  private readonly taskApplication: BackendNewTaskApplication;
  private readonly platformApplication: BackendNewPlatformApplication;
  private readonly workerService: QueueWorkerService | null;
  private readonly recoveryService: RecoveryService | null;
  private readonly services: RuntimeServiceBundle;
  private readonly startup: Promise<void>;
  private startupError: Error | null = null;

  constructor(options: BackendNewRuntimeOptions = {}) {
    const foundation = options.foundation ?? createBackendNewFoundation({
      config: options.config,
      resolvedConfig: options.resolvedConfig,
      storage: options.storage,
      cwd: options.cwd,
      env: options.env
    });
    this.foundation = foundation;
    this.config = foundation.config;
    registerDefaultRuntimeAdapters(foundation);
    this.services = createRuntimeServiceBundle(foundation);
    this.taskApplication = this.services.taskApplication;
    this.platformApplication = this.services.platformApplication;
    this.recoveryService = this.services.recovery;
    this.workerService = this.services.worker;
    this.tasks = createTasksFacade({
      ensureReady: this.ensureReady.bind(this),
      taskApplication: this.taskApplication
    });
    this.platform = createPlatformFacade({
      ensureReady: this.ensureReady.bind(this),
      platformApplication: this.platformApplication,
      getUserPreferenceProfile: () => loadUserPreferenceProfile(this.foundation)
    });
    this.analysis = createAnalysisFacade({
      ensureReady: this.ensureReady.bind(this),
      analysisService: this.services.analysis
    });
    this.extensions = createExtensionsFacade({
      ensureReady: this.ensureReady.bind(this),
      extensions: this.foundation.extensions,
      extensionRuntimeService: this.services.extensionRuntime
    });
    this.worker = createWorkerFacade({
      ensureReady: this.ensureReady.bind(this),
      workerService: this.workerService,
      recoveryService: this.recoveryService
    });
    this.startup = this.initializeFoundation().catch((error) => {
      this.startupError = error instanceof Error ? error : new Error(String(error));
    });
  }

  private async initializeFoundation(): Promise<void> {
    await loadExtensionManifests(
      this.foundation.config,
      this.foundation.storage,
      this.foundation.extensions
    );
    await loadSkillPlaceholders(
      this.foundation.config,
      this.foundation.storage,
      this.foundation.extensions,
      this.foundation.layout
    );
    await loadProviderManifest(
      this.foundation.config,
      this.foundation.storage,
      this.foundation.providers
    );
    await this.recoveryService?.recoverInterruptedTasks();
    startManagedRuntimeServices(this.foundation, this.services);
  }

  private async ensureReady(): Promise<void> {
    await this.startup;
    if (this.startupError) {
      throw this.startupError;
    }
  }

  async close(): Promise<void> {
    await this.startup;
    await this.workerService?.stop();
    if (this.foundation.database) {
      await this.foundation.database.close();
    }
  }

  get foundationRef(): BackendNewFoundation {
    return this.foundation;
  }
}

export function createBackendNewRuntime(options: BackendNewRuntimeOptions = {}): BackendNewRuntime {
  return new BackendNewRuntime(options);
}
