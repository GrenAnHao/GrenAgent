import { describe, expect, it, vi } from 'vitest';
import { AgentHost } from './agentHost.js';

const stub = () => ({ dispose: vi.fn(async () => {}), reload: vi.fn(async () => {}) });

function makeHost(createHandle = vi.fn(async () => stub()), over: Record<string, unknown> = {}) {
  const host = new AgentHost({
    createHandle: createHandle as never,
    watchConfig: (() => () => {}) as never,
    onResourceReloadRequested: (() => () => {}) as never,
    ...over,
  });
  return { host, createHandle };
}

describe('AgentHost', () => {
  it('同一 workspace 复用 handle', async () => {
    const { host, createHandle } = makeHost();
    const a = await host.open('D:/p', 'D:/p');
    const b = await host.open('D:/p', 'D:/p');
    expect(createHandle).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('不同 workspace 各一个', async () => {
    const { host, createHandle } = makeHost();
    await host.open('D:/a', 'D:/a');
    await host.open('D:/b', 'D:/b');
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('并发 open 同一 workspace 只创建一次', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const createHandle = vi.fn(() => new Promise((r) => { resolveCreate = r; }));
    const { host } = makeHost(createHandle as never);
    const pending = Promise.all([host.open('D:/p', 'D:/p'), host.open('D:/p', 'D:/p')]);
    resolveCreate(stub());
    await pending;
    expect(createHandle).toHaveBeenCalledTimes(1);
  });

  it('createHandle 失败不缓存半成品', async () => {
    const createHandle = vi.fn().mockRejectedValue(new Error('boom'));
    const { host } = makeHost(createHandle as never);
    await expect(host.open('D:/p', 'D:/p')).rejects.toThrow('boom');
    expect(host.get('D:/p')).toBeUndefined();
    await expect(host.open('D:/p', 'D:/p')).rejects.toThrow('boom');
    expect(createHandle).toHaveBeenCalledTimes(2);
  });

  it('close dispose 并移除；close 未开的 workspace 不抛', async () => {
    const handle = stub();
    const { host } = makeHost(vi.fn(async () => handle) as never);
    await host.open('D:/p', 'D:/p');
    await host.close('D:/p');
    expect(handle.dispose).toHaveBeenCalledTimes(1);
    expect(host.get('D:/p')).toBeUndefined();
    await expect(host.close('D:/never')).resolves.toBeUndefined();
  });

  it('closeAll 释放全部', async () => {
    const handles = [stub(), stub()];
    let i = 0;
    const { host } = makeHost(vi.fn(async () => handles[i++]) as never);
    await host.open('D:/a', 'D:/a');
    await host.open('D:/b', 'D:/b');
    await host.closeAll();
    expect(handles[0].dispose).toHaveBeenCalled();
    expect(handles[1].dispose).toHaveBeenCalled();
  });

  it('PI_RELOAD_REV 变化 → 各 handle reload（去重 rev）', async () => {
    let watchCb: ((next: Record<string, string>) => void) | undefined;
    const handle = stub();
    const { host } = makeHost(vi.fn(async () => handle) as never, {
      watchConfig: ((cb: (n: Record<string, string>) => void) => { watchCb = cb; return () => {}; }) as never,
    });
    await host.open('D:/p', 'D:/p');
    watchCb?.({ PI_RELOAD_REV: '1' });
    watchCb?.({ PI_RELOAD_REV: '1' }); // 同 rev 不重复
    await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(1));
    watchCb?.({ PI_RELOAD_REV: '2' });
    await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(2));
  });

  it('onResourceReloadRequested → 全部 handle reload', async () => {
    let reloadCb: (() => void) | undefined;
    const handle = stub();
    const { host } = makeHost(vi.fn(async () => handle) as never, {
      onResourceReloadRequested: ((cb: () => void) => { reloadCb = cb; return () => {}; }) as never,
    });
    await host.open('D:/p', 'D:/p');
    reloadCb?.();
    await vi.waitFor(() => expect(handle.reload).toHaveBeenCalledTimes(1));
  });
});
