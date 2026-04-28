import type {
  CapabilityHubView,
  ConfigStateView,
  EcosystemSummaryView,
  McpCatalogEntry,
  McpTestResult,
  ImprovementProposal,
  PlatformActionResult,
  PlatformConfigHealth,
  ProviderPresetView,
  ProviderProfile,
  ProviderProfileView,
  ProviderSecretSummary,
  ProviderTestResult,
  RuntimeEvent,
  SkillCatalogEntry,
  SubmitTaskPayload,
  TaskActionResponse,
  TaskCommandPayload,
  TaskDebugResponse,
  TaskDetail,
  TaskSummary,
  RealTaskArchiveEntry,
  ComplexTaskAcceptanceReport,
  WorkspaceWorkflowView
} from '../types';

const BASE_URL = import.meta.env.VITE_BACKEND_SERVER_URL ?? 'http://127.0.0.1:3011';

class ApiClient {
  private async request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${BASE_URL}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async getHealth() {
    return this.request<{ ok: boolean }>('/health');
  }

  async getCapabilities(): Promise<CapabilityHubView> {
    return this.request<CapabilityHubView>('/capabilities');
  }

  async getEcosystem(): Promise<EcosystemSummaryView> {
    return this.request<EcosystemSummaryView>('/ecosystem');
  }

  async getWorkspaceWorkflow(): Promise<WorkspaceWorkflowView> {
    return this.request<WorkspaceWorkflowView>('/workspace/workflow');
  }

