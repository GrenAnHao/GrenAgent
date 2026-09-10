import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeRuntimeSettingsFile, SettingsService } from './settingsService';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createService(): Promise<{ service: SettingsService; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'electron-agent-settings-'));
  directories.push(directory);
  return { service: new SettingsService(directory), directory };
}

describe('SettingsService runtime control keys', () => {
  it('keeps workspace approval keys when replacing unrelated settings', async () => {
    const { service, directory } = await createService();
    await writeFile(
      join(directory, 'runtime-settings.json'),
      `${JSON.stringify({ 'APPROVAL_POLICY:c:/work': 'full', OPENAI_API_KEY: 'old' }, null, 2)}\n`,
    );
    await service.replace({ OPENAI_API_KEY: 'new', titleModel: 'openai/gpt-5' });
    const runtime = JSON.parse(await readFile(join(directory, 'runtime-settings.json'), 'utf8')) as Record<string, string>;
    expect(runtime).toMatchObject({
      OPENAI_API_KEY: 'new',
      titleModel: 'openai/gpt-5',
      'APPROVAL_POLICY:c:/work': 'full',
    });
  });

  it('keeps pending context-exclusion pulses when replacing unrelated settings', async () => {
    const { service, directory } = await createService();
    const pulse = JSON.stringify({ op: 'add', ts: 42, rev: 9 });
    await writeFile(
      join(directory, 'runtime-settings.json'),
      `${JSON.stringify({ 'CONTEXT_EXCLUSION_OP:c:/work': pulse, OPENAI_API_KEY: 'old' }, null, 2)}\n`,
    );
    await service.replace({ OPENAI_API_KEY: 'new' });
    const runtime = JSON.parse(await readFile(join(directory, 'runtime-settings.json'), 'utf8')) as Record<string, string>;
    expect(runtime['CONTEXT_EXCLUSION_OP:c:/work']).toBe(pulse);
    expect(runtime.OPENAI_API_KEY).toBe('new');
  });

  it('keeps merged control-plane keys after a later replace', async () => {
    const { service, directory } = await createService();
    const runtimePath = join(directory, 'runtime-settings.json');
    await mergeRuntimeSettingsFile(runtimePath, { 'APPROVAL_POLICY:c:/work': 'ask' });
    await service.replace({ OPENAI_API_KEY: 'sk-test' });
    const runtime = JSON.parse(await readFile(runtimePath, 'utf8')) as Record<string, string>;
    expect(runtime).toMatchObject({
      OPENAI_API_KEY: 'sk-test',
      'APPROVAL_POLICY:c:/work': 'ask',
    });
  });
});
