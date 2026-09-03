mod commands;
mod pi;
mod security;
mod state;

use std::sync::Arc;

use tauri::Manager;

use commands::shell::ShellManager;
use pi::{PiManager, ProcessGuard};
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
            app_handle.manage(commands::files::DroppedAllowlist::default());
            app_handle.manage(Arc::new(PiManager::new()));
            app_handle.manage(Arc::new(ShellManager::new()));

            // OS 级孤儿兜底：主进程一旦消失（含崩溃），job 内的 pi sidecar 全被回收。
            // 创建失败不致命——降级为仅依赖 cli 侧 stdin-EOF 自杀。
            let process_guard = match ProcessGuard::new() {
                Ok(guard) => {
                    let guard = Arc::new(guard);
                    app_handle.manage(guard.clone());
                    Some(guard)
                }
                Err(e) => {
                    eprintln!("[pi] ProcessGuard init failed, orphan reaping degraded: {e}");
                    None
                }
            };

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                shutdown_children(window.app_handle());
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
            commands::agent_set_mode,
            commands::agent_set_approval,
            commands::agent_exclude_entry,
            commands::agent_restore_entry,
            commands::agent_rewind_to,
            commands::agent_compact,
            commands::agent_set_auto_compaction,
            commands::agent_abort_retry,
            commands::agent_get_session_stats,
            commands::agent_get_state,
            commands::agent_get_messages,
            commands::agent_get_commands,
            commands::warm_workspace,
            commands::agent_new_session,
            commands::agent_switch_session,
            commands::agent_fork,
            commands::agent_clone,
            commands::agent_get_fork_messages,
            commands::agent_set_session_name,
            commands::list_pi_sessions,
            commands::list_all_sessions,
            commands::usage_report,
            commands::delete_pi_session,
            commands::workspaces::create_conversation,
            commands::workspaces::get_works_dir,
            commands::workspaces::prune_orphan_conversations,
            commands::workspaces::delete_conversation,
            commands::workspaces::remove_project,
            commands::extension_ui_respond,
            commands::request_workspace_approval,
            commands::is_workspace_approved,
            commands::files::get_file_tree,
            commands::files::read_file,
            commands::files::read_file_binary,
            commands::files::register_dropped_files,
            commands::files::read_dropped_file,
            commands::files::import_dropped_file,
            commands::files::write_file,
            commands::mcp_policy::read_mcp_policy,
            commands::mcp_policy::write_mcp_policy,
            commands::mcp_policy::read_mcp_audit,
            commands::mcp_policy::read_mcp_tools_cache,
            commands::mcp_policy::probe_mcp_server,
            commands::mcp_config::list_mcp_configs,
            commands::mcp_config::upsert_mcp_config,
            commands::mcp_config::remove_mcp_config,
            commands::skills::list_skills,
            commands::skills::create_skill,
            commands::skills::delete_skill,
            commands::skills::import_skill_from_dir,
            commands::skills::import_skill_from_file,
            commands::skills::install_skill_from_zip,
            commands::skills::open_skills_dir,
            commands::git::get_git_status,
            commands::git::get_git_diff,
            commands::git::get_git_branches,
            commands::git::git_checkout,
            commands::git::git_create_branch,
            commands::git::get_git_log_graph,
            commands::create::create_list,
            commands::create::create_image,
            commands::get_settings,
            commands::set_settings,
            commands::providers::get_provider_config,
            commands::providers::set_provider_config,
            commands::providers::refresh_model_registry,
            commands::providers::list_models_global,
            commands::providers::fetch_provider_models,
            commands::providers::fix_mermaid_diagram,
            commands::providers::diagnose_provider_model,
            commands::subagent_list,
            commands::subagent_get_transcript,
            commands::subagent_cancel,
            commands::ui_history_read,
            commands::ui_history_write,
            commands::ui_history_delete,
            commands::terminal::execute_command,
            commands::shell::shell_start,
            commands::shell::shell_write,
            commands::shell::shell_resize,
            commands::shell::shell_stop,
            commands::files::write_temp_html,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                shutdown_children(app_handle);
            }
        });
}

fn shutdown_children(app_handle: &tauri::AppHandle) {
    let manager = app_handle
        .try_state::<Arc<PiManager>>()
        .map(|state| state.inner().clone());
    if manager.is_none() {
        return;
    }
    tauri::async_runtime::block_on(async move {
        if let Some(manager) = manager {
            manager.close_all().await;
        }
    });
}