  async initWorkspaceWorkflow(): Promise<PlatformActionResult<WorkspaceWorkflowView>> {
    return this.request<PlatformActionResult<WorkspaceWorkflowView>>('/workspace/workflow/init', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async importWorkspaceDocs(): Promise<PlatformActionResult<WorkspaceWorkflowView['docsImportSummary']>> {
    return this.request<PlatformActionResult<WorkspaceWorkflowView['docsImportSummary']>>('/workspace/workflow/docs/import', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getProviders(): Promise<ProviderProfileView[]> {
    return this.request<ProviderProfileView[]>('/providers');
  }

  async getProviderPresets(): Promise<ProviderPresetView[]> {
    return this.request<ProviderPresetView[]>('/providers/presets');
  }

  async getProviderSecrets(): Promise<ProviderSecretSummary[]> {
    return this.request<ProviderSecretSummary[]>('/providers/secrets');
  }

  async updateProvider(providerId: string, profile: ProviderProfile): Promise<PlatformActionResult<ProviderProfile>> {
    return this.request<PlatformActionResult<ProviderProfile>>(`/providers/${providerId}`, {
      method: 'PUT',
      body: JSON.stringify(profile),
    });
  }

  async testProvider(providerId: string): Promise<ProviderTestResult> {
    return this.request<ProviderTestResult>(`/providers/${providerId}/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async setDefaultProvider(providerId: string): Promise<PlatformActionResult<ProviderProfileView>> {
    return this.request<PlatformActionResult<ProviderProfileView>>(`/providers/${providerId}/default`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async deleteProvider(providerId: string): Promise<PlatformActionResult<{ ok: true; providerId: string }>> {
    return this.request<PlatformActionResult<{ ok: true; providerId: string }>>(`/providers/${providerId}`, {
      method: 'DELETE',
    });
  }

  async setProviderSecret(payload: {
    secretId?: string;
    provider: string;
    label: string;
    apiKey: string;
    metadata?: Record<string, unknown>;
  }): Promise<PlatformActionResult<ProviderSecretSummary>> {
    return this.request<PlatformActionResult<ProviderSecretSummary>>('/providers/secrets', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getConfig(): Promise<ConfigStateView> {
    return this.request<ConfigStateView>('/config');
  }

  async patchConfig(patch: Record<string, unknown>): Promise<PlatformActionResult<ConfigStateView>> {
    return this.request<PlatformActionResult<ConfigStateView>>('/config', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async reloadConfig(): Promise<PlatformActionResult<ConfigStateView>> {
    return this.request<PlatformActionResult<ConfigStateView>>('/config/reload', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getSkills(): Promise<SkillCatalogEntry[]> {
    return this.request<SkillCatalogEntry[]>('/skills');
  }

  async createSkill(payload: {
    id: string;
    name: string;
    description?: string;
    kind: 'runtime-skill' | 'instruction-skill';
    content: string;
  }): Promise<PlatformActionResult<SkillCatalogEntry>> {
    return this.request<PlatformActionResult<SkillCatalogEntry>>('/skills', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async updateSkill(
    skillId: string,
    payload: {
      id: string;
      name: string;
      description?: string;
      kind: 'runtime-skill' | 'instruction-skill';
      content: string;
    }
  ): Promise<PlatformActionResult<SkillCatalogEntry>> {
    return this.request<PlatformActionResult<SkillCatalogEntry>>(`/skills/${skillId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  async deleteSkill(skillId: string): Promise<PlatformActionResult<{ ok: true; skillId: string }>> {
    return this.request<PlatformActionResult<{ ok: true; skillId: string }>>(`/skills/${skillId}`, {
      method: 'DELETE',
    });
  }

  async duplicateSkill(
    skillId: string,
    payload?: {
      id?: string;
      name?: string;
    }
  ): Promise<PlatformActionResult<SkillCatalogEntry>> {
    return this.request<PlatformActionResult<SkillCatalogEntry>>(`/skills/${skillId}/duplicate`, {
      method: 'POST',
      body: JSON.stringify(payload ?? {}),
    });
  }

  async refreshSkills(): Promise<PlatformActionResult<SkillCatalogEntry[]>> {
    return this.request<PlatformActionResult<SkillCatalogEntry[]>>('/skills/refresh', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async importSkill(payload: {
    id?: string;
    name?: string;
    rootDir?: string;
    description?: string;
    kind?: 'runtime-skill' | 'instruction-skill';
  }): Promise<PlatformActionResult<SkillCatalogEntry['skill']>> {
    return this.request<PlatformActionResult<SkillCatalogEntry['skill']>>('/skills/import', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async importMarketplaceSkills(payload: {
    marketplaceFile: string;
    pluginName: string;
    skillPath?: string;
  }): Promise<PlatformActionResult<SkillCatalogEntry['skill'][]>> {
    return this.request<PlatformActionResult<SkillCatalogEntry['skill'][]>>('/skills/import-marketplace', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getMcpServers(): Promise<McpCatalogEntry[]> {
    return this.request<McpCatalogEntry[]>('/mcp');
  }

  async upsertMcpServer(serverId: string, payload: McpCatalogEntry['server']): Promise<PlatformActionResult<McpCatalogEntry['server']>> {
    return this.request<PlatformActionResult<McpCatalogEntry['server']>>(`/mcp/${serverId}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  async deleteMcpServer(serverId: string): Promise<PlatformActionResult<{ ok: true; serverId: string }>> {
    return this.request<PlatformActionResult<{ ok: true; serverId: string }>>(`/mcp/${serverId}`, {
      method: 'DELETE',
    });
  }

  async testMcpServer(serverId: string): Promise<McpTestResult> {
    return this.request<McpTestResult>(`/mcp/${serverId}/test`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getConfigHealth(): Promise<PlatformConfigHealth> {
    return this.request<PlatformConfigHealth>('/config/health');
  }

  async getImprovementProposals(): Promise<ImprovementProposal[]> {
    return this.request<ImprovementProposal[]>('/improvements/proposals');
  }

  async getImprovementProposal(proposalId: string): Promise<ImprovementProposal | null> {
    return this.request<ImprovementProposal | null>(`/improvements/proposals/${proposalId}`);
  }

  async approveImprovementProposal(proposalId: string): Promise<PlatformActionResult<ImprovementProposal>> {
    return this.request<PlatformActionResult<ImprovementProposal>>(`/improvements/proposals/${proposalId}/approve`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async rejectImprovementProposal(proposalId: string): Promise<PlatformActionResult<ImprovementProposal>> {
    return this.request<PlatformActionResult<ImprovementProposal>>(`/improvements/proposals/${proposalId}/reject`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async getImprovementArchive(): Promise<RealTaskArchiveEntry[]> {
    return this.request<RealTaskArchiveEntry[]>('/improvements/archive');
  }

  async getComplexTaskAcceptanceReport(): Promise<ComplexTaskAcceptanceReport> {
    return this.request<ComplexTaskAcceptanceReport>('/improvements/report');
  }

  async getTasks(includeArchived = false): Promise<TaskSummary[]> {
    const query = includeArchived ? '?includeArchived=true' : '';
    return this.request<TaskSummary[]>(`/tasks${query}`);
  }

  async getTask(taskId: string): Promise<TaskDetail> {
    return this.request<TaskDetail>(`/tasks/${taskId}`);
  }

  async getTaskDebug(taskId: string): Promise<TaskDebugResponse> {
    return this.request<TaskDebugResponse>(`/tasks/${taskId}/debug`);
  }

  async getTaskEvents(taskId: string, afterEventId?: string): Promise<RuntimeEvent[]> {
    const query = afterEventId ? `?afterEventId=${afterEventId}` : '';
    return this.request<RuntimeEvent[]>(`/tasks/${taskId}/events${query}`);
  }

  async submitTask(payload: SubmitTaskPayload): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>('/tasks', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async startTask(taskId: string, userMessage?: string): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/start`, {
      method: 'POST',
      body: JSON.stringify({ userMessage }),
    });
  }

  async pauseTask(taskId: string, userMessage?: string): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/pause`, {
      method: 'POST',
      body: JSON.stringify({ userMessage }),
    });
  }

  async resumeTask(taskId: string, userMessage?: string): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/resume`, {
      method: 'POST',
      body: JSON.stringify({ userMessage }),
    });
  }

  async restartTask(taskId: string, userMessage?: string): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/restart`, {
      method: 'POST',
      body: JSON.stringify({ userMessage }),
    });
  }

  async continueTask(taskId: string, userMessage?: string): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/continue`, {
      method: 'POST',
      body: JSON.stringify({ userMessage }),
    });
  }

  async archiveTask(taskId: string): Promise<{ ok: true; taskId: string; isArchived: boolean }> {
    return this.request<{ ok: true; taskId: string; isArchived: boolean }>(`/tasks/${taskId}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async unarchiveTask(taskId: string): Promise<{ ok: true; taskId: string; isArchived: boolean }> {
    return this.request<{ ok: true; taskId: string; isArchived: boolean }>(`/tasks/${taskId}/unarchive`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  async deleteTask(taskId: string): Promise<{ ok: true; taskId: string; deleted: boolean }> {
    return this.request<{ ok: true; taskId: string; deleted: boolean }>(`/tasks/${taskId}`, {
      method: 'DELETE',
    });
  }

  async submitCommand(taskId: string, payload: TaskCommandPayload): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/commands`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async resolveApproval(
    taskId: string,
    invocationId: string,
    status: 'APPROVED' | 'REJECTED' | 'EXPIRED',
    reason?: string,
  ): Promise<TaskActionResponse> {
    return this.request<TaskActionResponse>(`/tasks/${taskId}/approvals/resolve`, {
      method: 'POST',
      body: JSON.stringify({
        invocationId,
        status,
        reason: reason ?? null,
      }),
    });
  }

  async sendOperatorMessage(taskId: string, message: string): Promise<TaskActionResponse> {
    return this.submitCommand(taskId, {
      type: 'SEND_OPERATOR_MESSAGE',
      message,
    });
  }

  async applyArtifacts(taskId: string, destinationDir?: string, overwrite = false): Promise<TaskActionResponse> {
    return this.submitCommand(taskId, {
      type: 'APPLY_ARTIFACTS',
      message: destinationDir ?? null,
      metadata: {
        destinationDir: destinationDir ?? null,
        overwrite,
      },
    });
  }
}

export const api = new ApiClient();
