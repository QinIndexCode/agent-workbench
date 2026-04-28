import { normalizeProviderProfile } from './presets';
import { ProviderProfile } from './types';

export class ProviderRegistry {
  private readonly profiles = new Map<string, ProviderProfile>();

  register(profile: ProviderProfile): void {
    const id = profile.id.trim();
    if (!id) {
      throw new Error('backend_new provider error: provider id must not be empty.');
    }
    if (this.profiles.has(id)) {
      throw new Error(`backend_new provider error: duplicate provider id "${id}".`);
    }
    this.profiles.set(id, normalizeProviderProfile({
      ...profile,
      id
    }));
  }

  get(id: string): ProviderProfile | null {
    return this.profiles.get(id) ?? null;
  }

  upsert(profile: ProviderProfile): void {
    const id = profile.id.trim();
    if (!id) {
      throw new Error('backend_new provider error: provider id must not be empty.');
    }
    this.profiles.set(id, normalizeProviderProfile({
      ...profile,
      id
    }));
  }

  remove(id: string): boolean {
    return this.profiles.delete(id);
  }

  replaceAll(profiles: ProviderProfile[]): void {
    this.profiles.clear();
    for (const profile of profiles) {
      this.upsert(profile);
    }
  }

  list(): ProviderProfile[] {
    return Array.from(this.profiles.values());
  }
}
