import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ModelRuntime } from '../../../cli/src/pi-sdk.js';
import { ProviderService } from './providerService';

/**
 * 设置页保存内置供应商 API Key 的完整落盘链路：ProviderService → 官方 CredentialStore(auth.json)
 * → 新进程重启后再读。
 *
 * 回归的 bug：写入曾走 ModelRuntime.setRuntimeApiKey()，那只是进程内 overlay，
 * auth.json 从未收到 key，于是「保存即刻生效、重开设置页空白、重启彻底丢失」。
 *
 * 设置页回显走 loadState(auth.json)：内置供应商的 apiKey = auth[p.id]?.key，
 * 由 src/features/settings/providerConfigAdapter.test.ts 的「loads built-in key from auth.json」覆盖。
 * 这里只断言磁盘事实与冷启动解析，避免把渲染层代码拉进 node 工程。
 */

const roots: string[] = [];

async function fixture(auth: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gren-apikey-persist-'));
  roots.push(root);
  const authPath = join(root, 'auth.json');
  const modelsPath = join(root, 'models.json');
  await writeFile(modelsPath, JSON.stringify({ providers: {} }));
  await writeFile(authPath, JSON.stringify(auth));
  return { root, authPath, modelsPath };
}

async function newRuntime(authPath: string, modelsPath: string) {
  return ModelRuntime.create({
    authPath, modelsPath, refreshOnCreate: false, allowModelNetwork: false,
  });
}

/** 按生产装配造一份 ProviderService：主进程 runtime + 刷新回调（生产里还会让 agent 子进程重读）。 */
async function service(agentDir: string, modelsPath: string, authPath: string) {
  const runtime = await newRuntime(authPath, modelsPath);
  return {
    runtime,
    service: new ProviderService({
      agentDir,
      runtime: async () => runtime,
      refresh: async () => ({ refreshed: [], failed: [] }),
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('uses a saved built-in API key immediately, persists it, and survives a restart', async () => {
  const { root, authPath, modelsPath } = await fixture();
  const { runtime, service: providerService } = await service(root, modelsPath, authPath);

  await providerService.setApiKey('openai', 'sk-persisted');

  // 1) 保存即刻被运行时使用。
  await expect(runtime.getAuth('openai')).resolves.toMatchObject({ auth: { apiKey: 'sk-persisted' } });
  // 2) 已落盘到 auth.json —— 设置页重开读的就是它，而不是只活在进程内存里。
  const auth = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>;
  expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-persisted' });

  // 3) 重启：全新 runtime 不靠任何内存状态也能解析出同一个 key。
  const restarted = await newRuntime(authPath, modelsPath);
  await restarted.refresh({ providers: ['openai'], allowNetwork: false });
  await expect(restarted.getAuth('openai')).resolves.toMatchObject({ auth: { apiKey: 'sk-persisted' } });
});

it('does not clobber OAuth credentials or provider env when saving an API key', async () => {
  const { root, authPath, modelsPath } = await fixture({
    anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1893456000000 },
    'cloudflare-workers-ai': { type: 'api_key', key: 'old', env: { CLOUDFLARE_ACCOUNT_ID: 'acct' } },
  });
  const { service: providerService } = await service(root, modelsPath, authPath);

  await providerService.setApiKey('openai', 'sk-openai');
  await providerService.setApiKey('cloudflare-workers-ai', 'cf-new');

  const auth = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, Record<string, unknown>>;
  expect(auth.anthropic).toMatchObject({ type: 'oauth', access: 'a' });
  expect(auth.openai).toEqual({ type: 'api_key', key: 'sk-openai' });
  // 改 key 不能把官方登录流程写下的 provider env 冲掉。
  expect(auth['cloudflare-workers-ai']).toEqual({
    type: 'api_key', key: 'cf-new', env: { CLOUDFLARE_ACCOUNT_ID: 'acct' },
  });
});

it('clears an api_key credential but never an OAuth credential from the empty input', async () => {
  const { root, authPath, modelsPath } = await fixture({
    openai: { type: 'api_key', key: 'sk-old' },
    anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1893456000000 },
  });
  const { service: providerService } = await service(root, modelsPath, authPath);

  await providerService.setApiKey('openai', null);
  await providerService.setApiKey('anthropic', null);

  const auth = JSON.parse(await readFile(authPath, 'utf8')) as Record<string, unknown>;
  expect(auth.openai).toBeUndefined();
  expect(auth.anthropic).toMatchObject({ type: 'oauth' });
});
