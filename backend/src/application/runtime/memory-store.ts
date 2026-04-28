import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { UserPreferenceProfile } from '../../domain/contracts/types';
import { createEmptyUserPreferenceProfile } from '../../domain/runtime/memory';

export async function loadUserPreferenceProfile(
  foundation: BackendNewFoundation
): Promise<UserPreferenceProfile | null> {
  const filePath = foundation.layout.userProfilePath;
  if (!await foundation.storage.exists(filePath)) {
    return null;
  }
  return foundation.storage.readJson<UserPreferenceProfile>(
    filePath,
    foundation.config.storage.encoding
  );
}

export async function saveUserPreferenceProfile(
  foundation: BackendNewFoundation,
  profile: UserPreferenceProfile
): Promise<void> {
  await foundation.storage.writeJson(
    foundation.layout.userProfilePath,
    profile,
    foundation.config.storage.jsonSpacing
  );
}

export async function loadOrCreateUserPreferenceProfile(
  foundation: BackendNewFoundation
): Promise<UserPreferenceProfile> {
  return (await loadUserPreferenceProfile(foundation)) ?? createEmptyUserPreferenceProfile();
}
