import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import type { ManagedMemoryRecord, MemoryConversation, MemoryDraft, MemoryPage } from './memoryContracts';

describe('Memory trusted management entry', () => {
  it('validates project owners and reports user isolation and CAS failures with stable IPC prefixes', async () => {
    const validateProject = vi.fn(async (path: string) => {
      if (path !== '/real') throw new Error('PROJECT_NOT_DIRECTORY');
      return '/real';
    });
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', validateProject });
    const client = new AgentDataClient(await runtime.start());
    try {
      const draft: MemoryDraft = { level: 1, content: 'manual knowledge', owner: { scope: 'project', projectId: '/real' } };
      const made = await runtime.requestAdmin<ManagedMemoryRecord>('memory.create', { userId: 'u', draft });
      expect(validateProject).toHaveBeenCalledExactlyOnceWith('/real');
      expect(made).toMatchObject({ revision: 1, origin: 'manual', sourceProjectId: '/real', sourceWorkspace: '/real' });
      await expect(runtime.requestAdmin('memory.read', { userId: 'other', id: made.id })).rejects.toThrow('NOT_FOUND: memory not found');
      await expect(runtime.requestAdmin('memory.update', { userId: 'u', id: made.id, expectedRevision: 0, draft })).rejects.toThrow('VERSION_CONFLICT: memory version conflict');
      await expect(runtime.requestAdmin('memory.create', { userId: 'u', draft: { ...draft, owner: { scope: 'project', projectId: '/missing' } } })).rejects.toThrow('PROJECT_NOT_DIRECTORY');
      await expect(client.request('memory.search', { userId: 'u', workspace: '/else', query: 'knowledge' })).resolves.toEqual([]);
      await expect(client.request('memory.search', { userId: 'u', workspace: '/real', query: 'knowledge' })).resolves.toHaveLength(1);
    } finally { await client.close(); runtime.close(); await runtime.waitClosed(); }
  });

  it('never exposes new management methods to either root or project socket payloads', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const root = new AgentDataClient(await runtime.start()), project = new AgentDataClient(runtime.agentEndpoint('/real'));
    try {
      for (const client of [root, project]) for (const name of ['list', 'read', 'create', 'update', 'conversations.list', 'conversations.read']) {
        await expect(client.request(`memory.${name}`, { userId: 'u', id: 'x', filter: { scope: 'all' }, admin: true, includeOtherProjects: true, context: { kind: 'admin' } })).rejects.toMatchObject({ code: 'METHOD_NOT_FOUND' });
      }
    } finally { await project.close(); await root.close(); runtime.close(); }
  });

  it('browses captures separately and never queues extraction for manual CRUD or removes source transcripts', async () => {
    const execute = vi.fn(async () => ({ l1: { unexpected: true } }));
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', executeServiceTask: execute });
    const client = new AgentDataClient(await runtime.start());
    try {
      await client.request('memory.capture', { userId: 'u', workspace: '/real', sessionId: 's', source: 'session:s', transcript: 'user: untouched transcript', fingerprint: 'fp', extract: false });
      const input = { userId: 'u', filter: { scope: 'all' } };
      const captures = await runtime.requestAdmin<MemoryPage<MemoryConversation>>('memory.conversations.list', input);
      expect(captures.items).toHaveLength(1); expect(captures.items[0]).not.toHaveProperty('transcript');
      await expect(runtime.requestAdmin('memory.conversations.read', { userId: 'u', id: captures.items[0].id })).resolves.toMatchObject({ transcript: 'user: untouched transcript' });
      await expect(runtime.requestAdmin('memory.conversations.read', { userId: 'other', id: captures.items[0].id })).rejects.toThrow('NOT_FOUND');
      const made = await runtime.requestAdmin<ManagedMemoryRecord>('memory.create', { userId: 'u', draft: { level: 2, content: 'global text', owner: { scope: 'global' } } });
      const updated = await runtime.requestAdmin<ManagedMemoryRecord>('memory.update', { userId: 'u', id: made.id, expectedRevision: 1, draft: { level: 2, content: 'global updated', owner: { scope: 'global' } } });
      expect(updated.id).toBe(made.id);
      await runtime.requestAdmin('memory.delete', { userId: 'other', id: made.id });
      await expect(runtime.requestAdmin('memory.read', { userId: 'u', id: made.id })).resolves.toMatchObject({ revision: 2 });
      await runtime.requestAdmin('memory.delete', { userId: 'u', id: made.id });
      await expect(runtime.requestAdmin('memory.list', input)).resolves.toEqual({ items: [] });
      await expect(runtime.requestAdmin('memory.conversations.list', input)).resolves.toMatchObject({ items: [expect.objectContaining({ id: captures.items[0].id })] });
      expect(execute).not.toHaveBeenCalled();
    } finally { await client.close(); runtime.close(); await runtime.waitClosed(); }
  });

  it('rechecks the captured revision after asynchronous ownership validation', async () => {
    let release!: (path: string) => void;
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', validateProject: (path) => path === '/later' ? new Promise((resolve) => { release = resolve; }) : Promise.resolve(path) });
    await runtime.start();
    try {
      const draft: MemoryDraft = { content: 'original', level: 1, owner: { scope: 'global' } };
      const original = await runtime.requestAdmin<ManagedMemoryRecord>('memory.create', { userId: 'u', draft });
      const moving = runtime.requestAdmin('memory.update', { userId: 'u', id: original.id, expectedRevision: 1, draft: { ...draft, owner: { scope: 'project', projectId: '/later' } } });
      const conflict = expect(moving).rejects.toThrow('VERSION_CONFLICT');
      await runtime.requestAdmin('memory.update', { userId: 'u', id: original.id, expectedRevision: 1, draft: { ...draft, content: 'new human edit' } });
      release('/later'); await conflict;
      await expect(runtime.requestAdmin('memory.read', { userId: 'u', id: original.id })).resolves.toMatchObject({ content: 'new human edit', scope: 'global', revision: 2 });
    } finally { runtime.close(); await runtime.waitClosed(); }
  });

  it('rejects malformed management parameters without inserting or editing a record', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' }); await runtime.start();
    try {
      const draft = { content: 'x', level: 1, owner: { scope: 'global' } };
      for (const input of [{ draft }, { userId: 'u', draft: { ...draft, owner: undefined } }, { userId: 'u', draft: { ...draft, level: 4 } }, { userId: 'u', draft: { ...draft, content: '' } }]) {
        await expect(runtime.requestAdmin('memory.create', input)).rejects.toThrow('INVALID_PARAMS');
      }
      await expect(runtime.requestAdmin('memory.list', { userId: 'u' })).rejects.toThrow('INVALID_PARAMS');
      await expect(runtime.requestAdmin('memory.list', { userId: 'u', filter: { scope: 'all' } })).resolves.toEqual({ items: [] });
    } finally { runtime.close(); }
  });
});
