use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tauri_plugin_shell::ShellExt;

use crate::commands::sessions::{
    collect_session_files, parse_session_header, paths_equivalent, read_first_line, sessions_dir,
};
use crate::pi::types::PiOutbound;
use crate::pi::PiManager;
use crate::state::AppStateStore;

/// works 根目录：~/.pi/agent/works（与 sessions 同源）。
fn works_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("works"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo {
    pub cwd: String,
}

/// FR-1：在 ~/.pi/agent/works/<uuid> 下创建目录，返回 canonical 路径。
#[tauri::command]
pub async fn create_conversation() -> Result<ConversationInfo, String> {
    let base = works_dir().ok_or("works directory unavailable")?;
    std::fs::create_dir_all(&base).map_err(|e| format!("create works dir failed: {e}"))?;
    let dir = base.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).map_err(|e| format!("create conversation dir failed: {e}"))?;
    let cwd = std::fs::canonicalize(&dir).map_err(|e| format!("canonicalize failed: {e}"))?;
    Ok(ConversationInfo {
        cwd: cwd.to_string_lossy().to_string(),
    })
}

/// 供前端做"是否对话"前缀判断：返回 ~/.pi/agent/works 的 canonical 路径。
#[tauri::command]
pub async fn get_works_dir() -> Result<String, String> {
    let base = works_dir().ok_or("works directory unavailable")?;
    std::fs::create_dir_all(&base).map_err(|e| format!("create works dir failed: {e}"))?;
    let canon = std::fs::canonicalize(&base).map_err(|e| format!("canonicalize failed: {e}"))?;
    Ok(canon.to_string_lossy().to_string())
}

