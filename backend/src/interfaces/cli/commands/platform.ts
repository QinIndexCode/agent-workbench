import { CliCommandModule, getFlagString, readJsonFile, requestJson, writeJson } from '../shared';

export const platformCommandModule: CliCommandModule = {
  group: 'platform',
  aliases: [
    'providers',
    'capabilities',
    'ecosystem',
    'tools',
    'skills',
    'mcp',
    'scenarios',
    'workspace',
    'improvements',
    'channels',
    'schedules',
    'memories',
    'config',
    'audit',
    'stats',
    'system'
  ],
  usage: [
    'providers list|presets|get|test|set-default|upsert|delete|secrets',
    'capabilities status',
    'ecosystem status',
    'tools list|health',
    'skills list|get|status|refresh|import|import-marketplace',
    'mcp list|status|get|test|upsert|delete',
    'scenarios list|status',
    'workspace status|init|commands list|docs import',
    'improvements list|get|approve|reject|archive|report',
    'channels list|get|create|update|delete|test',
    'schedules list|get|create|update|delete|pause|resume',
    'memories list|get|search|create|update|delete',
    'config get|set|reload|health',
    'audit <RESOURCE_TYPE> <RESOURCE_ID>',
    'stats get',
    'system startup|metrics'
  ],
  async handle(action, rest, context) {
    const { fetchImpl, io, serverUrl, args } = context;
    const resource = action;
    const subaction = rest[0];
    const id = rest[1];

    if (resource === 'providers') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'presets') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/presets`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'test') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/${id}/test`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'set-default') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/${id}/default`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'upsert') {
        const profile = readJsonFile(rest[1]);
        const providerId = getFlagString(args, 'id') ?? (profile as { id?: string }).id;
        if (!providerId) throw new Error('backend_new CLI error: provider upsert requires --id or JSON id.');
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/${providerId}`, { method: 'PUT', body: JSON.stringify(profile) }));
        return 0;
      }
      if (subaction === 'delete') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/${id}`, { method: 'DELETE', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'secrets') {
        if (id === 'set') {
          writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/secrets`, {
            method: 'POST',
            body: JSON.stringify({
              secretId: getFlagString(args, 'secret-id'),
              provider: getFlagString(args, 'provider'),
              label: getFlagString(args, 'label'),
              apiKey: getFlagString(args, 'api-key'),
              metadata: {}
            })
          }));
          return 0;
        }
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/providers/secrets`, { method: 'GET', headers: {} }));
        return 0;
      }
    }

    if (resource === 'capabilities') {
      if (!subaction || subaction === 'status' || subaction === 'list') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/capabilities`, { method: 'GET', headers: {} }));
        return 0;
      }
    }

    if (resource === 'ecosystem') {
      if (!subaction || subaction === 'status' || subaction === 'list') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/ecosystem`, { method: 'GET', headers: {} }));
        return 0;
      }
    }

    if (resource === 'tools') {
      if (subaction === 'health') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tools/health`, { method: 'GET', headers: {} }));
        return 0;
      }
      if (!subaction || subaction === 'list' || subaction === 'status') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tools`, { method: 'GET', headers: {} }));
        return 0;
      }
    }

    if (resource === 'skills') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/skills`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/skills/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (!subaction || (subaction === 'status' && !id)) { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/ecosystem/skills`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'status') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/skills/${id}/status`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'refresh') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/skills/refresh`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'import') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/skills/import`, {
          method: 'POST',
          body: JSON.stringify({
            id: getFlagString(args, 'id'),
            name: getFlagString(args, 'name'),
            rootDir: getFlagString(args, 'root'),
            description: getFlagString(args, 'description')
          })
        }));
        return 0;
      }
      if (subaction === 'import-marketplace') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/skills/import-marketplace`, {
          method: 'POST',
          body: JSON.stringify({
            marketplaceFile: getFlagString(args, 'marketplace'),
            pluginName: getFlagString(args, 'plugin'),
            skillPath: getFlagString(args, 'skill')
          })
        }));
        return 0;
      }
    }

    if (resource === 'mcp') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/mcp`, { method: 'GET', headers: {} })); return 0; }
      if (!subaction || (subaction === 'status' && !id)) { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/ecosystem/mcp`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/mcp/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'test') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/mcp/${id}/test`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'upsert') {
        const definition = readJsonFile(rest[1]);
        const serverId = getFlagString(args, 'id') ?? (definition as { id?: string }).id;
        if (!serverId) throw new Error('backend_new CLI error: mcp upsert requires --id or JSON id.');
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/mcp/${serverId}`, { method: 'PUT', body: JSON.stringify(definition) }));
        return 0;
      }
      if (subaction === 'delete') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/mcp/${id}`, { method: 'DELETE', body: JSON.stringify({}) })); return 0; }
    }

    if (resource === 'scripts') {
      if (!subaction || subaction === 'list' || subaction === 'status') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/tools/script-catalog`, { method: 'GET', headers: {} }));
        return 0;
      }
    }

    if (resource === 'workspace') {
      if (subaction === 'status') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/workspace/workflow`, { method: 'GET', headers: {} }));
        return 0;
      }
      if (subaction === 'init') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/workspace/workflow/init`, { method: 'POST', body: JSON.stringify({}) }));
        return 0;
      }
      if (subaction === 'commands' && id === 'list') {
        const workflow = await requestJson<Record<string, unknown>>(fetchImpl, `${serverUrl}/workspace/workflow`, { method: 'GET', headers: {} });
        writeJson(io, Array.isArray(workflow.commands) ? workflow.commands : []);
        return 0;
      }
      if (subaction === 'docs' && id === 'import') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/workspace/workflow/docs/import`, { method: 'POST', body: JSON.stringify({}) }));
        return 0;
      }
    }

    if (resource === 'improvements') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/improvements/proposals`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/improvements/proposals/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'approve') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/improvements/proposals/${id}/approve`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'reject') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/improvements/proposals/${id}/reject`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'archive') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/improvements/archive`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'report') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/improvements/report`, { method: 'GET', headers: {} })); return 0; }
    }

    if (resource === 'channels') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/channels`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/channels/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'create') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/channels`, { method: 'POST', body: JSON.stringify(readJsonFile(rest[1])) }));
        return 0;
      }
      if (subaction === 'update') {
        writeJson(io, await requestJson(fetchImpl, `${serverUrl}/channels/${id}`, { method: 'PUT', body: JSON.stringify(readJsonFile(rest[2])) }));
        return 0;
      }
      if (subaction === 'delete') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/channels/${id}`, { method: 'DELETE', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'test') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/channels/${id}/test`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
    }

    if (resource === 'schedules') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'create') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules`, { method: 'POST', body: JSON.stringify(readJsonFile(rest[1])) })); return 0; }
      if (subaction === 'update') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules/${id}`, { method: 'PUT', body: JSON.stringify(readJsonFile(rest[2])) })); return 0; }
      if (subaction === 'delete') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules/${id}`, { method: 'DELETE', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'pause') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules/${id}/pause`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'resume') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/schedules/${id}/resume`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
    }

    if (resource === 'memories') {
      if (subaction === 'list') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memories`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'search') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memories?q=${encodeURIComponent(rest[1] ?? '')}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memories/${id}`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'create') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memories`, { method: 'POST', body: JSON.stringify(readJsonFile(rest[1])) })); return 0; }
      if (subaction === 'update') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memories/${id}`, { method: 'PUT', body: JSON.stringify(readJsonFile(rest[2])) })); return 0; }
      if (subaction === 'delete') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/memories/${id}`, { method: 'DELETE', body: JSON.stringify({}) })); return 0; }
    }

    if (resource === 'config') {
      if (subaction === 'get') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/config`, { method: 'GET', headers: {} })); return 0; }
      if (subaction === 'set') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/config`, { method: 'PATCH', body: JSON.stringify(readJsonFile(rest[1])) })); return 0; }
      if (subaction === 'reload') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/config/reload`, { method: 'POST', body: JSON.stringify({}) })); return 0; }
      if (subaction === 'health') { writeJson(io, await requestJson(fetchImpl, `${serverUrl}/config/health`, { method: 'GET', headers: {} })); return 0; }
    }

    if (resource === 'audit') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/platform/audit/${encodeURIComponent(subaction ?? '')}/${encodeURIComponent(id ?? '')}`, { method: 'GET', headers: {} }));
      return 0;
    }

    if (resource === 'stats' && subaction === 'get') {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/statistics`, { method: 'GET', headers: {} }));
      return 0;
    }

    if (resource === 'system' && (subaction === 'startup' || subaction === 'metrics')) {
      writeJson(io, await requestJson(fetchImpl, `${serverUrl}/system/${subaction}`, { method: 'GET', headers: {} }));
      return 0;
    }

    return null;
  }
};
