import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentDataRuntime } from './runtime';
import { AgentDataClient } from './client';
import { PermissionManager } from '../app/permissionManager';
import memory from '../../../extensions/memory/index';
import { MemoryClient } from '../../../extensions/memory/client';
import { __resetForTest } from '../../../extensions/_shared/runtime-config';

type MemoryTool = Parameters<Parameters<typeof memory>[0]['registerTool']>[0];
type ToolContext = Parameters<MemoryTool['execute']>[4];
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
  const permissions = new PermissionManager({ dataDir: directory });
  const runtime = new AgentDataRuntime({
    dataPath: join(directory, 'agent-data.db'),
    layerSchedule: { delayMs: 0, minIntervalMs: 0 },
    methods: { 'permission.authorize': (params) => permissions.authorize(params.operation as { kind: string }, String(params.profile)) },
    executeServiceTask: async (task) => {
      if (task.kind === 'memory_scene') {
        return { scenes: [{ filename: 'Preferences.md', action: 'write', content: 'global dark preference' }] };
      }
      if (task.kind === 'memory_persona') return { content: '# Team Operating Doctrine\n- 先对齐协议再落库' };
      return { l1: [{ content: 'prefer dark', type: 'work_fact', priority: 80 }] };
    },
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
  const ctx = { cwd: workspace, model: { id: 'fixture' }, modelRegistry: { complete: vi.fn() }, sessionManager: { getSessionId: () => 's1', getBranch: () => [{ type: 'message', message: { role: 'user', content: 'prefer dark theme' } }] } } as unknown as ToolContext;
  return { directory, workspace, runtime, client, ctx };
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

  it('captures through the real memory hook and retrieves layered memory and original conversations separately', async () => {
    const { workspace, ctx, client } = await fixture();
    const tools: Record<string, MemoryTool> = {};
    const events: Record<string, (event: unknown, context: unknown) => Promise<unknown>> = {};
    memory({ registerTool: (tool: MemoryTool) => { tools[tool.name] = tool; }, on: (name: string, handler: typeof events[string]) => { events[name] = handler; } } as never);
    await events.agent_end({ messages: [] }, ctx);
    await expect.poll(() => client.request('memory.search', { workspace, userId: 'local', query: 'dark' })).toEqual([
      expect.objectContaining({ content: expect.stringContaining('dark') }),
      expect.objectContaining({ content: expect.stringContaining('dark') }),
    ]);
    const conversation = await tools.conversation_search.execute('search', { query: 'prefer dark' }, undefined, undefined, ctx);
    expect(conversation.details).toEqual([expect.objectContaining({ sessionId: 's1', workspace, snippet: expect.stringContaining('prefer dark theme') })]);
    expect(await events.before_agent_start({ prompt: 'dark' }, ctx)).toMatchObject({ message: { customType: 'memory', display: false, content: expect.stringContaining('dark') } });
    // pi 1.2+: runs started by a triggerTurn custom message carry no prompt and get no memory.
    await expect(events.before_agent_start({ messageType: 'custom', message: { role: 'custom', customType: 'job-done', content: 'x' } }, ctx)).resolves.toBeUndefined();
    await expect(client.request('memory.conversations.search', { userId: 'local', workspace: '/other', query: 'dark' })).resolves.toEqual([]);
  });
});
