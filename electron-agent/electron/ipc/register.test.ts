import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
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
    expect(git.status).toHaveBeenCalledWith('C:/project');
    expect(git.diff).toHaveBeenCalledWith('C:/project', 'file.ts');
    expect(git.branches).toHaveBeenCalledWith('C:/project');
    expect(git.checkout).toHaveBeenCalledWith('C:/project', 'main');
    expect(git.createBranch).toHaveBeenCalledWith('C:/project', 'feature/x', true);
    expect(git.logGraph).toHaveBeenCalledWith('C:/project', null);
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
  });

  it('routes Agent Data module queries and job creation with explicit scope', async () => {
    const agentData = { request: vi.fn(async (method: string, params: Record<string, unknown>) => ({ method, params })) };
    registerIpcHandlers({ agentData } as any);
    const invoke = handler(IPC_CHANNELS.invoke);

    await expect(invoke({}, { command: 'agentData_memory_overview', args: { userId: 'u', workspace: '/w' } })).resolves.toEqual({
      method: 'memory.admin.overview', params: { userId: 'u', workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_wiki_overview', args: { workspace: '/w' } })).resolves.toEqual({
      method: 'wiki.admin.overview', params: { workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_code_status', args: { workspace: '/w' } })).resolves.toEqual({
      method: 'codeRetrieval.admin.status', params: { workspace: '/w' },
    });
    await expect(invoke({}, { command: 'agentData_jobs_create', args: { kind: 'wiki.sync', workspace: '/w' } })).resolves.toEqual({
      method: 'admin.jobs.create', params: { kind: 'wiki.sync', workspace: '/w' },
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
      appendAppEvent: vi.fn().mockResolvedValue({ id: 'event' }),
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
});
