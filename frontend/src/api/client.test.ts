import { describe, expect, it, vi } from 'vitest';
import { api } from './client';

function mockJsonFetch(payload: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('api governance contracts', () => {
  it('posts skill bulk-delete requests to the governance endpoint', async () => {
    const fetchMock = mockJsonFetch({
      resourceType: 'SKILL',
      resourceId: 'bulk',
      action: 'DELETE',
      commandId: 'cmd-1',
      auditId: 'audit-1',
      appliedAt: 1,
      resource: {
        requestedIds: ['skill-a', 'skill-b'],
        deletedIds: ['skill-a'],
        failed: [{ id: 'skill-b', error: 'not deletable' }],
      },
    });

    const result = await api.bulkDeleteSkills(['skill-a', 'skill-b']);

    expect(result.resource.deletedIds).toEqual(['skill-a']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3011/skills/bulk-delete',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ skillIds: ['skill-a', 'skill-b'] }),
      }),
    );
  });

  it('requests experience markdown exports without mutating records', async () => {
    const fetchMock = mockJsonFetch({
      generatedAt: 1777740000000,
      format: 'markdown',
      records: [],
      content: '# Experience Export\n',
    });

    const result = await api.exportExperiences('markdown');

    expect(result.content).toContain('Experience Export');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3011/experience/export?format=markdown',
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  it('sends running-task guidance through the guidance endpoint', async () => {
    const fetchMock = mockJsonFetch({
      task: { id: 'task-1' },
      action: { type: 'guidance' },
    });

    await api.sendGuidance('task-1', 'Add a stricter acceptance check.', {
      reason: 'operator redirect',
      metadata: { source: 'test' },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3011/tasks/task-1/guidance',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          content: 'Add a stricter acceptance check.',
          reason: 'operator redirect',
          metadata: { source: 'test' },
        }),
      }),
    );
  });

  it('keeps restart available in the API client for non-discussion diagnostics', async () => {
    const fetchMock = mockJsonFetch({
      task: { id: 'task-1' },
      action: { type: 'restart' },
    });

    await api.restartTask('task-1', 'diagnostic rerun');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3011/tasks/task-1/restart',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          userMessage: 'diagnostic rerun',
        }),
      }),
    );
  });
});
