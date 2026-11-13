import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentDataService } from './agentDataService';
import { AgentDataClient } from '../agentData/client';
import { AgentDataRuntime } from '../agentData/runtime';

/**
 * 门面现在只接受装配好的运行时：agentdata-host 与 child 模式已下线，
 * 凭证轮换、崩溃重拉这类跨进程行为不再存在，相关断言随之移除，
 * 保留「启动/状态/关停」「等执行器收尾」「长超时请求」三组仍然成立的行为。
 */
const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); });

const service = (options: Partial<ConstructorParameters<typeof AgentDataRuntime>[0]> = {}) => {
  const runtime = new AgentDataRuntime({ dataPath: ':memory:', ...options } as ConstructorParameters<typeof AgentDataRuntime>[0]);
  const instance = new AgentDataService({ runtime });
  cleanups.push(() => instance.stop());
  return instance;
};

describe('AgentDataService', () => {
  it('does not finish stopping until an existing executor has actually settled', async () => {
    let release!: (value: string) => void;
    const execute = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const instance = service({ executeServiceTask: execute });
    await instance.start();
    const work = instance.runServiceTask({ id: 'drain-task', kind: 'wiki_page_generate', input: { source: 'A' } });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    let stopped = false;
    const stop = instance.stop().then(() => { stopped = true; });
    try {
      await vi.waitFor(() => expect(instance.endpoint()).toBeUndefined());
      expect(stopped).toBe(false);
    } finally { release('# done'); await work; await stop; }
    expect(stopped).toBe(true);
  });

  it('starts, reports status and shuts down', async () => {
    const instance = service();
    await expect(instance.start()).resolves.toMatchObject({ version: 1 });
    await expect(instance.status()).resolves.toMatchObject({ state: 'ready' });
    await instance.stop();
    expect(instance.endpoint()).toBeUndefined();
  });

  it('allows CodeGraph requests to exceed the short standalone client timeout', async () => {
    const instance = service({
      methods: { 'codeRetrieval.call': () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 6_000)) },
    });
    await instance.start();
    const request = instance.request('codeRetrieval.call', { workspace: '/repo', tool: 'codegraph_search', args: {} });
    await expect(request).resolves.toEqual({ ok: true });
  }, 15_000);

  it('keeps serving threads and admin calls from the same in-process runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-data-service-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const instance = service({ dataPath: join(dir, 'agent-data.db') });
    await instance.start();
    const thread = await instance.createThread({ id: 't1', projectId: 'p', workspace: dir });
    expect(thread).toMatchObject({ id: 't1', status: 'active' });
    expect(await instance.listThreads()).toHaveLength(1);
    // 扩展方法转发仍按 owner 判定，未授权的名字返回 undefined。
    expect(instance.extensionMethod('permission.tool.evaluate', dir)).toBeTypeOf('function');
    expect(instance.extensionMethod('wiki.list', dir)).toBeUndefined();
  });
});
