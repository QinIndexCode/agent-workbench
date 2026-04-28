export interface ProviderClientCapability {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  supportsVision: boolean;
  maxContextTokens: number | null;
}

export function createDefaultProviderClientCapability(): ProviderClientCapability {
  return {
    supportsStreaming: false,
    supportsTools: false,
    supportsJsonMode: false,
    supportsVision: false,
    maxContextTokens: null
  };
}
