import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '../../../cli/src/pi-sdk.js';
import { PiPackageService } from './piPackageService';
import type { PackageSource } from './piPackageModel';

afterEach(() => {
  vi.unstubAllGlobals();
});

function service(fetchImpl: typeof fetch) {
  return new PiPackageService({
    agentDir: 'C:/tmp/agent',
    allowedPluginIds: () => [],
    fetchImpl,
  });
}

describe('PiPackageService.search', () => {
  it('queries keywords:pi-package, size 20, no from, and maps hits', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url.startsWith('https://registry.npmjs.org/-/v1/search?')).toBe(true);
      const parsed = new URL(url);
      expect(parsed.searchParams.get('text')).toBe('keywords:pi-package demo');
      expect(parsed.searchParams.get('size')).toBe('20');
      expect(parsed.searchParams.get('from')).toBeNull();
      return new Response(JSON.stringify({
        total: 9908,
        objects: [{ package: { name: 'pi-demo', version: '2.0.0', description: 'd', publisher: { username: 'ada' } } }],
      }), { status: 200 });
    });
    const result = await service(fetchImpl).search('demo');
    expect(result.total).toBe(9908);
    expect(result.objects[0]?.name).toBe('pi-demo');
  });

  it('sanitizes colons out of the user query before calling npm', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get('text')).toBe('keywords:pi-package foo bar');
      return new Response(JSON.stringify({ total: 0, objects: [] }), { status: 200 });
    });
    await service(fetchImpl).search('foo:bar');
  });

  it('uses keywords:pi-package alone when the query is empty', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      expect(new URL(String(input)).searchParams.get('text')).toBe('keywords:pi-package');
      return new Response(JSON.stringify({ total: 1, objects: [] }), { status: 200 });
    });
    await service(fetchImpl).search('   ');
  });

  it('throws a short message when the registry is not ok', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 }));
    await expect(service(fetchImpl).search('x')).rejects.toThrow(/HTTP 503/);
  });
});

function fakeSettings(init: { global?: PackageSource[]; project?: PackageSource[] }) {
  let globalPkgs = [...(init.global ?? [])];
  let projectPkgs = [...(init.project ?? [])];
  return {
    getGlobalSettings: () => ({ packages: globalPkgs }),
    getProjectSettings: () => ({ packages: projectPkgs }),
    setPackages: vi.fn((next: PackageSource[]) => { globalPkgs = next; }),
    setProjectPackages: vi.fn((next: PackageSource[]) => { projectPkgs = next; }),
    getPackages: vi.fn(() => [...projectPkgs, ...globalPkgs]),
    snapshot: () => ({ globalPkgs, projectPkgs }),
  };
}

function fakeManager(list: Array<{ source: string; scope: 'user' | 'project'; filtered: boolean }>) {
  return {
    listConfiguredPackages: () => list,
    installAndPersist: vi.fn(async () => {}),
    removeAndPersist: vi.fn(async () => true),
  };
}

const builtins = [
  { name: 'safety' },
  { name: 'todo' },
  { name: 'lsp' },
  { name: 'goal', manifest: { id: 'goal' } },
  { name: 'code-exec' },
];

describe('PiPackageService.list', () => {
  it('lists CORE_ALWAYS_ON plus allowed managed plugins, not CHAT_EXCLUDED unmanaged names', async () => {
    const settings = fakeSettings({
      global: [
        'npm:user-pkg@1.0.0',
        { source: 'npm:off-pkg@2.0.0', autoload: false },
        { source: 'npm:on-pkg@1.0.0', autoload: true, skills: ['a'] },
      ],
      project: ['npm:proj-pkg@3.0.0'],
    });
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => ['goal'],
      extensions: builtins,
      profile: 'project',
      createSettingsManager: () => settings,
      createPackageManager: () => fakeManager([
        { source: 'npm:user-pkg@1.0.0', scope: 'user', filtered: false },
        { source: 'npm:off-pkg@2.0.0', scope: 'user', filtered: true },
        { source: 'npm:on-pkg@1.0.0', scope: 'user', filtered: true },
        { source: 'npm:proj-pkg@3.0.0', scope: 'project', filtered: false },
      ]),
    });
    const items = await svc.list('C:/ws');
    const builtinIds = items.filter((item) => item.kind === 'builtin').map((item) => item.id);
    expect(builtinIds).toEqual(['safety', 'todo', 'goal']);
    expect(builtinIds).not.toContain('lsp');
    expect(builtinIds).not.toContain('code-exec');
    const off = items.find((item) => item.id === 'npm:off-pkg@2.0.0');
    expect(off?.enabled).toBe(false);
    expect(off?.canDisable).toBe(true);
    const on = items.find((item) => item.id === 'npm:on-pkg@1.0.0');
    expect(on?.enabled).toBe(true);
    const user = items.find((item) => item.id === 'npm:user-pkg@1.0.0');
    expect(user?.enabled).toBe(true);
    expect(user?.title).toBe('user-pkg');
    expect(items.find((item) => item.id === 'safety')?.canDisable).toBe(false);
    expect(items.find((item) => item.id === 'npm:proj-pkg@3.0.0')?.scope).toBe('project');
  });

  it('hides project packages when no workspace is open', async () => {
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [{ name: 'safety' }],
      createSettingsManager: () => fakeSettings({
        global: ['npm:user-pkg'],
        project: ['npm:proj-pkg'],
      }),
      createPackageManager: () => fakeManager([
        { source: 'npm:user-pkg', scope: 'user', filtered: false },
        { source: 'npm:proj-pkg', scope: 'project', filtered: false },
      ]),
    });
    const items = await svc.list('');
    expect(items.some((item) => item.id === 'npm:proj-pkg')).toBe(false);
    expect(items.some((item) => item.id === 'npm:user-pkg')).toBe(true);
  });
});

