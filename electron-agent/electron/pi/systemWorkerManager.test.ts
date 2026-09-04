import { describe, expect, it, vi } from 'vitest';
import { SystemWorkerManager } from './systemWorkerManager';
import type { PiProcessOptions } from './manager';

function fakeClient() {
  return { send: vi.fn(async () => ({ result: 'ok' })), respondUi: vi.fn(async () => {}), close: vi.fn(async () => {}) };
}

describe('SystemWorkerManager', () => {
  it('starts on demand, reuses the worker, and closes after idle timeout', async () => {
    vi.useFakeTimers(); const clients = [fakeClient()]; const open = vi.fn(() => clients[0]);
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
    const client = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'memory', kind: 'memory_extract', input: { delta: 'remember dark mode' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"l1":{"theme":"dark"}}' }] }] });

    await expect(running).resolves.toEqual({ l1: { theme: 'dark' } });
    expect(client.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'prompt', message: expect.stringContaining('memory_extract') }));
  });

  it('asks for markdown and returns raw text for wiki page generation', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'wiki', kind: 'wiki_page_generate', input: { sourcePath: 'README.md', source: '# Source' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '# Generated\n\nBody' }] }] });

    await expect(running).resolves.toBe('# Generated\n\nBody');
    const prompt = String(client.send.mock.calls[0][0].message);
    expect(prompt).toContain('Markdown');
    expect(prompt).not.toContain('JSON only');
  });

  it('still parses JSON for memory extraction after adding text kinds', async () => {
    let handlers: PiProcessOptions | undefined;
    const client = { send: vi.fn(async () => undefined), respondUi: vi.fn(), close: vi.fn() };
    const manager = new SystemWorkerManager({
      processCommand: { command: 'pi', args: ['--mode', 'rpc'] },
      createClient: vi.fn((_key, _command, options) => { handlers = options; return client as never; }),
    });

    const running = manager.run({ id: 'memory', kind: 'memory_extract', input: { delta: 'x' } });
    await vi.waitFor(() => expect(client.send).toHaveBeenCalled());
    handlers?.onEvent?.('__system__', { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: '{"l1":{"a":1}}' }] }] });

    await expect(running).resolves.toEqual({ l1: { a: 1 } });
    const prompt = String(client.send.mock.calls[0][0].message);
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
});
