import { describe, expect, it, vi } from 'vitest';
import { ModelRuntimeHost } from './modelRuntimeHost.js';

const stubRuntime = () => ({ getAvailableSnapshot: () => [], refresh: vi.fn(async () => ({})) });

describe('ModelRuntimeHost', () => {
  it('ensure() 只创建一次', async () => {
    const create = vi.fn().mockResolvedValue(stubRuntime());
    const host = new ModelRuntimeHost({ create });
    const a = await host.ensure();
    const b = await host.ensure();
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('并发 ensure() 不重复创建', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    const create = vi.fn().mockReturnValue(new Promise((r) => { resolveCreate = r; }));
    const host = new ModelRuntimeHost({ create });
    const pending = Promise.all([host.ensure(), host.ensure(), host.ensure()]);
    resolveCreate(stubRuntime());
    const [a, b, c] = await pending;
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('创建失败后下次 ensure() 重试', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('auth failed')).mockResolvedValue(stubRuntime());
    const host = new ModelRuntimeHost({ create });
    await expect(host.ensure()).rejects.toThrow('auth failed');
    await expect(host.ensure()).resolves.toBeDefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('refresh() 原地刷新，不丢弃实例', async () => {
    const runtime = stubRuntime();
    const create = vi.fn().mockResolvedValue(runtime);
    const host = new ModelRuntimeHost({ create });
    const a = await host.ensure();
    await host.refresh();
    const b = await host.ensure();
    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('refresh() 未 ensure 时先 ensure 再刷新', async () => {
    const runtime = stubRuntime();
    const create = vi.fn().mockResolvedValue(runtime);
    const host = new ModelRuntimeHost({ create });
    await host.refresh();
    expect(create).toHaveBeenCalledTimes(1);
    expect(runtime.refresh).toHaveBeenCalledTimes(1);
  });
});
