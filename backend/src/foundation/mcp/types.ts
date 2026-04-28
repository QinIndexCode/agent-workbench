import { McpServerDefinition } from '../extensions/types';

export interface McpConnectionContext {
  taskId: string;
  sessionId: string;
  correlationId: string;
  turnId: string;
}

export interface McpConnectionRequest {
  server: McpServerDefinition;
  context: McpConnectionContext;
  metadata?: Record<string, unknown>;
}

export interface McpToolCallRequest {
  server: McpServerDefinition;
  toolName: string;
  arguments: Record<string, unknown>;
  context: McpConnectionContext;
  metadata?: Record<string, unknown>;
}

export interface McpToolCallResult {
  ok: boolean;
  output: Record<string, unknown> | null;
  error: string | null;
  metadata: Record<string, unknown>;
}

export interface McpCapabilityDiscoveryResult {
  capability: McpClientCapability;
  metadata: Record<string, unknown>;
}

export interface McpClientCapability {
  supportsTools: boolean;
  supportsPrompts: boolean;
  supportsResources: boolean;
  supportsStreaming: boolean;
  toolNames?: string[];
  resourceNames?: string[];
  promptNames?: string[];
}

export interface McpClientAdapter {
  connect(request: McpConnectionRequest): Promise<void>;
  discoverCapabilities?(request: McpConnectionRequest): Promise<McpCapabilityDiscoveryResult>;
  callTool(request: McpToolCallRequest): Promise<McpToolCallResult>;
  close?(): Promise<void> | void;
}
