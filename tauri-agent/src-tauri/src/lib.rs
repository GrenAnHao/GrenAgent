mod commands;
mod pi;
mod security;
mod state;

use std::sync::Arc;

use tauri::Manager;

use commands::shell::ShellManager;
use pi::PiManager;
use state::AppStateStore;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_handle = app.handle();
            let app_data_dir = app_handle
                .path()
                .app_data_dir()
                .expect("Failed to get app data directory");
            std::fs::create_dir_all(&app_data_dir).ok();

            let store = AppStateStore::new(app_data_dir.join("app-state.json"));
            app_handle.manage(store);
            app_handle.manage(Arc::new(PiManager::new()));
            app_handle.manage(Arc::new(ShellManager::new()));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(mgr) = window.app_handle().try_state::<Arc<PiManager>>() {
                    let mgr = mgr.inner().clone();
                    tauri::async_runtime::block_on(async move { mgr.close_all().await });
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::open_workspace,
            commands::close_workspace,
            commands::agent_prompt,
            commands::agent_steer,
            commands::agent_follow_up,
            commands::agent_abort,
            commands::agent_set_model,
            commands::agent_cycle_model,
            commands::agent_get_available_models,
            commands::agent_set_thinking_level,
            commands::agent_cycle_thinking_level,
            commands::agent_compact,
            commands::agent_set_auto_compaction,
            commands::agent_abort_retry,
            commands::agent_get_session_stats,
            commands::agent_get_state,
            commands::agent_get_messages,
            commands::agent_get_commands,
            commands::agent_new_session,
            commands::agent_switch_session,
            commands::agent_fork,
            commands::agent_clone,
            commands::agent_get_fork_messages,
            commands::agent_set_session_name,
            commands::list_pi_sessions,
            commands::list_all_sessions,
            commands::delete_pi_session,
            commands::workspaces::create_conversation,
            commands::workspaces::get_works_dir,
            commands::workspaces::delete_conversation,
            commands::workspaces::remove_project,
            commands::workspaces::auto_title_session,
            commands::extension_ui_respond,
            commands::request_workspace_approval,
            commands::is_workspace_approved,
            commands::files::get_file_tree,
            commands::files::read_file,
            commands::files::read_file_binary,
            commands::files::write_file,
            commands::mcp_policy::read_mcp_policy,
            commands::mcp_policy::write_mcp_policy,
            commands::mcp_policy::read_mcp_audit,
            commands::git::get_git_status,
            commands::git::get_git_diff,
            commands::knowledge::kb_stats,
            commands::knowledge::kb_sources,
            commands::knowledge::kb_chunks,
            commands::memory::mem_stats,
            commands::memory::mem_list,
            commands::memory::mem_history,
            commands::checkpoint::cp_list,
            commands::checkpoint::cp_diff,
            commands::review::rv_list,
            commands::create::create_list,
            commands::create::create_image,
            commands::get_settings,
            commands::set_settings,
            commands::terminal::execute_command,
            commands::shell::shell_start,
            commands::shell::shell_write,
            commands::shell::shell_resize,
            commands::shell::shell_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
