import {
  CliCommandModule,
  HealthResponse,
  ReadinessResponse,
  requestJson,
  writeJson
} from '../shared';

export const coreCommandModule: CliCommandModule = {
  group: 'core',
  usage: [
    'health',
    'ready',
    'memory profile'
  ],
  async handle(action, rest, context) {
    const { fetchImpl, io, serverUrl } = context;
    if (action === 'health') {
      writeJson(io, await requestJson<HealthResponse>(fetchImpl, `${serverUrl}/health`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'ready') {
      writeJson(io, await requestJson<ReadinessResponse>(fetchImpl, `${serverUrl}/ready`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'memory-profile' || (action === 'memory' && rest[0] === 'profile')) {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memory/profile`, { method: 'GET', headers: {} }));
      return 0;
    }
    return null;
  }
};
