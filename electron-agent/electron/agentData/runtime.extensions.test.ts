import { describe, expect, it, vi } from 'vitest';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { AgentDataStorage } from './storage';
import { MemoryStore } from './memoryStore';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('AgentData extension RPC contracts', () => {
  it('continues durable newer input after a recovered extraction task fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-data-recovery-'));
    const dataPath = join(directory, 'agent-data.db');
    const storage = new AgentDataStorage(dataPath);
    storage.migrate();
    const scope = { userId: 'local', workspace: '/repo', projectId: '/repo', sessionId: 's1' };
    const store = new MemoryStore(storage.db);
    store.capture(scope, 'session:s1', 'user: first', 'fp1');
    store.capture(scope, 'session:s1', 'user: first\nuser: second', 'fp2');
    storage.db.prepare('INSERT INTO service_tasks(id,kind,source_project_id,source_session_id,is_system,status,input,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('recovered', 'memory_extract', '/repo', 's1', 1, 'running', JSON.stringify({ ...scope, source: 'session:s1', delta: 'user: first', fingerprint: 'fp1' }), 1, 1, 1);
    storage.close();
    const inputs: unknown[] = [];
    const runtime = new AgentDataRuntime({ dataPath, executeServiceTask: async (task) => {
      inputs.push(task.input);
      if (task.id === 'recovered') throw new Error('previous attempt failed');
      return { l1: [{ content: 'recovery completed', type: 'work_fact', priority: 80 }] };
    } });
    const client = new AgentDataClient(await runtime.start());
    try {
      await expect.poll(() => client.request('memory.search', { ...scope, query: 'recovery' })).toEqual([
        expect.objectContaining({ content: expect.stringContaining('recovery') }),
      ]);
      expect(inputs).toEqual([
        expect.objectContaining({ delta: 'user: first', fingerprint: 'fp1' }),
        expect.objectContaining({ delta: 'user: first\nuser: second', fingerprint: 'fp2' }),
      ]);
      await expect(client.request('memory.capture', { ...scope, source: 'session:s1', transcript: 'user: first\nuser: second', fingerprint: 'fp2' })).resolves.toMatchObject({ changed: false });
    } finally {
      await client.close(); runtime.close(); await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns a compact capture receipt while preserving the full stored conversation', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      const transcript = `beginmarker ${'x'.repeat(70_000)} endmarker`;
      const scope = { userId: 'local', workspace: '/repo', sessionId: 'long', source: 'session:long' };
      const receipt = await client.request<{ changed: boolean; delta: string }>('memory.capture', { ...scope, transcript, fingerprint: 'long', extract: false });
      expect(receipt.changed).toBe(true);
      expect(receipt.delta.length).toBe(0);
      await expect(client.request('memory.conversations.search', { ...scope, query: 'beginmarker' })).resolves.toHaveLength(1);
      await expect(client.request('memory.conversations.search', { ...scope, query: 'endmarker' })).resolves.toHaveLength(1);
    } finally { await client.close(); runtime.close(); }
  });

  it('assembles a request larger than one RPC frame before dispatching it', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', methods: { 'test.length': (params) => String(params.text).length } });
    const client = new AgentDataClient(await runtime.start());
    try {
      const text = '中文-content '.repeat(100_000);
      await expect(client.request('test.length', { text })).resolves.toBe(text.length);
    } finally { await client.close(); runtime.close(); }
  });

  it('captures conversations without extraction and searches only the current project', async () => {
    const execute = vi.fn(async () => ({ l1: { fact: 'generated' } }));
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', executeServiceTask: execute });
    const client = new AgentDataClient(await runtime.start());
    try {
      const scope = { userId: 'local', workspace: '/repo', sessionId: 'session-1', source: 'session:session-1' };
      const captured = await client.request('memory.capture', { ...scope, transcript: 'user: conversation-only-keyword', fingerprint: 'first', extract: false });
      expect(captured).not.toHaveProperty('taskId');
      expect(execute).not.toHaveBeenCalled();
      await client.request('memory.capture', { ...scope, workspace: '/other', transcript: 'user: conversation-only-keyword private', fingerprint: 'other', extract: false });

      await expect(client.request('memory.conversations.search', { ...scope, query: 'conversation-only-keyword' })).resolves.toEqual([
        expect.objectContaining({ workspace: '/repo', sessionId: 'session-1', snippet: expect.stringContaining('conversation-only-keyword') }),
      ]);
      await expect(client.request('memory.search', { ...scope, query: 'conversation-only-keyword' })).resolves.toEqual([]);
      await expect(client.request('memory.conversations.search', { ...scope, userId: 'other-user', query: 'conversation-only-keyword' })).resolves.toEqual([]);
    } finally {
      await client.close();
      runtime.close();
    }
  });

  it('forwards supported CodeGraph calls without losing the raw MCP payload', async () => {
    const raw = { content: [{ type: 'text', text: 'call graph result' }], structuredContent: { nodes: [{ name: 'parse' }] } };
    const call = vi.fn(async () => raw);
    const runtime = new AgentDataRuntime({ dataPath: ':memory:', codeRetrieval: {
      projects: () => [], status: () => ({}), search: async () => ({}), call,
    } });
    const client = new AgentDataClient(await runtime.start());
    try {
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_callers', args: { symbol: 'parse', limit: 5 } })).resolves.toEqual(raw);
      expect(call).toHaveBeenCalledWith('/repo', 'codegraph_callers', { symbol: 'parse', limit: 5 });
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_sync', args: {} })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_search', args: { query: 'parse', projectPath: '/other' } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(call).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      runtime.close();
    }
  });

  it('reports an unavailable CodeGraph provider instead of falling back to a local process', async () => {
    const runtime = new AgentDataRuntime({ dataPath: ':memory:' });
    const client = new AgentDataClient(await runtime.start());
    try {
      await expect(client.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_search', args: { query: 'parse' } })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    } finally {
      await client.close();
      runtime.close();
    }
  });
});
