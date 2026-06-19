use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use std::collections::HashMap;
use std::path::Path;

use crate::commands::sessions::{canonical_display_path, resolve_workspace_dir};
use crate::pi::sidecar::spawn_pi_client;
use crate::pi::sink::{EventSink, TauriSink};
use crate::pi::types::{PiOutbound, RpcResponse};
use crate::pi::{PiClient, PiManager};
use crate::state::AppStateStore;

async fn client_for(mgr: &PiManager, workspace: &str) -> Result<Arc<PiClient>, String> {
    mgr.get(workspace)
        .await
        .ok_or_else(|| format!("workspace not open: {workspace}"))
}

fn data_or_err(resp: RpcResponse) -> Result<Value, String> {
    if resp.success {
        Ok(resp.data.unwrap_or(Value::Null))
    } else {
        Err(resp.error.unwrap_or_else(|| "command failed".into()))
    }
}

/// 取工作区 client，发送命令，返回 data 或 error。
async fn send(mgr: &PiManager, workspace: &str, cmd: PiOutbound) -> Result<Value, String> {
    let client = client_for(mgr, workspace).await?;
    let resp = client.send(cmd).await.map_err(|e| e.to_string())?;
    data_or_err(resp)
}

fn perf_log(label: &str, elapsed_ms: u128) {
    eprintln!("[PERF-startup] {label}: {elapsed_ms}ms");
}

