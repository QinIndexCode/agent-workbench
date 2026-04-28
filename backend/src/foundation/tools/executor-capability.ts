export interface ToolExecutorCapability {
  supportsApprovalResume: boolean;
  supportsDryRun: boolean;
  supportsStreaming: boolean;
  maxExecutionMs: number | null;
}

export function createDefaultToolExecutorCapability(): ToolExecutorCapability {
  return {
    supportsApprovalResume: true,
    supportsDryRun: false,
    supportsStreaming: false,
    maxExecutionMs: null
  };
}
