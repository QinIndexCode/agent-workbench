import { ProviderProfile } from '../../../foundation/providers/types';
import { McpServerDefinition } from '../../../foundation/extensions/types';
import { HttpRouteModule } from '../route-types';
import { readJsonBody, sendJson } from '../utils';

export const platformRoutes: HttpRouteModule = {
  async handle({ runtime, request, response, segments, path, url }) {
    if (request.method === 'GET' && path === '/capabilities') {
      sendJson(response, 200, await runtime.platform.getCapabilityHub());
      return true;
    }
    if (request.method === 'GET' && path === '/ecosystem') {
      sendJson(response, 200, await runtime.platform.getEcosystemSummary());
      return true;
    }
    if (request.method === 'GET' && path === '/tools') {
      sendJson(response, 200, await runtime.platform.listToolCapabilities());
      return true;
    }
    if (request.method === 'GET' && path === '/tools/health') {
      sendJson(response, 200, (await runtime.platform.listToolCapabilities()).map((tool) => ({
        id: tool.id,
        name: tool.name,
        readiness: tool.readiness,
        healthCheck: tool.healthCheck,
        acceptanceEvidence: tool.acceptanceEvidence
      })));
      return true;
    }
    if (request.method === 'GET' && path === '/scenario-packs') {
      sendJson(response, 200, await runtime.platform.listScenarioPacks());
      return true;
    }
    if (request.method === 'GET' && path === '/ecosystem/skills') {
      sendJson(response, 200, await runtime.platform.listEcosystemSkills());
      return true;
    }
    if (request.method === 'GET' && path === '/ecosystem/mcp') {
      sendJson(response, 200, await runtime.platform.listEcosystemMcpServers());
      return true;
    }
    if (request.method === 'GET' && path === '/workspace/workflow') {
      sendJson(response, 200, await runtime.platform.getWorkspaceWorkflow());
      return true;
    }
    if (request.method === 'GET' && path === '/workspace/directories') {
      sendJson(response, 200, await runtime.platform.listWorkspaceDirectories(url.searchParams.get('path')));
      return true;
    }
    if (request.method === 'GET' && path === '/improvements/proposals') {
      sendJson(response, 200, await runtime.platform.listImprovementProposals());
      return true;
    }
    if (request.method === 'GET' && path === '/improvements/archive') {
      sendJson(response, 200, await runtime.platform.listRealTaskArchive());
      return true;
    }
    if (request.method === 'GET' && path === '/improvements/report') {
      sendJson(response, 200, await runtime.platform.getComplexTaskAcceptanceReport());
      return true;
    }
    if (segments[0] === 'improvements' && segments[1] === 'proposals' && segments[2]) {
      const proposalId = segments[2];
      if (request.method === 'GET' && segments.length === 3) {
        sendJson(response, 200, await runtime.platform.getImprovementProposal(proposalId));
        return true;
      }
      if (request.method === 'POST' && segments[3] === 'approve') {
        sendJson(response, 200, await runtime.platform.approveImprovementProposal(proposalId));
        return true;
      }
      if (request.method === 'POST' && segments[3] === 'reject') {
        sendJson(response, 200, await runtime.platform.rejectImprovementProposal(proposalId));
        return true;
      }
    }
    if (request.method === 'POST' && path === '/workspace/workflow/init') {
      sendJson(response, 200, await runtime.platform.initWorkspaceWorkflow());
      return true;
    }
    if (request.method === 'POST' && path === '/workspace/workflow/docs/import') {
      sendJson(response, 200, await runtime.platform.importWorkspaceDocs());
      return true;
    }

    if (request.method === 'GET' && path === '/providers') {
      sendJson(response, 200, await runtime.platform.listProviders());
      return true;
    }

    if (request.method === 'GET' && path === '/providers/presets') {
      sendJson(response, 200, await runtime.platform.listProviderPresets());
      return true;
    }

    if (request.method === 'GET' && path === '/providers/secrets') {
      sendJson(response, 200, await runtime.platform.listProviderSecrets());
      return true;
    }

    if (request.method === 'POST' && path === '/providers/secrets') {
      sendJson(response, 200, await runtime.platform.setProviderSecret(await readJsonBody(request)));
      return true;
    }

    if (segments[0] === 'providers' && segments[1]) {
      const providerId = segments[1];
      if (request.method === 'GET' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.getProvider(providerId));
        return true;
      }
      if (request.method === 'PUT' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.upsertProvider({
          ...(await readJsonBody<ProviderProfile>(request)),
          id: providerId
        }));
        return true;
      }
      if (request.method === 'DELETE' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.deleteProvider(providerId));
        return true;
      }
      if (request.method === 'POST' && segments[2] === 'test') {
        sendJson(response, 200, await runtime.platform.testProvider(providerId));
        return true;
      }
      if (request.method === 'POST' && segments[2] === 'default') {
        sendJson(response, 200, await runtime.platform.setDefaultProvider(providerId));
        return true;
      }
    }

    if (request.method === 'GET' && path === '/config') {
      sendJson(response, 200, await runtime.platform.getConfigState());
      return true;
    }
    if (request.method === 'PATCH' && path === '/config') {
      sendJson(response, 200, await runtime.platform.updateConfig(await readJsonBody(request)));
      return true;
    }
    if (request.method === 'POST' && path === '/config/reload') {
      sendJson(response, 200, await runtime.platform.reloadConfig());
      return true;
    }
    if (request.method === 'GET' && path === '/config/health') {
      sendJson(response, 200, await runtime.platform.getDetailedConfigHealth());
      return true;
    }

    if (request.method === 'GET' && path === '/skills') {
      sendJson(response, 200, await runtime.platform.listSkills());
      return true;
    }
    if (request.method === 'POST' && path === '/skills') {
      sendJson(response, 200, await runtime.platform.createSkill(await readJsonBody(request)));
      return true;
    }
    if (segments[0] === 'skills' && segments[1] && segments.length === 2 && request.method === 'GET') {
      sendJson(response, 200, await runtime.platform.getSkill(segments[1]));
      return true;
    }
    if (segments[0] === 'skills' && segments[1] && segments.length === 2 && request.method === 'PUT') {
      sendJson(response, 200, await runtime.platform.updateSkill(segments[1], await readJsonBody(request)));
      return true;
    }
    if (segments[0] === 'skills' && segments[1] && segments.length === 2 && request.method === 'DELETE') {
      sendJson(response, 200, await runtime.platform.deleteSkill(segments[1]));
      return true;
    }
    if (segments[0] === 'skills' && segments[1] && segments[2] === 'status' && request.method === 'GET') {
      sendJson(response, 200, await runtime.platform.getSkill(segments[1]));
      return true;
    }
    if (segments[0] === 'skills' && segments[1] && segments[2] === 'duplicate' && request.method === 'POST') {
      sendJson(response, 200, await runtime.platform.duplicateSkill(segments[1], await readJsonBody(request)));
      return true;
    }
    if (request.method === 'POST' && path === '/skills/refresh') {
      sendJson(response, 200, await runtime.platform.refreshSkills());
      return true;
    }
    if (request.method === 'POST' && path === '/skills/import') {
      sendJson(response, 200, await runtime.platform.importSkill(await readJsonBody(request)));
      return true;
    }
    if (request.method === 'POST' && path === '/skills/import-marketplace') {
      sendJson(response, 200, await runtime.platform.importMarketplaceSkills(await readJsonBody(request)));
      return true;
    }

    if (request.method === 'GET' && path === '/mcp') {
      sendJson(response, 200, await runtime.platform.listMcpServers());
      return true;
    }
    if (segments[0] === 'mcp' && segments[1]) {
      const serverId = segments[1];
      if (request.method === 'GET' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.getMcpServer(serverId));
        return true;
      }
      if (request.method === 'PUT' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.upsertMcpServer({
          ...(await readJsonBody<McpServerDefinition>(request)),
          id: serverId
        }));
        return true;
      }
      if (request.method === 'DELETE' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.deleteMcpServer(serverId));
        return true;
      }
      if (request.method === 'POST' && segments[2] === 'test') {
        sendJson(response, 200, await runtime.platform.testMcpServer(serverId));
        return true;
      }
    }

    if (request.method === 'GET' && path === '/channels') {
      sendJson(response, 200, await runtime.platform.listChannels());
      return true;
    }
    if (request.method === 'POST' && path === '/channels') {
      sendJson(response, 200, await runtime.platform.upsertChannel(await readJsonBody(request)));
      return true;
    }
    if (segments[0] === 'channels' && segments[1]) {
      const channelId = segments[1];
      if (request.method === 'GET' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.getChannel(channelId));
        return true;
      }
      if (request.method === 'PUT' && segments.length === 2) {
        const body = await readJsonBody<Record<string, unknown>>(request);
        sendJson(response, 200, await runtime.platform.upsertChannel({
          ...body,
          channelId
        } as Parameters<typeof runtime.platform.upsertChannel>[0]));
        return true;
      }
      if (request.method === 'DELETE' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.deleteChannel(channelId));
        return true;
      }
      if (request.method === 'POST' && segments[2] === 'test') {
        sendJson(response, 200, await runtime.platform.testChannel(channelId));
        return true;
      }
    }

    if (request.method === 'GET' && path === '/schedules') {
      sendJson(response, 200, await runtime.platform.listSchedules());
      return true;
    }
    if (request.method === 'POST' && path === '/schedules') {
      sendJson(response, 200, await runtime.platform.upsertSchedule(await readJsonBody(request)));
      return true;
    }
    if (segments[0] === 'schedules' && segments[1]) {
      const scheduleId = segments[1];
      if (request.method === 'GET' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.getSchedule(scheduleId));
        return true;
      }
      if (request.method === 'PUT' && segments.length === 2) {
        const body = await readJsonBody<Record<string, unknown>>(request);
        sendJson(response, 200, await runtime.platform.upsertSchedule({
          ...body,
          scheduleId
        } as Parameters<typeof runtime.platform.upsertSchedule>[0]));
        return true;
      }
      if (request.method === 'DELETE' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.deleteSchedule(scheduleId));
        return true;
      }
      if (request.method === 'POST' && segments[2] === 'pause') {
        sendJson(response, 200, await runtime.platform.pauseSchedule(scheduleId));
        return true;
      }
      if (request.method === 'POST' && segments[2] === 'resume') {
        sendJson(response, 200, await runtime.platform.resumeSchedule(scheduleId));
        return true;
      }
    }

    if (request.method === 'GET' && path === '/memories') {
      sendJson(response, 200, await runtime.platform.searchMemories(url.searchParams.get('q') ?? ''));
      return true;
    }
    if (request.method === 'POST' && path === '/memories') {
      sendJson(response, 200, await runtime.platform.upsertMemory(await readJsonBody(request)));
      return true;
    }
    if (segments[0] === 'memories' && segments[1]) {
      const memoryId = segments[1];
      if (request.method === 'GET' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.getMemory(memoryId));
        return true;
      }
      if (request.method === 'PUT' && segments.length === 2) {
        const body = await readJsonBody<Record<string, unknown>>(request);
        sendJson(response, 200, await runtime.platform.upsertMemory({
          ...body,
          memoryId
        } as Parameters<typeof runtime.platform.upsertMemory>[0]));
        return true;
      }
      if (request.method === 'DELETE' && segments.length === 2) {
        sendJson(response, 200, await runtime.platform.deleteMemory(memoryId));
        return true;
      }
    }

    if (
      request.method === 'GET'
      && segments[0] === 'platform'
      && segments[1] === 'audit'
      && segments[2]
      && segments[3]
    ) {
      sendJson(
        response,
        200,
        await runtime.platform.getAuditTrail(segments[2].toUpperCase() as Parameters<typeof runtime.platform.getAuditTrail>[0], segments[3])
      );
      return true;
    }

    return false;
  }
};
