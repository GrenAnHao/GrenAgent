import { describe, expect, it, vi } from 'vitest';
import { SystemWorkerManager } from './systemWorkerManager';
import type { PiProcessOptions } from './manager';

function fakeClient() {
  return { send: vi.fn(async (_command: Record<string, unknown>) => ({ result: 'ok' })), respondUi: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe('SystemWorkerManager', () => {
  it('describes the actual configured model without creating a session or prompting and releases the idle client', async () => {
    vi.useFakeTimers();
    const client = { ...fakeClient(), send: vi.fn(async () => ({ model: { provider: 'test-provider', id: 'test-model' } })) };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, idleTimeoutMs: 100, createClient: () => client as never });
    try {
      await expect(manager.describeModel()).resolves.toBe('test-provider/test-model');
      expect(client.send.mock.calls).toEqual([[{ type: 'get_state' }]]);
      await vi.advanceTimersByTimeAsync(100);
      expect(client.close).toHaveBeenCalledOnce();
    } finally { manager.close(); vi.useRealTimers(); }
  });

  it.each([undefined, {}, { model: { id: 'missing-provider' } }])('rejects unavailable model state %j without prompting', async (state) => {
    const client = { ...fakeClient(), send: vi.fn(async () => state) };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: () => client as never });
    try {
      await expect(manager.describeModel()).rejects.toThrow('MODEL_UNAVAILABLE');
      expect(client.send.mock.calls).toEqual([[{ type: 'get_state' }]]);
    } finally { manager.close(); }
  });

  it('maps model state RPC errors to MODEL_UNAVAILABLE', async () => {
    const client = { ...fakeClient(), send: vi.fn(async () => { throw new Error('not configured'); }) };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: () => client as never });
    try { await expect(manager.describeModel()).rejects.toThrow('MODEL_UNAVAILABLE'); }
    finally { manager.close(); }
  });

  it('rechecks the model after session reset and refuses changed models before prompt', async () => {
    const client = { ...fakeClient(), send: vi.fn(async (command: Record<string, unknown>) => command.type === 'get_state' ? { model: { provider: 'test', id: 'changed' } } : {}) };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: () => client as never });
    try {
      await expect(manager.run({ id: 'wiki-model-change', kind: 'wiki_page_generate', input: { expectedModel: 'test/confirmed' } })).rejects.toThrow('MODEL_CHANGED');
      expect(client.send.mock.calls.map(([command]) => command.type)).toEqual(['new_session', 'get_state']);
    } finally { manager.close(); }
  });

  it('bounds a model description that never returns and keeps the worker queue usable', async () => {
    vi.useFakeTimers();
    const stuck = { ...fakeClient(), send: vi.fn(() => new Promise(() => {})) };
    const fresh = fakeClient();
    const create = vi.fn().mockReturnValueOnce(stuck).mockReturnValue(fresh);
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, taskTimeoutMs: 50, createClient: create });
    try {
      const model = manager.describeModel();
      let failure = ''; void model.catch((error: Error) => { failure = error.message; });
      await vi.advanceTimersByTimeAsync(51);
      expect(failure).toBe('MODEL_UNAVAILABLE');
      expect(stuck.close).toHaveBeenCalledOnce();
      await expect(manager.run({ id: 'after-model-timeout', kind: 'memory_extract', input: {} })).resolves.toEqual({ result: 'ok' });
    } finally { manager.close(); vi.useRealTimers(); }
  });

  it('prompts only when the post-reset model matches the confirmed Wiki model', async () => {
    const client = { ...fakeClient(), send: vi.fn(async (command: Record<string, unknown>) => command.type === 'get_state' ? { model: { provider: 'test', id: 'confirmed' } } : command.type === 'prompt' ? '# Generated' : {}) };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: () => client as never });
    try {
      await expect(manager.run({ id: 'confirmed-wiki', kind: 'wiki_page_generate', input: { expectedModel: 'test/confirmed' } })).resolves.toBe('# Generated');
      expect(client.send.mock.calls.map(([command]) => command.type)).toEqual(['new_session', 'get_state', 'prompt']);
    } finally { manager.close(); }
  });

  it('starts on demand, reuses the worker, and closes after idle timeout', async () => {
    vi.useFakeTimers(); const clients = [fakeClient()]; const open = vi.fn(() => clients[0] as never);
    const manager = new SystemWorkerManager({ processCommand: { command: 'pi', args: ['agent'] }, idleTimeoutMs: 100, createClient: open });
    await manager.run({ id: 'a', kind: 'memory_extract', input: { text: 'a' } });
    await manager.run({ id: 'b', kind: 'memory_extract', input: { text: 'b' } });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith('__system__', expect.anything(), expect.objectContaining({ profile: 'automation' }));
    vi.advanceTimersByTime(100); await Promise.resolve();
    expect(clients[0].close).toHaveBeenCalledOnce(); vi.useRealTimers();
  });

  it('requeues a crashed task until max attempts then fails', async () => {
    const manager = new SystemWorkerManager({ processCommand: { command: 'pi', args: [] }, createClient: vi.fn(() => { throw new Error('spawn failed'); }), maxAttempts: 2 });
    await expect(manager.run({ id: 'a', kind: 'memory_extract', input: {} })).rejects.toThrow('spawn failed');
    expect(manager.taskState('a')).toMatchObject({ status: 'failed', attempts: 2 });
  });

  it('extracts structured output from the system Pi terminal event', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async (_command: Record<string, unknown>) => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'memory', kind: 'memory_extract', input: { delta: 'remember dark mode' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"l1":{"theme":"dark"}}' }] }] });

    await expect(running).resolves.toEqual({ l1: { theme: 'dark' } });
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', message: expect.stringContaining('memory_extract') }));
  });

  it('asks for markdown and returns raw text for wiki page generation', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async (_command: Record<string, unknown>) => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'wiki', kind: 'wiki_page_generate', input: { sourcePath: 'README.md', source: '# Source' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '# Generated\n\nBody' }] }] });

    await expect(running).resolves.toBe('# Generated\n\nBody');
    const prompt = String(client.send.mock.calls.find(([command]) => command.type === 'prompt')![0].message);
    expect(prompt).toContain('Markdown');
    expect(prompt).not.toContain('JSON only');
  });

  it('still parses JSON for memory extraction after adding text kinds', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async (_command: Record<string, unknown>) => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'memory', kind: 'memory_extract', input: { delta: 'x' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"l1":{"a":1}}' }] }] });

    await expect(running).resolves.toEqual({ l1: { a: 1 } });
    const prompt = String(client.send.mock.calls.find(([command]) => command.type === 'prompt')![0].message);
    expect(prompt).toContain('JSON only');
  });

  it('uses a 60s timeout for wiki_page_generate and 30s for memory_extract', async () => {
    vi.useFakeTimers();
    try {
      const wikiClient = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
      const wikiManager = new SystemWorkerManager({
        processCommand: { command: 'pi', args: [] },
        createClient: vi.fn(() => wikiClient as never),
      });
      const wikiRunning = wikiManager.run({ id: 'wiki', kind: 'wiki_page_generate', input: {} });
      let wikiSettled = false;
      void wikiRunning.then(() => { wikiSettled = true; }, () => { wikiSettled = true; });
      await Promise.resolve();
      await Promise.resolve();
      expect(wikiClient.send).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(wikiSettled).toBe(false);

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(wikiRunning).rejects.toThrow('system Pi task timed out');

      const memClient = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
      const memManager = new SystemWorkerManager({
        processCommand: { command: 'pi', args: [] },
        createClient: vi.fn(() => memClient as never),
      });
      const memRunning = memManager.run({ id: 'mem', kind: 'memory_extract', input: {} });
      const memExpect = expect(memRunning).rejects.toThrow('system Pi task timed out');
      await Promise.resolve();
      await Promise.resolve();
      expect(memClient.send).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      await memExpect;
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a fresh session for each reused worker task', async () => {
    const client = fakeClient();
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: () => client as never });
    await manager.run({ id: 'a', kind: 'memory_extract', input: { delta: 'project A' } });
    await manager.run({ id: 'b', kind: 'memory_extract', input: { delta: 'project B' } });
    expect(client.send.mock.calls.map(([command]) => command.type)).toEqual(['new_session', 'prompt', 'new_session', 'prompt']);
    manager.close();
  });

  it('serializes mixed task kinds so one terminal event cannot complete another task', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async (_command: Record<string, unknown>) => undefined), close: vi.fn(async () => {}), respondUi: vi.fn() };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: (_key, _command, options) => { handlers = options; return client as never; } });
    const memory = manager.run({ id: 'memory', kind: 'memory_extract', input: {} });
    const wiki = manager.run({ id: 'wiki', kind: 'wiki_page_generate', input: {} });
    void memory.catch(() => {}); void wiki.catch(() => {});
    await vi.waitFor(() => expect(client.send.mock.calls.filter(([command]) => command.type === 'prompt')).toHaveLength(1));
    handlers!.onEvent!('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"l1":{"fact":"memory"}}' }] }] });
    await expect(memory).resolves.toEqual({ l1: { fact: 'memory' } });
    await vi.waitFor(() => expect(client.send.mock.calls.filter(([command]) => command.type === 'prompt')).toHaveLength(2));
    handlers!.onEvent!('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '# Wiki' }] }] });
    await expect(wiki).resolves.toBe('# Wiki');
    manager.close();
  });

  it('gives a repeated task id a new attempt budget after a queue retry', async () => {
    const create = vi.fn().mockImplementationOnce(() => { throw new Error('temporary failure'); }).mockImplementation(() => fakeClient());
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: create });
    const task = { id: 'same-id', kind: 'memory_extract', input: {} };
    await expect(manager.run(task)).rejects.toThrow('temporary failure');
    await expect(manager.run(task)).resolves.toEqual({ result: 'ok' });
    expect(create).toHaveBeenCalledTimes(2);
    manager.close();
  });

  it('times out session initialization even when new_session never responds', async () => {
    vi.useFakeTimers();
    try {
      const client = { send: vi.fn(() => new Promise(() => {})), close: vi.fn(async () => {}), respondUi: vi.fn() };
      const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, taskTimeoutMs: 50, createClient: () => client as never });
      const running = manager.run({ id: 'stuck-reset', kind: 'memory_extract', input: {} });
      let failure: string | undefined;
      void running.catch((error: Error) => { failure = error.message; });
      await vi.advanceTimersByTimeAsync(51);
      expect(failure).toBe('system Pi task timed out');
      expect(client.close).toHaveBeenCalledOnce();
      manager.close();
    } finally { vi.useRealTimers(); }
  });

  it('does not reopen the worker for queued tasks after close', async () => {
    const client = { send: vi.fn(async () => undefined), close: vi.fn(async () => {}), respondUi: vi.fn() };
    const create = vi.fn(() => client as never);
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: create });
    const first = manager.run({ id: 'a', kind: 'memory_extract', input: {} });
    const second = manager.run({ id: 'b', kind: 'memory_extract', input: {} });
    const outcomes = Promise.allSettled([first, second]);
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    manager.close();
    expect((await outcomes).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(create).toHaveBeenCalledOnce();
  });

  it.each(['error', 'aborted', 'length'])('rejects assistant output that ended with %s even when it contains valid JSON', async (stopReason) => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async (_command: Record<string, unknown>) => undefined), close: vi.fn(async () => {}), respondUi: vi.fn() };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: (_key, _command, options) => { handlers = options; return client as never; } });
    const running = manager.run({ id: 'failed-output', kind: 'memory_extract', input: {} });
    void running.catch(() => {});
    await vi.waitFor(() => expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt' })));
    handlers!.onEvent!('__system__', { type: 'agent_end', messages: [{ role: 'assistant', stopReason, content: [{ type: 'text', text: '{"l1":{"partial":true}}' }] }] });
    await expect(running).rejects.toThrow(`system Pi output ended with ${stopReason}`);
    manager.close();
  });

  it('rejects a cancelled new_session without sending the task into the old session', async () => {
    const client = { send: vi.fn(async (command: Record<string, unknown>) => command.type === 'new_session' ? { cancelled: true } : { l1: { stale: true } }), close: vi.fn(async () => {}), respondUi: vi.fn() };
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: () => client as never });
    await expect(manager.run({ id: 'cancelled-reset', kind: 'memory_extract', input: {} })).rejects.toThrow('system Pi new session was cancelled');
    expect(client.send.mock.calls.map(([command]) => command.type)).toEqual(['new_session']);
    expect(client.close).toHaveBeenCalledOnce();
    manager.close();
  });

  it('recreates the client within the retry budget after a cancelled session reset', async () => {
    const stale = { send: vi.fn(async (command: Record<string, unknown>) => command.type === 'new_session' ? { cancelled: true } : { l1: { stale: true } }), close: vi.fn(async () => {}), respondUi: vi.fn() };
    const fresh = fakeClient();
    const create = vi.fn().mockReturnValueOnce(stale).mockReturnValue(fresh);
    const manager = new SystemWorkerManager({ processCommand: { command: 'fake', args: [] }, createClient: create });
    await expect(manager.run({ id: 'cancelled-retry', kind: 'memory_extract', input: {}, maxAttempts: 2 })).resolves.toEqual({ result: 'ok' });
    expect(stale.send.mock.calls.map(([command]) => command.type)).toEqual(['new_session']);
    expect(stale.close).toHaveBeenCalledOnce();
    expect(fresh.send.mock.calls.map(([command]) => command.type)).toEqual(['new_session', 'prompt']);
    manager.close();
  });
});
