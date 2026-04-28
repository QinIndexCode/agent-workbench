import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type {
  CapabilityHubView,
  ConfigStateView,
  EcosystemSummaryView,
  McpCatalogEntry,
  ImprovementProposal,
  RealTaskArchiveEntry,
  ComplexTaskAcceptanceReport,
  PlatformConfigHealth,
  ProviderPresetView,
  ProviderProfileView,
  ProviderSecretSummary,
  SkillCatalogEntry,
  WorkspaceWorkflowView
} from '../types';

export interface PlatformOverviewData {
  capabilities: CapabilityHubView;
  ecosystem: EcosystemSummaryView;
  workflow: WorkspaceWorkflowView;
  providers: ProviderProfileView[];
  providerPresets: ProviderPresetView[];
  providerSecrets: ProviderSecretSummary[];
  skills: SkillCatalogEntry[];
  mcpServers: McpCatalogEntry[];
  configHealth: PlatformConfigHealth;
  configState: ConfigStateView;
  improvements: ImprovementProposal[];
  archive: RealTaskArchiveEntry[];
  complexReport: ComplexTaskAcceptanceReport;
}

export function usePlatformOverview() {
  const [data, setData] = useState<PlatformOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [capabilities, ecosystem, workflow, providers, providerPresets, providerSecrets, skills, mcpServers, configHealth, configState, improvements, archive, complexReport] = await Promise.all([
        api.getCapabilities(),
        api.getEcosystem(),
        api.getWorkspaceWorkflow(),
        api.getProviders(),
        api.getProviderPresets(),
        api.getProviderSecrets(),
        api.getSkills(),
        api.getMcpServers(),
        api.getConfigHealth(),
        api.getConfig(),
        api.getImprovementProposals(),
        api.getImprovementArchive(),
        api.getComplexTaskAcceptanceReport(),
      ]);

      setData({
        capabilities,
        ecosystem,
        workflow,
        providers,
        providerPresets,
        providerSecrets,
        skills,
        mcpServers,
        configHealth,
        configState,
        improvements,
        archive,
        complexReport,
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load platform overview.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  return {
    data,
    loading,
    error,
    reload: loadOverview,
  };
}
