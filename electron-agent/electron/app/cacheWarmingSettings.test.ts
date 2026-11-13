import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CacheWarmingSettingsService } from './cacheWarmingSettings';
import { mergeRuntimeSettingsFile } from './settingsService';
import { AgentSession } from '@earendil-works/pi-coding-agent';
import { SettingsManager } from '../../../cli/src/pi-sdk.js';
import { attachCacheWarmingControl } from '../../../cli/src/cache-warming-control';
import { __resetForTest, restartRuntimeConfig, watchConfig } from '../../../extensions/_shared/runtime-config.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-cache-settings-'));
  directories.push(root);
  const agentDir = join(root, 'agent');
  await mkdir(agentDir);
  const changed = vi.fn(async () => {});
  return { root, agentDir, changed, path: join(agentDir, 'settings.json'), service: new CacheWarmingSettingsService(root, agentDir, changed) };
}

it('只读取 SDK 有效设置；缺省或读取都不写盘', async () => {
  const { service, path } = await fixture();
  expect(service.get()).toBe('idle');
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  await writeFile(path, JSON.stringify({ cacheWarming: 'off' }));
  expect(service.get()).toBe('off');
  await writeFile(path, JSON.stringify({ cacheWarming: 'streaming' }));
  expect(service.get()).toBe('streaming');
});

it('显式保存三种模式仅写 SDK canonical，保留其他字段并在落盘后通知', async () => {
  const { service, path, changed } = await fixture();
  await writeFile(path, JSON.stringify({ cacheWarming: 'off', defaultModel: 'preserved' }));
  for (const mode of ['streaming', 'idle', 'off']) {
    await service.set(mode);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ cacheWarming: mode, defaultModel: 'preserved' });
  }
  expect(changed).toHaveBeenCalledTimes(3);
});

it('拒绝非法模式；SDK 设置读取错误不会伪报成功', async () => {
  const { service, path, changed } = await fixture();
  await expect(service.set('')).rejects.toThrow();
  await expect(service.set('unknown')).rejects.toThrow();
  await mkdir(path);
  await expect(service.set('off')).rejects.toThrow();
  expect(changed).not.toHaveBeenCalled();
});

it('SDK 实际持久化失败时不发通知，并把错误交给表单', async () => {
  const { service, changed } = await fixture();
  const settings = SettingsManager.fromStorage({
    withLock(_scope, update) {
      const next = update(undefined);
      if (next !== undefined) throw new Error('storage write failed');
    },
  });
  const create = vi.spyOn(SettingsManager, 'create').mockReturnValueOnce(settings);
  try {
    await expect(service.set('off')).rejects.toThrow('storage write failed');
    expect(changed).not.toHaveBeenCalled();
  } finally {
    create.mockRestore();
  }
});

it('canonical 保存通过内容不变的既有配置通知更新全部已打开会话，不留下模式副本', async () => {
  const { root, agentDir, path } = await fixture();
  await writeFile(path, JSON.stringify({ cacheWarming: 'idle' }));
  const runtimePath = join(root, 'runtime-settings.json');
  await writeFile(runtimePath, JSON.stringify({ AUTO_TITLE: '1' }));
  const previous = process.env.PI_RUNTIME_CONFIG;
  process.env.PI_RUNTIME_CONFIG = runtimePath;
  restartRuntimeConfig();
  let events = 0;
  const off = watchConfig(() => { events++; });
  const sessions = [0, 1].map(() => ({
    settingsManager: SettingsManager.create(root, agentDir),
    setCacheWarmingMode: AgentSession.prototype.setCacheWarmingMode,
    dispose() {},
  }));
  for (const session of sessions) attachCacheWarmingControl(session, root, agentDir);
  const service = new CacheWarmingSettingsService(root, agentDir, () => mergeRuntimeSettingsFile(runtimePath, {}));
  try {
    await service.set('off');
    await vi.waitFor(() => {
      expect(events).toBeGreaterThan(0);
      expect(sessions.map((session) => session.settingsManager.getCacheWarmingMode())).toEqual(['off', 'off']);
    });
    await Promise.all(sessions.map((session) => session.settingsManager.flush()));
    expect(JSON.parse(await readFile(runtimePath, 'utf8'))).toEqual({ AUTO_TITLE: '1' });
    await service.set('streaming');
    await vi.waitFor(() => expect(sessions.map((session) => session.settingsManager.getCacheWarmingMode())).toEqual(['streaming', 'streaming']));
    await Promise.all(sessions.map((session) => session.settingsManager.flush()));
  } finally {
    for (const session of sessions) session.dispose();
    off();
    __resetForTest();
    if (previous === undefined) delete process.env.PI_RUNTIME_CONFIG;
    else process.env.PI_RUNTIME_CONFIG = previous;
  }
});
