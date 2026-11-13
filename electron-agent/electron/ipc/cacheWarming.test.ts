import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, BrowserWindow: {}, dialog: {}, shell: {} }));
import { ipcMain } from 'electron';
import { registerIpcHandlers } from './register';
import { IPC_CHANNELS } from './contracts';

beforeEach(() => vi.clearAllMocks());
it('缓存预热 get/set IPC 转发到 canonical 服务', async () => {
  const service = { get: vi.fn(() => 'streaming'), set: vi.fn(async () => {}) };
  registerIpcHandlers({ cacheWarming: service });
  const handler = vi.mocked(ipcMain.handle).mock.calls.find(([channel]) => channel === IPC_CHANNELS.invoke)?.[1];
  expect(await handler!({} as never, { command: 'get_cache_warming' })).toBe('streaming');
  await handler!({} as never, { command: 'set_cache_warming', args: { mode: 'off' } });
  expect(service.set).toHaveBeenCalledWith('off');
});
