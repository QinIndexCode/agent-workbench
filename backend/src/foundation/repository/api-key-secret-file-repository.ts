import { BackendNewConfig } from '../config/types';
import { SecretCipher } from '../security/types';
import { StorageLayout } from '../storage/layout';
import { StorageAdapter } from '../storage/types';
import {
  ApiKeySecretRecord,
  ApiKeySecretRepository,
  ApiKeySecretValue
} from './types';

export class FileApiKeySecretRepository implements ApiKeySecretRepository {
  constructor(
    private readonly config: BackendNewConfig,
    private readonly storage: StorageAdapter,
    private readonly layout: StorageLayout,
    private readonly cipher: SecretCipher
  ) {}

  async save(record: ApiKeySecretValue): Promise<void> {
    const payload: ApiKeySecretRecord = {
      id: record.id,
      provider: record.provider,
      label: record.label,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      cipherText: this.cipher.encrypt(record.apiKey),
      metadata: record.metadata
    };

    await this.storage.writeJson(
      this.layout.secretRecordPath(record.id),
      payload,
      this.config.storage.jsonSpacing
    );
  }

  async get(secretId: string): Promise<ApiKeySecretValue | null> {
    const filePath = this.layout.secretRecordPath(secretId);
    if (!await this.storage.exists(filePath)) {
      return null;
    }

    const stored = await this.storage.readJson<ApiKeySecretRecord>(filePath, this.config.storage.encoding);
    return {
      id: stored.id,
      provider: stored.provider,
      label: stored.label,
      apiKey: this.cipher.decrypt(stored.cipherText),
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      metadata: stored.metadata
    };
  }

  async list(): Promise<ApiKeySecretValue[]> {
    const files = await this.storage.listFiles(this.layout.paths.secretsDir);
    const records: ApiKeySecretValue[] = [];
    for (const filePath of files) {
      if (!filePath.endsWith('.json') || filePath === this.layout.secretsIndexPath) {
        continue;
      }
      const stored = await this.storage.readJson<ApiKeySecretRecord>(filePath, this.config.storage.encoding);
      records.push({
        id: stored.id,
        provider: stored.provider,
        label: stored.label,
        apiKey: this.cipher.decrypt(stored.cipherText),
        createdAt: stored.createdAt,
        updatedAt: stored.updatedAt,
        metadata: stored.metadata
      });
    }
    return records.sort((left, right) => right.updatedAt - left.updatedAt);
  }
}
