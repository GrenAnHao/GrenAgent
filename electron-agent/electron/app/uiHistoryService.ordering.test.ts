import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({
  data: new Map<string, string>(),
  gate: undefined as Promise<void> | undefined,
  started: undefined as (() => void) | undefined,
}));
vi.mock('node:fs/promises', () => ({
  mkdir: async () => {},
  writeFile: async (path: string, content: string) => {
    io.started?.();
    if (io.gate) await io.gate;
    if (content === 'fail') throw new Error('write failed');
    io.data.set(path, content);
  },
  rename: async (from: string, to: string) => { io.data.set(to, io.data.get(from)!); io.data.delete(from); },
  rm: async (path: string) => { io.data.delete(path); },
  readFile: async (path: string) => {
    if (!io.data.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return io.data.get(path)!;
  },
}));
import { UiHistoryService } from './uiHistoryService';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flushIoScheduling() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
beforeEach(() => { io.data.clear(); io.gate = undefined; io.started = undefined; });

describe('UI history operation ordering', () => {
  it('删除等待先前写入，旧 todo 历史不能在删除后复活', async () => {
    const service = new UiHistoryService(async (path) => path);
    const gate = deferred();
    const started = deferred();
    io.gate = gate.promise;
    io.started = started.resolve;
    const write = service.write('/repo', 'todo', 'stale todo');
    await started.promise;
    const deletion = service.delete('/repo', 'todo');
    await flushIoScheduling();
    gate.resolve();
    await Promise.all([write, deletion]);
    expect(await service.read('/repo', 'todo')).toBe('');
  });

  it('读取等待先前写入，不返回旧任务快照', async () => {
    const service = new UiHistoryService(async (path) => path);
    const gate = deferred();
    const started = deferred();
    io.gate = gate.promise;
    io.started = started.resolve;
    const write = service.write('/repo', 'todo', 'completed todo');
    await started.promise;
    const read = service.read('/repo', 'todo');
    await flushIoScheduling();
    gate.resolve();
    await write;
    expect(await read).toBe('completed todo');
  });

  it('写入失败不会堵住后续写入、读取或删除', async () => {
    const service = new UiHistoryService(async (path) => path);
    const failed = service.write('/repo', 'todo', 'fail');
    const next = service.write('/repo', 'todo', 'new todo');
    await expect(failed).rejects.toThrow('write failed');
    await next;
    expect(await service.read('/repo', 'todo')).toBe('new todo');
    await service.delete('/repo', 'todo');
    expect(await service.read('/repo', 'todo')).toBe('');
  });
});
