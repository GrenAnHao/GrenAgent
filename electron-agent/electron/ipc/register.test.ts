import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));

vi.mock('electron', () => electron);

import { registerIpcHandlers } from './register';
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

  it('routes TencentDB skill reload and Wiki file import through the native picker', async () => {
    electron.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['C:/guide.md'] });
    const tencentdb = {
      reloadSkills: vi.fn().mockResolvedValue('revision'),
      importWikiFiles: vi.fn().mockResolvedValue({ uploaded: 1, sync: {} }),
    };
    registerIpcHandlers({ tencentdb });
    const invoke = handler(IPC_CHANNELS.invoke);
    await expect(invoke({}, { command: 'tencentdb_reload_skills', args: {} })).resolves.toBeUndefined();
    await expect(invoke({}, { command: 'tencentdb_import_wiki_files', args: { input: { wikiId: 'wiki-1' } } })).resolves.toEqual({ uploaded: 1, sync: {} });
    expect(tencentdb.reloadSkills).toHaveBeenCalledOnce();
    expect(tencentdb.importWikiFiles).toHaveBeenCalledWith('wiki-1', ['C:/guide.md']);
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
