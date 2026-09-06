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
  'write_temp_html', 'agentData_status', 'agentData_start', 'agentData_stop', 'agentData_admin_jobs_list',
  'agentData_admin_jobs_get', 'agentData_admin_jobs_cancel', 'agentData_admin_config_get', 'agentData_admin_config_update',
  'agentData_admin_jobs_remove', 'agentData_admin_jobs_clear',
  'agentData_admin_audit_list', 'agentData_admin_diagnostics', 'agentData_admin_export', 'agentData_admin_import',
  'agentData_memory_overview', 'agentData_wiki_overview', 'agentData_code_status', 'agentData_jobs_create',
  'agentData_memory_search', 'agentData_memory_delete', 'agentData_wiki_search',
  'agentData_code_search', 'agentData_code_projects',
  'agentData_goal_get', 'agentData_goal_create', 'agentData_goal_update', 'agentData_goal_history',
  'agentData_goal_recordProgress', 'agentData_goal_requestCompletion', 'agentData_goal_judgeResult',
  'agentData_code_call', 'agentData_memory_list', 'agentData_memory_read', 'agentData_memory_create', 'agentData_memory_update', 'agentData_memory_conversations_list', 'agentData_memory_conversations_read',
  'agentData_tasks_list', 'agentData_tasks_read', 'agentData_tasks_previewRetry', 'agentData_tasks_retry', 'agentData_audit_query', 'agentData_audit_export', 'agentData_diagnostics_check', 'agentData_diagnostics_open', 'agentData_overview',
  'agentData_wiki_libraries_list', 'agentData_wiki_libraries_read', 'agentData_wiki_libraries_create', 'agentData_wiki_libraries_update',
  'agentData_wiki_libraries_previewDelete', 'agentData_wiki_libraries_remove', 'agentData_wiki_libraries_previewIngest', 'agentData_wiki_libraries_ingest', 'agentData_wiki_libraries_reindex',
  'agentData_wiki_sources_list', 'agentData_wiki_sources_read', 'agentData_wiki_sources_previewImport', 'agentData_wiki_sources_create', 'agentData_wiki_sources_update', 'agentData_wiki_sources_previewDelete', 'agentData_wiki_sources_remove',
  'agentData_wiki_pages_list', 'agentData_wiki_pages_read', 'agentData_wiki_pages_create', 'agentData_wiki_pages_update', 'agentData_wiki_pages_setLocked', 'agentData_wiki_pages_previewDelete', 'agentData_wiki_pages_remove',
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

  it('validates Goal IPC CAS fields and drops renderer origins', async () => {
    const agentData = {
      goalGet: vi.fn().mockResolvedValue(undefined),
      goalCreate: vi.fn().mockResolvedValue({}),
      goalUpdate: vi.fn().mockResolvedValue({}),
      goalHistory: vi.fn().mockResolvedValue([]),
      goalRecordProgress: vi.fn().mockResolvedValue({}),
      goalRequestCompletion: vi.fn().mockResolvedValue({}),
      goalJudgeResult: vi.fn().mockResolvedValue({}),
    };
    registerIpcHandlers({ agentData } as any);
    const invoke = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === IPC_CHANNELS.invoke)?.[1];
    if (!invoke) throw new Error('invoke handler not registered');

    await invoke({}, { command: 'agentData_goal_get', args: { sessionId: 's', workspace: '/repo' } });
    expect(agentData.goalGet).toHaveBeenCalledWith('s', '/repo');
    await invoke({}, { command: 'agentData_goal_create', args: { sessionId: 's', workspace: '/repo', condition: 'ship', origin: 'system' } });
    expect(agentData.goalCreate).toHaveBeenCalledWith({ sessionId: 's', workspace: '/repo', condition: 'ship', origin: 'human-ui' });
    await invoke({}, { command: 'agentData_goal_update', args: { sessionId: 's', goalId: 'g', revision: 1, action: 'pause', origin: 'system' } });
    expect(agentData.goalUpdate).toHaveBeenCalledWith({ sessionId: 's', goalId: 'g', revision: 1, action: 'pause', origin: 'human-ui' });
    await invoke({}, { command: 'agentData_goal_recordProgress', args: { sessionId: 's', goalId: 'g', revision: 1, action: 'pause', payload: { reason: 'progress' } } });
    expect(agentData.goalRecordProgress).toHaveBeenCalledWith({ sessionId: 's', goalId: 'g', revision: 1, action: 'pause', payload: { reason: 'progress' }, origin: 'human-ui' });
    await invoke({}, { command: 'agentData_goal_judgeResult', args: { sessionId: 's', goalId: 'g', revision: 2, verdict: 'pass', reason: 'done', origin: 'system' } });
    expect(agentData.goalJudgeResult).toHaveBeenCalledWith({ sessionId: 's', goalId: 'g', revision: 2, verdict: 'pass', reason: 'done' });
    await expect(invoke({}, { command: 'agentData_goal_update', args: { sessionId: 's', goalId: 'g', revision: 0, action: 'pause' } })).rejects.toThrow(/revision/);
    await expect(invoke({}, { command: 'agentData_goal_update', args: { sessionId: 's', goalId: 'g', revision: 1, action: 'invalid' } })).rejects.toThrow(/action/);
    await expect(invoke({}, { command: 'agentData_goal_update', args: { sessionId: 's', goalId: '', revision: 1, action: 'pause' } })).rejects.toThrow(/goalId/);
    await expect(invoke({}, { command: 'agentData_goal_judgeResult', args: { sessionId: 's', goalId: 'g', revision: 2, verdict: 'unknown', reason: 'done' } })).rejects.toThrow(/verdict/);
  });
});
