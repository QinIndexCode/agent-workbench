import { BackendNewFoundation } from '../../foundation/bootstrap/types';
import { AnthropicCompatibleProviderClient } from './providers/anthropic-compatible-client';
import { DeepSeekCompatibleProviderClient } from './providers/deepseek-compatible-client';
import { HttpMcpClientAdapter } from './mcp/http-mcp-client';
import { StdioMcpClientAdapter } from './mcp/stdio-mcp-client';
import { WsMcpClientAdapter } from './mcp/ws-mcp-client';
import { OpenAiCompatibleProviderClient } from './providers/openai-compatible-client';
import { ModuleSkillRuntime } from './skills/module-skill-runtime';
import { registerBuiltinToolAdapters } from './tools/builtin-tool-adapters';

export function registerDefaultRuntimeAdapters(foundation: BackendNewFoundation): void {
  if (!foundation.providerClients.hasTransport('openai-compatible')) {
    foundation.providerClients.registerTransport(
      'openai-compatible',
      new OpenAiCompatibleProviderClient(),
      {
        supportsTools: true,
        supportsJsonMode: true
      }
    );
  }

  if (!foundation.providerClients.hasTransport('deepseek-compatible')) {
    foundation.providerClients.registerTransport(
      'deepseek-compatible',
      new DeepSeekCompatibleProviderClient(),
      {
        supportsTools: true,
        supportsJsonMode: true
      }
    );
  }

  if (!foundation.providerClients.hasTransport('anthropic-compatible')) {
    foundation.providerClients.registerTransport(
      'anthropic-compatible',
      new AnthropicCompatibleProviderClient(),
      {
        supportsTools: true,
        supportsJsonMode: false
      }
    );
  }

  if (!foundation.mcpClients.hasTransport('stdio')) {
    foundation.mcpClients.registerTransport('stdio', new StdioMcpClientAdapter(), {
      supportsTools: true
    });
  }

  if (!foundation.mcpClients.hasTransport('http')) {
    foundation.mcpClients.registerTransport('http', new HttpMcpClientAdapter(), {
      supportsTools: true,
      supportsResources: true
    });
  }

  if (!foundation.mcpClients.hasTransport('ws')) {
    foundation.mcpClients.registerTransport('ws', new WsMcpClientAdapter(), {
      supportsTools: true,
      supportsStreaming: true
    });
  }

  if (!foundation.skillRuntimes.hasDefaultRuntime()) {
    foundation.skillRuntimes.setDefaultRuntime(new ModuleSkillRuntime(), {
      supportsStreaming: false
    });
  }

  registerBuiltinToolAdapters(foundation, foundation.extensions, foundation.toolExecutors);
}
