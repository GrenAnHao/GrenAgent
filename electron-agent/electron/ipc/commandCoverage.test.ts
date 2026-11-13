import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));
vi.mock('electron', () => electron);

import { getRegisteredCommands, registerIpcHandlers } from './register';
import { IPC_CHANNELS } from './contracts';

const expectedCommands = [
  'open_workspace', 'close_workspace', 'warm_workspace', 'agent_prompt', 'agent_get_state', 'get_settings',
  'write_temp_html', 'agentData_status', 'agentData_start', 'agentData_stop',
 
 
 
  'agentData_code_status', 'agentData_jobs_create',
  'agentData_code_search', 'agentData_code_projects', 'agentData_code_call',
                     ] as const;

describe('Rust handler coverage', () => {
  beforeEach(() => electron.ipcMain.handle.mockReset());

  it('registers every command from tauri generate_handler', () => {
    registerIpcHandlers({
      settings: {}, mcpPolicy: {}, mcpConfig: {}, subagent: {}, files: {}, skills: {}, usage: {}, pi: {}, provider: {}, workspace: {}, uiHistory: {}, workspaceApproval: {}, git: {}, terminal: {}, create: {}, tempHtml: {}, shell: {}, agentData: {},
    } as any);
    const registered = getRegisteredCommands();
    expect(registered).toEqual(expect.arrayContaining([...expectedCommands]));
  });

  it('rejects removed Goal and Memory IPC commands', async () => {
    registerIpcHandlers({ agentData: {} } as any);
    const invoke = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === IPC_CHANNELS.invoke)?.[1];
    if (!invoke) throw new Error('invoke handler not registered');
    for (const command of ['agentData_goal_get', 'agentData_memory_search', 'agentData_memory_create', 'agentData_memory_overview']) {
      await expect(invoke({}, { command, args: { sessionId: 's', workspace: '/repo' } })).rejects.toThrow();
    }
  });
});
