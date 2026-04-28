import { ProviderProfile, ProviderTransport } from './types';
import { ProviderClientCapability, createDefaultProviderClientCapability } from './client-capability';
import { ProviderClient } from './client-types';

export interface ProviderClientRegistration {
  client: ProviderClient;
  capability: ProviderClientCapability;
}

export class ProviderClientRegistry {
  private readonly clients = new Map<string, ProviderClientRegistration>();
  private readonly transportClients = new Map<ProviderTransport, ProviderClientRegistration>();

  register(
    providerId: string,
    client: ProviderClient,
    capability: Partial<ProviderClientCapability> = {}
  ): void {
    if (!providerId.trim()) {
      throw new Error('backend_new provider client error: providerId must not be empty.');
    }
    this.clients.set(providerId, {
      client,
      capability: {
        ...createDefaultProviderClientCapability(),
        ...capability
      }
    });
  }

  registerTransport(
    transport: ProviderTransport,
    client: ProviderClient,
    capability: Partial<ProviderClientCapability> = {}
  ): void {
    this.transportClients.set(transport, {
      client,
      capability: {
        ...createDefaultProviderClientCapability(),
        ...capability
      }
    });
  }

  has(providerId: string): boolean {
    return this.clients.has(providerId);
  }

  hasTransport(transport: ProviderTransport): boolean {
    return this.transportClients.has(transport);
  }

  resolve(profile: ProviderProfile): ProviderClient | null {
    return this.resolveEntry(profile)?.client ?? null;
  }

  resolveCapability(profile: ProviderProfile): ProviderClientCapability | null {
    return this.resolveEntry(profile)?.capability ?? null;
  }

  resolveEntry(profile: ProviderProfile): ProviderClientRegistration | null {
    const transport = profile.transport ?? null;
    return this.clients.get(profile.id) ?? (transport ? this.transportClients.get(transport) : null) ?? null;
  }
}
