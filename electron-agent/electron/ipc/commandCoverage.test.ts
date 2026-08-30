import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  shell: { openExternal: vi.fn(), openPath: vi.fn(), showItemInFolder: vi.fn() },
}));
vi.mock('electron', () => electron);

import { getRegisteredCommands, registerIpcHandlers } from './register';

const rustCommands = [
  'open_workspace','close_workspace','warm_workspace','agent_prompt','agent_steer','agent_follow_up','agent_abort','agent_set_model','agent_cycle_model','agent_get_available_models','agent_set_thinking_level','agent_cycle_thinking_level','agent_set_mode','agent_set_approval','agent_exclude_entry','agent_restore_entry','agent_rewind_to','agent_compact','agent_set_auto_compaction','agent_abort_retry','agent_get_session_stats','agent_get_state','agent_get_messages','agent_get_commands','agent_new_session','agent_switch_session','agent_fork','agent_clone','agent_get_fork_messages','agent_set_session_name','list_pi_sessions','list_all_sessions','usage_report','delete_pi_session','create_conversation','get_works_dir','prune_orphan_conversations','delete_conversation','remove_project','extension_ui_respond','request_workspace_approval','is_workspace_approved','get_file_tree','read_file','read_file_binary','register_dropped_files','read_dropped_file','import_dropped_file','write_file','read_mcp_policy','write_mcp_policy','read_mcp_audit','read_mcp_tools_cache','probe_mcp_server','list_mcp_configs','upsert_mcp_config','remove_mcp_config','list_skills','create_skill','delete_skill','import_skill_from_dir','import_skill_from_file','install_skill_from_zip','open_skills_dir','get_git_status','get_git_diff','get_git_branches','git_checkout','git_create_branch','get_git_log_graph','create_list','create_image','get_settings','set_settings','get_provider_config','set_provider_config','refresh_model_registry','list_models_global','fetch_provider_models','fix_mermaid_diagram','diagnose_provider_model','subagent_list','subagent_get_transcript','subagent_cancel','ui_history_read','ui_history_write','ui_history_delete','execute_command','shell_start','shell_write','shell_resize','shell_stop','tencentdb_get_status','tencentdb_get_config','tencentdb_open_panel','tencentdb_save_connection','tencentdb_test_connection','tencentdb_reload_skills','tencentdb_sync_llm','tencentdb_core_request','tencentdb_list_knowledge_assets','tencentdb_get_wiki','tencentdb_search_wiki','tencentdb_list_wiki_pages','tencentdb_read_wiki_pages','tencentdb_delete_wiki','tencentdb_get_code_graph','tencentdb_search_code_graph','tencentdb_explore_code_graph','tencentdb_get_code_graph_callers','tencentdb_get_code_graph_callees','tencentdb_analyze_code_graph_impact','tencentdb_get_code_graph_node','tencentdb_get_code_graph_status','tencentdb_list_code_graph_files','tencentdb_delete_code_graph','tencentdb_provision_workspace_assets','tencentdb_sync_code_graph','tencentdb_sync_wiki','tencentdb_import_wiki_files','write_temp_html',
] as const;

describe('Rust handler coverage', () => {
  beforeEach(() => electron.ipcMain.handle.mockReset());

  it('registers every command from tauri generate_handler', () => {
    registerIpcHandlers({
      settings: {}, mcpPolicy: {}, mcpConfig: {}, subagent: {}, files: {}, skills: {}, usage: {}, pi: {}, provider: {}, workspace: {}, uiHistory: {}, workspaceApproval: {}, git: {}, terminal: {}, create: {}, tempHtml: {}, shell: {}, tencentdb: {},
    } as any);
    const registered = getRegisteredCommands();
    expect(registered).toEqual(expect.arrayContaining(rustCommands));
    expect(rustCommands).toHaveLength(121);
  });
});
