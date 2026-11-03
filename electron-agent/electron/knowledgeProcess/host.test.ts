import { describe, expect, it, vi } from 'vitest';
import { KnowledgeWorkerHost } from './host';

describe('knowledge project scan cancellation', () => {
  it('aborts an active prepare and waits for its cleanup', async () => {
    const host = new KnowledgeWorkerHost({ engine: {} } as any, async () => ({}));
    let aborted = false, cleanup!: () => void;
    const held = new Promise<void>(resolve => { cleanup = resolve; });
    (host as any).projects.prepare = vi.fn(async (_id: string, _domain: string, signal: AbortSignal) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      await held; throw new Error('aborted');
    });
    const preparing = host.invoke('project.prepare', { projectId: 'p', domain: 'wiki', requestId: 'scan' }).catch(() => undefined);
    const abort = host.invoke('project.abortPrepare', { requestId: 'scan' });
    await vi.waitFor(() => expect(aborted).toBe(true));
    let done = false; void abort.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
    cleanup(); await Promise.all([preparing, abort]); expect(done).toBe(true);
  });

  it('does not start a scan if its cancellation arrived first', async () => {
    const host = new KnowledgeWorkerHost({ engine: {} } as any, async () => ({}));
    const prepare = vi.fn(async () => ({})); (host as any).projects.prepare = prepare;
    await host.invoke('project.abortPrepare', { requestId: 'early' });
    await expect(host.invoke('project.prepare', { projectId: 'p', domain: 'wiki', requestId: 'early' })).rejects.toThrow('aborted');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('does not start a stage if its cancellation arrived first', async () => {
    const host = new KnowledgeWorkerHost({ engine: {} } as any, async () => ({}));
    const fence = { ledgerId: 'l', controllerEpoch: 'e', ownerId: 'o', generation: 1 };
    await host.invoke('stage.abort', { taskId: 'task', fence });
    await expect(host.invoke('stage.execute', { taskId: 'task', fence, key: { projectId: 'p', domain: 'wiki' }, phase: 'generate', itemId: 'page', attempt: 1 })).rejects.toThrow('aborted');
  });
});

it('runs sibling stages independently and aborts all matching entries after one completes', async () => {
  const runtime = await import('./stageRuntime');
  const pending = new Map<string, { resolve: (value: any) => void; signal: AbortSignal }>();
  vi.spyOn(runtime, 'runKnowledgeStage').mockImplementation((request, _ports, signal) => new Promise(resolve => pending.set(request.itemId, { resolve, signal: signal! })));
  const host = new KnowledgeWorkerHost({ engine: {} } as any, async () => ({}));
  const key = { workspaceInstanceId: 'i', projectId: 'p', portableProjectId: 'p', branch: 'main', language: 'en', domain: 'wiki' };
  (host as any).projects.read = () => ({ key, root: process.cwd() });
  const fence = { ledgerId: 'l', controllerEpoch: 'e', ownerId: 'o', generation: 1 };
  const request = { taskId: 'task', fence, key, phase: 'generate', itemId: 'a', attempt: 1, input: { root: process.cwd() } };
  const a = host.invoke('stage.execute', request);
  const b = host.invoke('stage.execute', { ...request, itemId: 'b' });
  await vi.waitFor(() => expect(pending.size).toBe(2));
  await expect(host.invoke('stage.execute', request)).rejects.toThrow();
  pending.get('a')!.resolve({}); await a;
  const abort = host.invoke('stage.abort', { taskId: 'task', fence });
  await vi.waitFor(() => expect(pending.get('b')!.signal.aborted).toBe(true));
  let finished = false; void abort.then(() => finished = true); await Promise.resolve(); expect(finished).toBe(false);
  pending.get('b')!.resolve({}); await Promise.all([b, abort]);
  await expect(host.invoke('stage.execute', { ...request, itemId: 'c' })).rejects.toThrow('aborted');
  vi.restoreAllMocks();
});
