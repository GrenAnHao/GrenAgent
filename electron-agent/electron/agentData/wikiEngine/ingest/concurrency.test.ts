import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __resetForTest } from '../../../../../extensions/_shared/runtime-config.js';
import {
  createRefreshingLimit,
  getGlobalLlmConcurrency,
  getIngestConcurrency,
  getWikiIngestMode,
} from './concurrency';

const previousRuntime = process.env.PI_RUNTIME_CONFIG;
const previousIngest = process.env.KNOWLEDGE_WIKI_INGEST_CONCURRENCY;
const previousGlobal = process.env.KNOWLEDGE_LLM_GLOBAL_CONCURRENCY;
const previousMode = process.env.KNOWLEDGE_WIKI_INGEST_MODE;

afterEach(() => {
  if (previousRuntime === undefined) delete process.env.PI_RUNTIME_CONFIG;
  else process.env.PI_RUNTIME_CONFIG = previousRuntime;
  if (previousIngest === undefined) delete process.env.KNOWLEDGE_WIKI_INGEST_CONCURRENCY;
  else process.env.KNOWLEDGE_WIKI_INGEST_CONCURRENCY = previousIngest;
  if (previousGlobal === undefined) delete process.env.KNOWLEDGE_LLM_GLOBAL_CONCURRENCY;
  else process.env.KNOWLEDGE_LLM_GLOBAL_CONCURRENCY = previousGlobal;
  if (previousMode === undefined) delete process.env.KNOWLEDGE_WIKI_INGEST_MODE;
  else process.env.KNOWLEDGE_WIKI_INGEST_MODE = previousMode;
  __resetForTest();
});

describe('wiki ingest settings', () => {
  it('显式 env 按范围夹紧，缺省为 3 与 5', () => {
    expect(getIngestConcurrency({})).toBe(3);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '7' })).toBe(7);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '0' })).toBe(1);
    expect(getIngestConcurrency({ KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '99' })).toBe(10);
    expect(getGlobalLlmConcurrency({})).toBe(5);
    expect(getGlobalLlmConcurrency({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '20' })).toBe(20);
    expect(getGlobalLlmConcurrency({ KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '21' })).toBe(20);
  });

  it('未设置抽取模式时用两段式，只接受 single-stage', () => {
    expect(getWikiIngestMode({})).toBe('two-stage');
    expect(getWikiIngestMode({ KNOWLEDGE_WIKI_INGEST_MODE: 'single-stage' })).toBe('single-stage');
    expect(getWikiIngestMode({ KNOWLEDGE_WIKI_INGEST_MODE: 'batch' })).toBe('two-stage');
  });

  it('运行时设置覆盖同名环境变量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-data-settings-'));
    const path = join(dir, 'runtime-settings.json');
    writeFileSync(path, JSON.stringify({
      KNOWLEDGE_WIKI_INGEST_CONCURRENCY: '4',
      KNOWLEDGE_LLM_GLOBAL_CONCURRENCY: '2',
      KNOWLEDGE_WIKI_INGEST_MODE: 'single-stage',
    }));
    process.env.PI_RUNTIME_CONFIG = path;
    process.env.KNOWLEDGE_WIKI_INGEST_CONCURRENCY = '9';
    process.env.KNOWLEDGE_LLM_GLOBAL_CONCURRENCY = '8';
    process.env.KNOWLEDGE_WIKI_INGEST_MODE = 'two-stage';
    __resetForTest();

    expect(getIngestConcurrency()).toBe(4);
    expect(getGlobalLlmConcurrency()).toBe(2);
    expect(getWikiIngestMode()).toBe('single-stage');
  });

  it('并发变化后下一次取到新的限流器', async () => {
    let concurrency = 5;
    const current = createRefreshingLimit(() => concurrency);
    const first = current();
    concurrency = 1;
    const second = current();
    expect(second).not.toBe(first);

    let active = 0;
    let maxActive = 0;
    await Promise.all(Array.from({ length: 4 }, () => second(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active -= 1;
    })));
    expect(maxActive).toBe(1);
  });
});
