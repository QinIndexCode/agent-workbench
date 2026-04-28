import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { PlatformSystemView } from './types';

export class SystemService {
  constructor(private readonly foundation: BackendNewFoundation) {}

  async getStartup(): Promise<PlatformSystemView> {
    const snapshot = this.foundation.extensions.snapshot();
    return {
      server: {
        host: this.foundation.config.server.host,
        port: this.foundation.config.server.port,
        websocketPath: this.foundation.config.server.websocketPath,
        sseFallback: this.foundation.config.server.enableSseFallback
      },
      storage: {
        driver: this.foundation.config.storage.driver,
        rootDir: this.foundation.config.paths.rootDir
      },
      database: {
        enabled: Boolean(this.foundation.database),
        healthy: this.foundation.database ? await this.foundation.database.ping() : null,
        schema: this.foundation.config.database.schema
      },
      queue: {
        enabled: Boolean(this.foundation.queue),
        workerEnabled: this.foundation.config.worker.enabled
      },
      registries: {
        providers: this.foundation.providers.list().length,
        skills: snapshot.skills.length,
        mcpServers: snapshot.mcpServers.length,
        tools: snapshot.tools.length
      }
    };
  }
}
