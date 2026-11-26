import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { ModelRuntime, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionServices, type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { installActivation, markAnnounced, reapWaitingBash, disposeActivation, disposeResident } from '../../../extensions/multi-agent/activation.js';
import { waitForChildren } from '../../../extensions/multi-agent/wait-agent.js';
import { settlementMessage } from '../../../extensions/multi-agent/parent-host.js';
import { SubAgentRegistry } from '../../../extensions/multi-agent/registry.js';
import { createGrenBashTool } from '../../../extensions/sandbox/bashTool.js';
import { createSandboxedBashOperations } from '../../../extensions/_shared/sandbox/operations.js';
import { resolveBashShell } from '../../../extensions/_shared/sandbox/shellPath.js';
import { jobs } from '../../../extensions/jobs/service.js';
import { SubagentService } from './subagentService';

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

it.runIf(process.platform === 'win32')('settles an SDK reply and its actual Git Bash process tree as separate outcomes', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'gren-bash-drain-'));
  const owner = 'sa-drain';
  const parent = 'drain-parent';
  const registry = new SubAgentRegistry(join(cwd, '.pi', 'subagents', 'registry.db'));
  const service = new SubagentService();
  const notices: unknown[] = [];
  let args = '';
  let shell: Awaited<ReturnType<typeof resolveBashShell>>;
  let side: ChildProcess | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const hasResult = body.messages.some((message: { role: string }) => message.role === 'tool');
    const base = { id: 'drain', object: 'chat.completion.chunk', created: 1, model: 'drain' };
    const delta = hasResult ? { role: 'assistant', content: 'Final reply' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: 'call_bash', type: 'function', function: { name: 'bash', arguments: args } }],
    };
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
    res.end([
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: hasResult ? 'stop' : 'tool_calls' }] },
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  try {
    shell = await resolveBashShell(process.env.PI_TEST_GIT_BASH);
    side = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)'], { windowsHide: true, stdio: 'ignore' });
    await once(side, 'spawn');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    const modelsPath = join(cwd, 'models.json');
    await writeFile(modelsPath, JSON.stringify({ providers: { 'drain-fixture': {
      api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'fixture',
      models: [{ id: 'drain', input: ['text'], reasoning: false, contextWindow: 32000, maxTokens: 2048 }],
    } } }));
    const modelRuntime = await ModelRuntime.create({
      modelsPath, authPath: join(cwd, 'auth.json'), modelsStorePath: join(cwd, 'cache.json'), allowModelNetwork: false,
    });
    const operations = createSandboxedBashOperations({
      getPolicy: () => ({ mode: 'danger-full-access', workspaceRoot: cwd, network: 'enabled' }),
      resolveShell: () => shell,
      confine: async () => { throw new Error('unexpected sandbox request'); },
    });
    const register: ExtensionFactory = (pi) => {
      pi.registerTool(createGrenBashTool({ jobs, exec: operations.exec, tempDir: cwd }));
    };
    const services = await createAgentSessionServices({
      cwd, agentDir: cwd, modelRuntime,
      settingsManager: SettingsManager.inMemory({ cacheWarming: 'off', compaction: { enabled: false } }),
      resourceLoaderOptions: { extensionFactories: [register], noExtensions: true, noContextFiles: true, noSkills: true, noPromptTemplates: true },
    });
    for (const progressing of [false, true]) {
      notices.length = 0;
      const id = `${owner}-${progressing ? 'active' : 'stale'}`;
      const manager = SessionManager.create(cwd, join(cwd, 'sessions'), { id });
      const { session } = await createAgentSessionFromServices({
        services, sessionManager: manager, model: modelRuntime.getModel('drain-fixture', 'drain'), noTools: 'builtin',
      });
      await session.bindExtensions({ mode: 'rpc' });
      registry.create({ id, task: 'probe', parentId: parent });
      installActivation({
        childId: id, parentSessionId: parent, parentSessionPath: 'fixture-parent.jsonl', sessionPath: manager.getSessionFile()!,
        workspace: cwd, session, keepResident: true,
        onBashPhase: (state, reply) => registry.setBashPhase(id, state, reply),
        onSettled: (result) => registry.finish(id, {
          status: result.stopReason === 'completed' ? 'done' : 'error', output: result.output, bashState: result.bashTimeout,
        }),
        deliverFallback: (notice) => notices.push(settlementMessage(notice)),
      });
      args = JSON.stringify({ run_in_background: true, command: progressing
        ? 'for i in 1 2 3 4 5 6 7 8 9 10; do echo "$i"; sleep 0.16; done'
        : 'sleep 15 & kid=$!; ps -p "$$" | tail -1; ps -p "$kid" | tail -1; wait "$kid"' });
      const prompt = session.prompt('Run the fixture command');
      markAnnounced(id);
      const waited = waitForChildren(parent, { timeoutMs: 12_000 });
      try {
        await prompt;
        await vi.waitFor(() => expect(service.list(cwd).find((row) => row.id === id)).toMatchObject({
          status: 'running', output: 'Final reply', bashState: { phase: 'waiting-for-bash' },
        }));
        expect(notices).toEqual([]);
        const [job] = jobs.list(id);
        expect(job?.status).toBe('running');
        if (!job) throw new Error('fixture job missing');
        if (progressing) {
          const timer = setInterval(() => reapWaitingBash(id, 600), 100);
          try {
            expect((await waited).settled).toEqual([{ childId: id, parentSessionId: parent, stopReason: 'completed' }]);
            expect(service.list(cwd).find((row) => row.id === id)).toMatchObject({ status: 'done', output: 'Final reply' });
          } finally { clearInterval(timer); }
        } else {
          let pids: number[] = [];
          await vi.waitFor(() => {
            const read = jobs.readAt(job.id, 0, id).chunks.map((chunk) => chunk.text).join('');
            pids = read.trim().split(/\r?\n/).map((line) => Number(line.trim().split(/\s+/)[3])).filter(Boolean);
            expect(pids).toHaveLength(2);
          });
          expect(pids.every(alive)).toBe(true);
          await new Promise((resolve) => setTimeout(resolve, 650));
          expect(reapWaitingBash(id, 500)).toBe(true);
          expect((await waited).settled).toEqual([{ childId: id, parentSessionId: parent, stopReason: 'error', reason: 'background-bash-timeout' }]);
          expect(pids.some(alive)).toBe(false);
          expect(alive(side.pid!)).toBe(true);
          const row = service.list(cwd).find((row) => row.id === id);
          expect(row).toMatchObject({ status: 'error', output: 'Final reply', bashState: {
            reason: 'background-bash-timeout', jobs: [{ id: job.id, stopConfirmed: true }],
          } });
          expect(notices).toEqual([expect.objectContaining({ details: expect.objectContaining({ reply: row?.output, bashTimeout: row?.bashState }) })]);
        }
      } finally {
        await disposeActivation(id, 'rollback');
        try { await jobs.detachOwner(id); } finally { disposeResident(id); }
      }
    }
  } finally {
    if (side && side.exitCode === null) {
      const closed = once(side, 'close');
      side.kill();
      await closed;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    registry.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);