fn is_conversation_workspace(cwd: &Path) -> bool {
    let works = match dirs::home_dir().map(|h| h.join(".pi").join("agent").join("works")) {
        Some(works) => works,
        None => return false,
    };
    let works = std::fs::canonicalize(&works).unwrap_or(works);
    let cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let normalize = |path: &Path| {
        path.to_string_lossy()
            .trim_start_matches(r"\\?\")
            .replace('\\', "/")
            .trim_end_matches('/')
            .to_ascii_lowercase()
    };
    let works = normalize(&works);
    let cwd = normalize(&cwd);
    cwd == works || cwd.starts_with(&format!("{works}/"))
}

fn apply_conversation_tool_policy(
    mut env: HashMap<String, String>,
    cwd: &Path,
) -> HashMap<String, String> {
    if is_conversation_workspace(cwd) {
        env.remove("MCP_SERVERS");
        env.insert("MCP_DISABLED".into(), "1".into());
    }
    env
}

async fn current_session_file(mgr: &PiManager, workspace: &str) -> Option<String> {
    send(mgr, workspace, PiOutbound::GetState { id: None })
        .await
        .ok()
        .and_then(|d| {
            d.get("sessionFile")
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWorkspaceResult {
    pub restored_session: Option<String>,
    pub session_file: Option<String>,
}

#[tauri::command]
pub async fn open_workspace(
    workspace: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<OpenWorkspaceResult, String> {
    let t0 = Instant::now();
    let cwd = resolve_workspace_dir(&workspace)?;
    let cwd_for_spawn = cwd.to_string_lossy().to_string();
    let app2 = app.clone();
    let ws = workspace.clone();
    let env = apply_conversation_tool_policy(store.settings_env().await, &cwd);
    store.write_runtime_config().await;
    let runtime_config = store.runtime_path().to_string_lossy().to_string();
    // Code Intelligence 自动 init 开关（在 env 被 move 进 spawn 闭包前读取）。
    let auto_init_codegraph = env
        .get("CODE_INTEL")
        .map(|v| v.as_str() != "off")
        .unwrap_or(true)
        && env
            .get("CODE_INTEL_AUTO_INIT")
            .map(|v| v.as_str() != "0")
            .unwrap_or(true);
    mgr.get_or_open(&workspace, move || {
        let sink: Arc<dyn EventSink> = Arc::new(TauriSink { app: app2.clone() });
        spawn_pi_client(
            &app2,
            ws.clone(),
            &cwd_for_spawn,
            sink,
            env.clone(),
            &runtime_config,
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    perf_log(
        &format!("open_workspace/spawn:{workspace}"),
        t0.elapsed().as_millis(),
    );

    store.update(|st| st.touch_workspace(&workspace)).await;

    let mut restored_session = None;
    if let Some(last) = store.last_session_for(&workspace).await {
        let last = canonical_display_path(Path::new(&last));
        if Path::new(&last).exists() {
            let switch_t0 = Instant::now();
            if send(
                &mgr,
                &workspace,
                PiOutbound::SwitchSession {
                    id: None,
                    session_path: last.clone(),
                },
            )
            .await
            .is_ok()
            {
                restored_session = Some(last);
            }
            perf_log(
                &format!("open_workspace/switch:{workspace}"),
                switch_t0.elapsed().as_millis(),
            );
        }
    }

    let session_file = current_session_file(&mgr, &workspace).await;
    perf_log(
        &format!("open_workspace/total:{workspace}"),
        t0.elapsed().as_millis(),
    );

    // Code Intelligence：首次打开未索引项目时后台自动 init（非阻塞，失败仅日志）。
    // 对话工作区（~/.pi/agent/works/<uuid>）是临时目录，不建代码索引——与
    // apply_conversation_tool_policy 给对话关闭 MCP 的策略保持一致，避免在临时对话目录里
    // 残留 .codegraph 索引。
    if auto_init_codegraph && !is_conversation_workspace(&cwd) && !cwd.join(".codegraph").is_dir() {
        let app_for_init = app.clone();
        let ws_for_init = workspace.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) =
                crate::commands::code_intel::code_intel_init(app_for_init, ws_for_init).await
            {
                eprintln!("[code-intel] auto-init failed: {e}");
            }
        });
    }

    Ok(OpenWorkspaceResult {
        restored_session,
        session_file,
    })
}

#[tauri::command]
pub async fn close_workspace(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<(), String> {
    mgr.close(&workspace).await;
    Ok(())
}

/// 预热一个工作区：仅 spawn pi 进程并发一次轻量 ping 让它把扩展加载完，
/// 不恢复会话、不改 touch 顺序。供前端在用户点击前（hover/最近会话）后台预热，
/// 把冷启动从切换关键路径移走，消除切会话/切项目的卡顿。已在运行则直接返回。
#[tauri::command]
pub async fn warm_workspace(
    workspace: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    if mgr.get(&workspace).await.is_some() {
        return Ok(());
    }
    let t0 = Instant::now();
    let cwd = resolve_workspace_dir(&workspace)?;
    let cwd_for_spawn = cwd.to_string_lossy().to_string();
    let app2 = app.clone();
    let ws = workspace.clone();
    let env = apply_conversation_tool_policy(store.settings_env().await, &cwd);
    store.write_runtime_config().await;
    let runtime_config = store.runtime_path().to_string_lossy().to_string();
    let client = mgr
        .get_or_open(&workspace, move || {
            let sink: Arc<dyn EventSink> = Arc::new(TauriSink { app: app2.clone() });
            spawn_pi_client(
                &app2,
                ws.clone(),
                &cwd_for_spawn,
                sink,
                env.clone(),
                &runtime_config,
            )
        })
        .await
        .map_err(|e| e.to_string())?;
    // 轻量 ping：迫使 pi 完成扩展加载后再就绪（结果忽略）。
    let _ = client.send(PiOutbound::GetState { id: None }).await;
    perf_log(
        &format!("warm_workspace:{workspace}"),
        t0.elapsed().as_millis(),
    );
    Ok(())
}

#[tauri::command]
pub async fn agent_prompt(
    workspace: String,
    message: String,
    images: Option<Vec<Value>>,
    streaming_behavior: Option<String>,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::Prompt {
            id: None,
            message,
            images,
            streaming_behavior,
        },
    )
    .await
}

#[tauri::command]
pub async fn agent_steer(
    workspace: String,
    message: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::Steer { id: None, message }).await
}

#[tauri::command]
pub async fn agent_follow_up(
    workspace: String,
    message: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::FollowUp { id: None, message }).await
}

#[tauri::command]
pub async fn agent_abort(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::Abort { id: None }).await
}

#[tauri::command]
pub async fn agent_set_model(
    workspace: String,
    provider: String,
    model_id: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::SetModel {
            id: None,
            provider,
            model_id,
        },
    )
    .await
}

#[tauri::command]
pub async fn agent_cycle_model(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::CycleModel { id: None }).await
}

#[tauri::command]
pub async fn agent_get_available_models(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::GetAvailableModels { id: None },
    )
    .await
}

#[tauri::command]
pub async fn agent_set_thinking_level(
    workspace: String,
    level: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::SetThinkingLevel { id: None, level },
    )
    .await
}

