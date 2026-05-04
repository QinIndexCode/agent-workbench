import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type {
  CapabilityHubView,
  ConfigStateView,
  EcosystemSummaryView,
  ExperienceRecord,
  McpCatalogEntry,
  ImprovementProposal,
  RealTaskArchiveEntry,
  ComplexTaskAcceptanceReport,
  PlatformConfigHealth,
  PlatformSystemView,
  ProviderPresetView,
  ProviderProfileView,
  ProviderSecretSummary,
  SkillCatalogEntry,
  WorkspaceWorkflowView
} from '../types';

export interface PlatformOverviewData {
  capabilities: CapabilityHubView;
  ecosystem: EcosystemSummaryView;
  system: PlatformSystemView;
  workflow: WorkspaceWorkflowView;
  providers: ProviderProfileView[];
  providerPresets: ProviderPresetView[];
  providerSecrets: ProviderSecretSummary[];
  skills: SkillCatalogEntry[];
  mcpServers: McpCatalogEntry[];
  configHealth: PlatformConfigHealth;
  configState: ConfigStateView;
  improvements: ImprovementProposal[];
  experiences: ExperienceRecord[];
  archive: RealTaskArchiveEntry[];
  complexReport: ComplexTaskAcceptanceReport;
}

export function usePlatformOverview() {
  const [data, setData] = useState<PlatformOverviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  const loadOverview = useCallback(async () => {
    const currentRequest = requestSequence.current + 1;
    requestSequence.current = currentRequest;
    try {
      setLoading(true);
      setError(null);
      const [capabilities, ecosystem, system, workflow, providers, providerPresets, providerSecrets, skills, mcpServers, configHealth, configState, improvements, experiences, archive, complexReport] = await Promise.all([
        api.getCapabilities(),
        api.getEcosystem(),
        api.getSystemStartup(),
        api.getWorkspaceWorkflow(),
        api.getProviders(),
        api.getProviderPresets(),
        api.getProviderSecrets(),
        api.getSkills(),
        api.getMcpServers(),
        api.getConfigHealth(),
        api.getConfig(),
        api.getImprovementProposals(),
        api.getExperiences(),
        api.getImprovementArchive(),
        api.getComplexTaskAcceptanceReport(),
      ]);

      if (requestSequence.current !== currentRequest) {
        return;
      }
      setData({
        capabilities,
        ecosystem,
        system,
        workflow,
        providers,
        providerPresets,
        providerSecrets,
        skills,
        mcpServers,
        configHealth,
        configState,
        improvements,
        experiences,
        archive,
        complexReport,
      });
    } catch (loadError) {
      if (requestSequence.current !== currentRequest) {
        return;
      }
      setError(loadError instanceof Error ? loadError.message : 'Failed to load platform overview.');
    } finally {
      if (requestSequence.current === currentRequest) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    return () => {
      requestSequence.current += 1;
    };
  }, [loadOverview]);

  return {
    data,
    loading,
    error,
    reload: loadOverview,
  };
}