describe('PiPackageService.setEnabled', () => {
  it('does not copy a project package into user settings when disabling it', async () => {
    const settings = fakeSettings({
      global: ['npm:user-pkg@1.0.0'],
      project: [{ source: 'npm:proj-pkg@3.0.0', skills: ['kept'] }],
    });
    const reload = vi.fn(() => true);
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: reload,
      createSettingsManager: () => settings,
      createPackageManager: () => fakeManager([]),
    });
    await svc.setEnabled('C:/ws', 'npm:proj-pkg@9.9.9', 'project', false);
    expect(settings.setPackages).not.toHaveBeenCalled();
    expect(settings.getPackages).not.toHaveBeenCalled();
    expect(settings.setProjectPackages).toHaveBeenCalledTimes(1);
    expect(settings.snapshot().globalPkgs).toEqual(['npm:user-pkg@1.0.0']);
    expect(settings.snapshot().projectPkgs).toEqual([{
      source: 'npm:proj-pkg@3.0.0',
      autoload: false,
      skills: ['kept'],
    }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not write project settings when disabling a user package', async () => {
    const settings = fakeSettings({
      global: ['npm:user-pkg@1.0.0'],
      project: ['npm:proj-pkg'],
    });
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: vi.fn(() => true),
      createSettingsManager: () => settings,
      createPackageManager: () => fakeManager([]),
    });
    await svc.setEnabled('C:/ws', 'npm:user-pkg@1.0.0', 'user', false);
    expect(settings.setProjectPackages).not.toHaveBeenCalled();
    expect(settings.snapshot().projectPkgs).toEqual(['npm:proj-pkg']);
    expect(settings.snapshot().globalPkgs).toEqual([{ source: 'npm:user-pkg@1.0.0', autoload: false }]);
  });

  it('leaves ~/.pi/agent/settings.json bytes unchanged when toggling a project package', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-pkg-m2-'));
    const agentDir = join(root, 'agent');
    const workspace = join(root, 'ws');
    await mkdir(agentDir, { recursive: true });
    await mkdir(join(workspace, '.pi'), { recursive: true });
    const userFile = join(agentDir, 'settings.json');
    await writeFile(userFile, `${JSON.stringify({ packages: ['npm:user-pkg@1.0.0'] }, null, 2)}\n`);
    await writeFile(join(workspace, '.pi/settings.json'), `${JSON.stringify({ packages: ['npm:proj-pkg@3.0.0'] }, null, 2)}\n`);
    const before = await readFile(userFile, 'utf8');
    let created: SettingsManager | undefined;
    const svc = new PiPackageService({
      agentDir,
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: () => true,
      createSettingsManager: (cwd, dir) => {
        created = SettingsManager.create(cwd, dir);
        return created;
      },
      createPackageManager: () => fakeManager([]),
    });
    await svc.setEnabled(workspace, 'npm:proj-pkg@3.0.0', 'project', false);
    if (created && 'flush' in created) await created.flush();
    expect(await readFile(userFile, 'utf8')).toBe(before);
    await rm(root, { recursive: true, force: true });
  });
});

describe('PiPackageService.install and remove', () => {
  it('pins npm:name@version, passes local for project scope, then reloads', async () => {
    const manager = fakeManager([]);
    const reload = vi.fn(() => true);
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: reload,
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => manager,
    });
    await svc.install('C:/ws', 'pi-demo', '2.0.0', 'project');
    expect(manager.installAndPersist).toHaveBeenCalledWith('npm:pi-demo@2.0.0', { local: true });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid names with INVALID_PACKAGE', async () => {
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => fakeManager([]),
    });
    await expect(svc.install('C:/ws', 'UPPER', '1.0.0', 'user')).rejects.toThrow('INVALID_PACKAGE');
    await expect(svc.install('C:/ws', 'ok', 'latest', 'user')).rejects.toThrow('INVALID_PACKAGE');
  });

  it('still reloads when removeAndPersist returns false', async () => {
    const manager = fakeManager([]);
    manager.removeAndPersist = vi.fn(async () => false);
    const reload = vi.fn(() => true);
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      requestReload: reload,
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => manager,
    });
    await svc.remove('C:/ws', 'npm:missing', 'user');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses project install without a workspace', async () => {
    const svc = new PiPackageService({
      agentDir: 'C:/tmp/agent',
      allowedPluginIds: () => [],
      extensions: [],
      createSettingsManager: () => fakeSettings({}),
      createPackageManager: () => fakeManager([]),
    });
    await expect(svc.install('', 'pi-demo', '1.0.0', 'project')).rejects.toThrow('请先打开项目');
  });
});
