import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsService } from './settingsService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: SettingsService; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'electron-agent-settings-'));
  directories.push(directory);
  return { service: new SettingsService(directory), directory };
}

describe('SettingsService', () => {
  it('returns persisted settings after a restart', async () => {
    const { service, directory } = await createService();
    await service.replace({ OPENAI_API_KEY: 'sk-test', EMPTY: '  ' });

    await expect(new SettingsService(directory).getAll()).resolves.toEqual({
      OPENAI_API_KEY: 'sk-test',
      EMPTY: '  ',
    });
  });

  it('writes only usable non-legacy values to runtime settings', async () => {
    const { service, directory } = await createService();
    await service.replace({
      OPENAI_API_KEY: 'sk-test',
      EMPTY: ' ',
      TDAI_MEMORY_API_KEY: 'secret',
      TDAI_KNOWLEDGE_ENDPOINT: 'http://local',
      titleModel: 'openai/gpt-5',
    });

    await expect(readFile(join(directory, 'runtime-settings.json'), 'utf8')).resolves.toBe(
      `${JSON.stringify({ OPENAI_API_KEY: 'sk-test', titleModel: 'openai/gpt-5' }, null, 2)}\n`,
    );
  });
});
