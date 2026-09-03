import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  it('reads MCP settings persisted by Tauri in app-state.json', async () => {
    const { service, directory } = await createService();
    await writeFile(join(directory, 'app-state.json'), JSON.stringify({
      settings: {
        MCP_SERVERS: JSON.stringify({ mcpServers: {
          context7: { command: 'npx' },
          deepwiki: { command: 'npx' },
        } }),
        MCP_SERVERS_DISABLED: '',
      },
    }));

    await expect(service.getAll()).resolves.toMatchObject({
      MCP_SERVERS: expect.stringContaining('context7'),
      MCP_SERVERS_DISABLED: '',
    });
  });

  it('updates the shared app-state settings without discarding Tauri state', async () => {
    const { service, directory } = await createService();
    await writeFile(join(directory, 'app-state.json'), JSON.stringify({
      recent_workspaces: ['C:\\workspace'],
      settings: { MCP_SERVERS: 'old' },
    }));

    await service.replace({ MCP_SERVERS: 'new' });

    const state = JSON.parse(await readFile(join(directory, 'app-state.json'), 'utf8')) as {
      recent_workspaces: string[];
      settings: Record<string, string>;
    };
    expect(state.recent_workspaces).toEqual(['C:\\workspace']);
    expect(state.settings.MCP_SERVERS).toBe('new');
  });

  it('falls back to the legacy data dir app-state when the current one is empty', async () => {
    const { directory } = await createService();
    const legacyDir = await mkdtemp(join(tmpdir(), 'electron-agent-settings-legacy-'));
    directories.push(legacyDir);
    await writeFile(join(legacyDir, 'app-state.json'), JSON.stringify({
      settings: { MCP_SERVERS: JSON.stringify({ mcpServers: { context7: { command: 'npx' } } }) },
    }));

    await expect(new SettingsService(directory, [legacyDir]).getAll()).resolves.toMatchObject({
      MCP_SERVERS: expect.stringContaining('context7'),
    });
  });

  it('prefers current-dir settings over the legacy fallback', async () => {
    const { directory } = await createService();
    const legacyDir = await mkdtemp(join(tmpdir(), 'electron-agent-settings-legacy-'));
    directories.push(legacyDir);
    await writeFile(join(legacyDir, 'app-state.json'), JSON.stringify({
      settings: { MCP_SERVERS: JSON.stringify({ mcpServers: { legacy: { command: 'npx' } } }) },
    }));

    const service = new SettingsService(directory, [legacyDir]);
    await service.replace({ MCP_SERVERS: JSON.stringify({ mcpServers: { current: { command: 'npx' } } }) });

    await expect(service.getAll()).resolves.toMatchObject({
      MCP_SERVERS: expect.stringContaining('current'),
    });
  });

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
