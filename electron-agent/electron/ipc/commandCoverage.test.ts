import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));
vi.mock('electron', () => electron);

import { getRegisteredCommands, registerIpcHandlers } from './register';

const expectedCommands = [
  'open_workspace', 'close_workspace', 'warm_workspace', 'agent_prompt', 'agent_get_state', 'get_settings',
  'write_temp_html', 'agentData_status', 'agentData_start', 'agentData_stop', 'agentData_admin_jobs_list',
  'agentData_admin_jobs_get', 'agentData_admin_jobs_cancel', 'agentData_admin_config_get', 'agentData_admin_config_update',
  'agentData_admin_audit_list', 'agentData_admin_diagnostics', 'agentData_admin_export', 'agentData_admin_import',
] as const;

describe('Rust handler coverage', () => {
  beforeEach(() => electron.ipcMain.handle.mockReset());

  it('registers every command from tauri generate_handler', () => {
    registerIpcHandlers({
      settings: {}, mcpPolicy: {}, mcpConfig: {}, subagent: {}, files: {}, skills: {}, usage: {}, pi: {}, provider: {}, workspace: {}, uiHistory: {}, workspaceApproval: {}, git: {}, terminal: {}, create: {}, tempHtml: {}, shell: {}, agentData: {},
    } as any);
    const registered = getRegisteredCommands();
    expect(registered).toEqual(expect.arrayContaining(expectedCommands));
  });
});
