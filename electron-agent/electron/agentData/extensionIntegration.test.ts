import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { WikiFiles } from './wikiFiles';
import type { WikiLibraryView } from './wikiContracts';
import { PermissionManager } from '../app/permissionManager';
import wikiRag from '../../../extensions/wiki-rag/index';
import memory from '../../../extensions/memory/index';
import { MemoryClient } from '../../../extensions/memory/client';
import { __resetForTest } from '../../../extensions/_shared/runtime-config';

type WikiTool = Parameters<Parameters<typeof wikiRag>[0]['registerTool']>[0];
type ToolContext = Parameters<WikiTool['execute']>[4];
type Page = { workspace: string; page: string; title: string; content: string; sourcePath: string; sources: string[]; path: string };
const directories: string[] = [];
const runtimes: AgentDataRuntime[] = [];
const clients: AgentDataClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  runtimes.splice(0).forEach((runtime) => runtime.close());
  vi.unstubAllEnvs();
  __resetForTest();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-data-integration-'));
  directories.push(directory);
  const workspace = join(directory, 'project');
  await mkdir(workspace);
  new WikiFiles(join(directory, 'wiki')).manifest(workspace, true);
  const permissions = new PermissionManager({ dataDir: directory });
  const runtime = new AgentDataRuntime({
    dataPath: join(directory, 'agent-data.db'),
    methods: { 'permission.authorize': (params) => permissions.authorize(params.operation as { kind: string }, String(params.profile)) },
    executeServiceTask: async () => ({ l1: { preference: 'dark' }, l2: 'global dark preference' }),
  });
  runtimes.push(runtime);
  await runtime.start();
  const endpoint = runtime.agentEndpoint(workspace);
  const client = new AgentDataClient(endpoint);
  clients.push(client);
  vi.stubEnv('PI_RUNTIME_CONFIG', '');
  vi.stubEnv('AGENT_DATA_ENDPOINT', JSON.stringify(endpoint));
  vi.stubEnv('PI_PERMISSION_PROFILE', 'workspace');
  vi.stubEnv('PI_IS_SUBAGENT', '0');
  vi.stubEnv('PI_SYSTEM_WORKER', '0');
  vi.stubEnv('MEMORY_AUTO_INJECT', '1');
  vi.stubEnv('MEMORY_AUTO_CAPTURE', '1');
  vi.stubEnv('MEMORY_EXTRACT', '1');
  __resetForTest();
  const complete = vi.fn(async () => ({ role: 'assistant', content: [{ type: 'text', text: '# Guide\nGenerated searchable knowledge' }], stopReason: 'stop' }));
  const ctx = { cwd: workspace, model: { id: 'fixture' }, modelRegistry: { complete }, sessionManager: { getSessionId: () => 's1', getBranch: () => [{ type: 'message', message: { role: 'user', content: 'prefer dark theme' } }] } } as unknown as ToolContext;
  const tools: Record<string, WikiTool> = {};
  wikiRag({ registerTool: (tool: WikiTool) => { tools[tool.name] = tool; } } as never);
  const [library] = await runtime.requestAdmin<WikiLibraryView[]>('wiki.libraries.list');
  return { directory, workspace, runtime, client, ctx, complete, tools, library };
}

