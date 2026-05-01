import { ProviderCapabilityMetadata } from './types';

export interface ProviderClientCapability {
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  supportsVision: boolean;
  supportsFiles: boolean;
  inputModalities: ProviderCapabilityMetadata['inputModalities'];
  outputModalities: ProviderCapabilityMetadata['outputModalities'];
  supportedFileExtensions: string[];
  maxContextTokens: number | null;
}

export function createDefaultProviderClientCapability(): ProviderClientCapability {
  return {
    supportsStreaming: false,
    supportsTools: false,
    supportsJsonMode: false,
    supportsVision: false,
    supportsFiles: false,
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedFileExtensions: [],
    maxContextTokens: null
  };
}
