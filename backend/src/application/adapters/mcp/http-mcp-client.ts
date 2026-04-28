import {
  McpCapabilityDiscoveryResult,
  McpClientAdapter,
  McpConnectionRequest,
  McpToolCallRequest,
  McpToolCallResult
} from '../../../foundation/mcp/types';

function resolveBaseUrl(rawUrl: string | undefined): string {
  if (!rawUrl?.trim()) {
    throw new Error('backend_new mcp error: http transport requires url.');
  }
  return rawUrl.replace(/\/+$/, '');
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as Record<string, unknown>;
}

export class HttpMcpClientAdapter implements McpClientAdapter {
  async connect(request: McpConnectionRequest): Promise<void> {
    resolveBaseUrl(request.server.url);
  }

  async discoverCapabilities(request: McpConnectionRequest): Promise<McpCapabilityDiscoveryResult> {
    const baseUrl = resolveBaseUrl(request.server.url);
    const response = await fetch(`${baseUrl}/capabilities`, {
      method: 'GET',
      headers: {
        accept: 'application/json'
      }
    });
    const payload = await readJsonResponse(response);
    const capability = payload.capability as Record<string, unknown> | undefined;
    return {
      capability: {
        supportsTools: capability?.supportsTools !== false,
        supportsPrompts: Boolean(capability?.supportsPrompts),
        supportsResources: Boolean(capability?.supportsResources),
        supportsStreaming: Boolean(capability?.supportsStreaming)
      },
      metadata: (payload.metadata as Record<string, unknown> | undefined) ?? {}
    };
  }

  async callTool(request: McpToolCallRequest): Promise<McpToolCallResult> {
    const baseUrl = resolveBaseUrl(request.server.url);
    const response = await fetch(`${baseUrl}/call-tool`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        accept: 'application/json'
      },
      body: JSON.stringify({
        toolName: request.toolName,
        arguments: request.arguments,
        context: request.context,
        metadata: request.metadata ?? {}
      })
    });
    const payload = await readJsonResponse(response);
    return {
      ok: payload.ok !== false && response.ok,
      output: (payload.output as Record<string, unknown> | null | undefined) ?? null,
      error: (payload.error as string | null | undefined) ?? (response.ok ? null : `HTTP ${response.status}`),
      metadata: {
        transport: 'http',
        status: response.status,
        ...((payload.metadata as Record<string, unknown> | undefined) ?? {})
      }
    };
  }
}