#[tauri::command]
pub async fn agent_cycle_thinking_level(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::CycleThinkingLevel { id: None },
    )
    .await
}

/// 切换 agent 模式（agent / ask / debug / plan）。底层走 prompt 通道发送 `/mode <mode>`，
/// 由 sidecar 的 agent-mode 扩展执行命令（限制工具集 + 注入对应 prompt），不调用 LLM；
/// 切换后新模式经 setStatus 推回前端供选择器回读。
#[tauri::command]
pub async fn agent_set_mode(
    workspace: String,
    mode: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::Prompt {
            id: None,
            message: format!("/mode {mode}"),
            images: None,
            streaming_behavior: None,
        },
    )
    .await
}

/// 切换审批策略（ask / auto / full）。底层走 prompt 通道发送 `/approval <level>`，
/// 由 sidecar 的 approval 扩展执行（设共享策略 + 持久化），不调用 LLM；
/// 切换后新策略经 setStatus 推回前端供选择器回读。
#[tauri::command]
pub async fn agent_set_approval(
    workspace: String,
    level: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::Prompt {
            id: None,
            message: format!("/approval {level}"),
            images: None,
            streaming_behavior: None,
        },
    )
    .await
}

#[tauri::command]
pub async fn agent_compact(
    workspace: String,
    custom_instructions: Option<String>,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::Compact {
            id: None,
            custom_instructions,
        },
    )
    .await
}

#[tauri::command]
pub async fn agent_set_auto_compaction(
    workspace: String,
    enabled: bool,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::SetAutoCompaction { id: None, enabled },
    )
    .await
}

#[tauri::command]
pub async fn agent_abort_retry(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::AbortRetry { id: None }).await
}

#[tauri::command]
pub async fn agent_get_session_stats(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::GetSessionStats { id: None }).await
}

#[tauri::command]
pub async fn agent_get_state(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::GetState { id: None }).await
}

#[tauri::command]
pub async fn agent_get_messages(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    let t0 = Instant::now();
    let result = send(&mgr, &workspace, PiOutbound::GetMessages { id: None }).await;
    perf_log(
        &format!("agent_get_messages:{workspace}"),
        t0.elapsed().as_millis(),
    );
    result
}

#[tauri::command]
pub async fn agent_get_commands(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::GetCommands { id: None }).await
}

#[tauri::command]
pub async fn agent_new_session(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::NewSession { id: None }).await
}

#[tauri::command]
pub async fn agent_switch_session(
    workspace: String,
    session_path: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<Value, String> {
    let data = send(
        &mgr,
        &workspace,
        PiOutbound::SwitchSession {
            id: None,
            session_path: session_path.clone(),
        },
    )
    .await?;
    store
        .update(|st| st.set_last_session(&workspace, &session_path))
        .await;
    Ok(data)
}

#[tauri::command]
pub async fn agent_fork(
    workspace: String,
    entry_id: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::Fork { id: None, entry_id }).await
}

#[tauri::command]
pub async fn agent_clone(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::Clone { id: None }).await
}

#[tauri::command]
pub async fn agent_get_fork_messages(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(&mgr, &workspace, PiOutbound::GetForkMessages { id: None }).await
}

#[tauri::command]
pub async fn agent_set_session_name(
    workspace: String,
    name: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<Value, String> {
    send(
        &mgr,
        &workspace,
        PiOutbound::SetSessionName { id: None, name },
    )
    .await
}

#[tauri::command]
pub async fn get_settings(
    store: State<'_, AppStateStore>,
) -> Result<std::collections::HashMap<String, String>, String> {
    Ok(store.settings_all().await)
}

#[tauri::command]
pub async fn set_settings(
    settings: std::collections::HashMap<String, String>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    store.replace_settings(settings).await;
    store.write_runtime_config().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_workspace_removes_mcp_servers_env() {
        let home = match dirs::home_dir() {
            Some(home) => home,
            None => return,
        };
        let works = home.join(".pi").join("agent").join("works");
        let _ = std::fs::create_dir_all(&works);
        let cwd = works.join("test-conversation");
        let mut env = HashMap::new();
        env.insert("MCP_SERVERS".into(), "[{}]".into());

        let next = apply_conversation_tool_policy(env, &cwd);

        assert!(!next.contains_key("MCP_SERVERS"));
        assert_eq!(next.get("MCP_DISABLED").map(String::as_str), Some("1"));
    }
}
