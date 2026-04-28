import {
  CliCommandModule,
  QueueActiveResponse,
  QueueDeadLetterResponse,
  QueueRecoverExpiredResponse,
  QueueRequeueResponse,
  requestJson,
  writeJson
} from '../shared';

export const queueCommandModule: CliCommandModule = {
  group: 'queue',
  usage: [
    'queue active|dead-letters|recover-expired|requeue <taskId>'
  ],
  async handle(action, rest, context) {
    const { fetchImpl, io, serverUrl } = context;
    if (action === 'active') {
      writeJson(io, await requestJson<QueueActiveResponse>(fetchImpl, `${serverUrl}/queue/active`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'dead-letters') {
      writeJson(io, await requestJson<QueueDeadLetterResponse>(fetchImpl, `${serverUrl}/queue/dead-letters`, { method: 'GET', headers: {} }));
      return 0;
    }
    if (action === 'recover-expired') {
      writeJson(io, await requestJson<QueueRecoverExpiredResponse>(fetchImpl, `${serverUrl}/queue/recover-expired`, {
        method: 'POST',
        body: JSON.stringify({})
      }));
      return 0;
    }
    if (action === 'requeue') {
      writeJson(io, await requestJson<QueueRequeueResponse>(fetchImpl, `${serverUrl}/queue/dead-letters/${rest[0]}/requeue`, {
        method: 'POST',
        body: JSON.stringify({})
      }));
      return 0;
    }
    return null;
  }
};
