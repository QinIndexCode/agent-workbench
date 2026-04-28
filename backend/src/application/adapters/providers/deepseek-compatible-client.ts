import { OpenAiCompatibleProviderClient } from './openai-compatible-client';

export class DeepSeekCompatibleProviderClient extends OpenAiCompatibleProviderClient {
  protected providerKind = 'deepseek-compatible';

  protected override buildHeaders(request: import('../../../foundation/providers/client-types').ProviderCompletionRequest): Record<string, string> {
    return {
      ...super.buildHeaders(request),
      'x-backend-new-provider': 'deepseek-compatible',
      'accept': 'application/json'
    };
  }
}
