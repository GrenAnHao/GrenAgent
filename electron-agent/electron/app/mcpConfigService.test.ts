import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConfigService } from './mcpConfigService';
import { SettingsService } from './settingsService';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'electron-agent-mcp-home-'));
  const workspace = await mkdtemp(join(tmpdir(), 'electron-agent-mcp-workspace-'));
  directories.push(home, workspace);
  let values: Record<string, string> = {
    MCP_SERVERS: JSON.stringify({ mcpServers: { settings: { command: 'settings' }, shared: { command: 'settings' } } }),
    MCP_SERVERS_DISABLED: JSON.stringify({ disabledSettings: { command: 'off' } }),
  };
  const settings = {
    getAll: async () => ({ ...values }),
    replace: async (next: Record<string, string>) => { values = { ...next }; },
  };
  return { home, workspace, settings, currentSettings: () => values };
}

describe('McpConfigService', () => {
  it('includes MCP servers persisted in the shared Tauri app state', async () => {
    const { home, workspace } = await fixture();
    const dataDir = await mkdtemp(join(tmpdir(), 'electron-agent-shared-state-'));
    directories.push(dataDir);
    await writeFile(join(dataDir, 'app-state.json'), JSON.stringify({
      settings: {
        MCP_SERVERS: JSON.stringify({ mcpServers: {
          context7: { command: 'npx' },
          deepwiki: { command: 'npx' },
        } }),
        MCP_SERVERS_DISABLED: '',
      },
    }));

    const service = new McpConfigService(home, new SettingsService(dataDir));

    await expect(service.list(workspace)).resolves.toEqual([
      { name: 'context7', config: { command: 'npx' }, enabled: true, scope: 'settings' },
      { name: 'deepwiki', config: { command: 'npx' }, enabled: true, scope: 'settings' },
    ]);
  });

  it('lists settings, global, and project configs with project precedence', async () => {
    const { home, workspace, settings } = await fixture();
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await mkdir(join(workspace, '.pi'), { recursive: true });
    await writeFile(join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({
      mcpServers: { global: { command: 'global' }, shared: { command: 'global' } },
    }));
    await writeFile(join(workspace, '.pi', 'mcp.json'), JSON.stringify({
      mcpServers: { project: { command: 'project' }, shared: { command: 'project' } },
      disabledMcpServers: { disabledProject: { command: 'disabled' } },
    }));
    const service = new McpConfigService(home, settings);

    await expect(service.list(workspace)).resolves.toEqual([
      { name: 'disabledProject', config: { command: 'disabled' }, enabled: false, scope: 'project' },
      { name: 'disabledSettings', config: { command: 'off' }, enabled: false, scope: 'settings' },
      { name: 'global', config: { command: 'global' }, enabled: true, scope: 'global' },
      { name: 'project', config: { command: 'project' }, enabled: true, scope: 'project' },
      { name: 'settings', config: { command: 'settings' }, enabled: true, scope: 'settings' },
      { name: 'shared', config: { command: 'project' }, enabled: true, scope: 'project' },
    ]);
  });

  it('writes settings scope as separate enabled and disabled collections', async () => {
    const { home, workspace, settings, currentSettings } = await fixture();
    const service = new McpConfigService(home, settings);

    await service.upsert(workspace, 'settings', 'shared', { url: 'https://example.com/mcp' }, false);

    expect(JSON.parse(currentSettings().MCP_SERVERS)).toEqual({ mcpServers: { settings: { command: 'settings' } } });
    expect(JSON.parse(currentSettings().MCP_SERVERS_DISABLED)).toEqual({
      mcpServers: { disabledSettings: { command: 'off' }, shared: { url: 'https://example.com/mcp' } },
    });
  });

  it('persists global config and removes it without discarding unrelated document fields', async () => {
    const { home, workspace, settings } = await fixture();
    const path = join(home, '.pi', 'agent', 'mcp.json');
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await writeFile(path, JSON.stringify({ metadata: { owner: 'user' }, mcpServers: { old: { command: 'old' } } }));
    const service = new McpConfigService(home, settings);

    await service.upsert(workspace, 'global', 'new', { command: 'npx', args: ['-y'] }, true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      metadata: { owner: 'user' },
      mcpServers: { old: { command: 'old' }, new: { command: 'npx', args: ['-y'] } },
    });
    await service.remove(workspace, 'global', 'old');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      metadata: { owner: 'user' },
      mcpServers: { new: { command: 'npx', args: ['-y'] } },
    });
  });

  it('rejects invalid scope and a config without command or url', async () => {
    const { home, workspace, settings } = await fixture();
    const service = new McpConfigService(home, settings);

    await expect(service.upsert(workspace, 'unknown', 'server', { command: 'x' }, true)).rejects.toThrow('未知 MCP 作用域');
    await expect(service.upsert(workspace, 'project', 'server', { args: [] }, true)).rejects.toThrow('MCP 配置必须包含 command 或 url');
  });

  it('returns only effective project servers and replaces inline secrets with credential references', async () => {
    const { home, workspace, settings } = await fixture();
    await mkdir(join(home, '.pi', 'agent'), { recursive: true });
    await mkdir(join(workspace, '.pi'), { recursive: true });
    await writeFile(join(home, '.pi', 'agent', 'mcp.json'), JSON.stringify({
      mcpServers: {
        shared: { command: 'global', env: { API_TOKEN: 'global-secret', MODE: 'dev' } },
        global: { url: 'https://example.com', headers: { Authorization: 'Bearer secret' } },
      },
    }));
    await writeFile(join(workspace, '.pi', 'mcp.json'), JSON.stringify({
      mcpServers: { shared: { command: 'project', env: { API_TOKEN: 'project-secret' } } },
      disabledMcpServers: { global: { url: 'https://example.com' } },
    }));
    const service = new McpConfigService(home, settings);

    const effective = await service.effective(workspace);

    expect(effective).toEqual([
      { name: 'settings', config: { command: 'settings' } },
      { name: 'shared', config: { command: 'project', env: { API_TOKEN: { credentialRef: 'mcp/shared/env/API_TOKEN' } } } },
    ]);
    expect(JSON.stringify(effective)).not.toContain('project-secret');
    expect(JSON.stringify(effective)).not.toContain('global-secret');
    expect(JSON.stringify(effective)).not.toContain('Bearer secret');
  });

  it('keeps raw credentials only for the internal Pi launch path', async () => {
    const { home, workspace, settings } = await fixture();
    await mkdir(join(workspace, '.pi'), { recursive: true });
    await writeFile(join(workspace, '.pi', 'mcp.json'), JSON.stringify({ mcpServers: { secure: { command: 'server', env: { API_TOKEN: 'secret' } } } }));
    const service = new McpConfigService(home, settings);

    await expect(service.effective(workspace)).resolves.toEqual(expect.arrayContaining([{ name: 'secure', config: { command: 'server', env: { API_TOKEN: { credentialRef: 'mcp/secure/env/API_TOKEN' } } } }]));
    await expect(service.runtime(workspace)).resolves.toEqual(expect.arrayContaining([{ name: 'secure', config: { command: 'server', env: { API_TOKEN: 'secret' } } }]));
  });

  it('reload 按 workspace 与 name 转发，不写配置文件', async () => {
    const { home, workspace, settings, currentSettings } = await fixture();
    const reload = vi.fn(async () => [] as unknown[]);
    const before = JSON.stringify(currentSettings());
    const service = new McpConfigService(home, settings, { reload });

    await service.reload(workspace, 'settings');

    expect(reload).toHaveBeenCalledWith(workspace, 'settings');
    expect(JSON.stringify(currentSettings())).toBe(before);
  });

  it('reload 把运行时带回的状态按这个 workspace 发布给界面', async () => {
    const { home, workspace, settings } = await fixture();
    const servers = [{ name: 'settings', status: 'connected', tools: 2 }];
    const publish = vi.fn();
    const service = new McpConfigService(home, settings, { reload: async () => servers, publish });

    await service.reload(workspace, 'settings');

    expect(publish).toHaveBeenCalledWith(workspace, servers);
  });

  it('运行时没带回状态（旧子进程）时不发布空列表把界面清掉', async () => {
    const { home, workspace, settings } = await fixture();
    const publish = vi.fn();
    const service = new McpConfigService(home, settings, { reload: async () => null, publish });

    await service.reload(workspace, 'settings');

    expect(publish).not.toHaveBeenCalled();
  });

  it('改配置后把该工作区完整的 runtime 列表交给运行时热重载', async () => {
    const { home, workspace, settings } = await fixture();
    const hotReload = vi.fn(async () => {});
    const service = new McpConfigService(home, settings, { hotReload });

    await service.upsert(workspace, 'settings', 'added', { command: 'new' }, true);

    expect(hotReload).toHaveBeenCalledTimes(1);
    const [target, runtimeJson] = hotReload.mock.calls[0] as unknown as [string, string];
    expect(target).toBe(workspace);
    expect((JSON.parse(runtimeJson) as Array<{ name: string }>).map((entry) => entry.name)).toEqual(expect.arrayContaining(['added', 'settings']));
  });

  it('运行时还没接上时 reload 明确失败', async () => {
    const { home, workspace, settings } = await fixture();
    await expect(new McpConfigService(home, settings).reload(workspace, 'settings')).rejects.toThrow('MCP runtime is not available');
  });
});
