import { expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
  webUtils: {},
}));

vi.mock('electron', () => electron);

import './preload';

it('routes filtered file selection separately from the unchanged directory selector', async () => {
  const gren = electron.contextBridge.exposeInMainWorld.mock.calls[0][1];
  electron.ipcRenderer.invoke.mockResolvedValue('C:/skills/SKILL.md');
  await expect(gren.pickFile({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] })).resolves.toBe('C:/skills/SKILL.md');
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('gren:pick-file', { filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] });
  await gren.pickDirectory();
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith('gren:pick-directory');
});
