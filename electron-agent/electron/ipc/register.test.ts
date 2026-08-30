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
