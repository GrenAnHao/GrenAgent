import { describe, expect, it, vi } from 'vitest';
const ipc = vi.hoisted(() => ({ handle: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {}, ipcMain: ipc, shell: {} }));
import { getRegisteredCommands, registerCommand, registerIpcHandlers } from './register';

describe('command registration disposal', () => {
  it('removes its own registration without removing a later replacement', () => {
    const first = registerCommand('repoWiki_dispose_test', () => 'old');
    expect(first).toBeTypeOf('function');
    const second = registerCommand('repoWiki_dispose_test', () => 'new');
    (first as unknown as () => void)();
    expect(getRegisteredCommands()).toContain('repoWiki_dispose_test');
    (second as unknown as () => void)();
    expect(getRegisteredCommands()).not.toContain('repoWiki_dispose_test');
  });

  it('waits for repository permission revocation after removing a host project', async () => {
    let removed = false, stopped = false;
    registerIpcHandlers({
      workspace: { removeProject: async () => { removed = true; } } as any,
      workspaceProjectsChanged: async () => { expect(removed).toBe(true); await Promise.resolve(); stopped = true; },
    } as any);
    const invoke = ipc.handle.mock.calls.find(([name]) => name === 'gren:invoke')![1];
    await invoke({}, { command: 'remove_project', args: { workspace: 'D:/approved' } });
    expect(stopped).toBe(true);
  });
});
