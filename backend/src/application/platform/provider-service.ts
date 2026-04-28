import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { ProviderProfile } from '../../foundation/providers/types';
import { getProviderPreset } from '../../foundation/providers/presets';
import { resolveProviderProfile } from '../../foundation/providers/resolver';
import {
  PlatformActionResult,
  ProviderPresetView,
  ProviderProfileView,
  ProviderSecretSummary,
  ProviderTestResult
} from './types';
import { PlatformMutationRecorder } from './platform-mutation-recorder';
import { ConfigService } from './config-service';
import { createProviderProfileView } from './capability-hub';

const CURATED_PROVIDER_PRESETS: Array<{
  id: string;
  label: string;
  vendor: NonNullable<ProviderProfile['vendor']>;
  defaultModel: string;
  supportsQuickAdd: boolean;
}> = [
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: 'openai',
    defaultModel: 'gpt-5.4',
    supportsQuickAdd: true
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    vendor: 'anthropic',
    defaultModel: 'claude-sonnet-4.5',
    supportsQuickAdd: true
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: 'deepseek',
    defaultModel: 'deepseek-chat',
    supportsQuickAdd: true
  },
  {
    id: 'moonshot',
    label: 'Moonshot / Kimi',
    vendor: 'moonshot',
    defaultModel: 'moonshot-v1-8k',
    supportsQuickAdd: true
  },
  {
    id: 'zhipu',
    label: 'Zhipu / GLM',
    vendor: 'zhipu',
    defaultModel: 'glm-4.5',
    supportsQuickAdd: true
  },
  {
    id: 'ollama',
    label: 'Ollama',
    vendor: 'ollama',
    defaultModel: 'llama3.1',
    supportsQuickAdd: true
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    vendor: 'lmstudio',
    defaultModel: 'local-model',
    supportsQuickAdd: true
  },
  {
    id: 'custom-openai-compatible',
    label: 'Custom OpenAI-compatible',
    vendor: 'custom',
    defaultModel: '',
    supportsQuickAdd: false
  }
];

function requireNonEmpty(value: string | undefined | null, field: string): string {
  const normalized = value?.trim() ?? '';
  if (!normalized) {
    throw new Error(`backend_new provider error: ${field} must not be empty.`);
  }
  return normalized;
}

export class ProviderService {
  private readonly recorder: PlatformMutationRecorder;

  constructor(
    private readonly foundation: BackendNewFoundation,
    private readonly configService: ConfigService
  ) {
    this.recorder = new PlatformMutationRecorder(foundation);
  }

  async list(): Promise<ProviderProfileView[]> {
    const secrets = await this.listSecrets();
    const secretIds = new Set(secrets.map(secret => secret.id));
    const activeSnapshot = await this.foundation.configSnapshots.getActive();
    const snapshotConfig = activeSnapshot?.config as Record<string, unknown> | undefined;
    const snapshotProviders = snapshotConfig?.providers;
    const savedDefaultProviderId = (
      snapshotProviders
      && typeof snapshotProviders === 'object'
      && !Array.isArray(snapshotProviders)
      && typeof (snapshotProviders as Record<string, unknown>).defaultProviderId === 'string'
    )
      ? ((snapshotProviders as Record<string, unknown>).defaultProviderId as string).trim() || null
      : null;
    const runtimeDefaultProviderId = this.foundation.config.providers.defaultProviderId ?? null;
    return this.foundation.providers.list().map(profile => createProviderProfileView({
      foundation: this.foundation,
      profile,
      hasSecret: Boolean(profile.apiKeySecretId && secretIds.has(profile.apiKeySecretId)),
      savedDefaultProviderId,
      runtimeDefaultProviderId,
    }));
  }

  async get(providerId: string): Promise<ProviderProfileView | null> {
    const entry = (await this.list()).find(item => item.profile.id === providerId);
    return entry ?? null;
  }

  async listPresets(): Promise<ProviderPresetView[]> {
    return CURATED_PROVIDER_PRESETS.map((entry) => {
      const preset = getProviderPreset(entry.vendor);
      return {
        id: entry.id,
        label: entry.label,
        vendor: preset.vendor,
        transport: preset.transport,
        baseUrl: preset.baseUrl,
        defaultModel: entry.defaultModel,
        requiresApiKey: preset.auth.scheme !== 'none',
        supportsQuickAdd: entry.supportsQuickAdd
      };
    });
  }

