import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
  BrowserWindow: {
    fromWebContents: (sender: { getOwnerBrowserWindow?: () => unknown }) => sender.getOwnerBrowserWindow?.(),
  },
}));

vi.mock('electron', () => electron);

import { getRegisteredCommands, registerIpcHandlers } from './register';
import { IPC_CHANNELS } from './contracts';

function handler(channel: string): (...args: any[]) => any {
  const entry = electron.ipcMain.handle.mock.calls.find(([registered]) => registered === channel);
  if (!entry) throw new Error(`No handler registered for ${channel}`);
  return entry[1];
}

describe('registerIpcHandlers', () => {
  it('dispatches operations only to fixed management methods and opens diagnostic IDs not caller paths', async () => {
    const agentData = { requestAdmin: vi.fn().mockResolvedValue({}), request: vi.fn(), resolveDiagnosticPath: vi.fn().mockResolvedValue('D:/safe/wiki/page.md') };
    registerIpcHandlers({ agentData: agentData as never }); const invoke = handler(IPC_CHANNELS.invoke);
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['tasks_list', 'admin.tasks.list', { source: 'system', group: 'active', limit: 10 }],
      ['tasks_read', 'admin.tasks.read', { source: 'system', id: 'same' }], ['tasks_previewRetry', 'admin.tasks.previewRetry', { source: 'user', id: 'same' }],
      ['tasks_retry', 'admin.tasks.retry', { source: 'user', id: 'same', expectedModel: 'model' }],
      ['audit_query', 'admin.audit.query', { action: 'job.stage' }], ['audit_export', 'admin.audit.export', { from: 1, to: 2 }],
      ['diagnostics_check', 'admin.diagnostics.check', {}], ['overview', 'admin.overview', { userId: 'u' }],
    ];
    for (const [command, method, args] of cases) {
      await invoke({}, { command: `agentData_${command}`, args });
      expect(agentData.requestAdmin).toHaveBeenLastCalledWith(method, args);
    }
    await invoke({}, { command: 'agentData_diagnostics_open', args: { id: 'known', path: 'D:/untrusted/file' } });
    expect(agentData.resolveDiagnosticPath).toHaveBeenCalledExactlyOnceWith('known');
    expect(electron.shell.openPath).toHaveBeenCalledWith('D:/safe/wiki/page.md');
    expect(agentData.request).not.toHaveBeenCalled();
  });

  it('routes Memory management through fixed in-process methods instead of the socket', async () => {
    const requestAdmin = vi.fn().mockResolvedValue({}), request = vi.fn();
    registerIpcHandlers({ agentData: { requestAdmin, request } as never }); const invoke = handler(IPC_CHANNELS.invoke);
    const draft = { content: 'manual', level: 2, owner: { scope: 'global' } };
    const cases: Array<[string, Record<string, unknown>]> = [
      ['list', { userId: 'u', filter: { scope: 'all' }, query: '', cursor: 'cursor', limit: 50 }], ['read', { userId: 'u', id: 'm' }],
      ['create', { userId: 'u', draft }], ['update', { userId: 'u', id: 'm', expectedRevision: 2, draft }],
      ['conversations.list', { userId: 'u', filter: { scope: 'project', projectId: 'D:/real' } }], ['conversations.read', { userId: 'u', id: 'capture' }],
    ];
    for (const [method, args] of cases) {
      await invoke({}, { command: `agentData_memory_${method.replace('.', '_')}`, args });
      expect(requestAdmin).toHaveBeenLastCalledWith(`memory.${method}`, args);
    }
    await invoke({}, { command: 'agentData_memory_delete', args: { userId: 'u', id: 'm', workspace: 'D:/current-chat' } });
    expect(requestAdmin).toHaveBeenLastCalledWith('memory.delete', { userId: 'u', id: 'm' });
    expect(request).not.toHaveBeenCalled();
  });

  it('dispatches every Wiki management operation to its fixed method with only supported fields', async () => {
    const agentData = { requestAdmin: vi.fn().mockResolvedValue({}), request: vi.fn() };
    registerIpcHandlers({ agentData: agentData as never }); const invoke = handler(IPC_CHANNELS.invoke);
    const wikiId = 'w1';
    const operations: Array<[string, Record<string, unknown>]> = [
      ['create', { name: '产品' }], ['read', { wikiId }], ['list', {}], ['update', { wikiId, name: '新品', summary: '摘要' }],
      ['remove', { wikiId }], ['resetDraft', { wikiId }], ['ingest', { wikiId }],
      ['rawWrite', { wikiId, filename: 'note.md', content: '原文' }], ['rawRemove', { wikiId, filename: 'note.md' }],
      ['rawList', { wikiId }], ['rawRead', { wikiId, filename: 'note.md' }],
      ['writeTemplate', { wikiId, name: 'purpose', content: '# purpose' }],
      ['pageWrite', { wikiId, ref: 'concepts/auth', content: '# 权限' }], ['pageRemove', { wikiId, ref: 'concepts/auth' }],
      ['pageList', { wikiId }], ['pageRead', { wikiId, ref: 'concepts/auth' }],
      ['search', { wikiId, query: '权限', limit: 10, hop: 1 }], ['graph', { wikiId }],
    ];
    for (const [method, args] of operations) {
      await invoke({}, { command: `agentData_wiki_${method}`, args: { ...args, method: 'untrusted', admin: false } });
      expect(agentData.requestAdmin).toHaveBeenLastCalledWith(`wiki.${method}`, args);
    }
    expect(agentData.request).not.toHaveBeenCalled();
  });

  it('uses a fixed in-process Wiki admin entry and rejects unknown wiki invoke', async () => {
    const agentData = { requestAdmin: vi.fn().mockResolvedValue({ wikiId: 'w' }), request: vi.fn() };
    registerIpcHandlers({ agentData: agentData as never }); const invoke = handler(IPC_CHANNELS.invoke);
    await invoke({}, { command: 'agentData_wiki_create', args: { name: '手册', admin: false, method: 'wiki.deleteWorkspace' } });
    expect(agentData.requestAdmin).toHaveBeenCalledWith('wiki.create', { name: '手册' });
    expect(agentData.request).not.toHaveBeenCalled();
    await invoke({}, { command: 'agentData_wiki_pageWrite', args: { wikiId: 'w', ref: 'concepts/a', content: '# a' } });
    expect(agentData.requestAdmin).toHaveBeenLastCalledWith('wiki.pageWrite', { wikiId: 'w', ref: 'concepts/a', content: '# a' });
    await expect(invoke({}, { command: 'agentData_wiki_invoke', args: { method: 'wiki.list' } })).rejects.toThrow();
  });

  beforeEach(() => {
    electron.ipcMain.handle.mockReset();
  });

  it('routes UI history commands and permits empty content', async () => {
    const uiHistory = {
      read: vi.fn().mockResolvedValue('saved'),
      write: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    registerIpcHandlers({ uiHistory });
    const invoke = handler(IPC_CHANNELS.invoke);
    const event = {};

    await expect(invoke(event, { command: 'ui_history_read', args: { workspace: 'C:/project', sessionKey: 's' } })).resolves.toBe('saved');
    await expect(invoke(event, { command: 'ui_history_write', args: { workspace: 'C:/project', sessionKey: 's', content: '' } })).resolves.toBeUndefined();
    await expect(invoke(event, { command: 'ui_history_delete', args: { workspace: 'C:/project', sessionKey: 's' } })).resolves.toBeUndefined();
    expect(uiHistory.read).toHaveBeenCalledWith('C:/project', 's');
    expect(uiHistory.write).toHaveBeenCalledWith('C:/project', 's', '');
    expect(uiHistory.delete).toHaveBeenCalledWith('C:/project', 's');
  });

  it('routes workspace approval commands', async () => {
    const workspaceApproval = { approve: vi.fn().mockResolvedValue(undefined), isApproved: vi.fn().mockResolvedValue(true) };
    registerIpcHandlers({ workspaceApproval });
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'request_workspace_approval', args: { path: 'C:/project' } })).resolves.toBeUndefined();
    await expect(invoke({}, { command: 'is_workspace_approved', args: { path: 'C:/project' } })).resolves.toBe(true);
    expect(workspaceApproval.approve).toHaveBeenCalledWith('C:/project');
    expect(workspaceApproval.isApproved).toHaveBeenCalledWith('C:/project');
  });

  it('registers permission and effective MCP configuration commands', () => {
    registerIpcHandlers({
      permissions: { authorize: vi.fn(), resolve: vi.fn() } as any,
      mcpConfig: { effective: vi.fn(), list: vi.fn(), upsert: vi.fn(), remove: vi.fn() } as any,
    });
    const commands = getRegisteredCommands();
    expect(commands).toContain('permission_evaluate');
    expect(commands).toContain('permission_resolve');
    expect(commands).toContain('effective_mcp_configs');
  });

  it('resolves permission requests with the requestId contract', async () => {
    const permissions = { authorize: vi.fn(), resolve: vi.fn().mockResolvedValue({ id: 'p1', status: 'resolved' }) };
    registerIpcHandlers({ permissions } as any);
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'permission_resolve', args: { requestId: 'p1', resolution: 'allow' } })).resolves.toMatchObject({ id: 'p1' });
    expect(permissions.resolve).toHaveBeenCalledWith('p1', 'allow');
  });

  it('returns serialized plugin state and routes lifecycle commands', async () => {
    const plugins = {
      list: vi.fn(() => [{ id: 'goal', state: 'ready', updatedAt: 1 }]),
      start: vi.fn(async () => ({ id: 'goal', state: 'ready', updatedAt: 2 })),
      stop: vi.fn(async () => ({ id: 'goal', state: 'stopped', updatedAt: 3 })),
      allowedPluginIds: vi.fn(() => ['goal']),
    };
    registerIpcHandlers({ plugins } as any);
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'plugin_list' })).resolves.toEqual([{ id: 'goal', state: 'ready', updatedAt: 1 }]);
    await expect(invoke({}, { command: 'plugin_start', args: { id: 'goal' } })).resolves.toMatchObject({ state: 'ready' });
    await expect(invoke({}, { command: 'plugin_stop', args: { id: 'goal' } })).resolves.toMatchObject({ state: 'stopped' });
    await expect(invoke({}, { command: 'plugin_allowed_list' })).resolves.toEqual(['goal']);
  });

  it('routes package commands onto PiPackageService', async () => {
    const piPackages = {
      list: vi.fn(async () => []),
      search: vi.fn(async () => ({ objects: [], total: 0 })),
      install: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
    };
    registerIpcHandlers({ piPackages } as any);
    const invoke = handler(IPC_CHANNELS.invoke);
    await invoke({}, { command: 'package_list', args: { workspace: '' } });
    await invoke({}, { command: 'package_search', args: { query: '' } });
    await invoke({}, { command: 'package_install', args: { workspace: 'C:/ws', name: 'pi-demo', version: '1.0.0', scope: 'user' } });
    await invoke({}, { command: 'package_remove', args: { workspace: 'C:/ws', source: 'npm:pi-demo@1.0.0', scope: 'user' } });
    await invoke({}, { command: 'package_set_enabled', args: { workspace: 'C:/ws', source: 'npm:pi-demo@1.0.0', scope: 'project', enabled: false } });
    expect(piPackages.list).toHaveBeenCalledWith('');
    expect(piPackages.search).toHaveBeenCalledWith('');
    expect(piPackages.install).toHaveBeenCalledWith('C:/ws', 'pi-demo', '1.0.0', 'user');
    expect(piPackages.remove).toHaveBeenCalledWith('C:/ws', 'npm:pi-demo@1.0.0', 'user');
    expect(piPackages.setEnabled).toHaveBeenCalledWith('C:/ws', 'npm:pi-demo@1.0.0', 'project', false);
  });

  it('routes all Git commands with their contract argument names', async () => {
    const git = {
      status: vi.fn().mockResolvedValue([]), diff: vi.fn().mockResolvedValue(''), branches: vi.fn().mockResolvedValue({ current: '', branches: [] }),
      checkout: vi.fn().mockResolvedValue(undefined), createBranch: vi.fn().mockResolvedValue(undefined), logGraph: vi.fn().mockResolvedValue([]),
    };
    registerIpcHandlers({ git });
    const invoke = handler(IPC_CHANNELS.invoke);

    await invoke({}, { command: 'get_git_status', args: { workspacePath: 'C:/project' } });
    await invoke({}, { command: 'get_git_diff', args: { workspacePath: 'C:/project', filePath: 'file.ts' } });
    await invoke({}, { command: 'get_git_branches', args: { workspacePath: 'C:/project' } });
    await invoke({}, { command: 'git_checkout', args: { workspacePath: 'C:/project', branch: 'main' } });
    await invoke({}, { command: 'git_create_branch', args: { workspacePath: 'C:/project', name: 'feature/x', checkout: true } });
    await invoke({}, { command: 'get_git_log_graph', args: { workspacePath: 'C:/project', limit: null } });
    await invoke({}, { command: 'get_git_log_graph', args: { workspacePath: 'C:/project', limit: 300, skip: 600 } });
    await expect(invoke({}, { command: 'get_git_log_graph', args: { workspacePath: 'C:/project', limit: 300, skip: -1 } })).rejects.toThrow('skip');
    expect(git.status).toHaveBeenCalledWith('C:/project');
    expect(git.diff).toHaveBeenCalledWith('C:/project', 'file.ts');
    expect(git.branches).toHaveBeenCalledWith('C:/project');
    expect(git.checkout).toHaveBeenCalledWith('C:/project', 'main');
    expect(git.createBranch).toHaveBeenCalledWith('C:/project', 'feature/x', true);
    expect(git.logGraph).toHaveBeenCalledWith('C:/project', null, 0);
    expect(git.logGraph).toHaveBeenCalledWith('C:/project', 300, 600);
  });

  it('routes execute_command with string arguments and optional workspace', async () => {
    const terminal = { execute: vi.fn().mockResolvedValue(undefined) };
    registerIpcHandlers({ terminal });
    await expect(handler(IPC_CHANNELS.invoke)({}, {
      command: 'execute_command', args: { command: 'git', args: ['status'], workspace: 'C:/project' },
    })).resolves.toBeUndefined();
    expect(terminal.execute).toHaveBeenCalledWith('git', ['status'], 'C:/project');
  });

  it('routes Agent Data management commands without exposing runtime details', async () => {
    const agentData = { request: vi.fn(async (method: string) => ({ method })) };
    registerIpcHandlers({ agentData } as any);
    const invoke = handler(IPC_CHANNELS.invoke);
    await expect(invoke({}, { command: 'agentData_admin_jobs_list', args: {} })).resolves.toEqual({ method: 'admin.jobs.list' });
    await expect(invoke({}, { command: 'agentData_admin_config_update', args: { module: 'memory', value: {}, version: 0 } })).resolves.toEqual({ method: 'admin.config.update' });
    await expect(invoke({}, { command: 'agentData_admin_jobs_remove', args: { id: 'job-1' } })).resolves.toEqual({ method: 'admin.jobs.remove' });
    await expect(invoke({}, { command: 'agentData_admin_jobs_clear', args: { ids: ['job-1', 'job-2'] } })).resolves.toEqual({ method: 'admin.jobs.clear' });
    expect(agentData.request).toHaveBeenCalledWith('admin.jobs.remove', { id: 'job-1' });
    expect(agentData.request).toHaveBeenCalledWith('admin.jobs.clear', { ids: ['job-1', 'job-2'] });
  });

  it('routes Agent Data module queries and job creation with explicit scope', async () => {
    const agentData = { request: vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params })), requestAdmin: vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params })) };
    registerIpcHandlers({ agentData } as any);
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'agentData_memory_overview', args: { userId: 'u', workspace: '/w' } })).resolves.toEqual({
      method: 'memory.admin.overview', params: { userId: 'u', workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_code_status', args: { workspace: '/w' } })).resolves.toEqual({
      method: 'codeRetrieval.admin.status', params: { workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_jobs_create', args: { kind: 'codegraph.sync', workspace: '/w' } })).resolves.toEqual({
      method: 'admin.jobs.create', params: { kind: 'codegraph.sync', workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_memory_overview', args: { userId: 'u', includeOtherProjects: true } })).resolves.toEqual({
      method: 'memory.admin.overview', params: { userId: 'u', includeOtherProjects: true },
    });
    await expect(invoke({}, { command: 'agentData_memory_search', args: { userId: 'u', projectId: '/w', query: 'x', limit: 10 } })).resolves.toEqual({
      method: 'memory.search', params: { userId: 'u', projectId: '/w', query: 'x', limit: 10 },
    });
    await expect(invoke({}, { command: 'agentData_code_projects', args: {} })).resolves.toEqual({
      method: 'codeRetrieval.admin.projects', params: {},
    });
  });

  it('routes app server thread and turn commands through Agent Data', async () => {
    const agentData = {
      createThread: vi.fn().mockResolvedValue({ id: 't' }),
      listThreads: vi.fn().mockResolvedValue([]),
      readThread: vi.fn().mockResolvedValue(undefined),
      createTurn: vi.fn().mockResolvedValue({ id: 'turn' }),
      updateTurn: vi.fn().mockResolvedValue({ id: 'turn', status: 'failed' }),
      upsertItem: vi.fn().mockResolvedValue({ id: 'item' }),
      listItems: vi.fn().mockResolvedValue([]),
    };
    registerIpcHandlers({ agentData } as any);
    const invoke = handler(IPC_CHANNELS.invoke);
    await expect(invoke({}, { command: 'thread_create', args: { id: 't', projectId: 'p', workspace: '/w' } })).resolves.toEqual({ id: 't' });
    await expect(invoke({}, { command: 'turn_update', args: { id: 'turn', status: 'failed', error: 'boom' } })).resolves.toEqual({ id: 'turn', status: 'failed' });
    expect(agentData.createThread).toHaveBeenCalledWith({ id: 't', projectId: 'p', workspace: '/w' });
    expect(agentData.updateTurn).toHaveBeenCalledWith('turn', { status: 'failed', error: 'boom' });
  });

  it('controls the owner BrowserWindow through the window IPC handlers', async () => {
    const window = {
      minimize: vi.fn(), maximize: vi.fn(), unmaximize: vi.fn(), isMaximized: vi.fn().mockReturnValue(false), close: vi.fn(),
    };
    const event = { sender: { getOwnerBrowserWindow: () => window } };
    registerIpcHandlers();

    await handler(IPC_CHANNELS.windowMinimize)(event);
    await handler(IPC_CHANNELS.windowToggleMaximize)(event);
    expect(handler(IPC_CHANNELS.windowIsMaximized)(event)).toBe(false);
    await handler(IPC_CHANNELS.windowClose)(event);
    expect(window.minimize).toHaveBeenCalledOnce();
    expect(window.maximize).toHaveBeenCalledOnce();
    expect(window.close).toHaveBeenCalledOnce();

    window.isMaximized.mockReturnValue(true);
    await handler(IPC_CHANNELS.windowToggleMaximize)(event);
    expect(window.unmaximize).toHaveBeenCalledOnce();
  });

  it('sets the owner window background and remembers it for the next launch', async () => {
    const window = { setBackgroundColor: vi.fn() };
    const windowBackground = { save: vi.fn().mockResolvedValue(undefined) };
    const event = { sender: { getOwnerBrowserWindow: () => window } };
    registerIpcHandlers({ windowBackground: windowBackground as never });

    await handler(IPC_CHANNELS.windowSetBackground)(event, '#ffffff');
    expect(window.setBackgroundColor).toHaveBeenCalledWith('#ffffff');
    expect(windowBackground.save).toHaveBeenCalledWith('#ffffff');

    await expect(handler(IPC_CHANNELS.windowSetBackground)(event, 'url(evil)')).rejects.toThrow();
    expect(window.setBackgroundColor).toHaveBeenCalledOnce();
    expect(windowBackground.save).toHaveBeenCalledOnce();
  });

  it('enhance_prompt 从 onChunk.__grenChannelId 推 delta，abort 调 service.abort', async () => {
    const run = vi.fn(async (_input: unknown, emit: (chunk: string) => void) => {
      emit('chunk-1');
      return { ok: true, content: 'chunk-1' };
    });
    const abort = vi.fn();
    registerIpcHandlers({ enhancePrompt: { run, abort } } as never);
    const invoke = handler(IPC_CHANNELS.invoke);
    const sender = { send: vi.fn() };
    await invoke({ sender }, { command: 'enhance_prompt', args: { workspace: '/ws', text: 'hello', onChunk: { __grenChannelId: 'channel-9' } } });
    expect(run).toHaveBeenCalledWith(
      { workspace: '/ws', text: 'hello', goalText: '' },
      expect.any(Function),
    );
    expect(sender.send).toHaveBeenCalledWith(`${IPC_CHANNELS.eventPrefix}channel:channel-9`, 'chunk-1');
    await invoke({ sender }, { command: 'enhance_prompt_abort', args: { workspace: '/ws' } });
    expect(abort).toHaveBeenCalledWith('/ws');
  });

  it('diagnose_provider_model 带 requestId / 思考档、分片推到 channel；abort 按 requestId 取消；非法档位拒绝', async () => {
    const diagnose = vi.fn(async (_request: unknown, emit: (chunk: unknown) => void) => {
      emit({ type: 'thinking', text: 't' });
      return { ok: true };
    });
    const abortDiagnose = vi.fn();
    registerIpcHandlers({ provider: { diagnose, abortDiagnose } } as never);
    const invoke = handler(IPC_CHANNELS.invoke);
    const sender = { send: vi.fn() };
    const args = { requestId: 'req-1', providerId: 'p', modelId: 'm', prompt: 'hi', stream: true, onChunk: { __grenChannelId: 'c-1' } };

    await invoke({ sender }, { command: 'diagnose_provider_model', args: { ...args, reasoning: 'high' } });
    await invoke({ sender }, { command: 'diagnose_provider_model', args });
    await expect(invoke({ sender }, { command: 'diagnose_provider_model', args: { ...args, reasoning: 'off' } })).rejects.toThrow(/reasoning/);
    await invoke({ sender }, { command: 'diagnose_provider_model_abort', args: { requestId: 'req-1' } });

    expect(diagnose.mock.calls[0]![0]).toEqual({ requestId: 'req-1', providerId: 'p', modelId: 'm', prompt: 'hi', stream: true, reasoning: 'high' });
    expect(diagnose.mock.calls[1]![0]).not.toHaveProperty('reasoning');
    expect(diagnose).toHaveBeenCalledTimes(2);
    expect(sender.send).toHaveBeenCalledWith(`${IPC_CHANNELS.eventPrefix}channel:c-1`, { type: 'thinking', text: 't' });
    expect(abortDiagnose).toHaveBeenCalledWith('req-1');
  });

});