/// 删除 sessions/ 下所有 header.cwd 等价于 `cwd` 的 .jsonl，返回删除条数。
/// 仅在 sessions 根内操作，跳过符号链接/非 jsonl。
pub(crate) fn delete_sessions_for_cwd(cwd: &str) -> Result<usize, String> {
    let sessions_root = sessions_dir().ok_or("sessions directory unavailable")?;
    let canonical_sessions = match std::fs::canonicalize(&sessions_root) {
        Ok(c) => c,
        Err(_) => return Ok(0),
    };
    let mut files = Vec::new();
    collect_session_files(&canonical_sessions, &mut files);
    let mut count = 0usize;
    for path in files {
        let first = match read_first_line(&path) {
            Ok(s) => s,
            Err(_) => continue,
        };
        let path_str = path.to_string_lossy().to_string();
        let info = match parse_session_header(&first, &path_str) {
            Some(i) => i,
            None => continue,
        };
        let matches = info
            .cwd
            .as_deref()
            .map(|c| paths_equivalent(c, cwd))
            .unwrap_or(false);
        if !matches {
            continue;
        }
        let canon = match std::fs::canonicalize(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(&canonical_sessions) {
            continue;
        }
        if canon.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        if std::fs::symlink_metadata(&path)
            .map(|m| m.is_symlink())
            .unwrap_or(false)
        {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            count += 1;
        }
    }
    Ok(count)
}

/// FR-4：删除一个对话（works/<uuid> 整个目录 + 其会话文件 + 应用记录）。
#[tauri::command]
pub async fn delete_conversation(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    let works_root = works_dir().ok_or("works directory unavailable")?;
    let canonical_works =
        std::fs::canonicalize(&works_root).map_err(|e| format!("invalid works root: {e}"))?;

    if let Ok(target) = std::fs::canonicalize(&workspace) {
        if !target.starts_with(&canonical_works) {
            return Err("not a conversation directory".into());
        }
        if std::fs::symlink_metadata(&workspace)
            .map(|m| m.is_symlink())
            .unwrap_or(false)
        {
            return Err("cannot delete symlinks".into());
        }
        mgr.close(&workspace).await;
        let _ = delete_sessions_for_cwd(&workspace);
        std::fs::remove_dir_all(&target).map_err(|e| format!("delete failed: {e}"))?;
    } else {
        mgr.close(&workspace).await;
        let _ = delete_sessions_for_cwd(&workspace);
    }

    let ws = workspace.clone();
    store.update(|st| st.forget_workspace(&ws)).await;
    Ok(())
}

/// FR-5：移除一个项目——仅清空其会话与应用记录，绝不删除真实目录。
#[tauri::command]
pub async fn remove_project(
    workspace: String,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<(), String> {
    mgr.close(&workspace).await;
    delete_sessions_for_cwd(&workspace)?;
    let ws = workspace.clone();
    store.update(|st| st.forget_workspace(&ws)).await;
    Ok(())
}

const LITE_KEYWORDS: &[&str] = &[
    "haiku", "mini", "flash", "lite", "small", "nano", "air", "8b", "7b", "4b", "1b",
];

fn is_lite(id: &str) -> bool {
    let l = id.to_lowercase();
    LITE_KEYWORDS.iter().any(|k| l.contains(k))
}

/// 标题小模型「启发式 + 兜底」：models = (provider, id, reasoning)。
fn pick_title_model(
    models: &[(String, String, bool)],
    current_provider: Option<&str>,
    current_model: Option<(&str, &str)>,
) -> Option<(String, String)> {
    let same = |p: &str| current_provider == Some(p);
    let pick = |f: &dyn Fn(&(String, String, bool)) -> bool| -> Option<(String, String)> {
        models
            .iter()
            .find(|m| f(m))
            .map(|m| (m.0.clone(), m.1.clone()))
    };
    pick(&|m| same(&m.0) && is_lite(&m.1) && !m.2)
        .or_else(|| pick(&|m| same(&m.0) && is_lite(&m.1)))
        .or_else(|| pick(&|m| is_lite(&m.1) && !m.2))
        .or_else(|| pick(&|m| is_lite(&m.1)))
        .or_else(|| current_model.map(|(p, id)| (p.to_string(), id.to_string())))
}

/// 清洗 LLM 标题输出：去 <think> 段、取首个非空行、>100 字符截断为 97+"..."。
fn clean_title(raw: &str) -> Option<String> {
    let mut s = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("<think>") {
        s.push_str(&rest[..start]);
        match rest[start..].find("</think>") {
            Some(end) => rest = &rest[start + end + "</think>".len()..],
            None => {
                rest = "";
                break;
            }
        }
    }
    s.push_str(rest);
    let line = s.lines().map(|l| l.trim()).find(|l| !l.is_empty())?;
    if line.is_empty() {
        return None;
    }
    if line.chars().count() > 100 {
        let truncated: String = line.chars().take(97).collect();
        Some(format!("{truncated}..."))
    } else {
        Some(line.to_string())
    }
}

/// 从 get_messages 的 data 里取第一条 user 文本。
fn extract_first_user_text(data: Option<Value>) -> Option<String> {
    let msgs = data?.get("messages")?.as_array()?.clone();
    for m in msgs {
        if m.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        if let Some(s) = m.get("content").and_then(|c| c.as_str()) {
            if !s.trim().is_empty() {
                return Some(s.to_string());
            }
        }
        if let Some(arr) = m.get("content").and_then(|c| c.as_array()) {
            let text: String = arr
                .iter()
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    None
}

/// (provider, id) 取自 RpcSessionState.model。
fn extract_provider_model(state: &Value) -> (Option<String>, Option<String>) {
    let m = state.get("model");
    let p = m
        .and_then(|m| m.get("provider"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let id = m
        .and_then(|m| m.get("id"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    (p, id)
}

/// 起临时 print-mode sidecar 生成标题（一次性，不写会话/不用工具）。
async fn run_pi_print_title(
    app: &tauri::AppHandle,
    cwd: &str,
    provider: &str,
    model: &str,
    prompt: &str,
    env: HashMap<String, String>,
) -> Result<String, String> {
    let package_dir = crate::pi::sidecar::pi_package_dir();
    let output = app
        .shell()
        .sidecar("pi")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args([
            "-p",
            "--no-session",
            "--no-tools",
            "--provider",
            provider,
            "--model",
            model,
            prompt,
        ])
        .env("PI_PACKAGE_DIR", &package_dir)
        .envs(env)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("title sidecar failed: {e}"))?;
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// FR-7：为对话生成并写回标题；失败静默返回 None。
#[tauri::command]
pub async fn auto_title_session(
    workspace: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
    store: State<'_, AppStateStore>,
) -> Result<Option<String>, String> {
    let client = match mgr.get(&workspace).await {
        Some(c) => c,
        None => return Ok(None),
    };

    // 1) 首条 user 消息
    let msgs = client
        .send(PiOutbound::GetMessages { id: None })
        .await
        .map_err(|e| e.to_string())?;
    if !msgs.success {
        return Ok(None);
    }
    let first_user = match extract_first_user_text(msgs.data) {
        Some(t) => t,
        None => return Ok(None),
    };

    // 2) 当前 provider/model
    let state = client
        .send(PiOutbound::GetState { id: None })
        .await
        .ok()
        .and_then(|r| r.data);
    let (cur_provider, cur_model) = match &state {
        Some(s) => extract_provider_model(s),
        None => (None, None),
    };

    // 3) 选模型：设置项 → 启发式 → 兜底当前
    let settings = store.settings_all().await;
    let (provider, model) = if let Some(tm) = settings
        .get("titleModel")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        match tm.split_once('/') {
            Some((p, m)) => (p.to_string(), m.to_string()),
            None => return Ok(None),
        }
    } else {
        let avail = client
            .send(PiOutbound::GetAvailableModels { id: None })
            .await
            .ok()
            .and_then(|r| r.data);
        let list: Vec<(String, String, bool)> = avail
            .and_then(|d| d.get("models").and_then(|m| m.as_array()).cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|m| {
                Some((
                    m.get("provider")?.as_str()?.to_string(),
                    m.get("id")?.as_str()?.to_string(),
                    m.get("reasoning").and_then(|r| r.as_bool()).unwrap_or(false),
                ))
            })
            .collect();
        let cur = match (&cur_provider, &cur_model) {
            (Some(p), Some(m)) => Some((p.as_str(), m.as_str())),
            _ => None,
        };
        match pick_title_model(&list, cur_provider.as_deref(), cur) {
            Some(pm) => pm,
            None => return Ok(None),
        }
    };

    // 4) 临时 sidecar 生成
    let prompt = format!("Generate a title for this conversation:\n{first_user}");
    let env = store.settings_env().await;
    let raw = match run_pi_print_title(&app, &workspace, &provider, &model, &prompt, env).await {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let title = match clean_title(&raw) {
        Some(t) => t,
        None => return Ok(None),
    };

    // 5) 写回 set_session_name
    let resp = client
        .send(PiOutbound::SetSessionName {
            id: None,
            name: title.clone(),
        })
        .await
        .map_err(|e| e.to_string())?;
    if !resp.success {
        return Ok(None);
    }
    Ok(Some(title))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn works_dir_under_pi_agent() {
        let d = works_dir().unwrap();
        assert!(d.ends_with("works"));
        assert!(d
            .to_string_lossy()
            .replace('\\', "/")
            .contains(".pi/agent/works"));
    }

    #[test]
    fn delete_matcher_uses_paths_equivalent() {
        let with = "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"C:/ws/a\",\"timestamp\":\"t\"}\n";
        let info = parse_session_header(with, "/tmp/a.jsonl").unwrap();
        assert!(paths_equivalent(info.cwd.as_deref().unwrap(), "C:\\ws\\a"));
    }

    #[test]
    fn pick_title_model_prefers_same_provider_lite_nonreasoning() {
        let models = vec![
            ("anthropic".to_string(), "claude-sonnet-4".to_string(), true),
            ("anthropic".to_string(), "claude-haiku-4".to_string(), false),
            ("openai".to_string(), "gpt-5-mini".to_string(), false),
        ];
        let got =
            pick_title_model(&models, Some("anthropic"), Some(("anthropic", "claude-sonnet-4")));
        assert_eq!(got, Some(("anthropic".to_string(), "claude-haiku-4".to_string())));
    }

    #[test]
    fn pick_title_model_falls_back_to_current_when_no_lite() {
        let models = vec![("x".to_string(), "big-model".to_string(), true)];
        let got = pick_title_model(&models, Some("x"), Some(("x", "big-model")));
        assert_eq!(got, Some(("x".to_string(), "big-model".to_string())));
    }

    #[test]
    fn clean_title_strips_think_and_truncates() {
        assert_eq!(
            clean_title("<think>hmm</think>\n  Refactor auth  \n"),
            Some("Refactor auth".to_string())
        );
        let long = "a".repeat(120);
        let t = clean_title(&long).unwrap();
        assert_eq!(t.chars().count(), 100);
        assert!(t.ends_with("..."));
        assert_eq!(clean_title("   \n  "), None);
    }
}