  async upsert(profile: ProviderProfile): Promise<PlatformActionResult<ProviderProfile>> {
    const command = await this.recorder.recordCommand({
      resourceType: 'PROVIDER',
      resourceId: profile.id,
      action: 'UPSERT',
      input: sanitizeProviderProfile(profile)
    });
    try {
      this.foundation.providers.upsert(profile);
      await this.persistManifest();
      return await this.recorder.recordApplied(
        command,
        this.foundation.providers.get(profile.id) as ProviderProfile
      );
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async remove(providerId: string): Promise<PlatformActionResult<{ ok: true; providerId: string }>> {
    if (!this.foundation.providers.get(providerId)) {
      throw new Error(`backend_new provider error: unknown provider "${providerId}".`);
    }
    const command = await this.recorder.recordCommand({
      resourceType: 'PROVIDER',
      resourceId: providerId,
      action: 'DELETE',
    });
    try {
      this.foundation.providers.remove(providerId);
      await this.persistManifest();
      if (this.foundation.config.providers.defaultProviderId === providerId) {
        await this.configService.setDefaultProvider(null);
      }
      return await this.recorder.recordApplied(command, {
        ok: true,
        providerId
      });
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async setDefault(providerId: string): Promise<PlatformActionResult<ProviderProfileView>> {
    const existing = this.foundation.providers.get(providerId);
    if (!existing) {
      throw new Error(`backend_new provider error: unknown provider "${providerId}".`);
    }
    const configResult = await this.configService.setDefaultProvider(providerId);
    return {
      resourceType: 'PROVIDER',
      resourceId: providerId,
      action: 'SET_DEFAULT',
      commandId: configResult.commandId,
      auditId: configResult.auditId,
      appliedAt: configResult.appliedAt,
      resource: (await this.get(providerId)) as ProviderProfileView,
    };
  }

  async listSecrets(): Promise<ProviderSecretSummary[]> {
    const values = await this.foundation.apiKeys.list();
    return values.map(entry => ({
      id: entry.id,
      provider: entry.provider,
      label: entry.label,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      hasValue: true,
      metadata: entry.metadata ?? {}
    }));
  }

  async setSecret(input: {
    secretId?: string;
    provider: string;
    label: string;
    apiKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<PlatformActionResult<ProviderSecretSummary>> {
    const now = Date.now();
    const secretId = input.secretId?.trim() || `secret_${randomUUID().slice(0, 8)}`;
    const existing = input.secretId ? await this.foundation.apiKeys.get(secretId) : null;
    const provider = requireNonEmpty(input.provider, 'secret.provider');
    const label = requireNonEmpty(input.label, 'secret.label');
    const summary: ProviderSecretSummary = {
      id: secretId,
      provider,
      label,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      hasValue: true,
      metadata: input.metadata ?? {}
    };
    const command = await this.recorder.recordCommand({
      resourceType: 'PROVIDER',
      resourceId: provider,
      action: 'SET_SECRET',
      input: {
        secretId,
        provider,
        label,
        hasApiKey: true
      }
    });
    try {
      await this.foundation.apiKeys.save({
        id: secretId,
        provider,
        label,
        apiKey: requireNonEmpty(input.apiKey, 'secret.apiKey'),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        metadata: input.metadata ?? {}
      });
      return await this.recorder.recordApplied(command, summary);
    } catch (error) {
      await this.recorder.recordRejected(command, error);
      throw error;
    }
  }

  async test(providerId: string): Promise<ProviderTestResult> {
    const profile = await resolveProviderProfile(this.foundation.providers, this.foundation.apiKeys, providerId);
    const client = this.foundation.providerClients.resolve(profile);
    const capability = this.foundation.providerClients.resolveCapability(profile);
    if (!client) {
      return {
        ok: false,
        providerId,
        message: 'No provider client registered.',
        capability: capability ? { ...capability } : {}
      };
    }

    try {
      await client.complete({
        profile,
        context: {
          taskId: 'platform_test',
          unitId: null,
          sessionId: 'platform_test',
          correlationId: 'platform_test',
          turnId: 'platform_test',
          checkpointId: null
        },
        messages: [
          {
            role: 'user',
            content: 'Reply with OK.'
          }
        ],
        maxTokens: 8,
        temperature: 0
      });
      return {
        ok: true,
        providerId,
        message: 'Provider completion succeeded.',
        capability: capability ? { ...capability } : {}
      };
    } catch (error) {
      return {
        ok: false,
        providerId,
        message: error instanceof Error ? error.message : String(error),
        capability: capability ? { ...capability } : {}
      };
    }
  }

  private async persistManifest(): Promise<void> {
    const filePath = this.foundation.config.providers.manifestFile;
    await this.foundation.storage.ensureDir(path.dirname(filePath));
    await this.foundation.storage.writeJson(filePath, {
      providers: this.foundation.providers.list()
    }, this.foundation.config.storage.jsonSpacing);
  }
}

function sanitizeProviderProfile(profile: ProviderProfile): Record<string, unknown> {
  const next: Record<string, unknown> = { ...profile };
  delete next.apiKey;
  return next;
}