describe('AgentData extension integration', () => {
  it('captures and searches both ends of a transcript larger than 1 MiB through the real runtime', async () => {
    const { workspace } = await fixture();
    const client = new MemoryClient(1000);
    const scope = { userId: 'local', workspace, projectId: workspace, sessionId: 'large-session' };
    const transcript = `user: first-transcript-marker\n${'x'.repeat(1_100_000)}\nassistant: last-transcript-marker`;
    await expect(client.request('memory.capture', { ...scope, source: 'session:large-session', transcript, fingerprint: 'large-fingerprint', extract: false })).resolves.toMatchObject({ changed: true, delta: '' });
    for (const marker of ['first-transcript-marker', 'last-transcript-marker']) {
      await expect(client.request('memory.conversations.search', { ...scope, query: marker })).resolves.toEqual([
        expect.objectContaining({ snippet: expect.stringContaining(marker) }),
      ]);
    }
    await expect(client.request('memory.conversations.search', { ...scope, userId: 'other-user', query: 'first-transcript-marker' })).resolves.toEqual([]);
  });

  it('generates real Markdown and source snapshots, reads them and rebuilds after edits without an LLM', async () => {
    const { workspace, directory, client, ctx, complete, tools, library } = await fixture();
    await writeFile(join(workspace, 'README.md'), '# Original source\nA durable explanation');
    const result = await tools.wiki_update.execute('update', { page: 'guide', sourcePath: 'README.md' }, undefined, undefined, ctx);
    expect(result.details).toEqual({ updated: true });
    const stored = await client.request<Page>('wiki.read', { workspace, page: 'guide' });
    expect(stored.path.startsWith(join(directory, 'wiki'))).toBe(true);
    expect(await readFile(stored.path, 'utf8')).toContain('Generated searchable knowledge');
    expect(stored.sources).toHaveLength(1);
    expect(await readFile(join(dirname(dirname(stored.path)), stored.sources[0]), 'utf8')).toBe('# Original source\nA durable explanation');
    expect((await tools.wiki_read.execute('read', { kbId: library.kbId, pageId: 'guide' }, undefined, undefined, ctx)).content).toEqual([{ type: 'text', text: stored.content }]);
    expect((await client.request<Page[]>('wiki.list', { workspace }))[0]).toMatchObject({ page: 'guide', path: stored.path });

    await writeFile(stored.path, (await readFile(stored.path, 'utf8')).replace('Generated searchable knowledge', 'Edited uniquephrase knowledge'));
    await tools.wiki_reindex.execute('reindex', {}, undefined, undefined, ctx);
    await expect(client.request('wiki.search', { workspace, query: 'uniquephrase' })).resolves.toHaveLength(1);
    expect(complete).toHaveBeenCalledTimes(1);

    await rm(stored.path);
    await tools.wiki_reindex.execute('reindex-again', {}, undefined, undefined, ctx);
    await expect(client.request('wiki.search', { workspace, query: 'uniquephrase' })).resolves.toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps Markdown searchable across runtime restarts and does not expose it to another workspace', async () => {
    const { workspace, directory, client, runtime } = await fixture();
    await client.request('wiki.replace', { workspace, page: 'guide.md', title: 'Guide', content: '# Durable\npersistentwiki' });
    await client.close(); runtime.close();
    const restarted = new AgentDataRuntime({ dataPath: join(directory, 'agent-data.db') });
    runtimes.push(restarted);
    await restarted.start();
    const reconnected = new AgentDataClient(restarted.agentEndpoint(workspace));
    clients.push(reconnected);
    await expect(reconnected.request('wiki.search', { workspace, query: 'persistentwiki' })).resolves.toHaveLength(1);
    await expect(reconnected.request('wiki.list', { workspace: join(directory, 'other') })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const other = new AgentDataClient(restarted.agentEndpoint(join(directory, 'other'))); clients.push(other);
    await expect(other.request('wiki.list')).resolves.toEqual([]);
    await expect(other.request('wiki.search', { query: 'persistentwiki' })).resolves.toEqual([]);
  });

  it('captures through the real memory hook and retrieves layered memory and original conversations separately', async () => {
    const { workspace, ctx, client } = await fixture();
    const tools: Record<string, WikiTool> = {};
    const events: Record<string, (event: unknown, context: unknown) => Promise<unknown>> = {};
    memory({ registerTool: (tool: WikiTool) => { tools[tool.name] = tool; }, on: (name: string, handler: typeof events[string]) => { events[name] = handler; } } as never);
    await events.agent_end({ messages: [] }, ctx);
    await expect.poll(() => client.request('memory.search', { workspace, userId: 'local', query: 'dark' })).toEqual([
      expect.objectContaining({ content: expect.stringContaining('dark') }),
      expect.objectContaining({ content: expect.stringContaining('dark') }),
    ]);
    const conversation = await tools.conversation_search.execute('search', { query: 'prefer dark' }, undefined, undefined, ctx);
    expect(conversation.details).toEqual([expect.objectContaining({ sessionId: 's1', workspace, snippet: expect.stringContaining('prefer dark theme') })]);
    expect(await events.before_agent_start({ prompt: 'dark' }, ctx)).toMatchObject({ message: { customType: 'memory', display: false, content: expect.stringContaining('dark') } });
    await expect(client.request('memory.conversations.search', { userId: 'local', workspace: '/other', query: 'dark' })).resolves.toEqual([]);
  });
});
