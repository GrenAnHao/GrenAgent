import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConfig, watchConfig, __resetForTest } from '../../../extensions/_shared/runtime-config.js';
import { currentWorkspaceContext, runInWorkspace } from '../../../extensions/_shared/workspace-context.js';
import { bootstrapRuntimeConfig } from './runtimeConfigBootstrap.js';

afterEach(() => {
  __resetForTest();
  delete process.env.PI_RUNTIME_CONFIG;
});

describe('bootstrapRuntimeConfig', () => {
  it('设置 env 且文件不存在时创建 {}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-boot-'));
    const path = join(dir, 'sub', 'runtime-settings.json');
    try {
      bootstrapRuntimeConfig(path);
      expect(process.env.PI_RUNTIME_CONFIG).toBe(path);
      expect(getConfig('__any__')).toBeUndefined(); // 文件为 {}，读得到不报错
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('watcher 在 ALS 之外创建：watch 回调内 currentWorkspaceContext 为 undefined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-boot-'));
    const path = join(dir, 'runtime-settings.json');
    await writeFile(path, '{}');
    try {
      bootstrapRuntimeConfig(path);
      let seenOrigin: string | undefined = 'SENTINEL';
      // 在某 workspace 的 ALS 内注册 subscriber——但 watcher 已在 bootstrap（ALS 外）建立，
      // 回调应看不到 store。
      runInWorkspace({ origin: 'main', workspace: 'A', cwd: 'A', config: {} }, () => {
        watchConfig(() => {
          seenOrigin = currentWorkspaceContext()?.origin;
        });
      });
      await writeFile(path, JSON.stringify({ PI_RELOAD_REV: '1' }));
      await vi.waitFor(() => expect(seenOrigin).not.toBe('SENTINEL'), { timeout: 2000 });
      expect(seenOrigin).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('bootstrap 前调过 getConfig（模拟 import 期）仍能重建 watcher', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rc-boot-'));
    const path = join(dir, 'runtime-settings.json');
    await writeFile(path, '{}');
    try {
      getConfig('X'); // env 未设 → ensureStarted 建了个空 watcher，started=true
      bootstrapRuntimeConfig(path);
      let fired = false;
      watchConfig(() => {
        fired = true;
      });
      await writeFile(path, JSON.stringify({ PI_RELOAD_REV: '2' }));
      await vi.waitFor(() => expect(fired).toBe(true), { timeout: 2000 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
