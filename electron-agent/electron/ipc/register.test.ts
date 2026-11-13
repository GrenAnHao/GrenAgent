import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(),showSaveDialog:vi.fn() },
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
  it('opens a single filtered file without changing the directory picker contract', async () => {
    electron.dialog.showOpenDialog.mockReset().mockResolvedValue({ canceled: false, filePaths: ['C:/skills/example.zip'] });
    registerIpcHandlers();
    await expect(handler('gren:pick-file')({}, { filters: [{ name: 'Zip', extensions: ['zip'] }] })).resolves.toBe('C:/skills/example.zip');
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith({ properties: ['openFile'], filters: [{ name: 'Zip', extensions: ['zip'] }] });
    await handler(IPC_CHANNELS.pickDirectory)({});
    expect(electron.dialog.showOpenDialog).toHaveBeenLastCalledWith({ properties: ['openDirectory', 'createDirectory'] });
  });

  it.each([
    { canceled: true, filePaths: ['C:/ignored.zip'] },
    { canceled: false, filePaths: [] },
  ])('returns null for an unselected file ($canceled / $filePaths)', async (result) => {
    electron.dialog.showOpenDialog.mockReset().mockResolvedValue(result);
    registerIpcHandlers();
    await expect(handler('gren:pick-file')({})).resolves.toBeNull();
  });

  it('agent_get_session_defaults / agent_set_session_defaults 能经 IPC invoke 到宿主', async () => {
    const send = vi.fn(async (_workspace: string, command: string) => ({ command }));
    registerIpcHandlers({ pi: { send } as never });
    const invoke = handler(IPC_CHANNELS.invoke);
    const preferences = { model: { provider: 'anthropic', id: 'claude' }, thinkingLevel: 'high', mode: 'plan' };
    await invoke({}, { command: 'agent_get_session_defaults', args: { workspace: 'D:/p' } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_get_session_defaults', {});
    await invoke({}, { command: 'agent_set_session_defaults', args: { workspace: 'D:/p', preferences } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_set_session_defaults', { preferences });
  });

  it('agent_new_session 把 initialPreferences 原样交给宿主', async () => {
    const send = vi.fn(async (_workspace: string, command: string) => ({ command }));
    registerIpcHandlers({ pi: { send } as never });
    const invoke = handler(IPC_CHANNELS.invoke);
    const initialPreferences = { thinkingLevel: 'low', approval: 'readonly' };
    await invoke({}, { command: 'agent_new_session', args: { workspace: 'D:/p', initialPreferences } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_new_session', { initialPreferences });
  });

  it('agent_set_fast_mode 原样透传 enabled（false 不能丢）与 targetSessionPath', async () => {
    const send = vi.fn(async (_workspace: string, command: string) => ({ command }));
    registerIpcHandlers({ pi: { send } as never });
    const invoke = handler(IPC_CHANNELS.invoke);
    await invoke({}, { command: 'agent_set_fast_mode', args: { workspace: 'D:/p', enabled: true, targetSessionPath: 'D:/p/a.jsonl' } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_set_fast_mode', { enabled: true, targetSessionPath: 'D:/p/a.jsonl' });
    await invoke({}, { command: 'agent_set_fast_mode', args: { workspace: 'D:/p', enabled: false, targetSessionPath: 'D:/p/a.jsonl' } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_set_fast_mode', { enabled: false, targetSessionPath: 'D:/p/a.jsonl' });
    expect(getRegisteredCommands()).toContain('agent_set_fast_mode');
  });

  it('agent_set_session_defaults / agent_get_session_defaults 透传 fastMode（含 false）', async () => {
    const send = vi.fn(async (_workspace: string, command: string) => ({ command }));
    registerIpcHandlers({ pi: { send } as never });
    const invoke = handler(IPC_CHANNELS.invoke);
    await invoke({}, { command: 'agent_get_session_defaults', args: { workspace: 'D:/p' } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_get_session_defaults', {});
    await invoke({}, { command: 'agent_set_session_defaults', args: { workspace: 'D:/p', preferences: { fastMode: false } } });
    expect(send).toHaveBeenLastCalledWith('D:/p', 'agent_set_session_defaults', { preferences: { fastMode: false } });
  });
  it('no longer exposes task reads now that the task surface is retired', async () => {
    const agentData = { requestAdmin: vi.fn().mockResolvedValue({}), request: vi.fn() };
    registerIpcHandlers({ agentData: agentData as never }); const invoke = handler(IPC_CHANNELS.invoke);
    for (const command of ['agentData_tasks_list', 'agentData_tasks_read', 'agentData_tasks_retry', 'agentData_tasks_previewRetry']) {
      await expect(invoke({}, { command, args: {} })).rejects.toThrow();
    }
    expect(agentData.requestAdmin).not.toHaveBeenCalled();
  });

  it('rejects the retired Agent Data commands instead of returning empty data', async () => {
    const agentData = { requestAdmin: vi.fn().mockResolvedValue({}), request: vi.fn(), resolveDiagnosticPath: vi.fn() };
    registerIpcHandlers({ agentData: agentData as never }); const invoke = handler(IPC_CHANNELS.invoke);
    // 已下线能力必须给出明确失败，不能静默成功让调用方以为“没有数据”。
    for (const command of [
      'agentData_tasks_previewRetry', 'agentData_tasks_retry',
      'agentData_audit_query', 'agentData_audit_export',
      'agentData_diagnostics_check', 'agentData_diagnostics_open',
      'agentData_overview', 'agentData_admin_jobs_list', 'agentData_admin_export',
      'agentData_wiki_list', 'agentData_wiki_ingest', 'agentData_wiki_search',
    ]) {
      await expect(invoke({}, { command, args: {} })).rejects.toThrow();
    }
    expect(agentData.requestAdmin).not.toHaveBeenCalled();
    expect(agentData.request).not.toHaveBeenCalled();
    expect(agentData.resolveDiagnosticPath).not.toHaveBeenCalled();
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

  it('routes isolated workspace commands and rejects bad base / fetch values', async () => {
    const isolatedWorkspace = {
      create: vi.fn().mockResolvedValue({ id: 'abc12345' }),
      list: vi.fn().mockReturnValue([]),
      syncBack: vi.fn().mockResolvedValue({ branch: 'gren/abc12345', commit: 'c' }),
    };
    registerIpcHandlers({ isolatedWorkspace: isolatedWorkspace as never });
    const invoke = handler(IPC_CHANNELS.invoke);

    await invoke({}, { command: 'isolated_workspace_create', args: { workspace: 'C:/repo' } });
    expect(isolatedWorkspace.create).toHaveBeenLastCalledWith({ project: 'C:/repo' });
    await invoke({}, { command: 'isolated_workspace_create', args: { workspace: 'C:/repo', base: 'head', fetch: true } });
    expect(isolatedWorkspace.create).toHaveBeenLastCalledWith({ project: 'C:/repo', base: 'head', fetch: true });
    await expect(invoke({}, { command: 'isolated_workspace_create', args: { workspace: 'C:/repo', base: 'worktree' } })).rejects.toThrow('base');
    await expect(invoke({}, { command: 'isolated_workspace_create', args: { workspace: 'C:/repo', fetch: 'yes' } })).rejects.toThrow('fetch');
    await expect(invoke({}, { command: 'isolated_workspace_create', args: {} })).rejects.toThrow('workspace');
    expect(isolatedWorkspace.create).toHaveBeenCalledTimes(2);

    await invoke({}, { command: 'isolated_workspace_list', args: { workspace: 'C:/repo' } });
    expect(isolatedWorkspace.list).toHaveBeenCalledWith('C:/repo');
    await invoke({}, { command: 'isolated_workspace_sync_back', args: { workspace: 'C:/repo', id: 'abc12345' } });
    expect(isolatedWorkspace.syncBack).toHaveBeenCalledWith('C:/repo', 'abc12345');
    await invoke({}, { command: 'isolated_workspace_create', args: { workspace: 'C:/repo', carryChanges: true } });
    expect(isolatedWorkspace.create).toHaveBeenLastCalledWith({ project: 'C:/repo', carryChanges: true });
  });

  it('isolated_workspace_remove refuses a running workspace and unsaved work before closing anything', async () => {
    const W = 'C:/repo/.gren/worktrees/abc12345';
    const entry = { id: 'abc12345', path: W, exists: true };
    const state = vi.fn().mockResolvedValue({ dirty: false, synced: true });
    const isolatedWorkspace = {
      create: vi.fn(), syncBack: vi.fn(), probe: vi.fn().mockReturnValue({}),
      list: vi.fn().mockReturnValue([entry]),
      state,
      remove: vi.fn().mockResolvedValue({ removed: true }),
    };
    const pi = { listRunningTurns: vi.fn().mockResolvedValue([{ workspace: 'C:\\repo\\.gren\\worktrees\\abc12345' }]) };
    const workspace = { releaseWorkspace: vi.fn().mockResolvedValue(undefined) };
    registerIpcHandlers({ isolatedWorkspace: isolatedWorkspace as never, pi: pi as never, workspace: workspace as never });
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'isolated_workspace_remove', args: { workspace: 'C:/repo', id: 'abc12345' } })).rejects.toThrow('ISOLATED_BUSY');
    expect(workspace.releaseWorkspace).not.toHaveBeenCalled();

    pi.listRunningTurns.mockResolvedValue([]);
    state.mockResolvedValue({ dirty: true, synced: true });
    await expect(invoke({}, { command: 'isolated_workspace_remove', args: { workspace: 'C:/repo', id: 'abc12345' } })).rejects.toThrow('ISOLATED_UNSAVED');
    expect(workspace.releaseWorkspace).not.toHaveBeenCalled();

    await invoke({}, { command: 'isolated_workspace_remove', args: { workspace: 'C:/repo', id: 'abc12345', force: true } });
    expect(workspace.releaseWorkspace).toHaveBeenCalledWith(W);
    expect(isolatedWorkspace.remove).toHaveBeenCalledWith('C:/repo', 'abc12345', { force: true });

    await invoke({}, { command: 'isolated_workspace_probe', args: { paths: [W] } });
    expect(isolatedWorkspace.probe).toHaveBeenCalledWith([W]);
    await invoke({}, { command: 'isolated_workspace_state', args: { workspace: 'C:/repo', id: 'abc12345' } });
    expect(state).toHaveBeenLastCalledWith('C:/repo', 'abc12345');
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

  it('no longer exposes the retired Agent Data management surface', async () => {
    const agentData = { request: vi.fn() };
    registerIpcHandlers({ agentData } as any);
    const invoke = handler(IPC_CHANNELS.invoke);
    for (const [command, args] of [
      ['agentData_admin_jobs_list', {}],
      ['agentData_admin_config_update', { module: 'codeRetrieval', value: {}, version: 0 }],
      ['agentData_admin_jobs_remove', { id: 'job-1' }],
      ['agentData_admin_jobs_clear', { ids: ['job-1'] }],
      ['agentData_admin_audit_list', {}],
      ['agentData_admin_export', {}],
      ['agentData_admin_import', { data: {} }],
    ] as const) {
      await expect(invoke({}, { command, args })).rejects.toThrow();
    }
    // 这些命令不得再被转发到运行时。
    expect(agentData.request).not.toHaveBeenCalled();
  });

  it('routes Agent Data module queries and job creation with explicit scope', async () => {
    const agentData = { request: vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params })), requestAdmin: vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params })) };
    registerIpcHandlers({ agentData } as any);
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'agentData_code_status', args: { workspace: '/w' } })).resolves.toEqual({
      method: 'codeRetrieval.admin.status', params: { workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_jobs_create', args: { kind: 'codegraph.sync', workspace: '/w' } })).resolves.toEqual({
      method: 'admin.jobs.create', params: { kind: 'codegraph.sync', workspace: '/w' },
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
      { workspace: '/ws', text: 'hello', goalText: '', recentTurn: '' },
      expect.any(Function),
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

describe('attention commands', () => {
  function setup() {
    const attention = {
      notify: vi.fn().mockResolvedValue({ route: 'os', sound: true }),
      badge: vi.fn().mockResolvedValue(undefined),
      isFocused: vi.fn().mockReturnValue(true),
      clear: vi.fn(),
    };
    registerIpcHandlers({ attention: attention as never });
    return { attention, invoke: handler(IPC_CHANNELS.invoke) };
  }

  it('validates and forwards attention_notify', async () => {
    const { attention, invoke } = setup();
    const args = { kind: 'failed', workspace: 'D:/repo', sessionPath: 'D:/s.jsonl', title: 'T', body: 'B' };
    await expect(invoke({}, { command: 'attention_notify', args })).resolves.toEqual({ route: 'os', sound: true });
    expect(attention.notify).toHaveBeenCalledWith(args);
    await expect(invoke({}, { command: 'attention_notify', args: { ...args, kind: 'nope' } })).rejects.toThrow();
    await expect(invoke({}, { command: 'attention_notify', args: { ...args, sessionPath: '' } })).rejects.toThrow();
  });

  it('rejects a negative badge count', async () => {
    const { attention, invoke } = setup();
    await expect(invoke({}, { command: 'attention_badge', args: { count: -1 } })).rejects.toThrow();
    await expect(invoke({}, { command: 'attention_badge', args: { count: 1.5 } })).rejects.toThrow();
    await invoke({}, { command: 'attention_badge', args: { count: 2 } });
    expect(attention.badge).toHaveBeenCalledWith({ count: 2, overlayDataUrl: undefined });
    await invoke({}, { command: 'attention_badge', args: { count: 1, overlayDataUrl: 'data:x' } });
    expect(attention.badge).toHaveBeenLastCalledWith({ count: 1, overlayDataUrl: 'data:x' });
  });

  it('forwards attention_clear', async () => {
    const { attention, invoke } = setup();
    await invoke({}, { command: 'attention_clear', args: { sessionPath: 'D:/s.jsonl' } });
    expect(attention.clear).toHaveBeenCalledWith('D:/s.jsonl');
    await expect(invoke({}, { command: 'attention_clear', args: {} })).rejects.toThrow();
  });

  it('reports the window focus', async () => {
    const { invoke } = setup();
    await expect(invoke({}, { command: 'attention_window_focused', args: {} })).resolves.toBe(true);
  });
});

describe('context rule mode scope IPC', () => {
  it('passes optional modes through to saveRule and rejects non-string arrays', async () => {
    const saveRule = vi.fn().mockResolvedValue({});
    registerIpcHandlers({ promptLibrary: { saveRule } as never });
    const invoke = handler(IPC_CHANNELS.invoke);

    await invoke({}, {
      command: 'save_context_rule',
      args: { workspace: '/w', scope: 'global', title: 'T', enabled: true, body: 'b', modes: ['ultra', 'plan'] },
    });
    expect(saveRule).toHaveBeenLastCalledWith(expect.objectContaining({ modes: ['ultra', 'plan'], title: 'T' }));

    await invoke({}, { command: 'save_context_rule', args: { scope: 'global', title: 'T', enabled: true, body: 'b' } });
    expect(saveRule).toHaveBeenLastCalledWith(expect.objectContaining({ modes: undefined }));

    await expect(invoke({}, {
      command: 'save_context_rule',
      args: { scope: 'global', title: 'T', enabled: true, body: 'b', modes: 'ultra' },
    })).rejects.toThrow('modes must be a string array');
  });
});

it('exports only the frozen host preview and keeps it retryable after a real file write failure',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {RequestObservations}=await import('../../../extensions/_shared/requestObservation.js');const {RequestObservationService}=await import('../../../extensions/_shared/requestObservationService.js');
 const dir=await mkdtemp(join(tmpdir(),'observation-export-'));const hub=new RequestObservations('export-generation');const observations=new RequestObservationService({hub});const r=hub.begin({sessionId:'export',provider:'fixture',api:'a',requestedModel:'m'});hub.collect(r.identity,true);r.raw({type:'text_delta',text:'DO_NOT_EXPORT'});
 const preview=await observations.command({action:'preview',identity:r.identity});r.raw({index:2});registerIpcHandlers({observations});const invoke=handler(IPC_CHANNELS.invoke);const event={sender:{}};
 try{
  electron.dialog.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:join(dir,'missing','file.json')}).mockResolvedValueOnce({canceled:false,filePath:join(dir,'saved.json')});
  const command={command:'export_request_observation',args:{previewId:preview.previewId}};
  await expect(invoke(event,command)).rejects.toThrow();await expect(invoke(event,command)).resolves.toEqual({saved:true});
  const text=await readFile(join(dir,'saved.json'),'utf8');expect(text).not.toContain('DO_NOT_EXPORT');expect(JSON.parse(text).events).toEqual([{type:'text_delta',text:'[redacted]'}]);
 }finally{observations.clear();await rm(dir,{recursive:true,force:true});}
});

describe('session workflow file authority',()=>{
 const target={targetSessionPath:'D:/sessions/a.jsonl',expectedSessionId:'A',expectedLeafId:null,expectedRevision:'host:1'};
 it('drops renderer-supplied paths and accepts only native dialog source/destination',async()=>{
  const sessionWorkflow=vi.fn(async(_workspace:string,_request:Record<string,unknown>)=>({status:'ok'}));registerIpcHandlers({pi:{sessionWorkflow} as never});const invoke=handler(IPC_CHANNELS.invoke),event={sender:{}};
  electron.dialog.showSaveDialog.mockResolvedValueOnce({canceled:false,filePath:'D:/approved/session.html'});
  await invoke(event,{command:'agent_session_workflow',args:{workspace:'D:/repo',...target,action:'export-preview',format:'html',destination:'D:/unapproved/overwrite.html',source:'D:/unapproved/history.jsonl'}});
  expect(sessionWorkflow).toHaveBeenLastCalledWith('D:/repo',expect.objectContaining({destination:'D:/approved/session.html'}));expect(sessionWorkflow.mock.calls.at(-1)![1]).not.toHaveProperty('source');
  electron.dialog.showOpenDialog.mockResolvedValueOnce({canceled:false,filePaths:['D:/approved/history.jsonl']});
  await invoke(event,{command:'agent_session_workflow',args:{workspace:'D:/repo',...target,action:'import-preview',source:'D:/unapproved/history.jsonl',destination:'D:/unapproved/overwrite.html'}});
  expect(sessionWorkflow).toHaveBeenLastCalledWith('D:/repo',expect.objectContaining({source:'D:/approved/history.jsonl'}));expect(sessionWorkflow.mock.calls.at(-1)![1]).not.toHaveProperty('destination');
 });
 it('cancelled native file selection never reaches runtime publication or export',async()=>{
  const sessionWorkflow=vi.fn();registerIpcHandlers({pi:{sessionWorkflow} as never});const invoke=handler(IPC_CHANNELS.invoke),event={sender:{}};
  electron.dialog.showSaveDialog.mockResolvedValueOnce({canceled:true,filePath:'D:/ignored.html'});
  await expect(invoke(event,{command:'agent_session_workflow',args:{workspace:'D:/repo',...target,action:'export-preview',format:'html'}})).resolves.toEqual({status:'cancelled'});
  electron.dialog.showOpenDialog.mockResolvedValueOnce({canceled:true,filePaths:[]});
  await expect(invoke(event,{command:'agent_session_workflow',args:{workspace:'D:/repo',...target,action:'import-preview'}})).resolves.toEqual({status:'cancelled'});expect(sessionWorkflow).not.toHaveBeenCalled();
 });
});
