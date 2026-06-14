use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::pi::types::PiOutbound;
use crate::pi::PiManager;

#[derive(Debug, Clone, Serialize)]
pub struct SessionInfo {
    pub id: String,
    pub path: String,
    pub cwd: Option<String>,
    pub timestamp: Option<String>,
    pub name: Option<String>,
}

/// 从一个 jsonl 文件内容解析会话 header（首行）。
pub fn parse_session_header(contents: &str, path: &str) -> Option<SessionInfo> {
    let first = contents.lines().next()?;
    let v: Value = serde_json::from_str(first.trim_end_matches('\r')).ok()?;
    if v.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    Some(SessionInfo {
        id: v
            .get("id")
            .and_then(|x| x.as_str())
            .unwrap_or_default()
            .to_string(),
        path: path.to_string(),
        cwd: v.get("cwd").and_then(|x| x.as_str()).map(str::to_string),
        timestamp: v
            .get("timestamp")
            .and_then(|x| x.as_str())
            .map(str::to_string),
        name: v.get("name").and_then(|x| x.as_str()).map(str::to_string),
    })
}

/// pi 默认会话目录：~/.pi/agent/sessions
fn sessions_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("sessions"))
}

fn read_first_line(path: &std::path::Path) -> std::io::Result<String> {
    use std::io::{BufRead, BufReader};
    let file = std::fs::File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    Ok(line)
}

/// 规范化路径字符串用于比较：统一分隔符为 '/'、去掉尾部 '/'。
fn normalize_path_str(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_string()
}

/// 判断两个路径是否指向同一位置：优先用 canonicalize；失败则回退到
/// 规范化字符串比较（Windows 下大小写不敏感）。
fn paths_equivalent(a: &str, b: &str) -> bool {
    if let (Ok(ca), Ok(cb)) = (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        return ca == cb;
    }
    let (na, nb) = (normalize_path_str(a), normalize_path_str(b));
    #[cfg(windows)]
    {
        na.eq_ignore_ascii_case(&nb)
    }
    #[cfg(not(windows))]
    {
        na == nb
    }
}

/// pi 将会话文件放在 `~/.pi/agent/sessions/<cwd-hash>/` 子目录下。
fn collect_session_files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_session_files(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

/// Tauri 开发时进程 cwd 常在 `src-tauri`，需上溯到项目根目录。
fn project_base_dir() -> Result<std::path::PathBuf, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let name = cwd.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name == "src-tauri" {
        return cwd
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "invalid src-tauri parent".to_string());
    }
    Ok(cwd)
}

/// 将前端传入的 workspace（常为 `.`）解析为 pi 侧使用的 cwd 绝对路径。
pub fn resolve_workspace_dir(workspace: &str) -> Result<std::path::PathBuf, String> {
    let base = project_base_dir()?;
    let p = if Path::new(workspace).is_absolute() {
        Path::new(workspace).to_path_buf()
    } else {
        base.join(workspace)
    };
    std::fs::canonicalize(&p).map_err(|e| format!("invalid workspace cwd: {e}"))
}

fn workspace_cwd(workspace: &str) -> String {
    resolve_workspace_dir(workspace)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| workspace.to_string())
}

/// 统一会话路径格式，便于与 pi `sessionFile` 比较。
pub fn canonical_display_path(path: &Path) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

fn perf_log(label: &str, elapsed_ms: u128) {
    eprintln!("[PERF-startup] {label}: {elapsed_ms}ms");
}

/// 列出某工作区（cwd）的会话，按 timestamp 倒序。
#[tauri::command]
pub async fn list_pi_sessions(workspace: String) -> Result<Vec<SessionInfo>, String> {
    let t0 = Instant::now();
    let cwd = workspace_cwd(&workspace);
    let dir = match sessions_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    let mut files = Vec::new();
    collect_session_files(&dir, &mut files);

    let mut out = Vec::new();
    for path in files {
        if let Ok(contents) = read_first_line(&path) {
            let path_str = canonical_display_path(&path);
            if let Some(info) = parse_session_header(&contents, &path_str) {
                let matches = info
                    .cwd
                    .as_deref()
                    .map(|c| paths_equivalent(c, &cwd))
                    .unwrap_or(false);
                if matches {
                    out.push(info);
                }
            }
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    perf_log(
        &format!("list_pi_sessions:{workspace} count={}", out.len()),
        t0.elapsed().as_millis(),
    );
    Ok(out)
}

async fn pi_get_session_file(mgr: &PiManager, workspace: &str) -> Result<Option<String>, String> {
    let client = mgr
        .get(workspace)
        .await
        .ok_or_else(|| format!("workspace not open: {workspace}"))?;
    let resp = client
        .send(PiOutbound::GetState { id: None })
        .await
        .map_err(|e| e.to_string())?;
    if !resp.success {
        return Err(resp.error.unwrap_or_else(|| "get_state failed".into()));
    }
    Ok(resp.data.and_then(|d| {
        d.get("sessionFile")
            .and_then(|v| v.as_str())
            .map(str::to_string)
    }))
}

/// 删除会话文件。若删除的是当前活跃会话，先 new_session 再删文件。
#[tauri::command]
pub async fn delete_pi_session(
    workspace: String,
    session_path: String,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<(), String> {
    use crate::security;

    // 1. 规范化会话目录
    let sessions_root = sessions_dir().ok_or("sessions directory unavailable")?;
    let canonical_sessions =
        std::fs::canonicalize(&sessions_root).map_err(security::sanitize_error)?;

    // 2. 规范化目标路径
    let path = Path::new(&session_path);
    if !path.exists() {
        return Err("session file not found".into());
    }

    let canonical_target = std::fs::canonicalize(path).map_err(|_| "session file not found")?;

    // 3. 检查边界
    if !canonical_target.starts_with(&canonical_sessions) {
        return Err("session file not in sessions directory".into());
    }

    // 4. 检查扩展名
    if canonical_target.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("not a session file".into());
    }

    // 5. 拒绝符号链接
    if std::fs::symlink_metadata(&session_path)
        .map(|m| m.is_symlink())
        .unwrap_or(false)
    {
        return Err("cannot delete symlinks".into());
    }

    let mgr = mgr.inner().clone();
    if let Ok(Some(active)) = pi_get_session_file(&mgr, &workspace).await {
        if paths_equivalent(&active, &session_path) {
            let client = mgr
                .get(&workspace)
                .await
                .ok_or_else(|| format!("workspace not open: {workspace}"))?;
            let resp = client
                .send(PiOutbound::NewSession { id: None })
                .await
                .map_err(|e| e.to_string())?;
            if !resp.success {
                return Err(resp
                    .error
                    .unwrap_or_else(|| "cannot start new session before delete".into()));
            }
        }
    }

    std::fs::remove_file(path).map_err(|e| format!("delete failed: {e}"))
}

/// 回传 extension UI 响应到 pi。
#[tauri::command]
pub async fn extension_ui_respond(
    workspace: String,
    response: Value,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<(), String> {
    let client = mgr
        .get(&workspace)
        .await
        .ok_or_else(|| format!("workspace not open: {workspace}"))?;
    client.respond_ui(response).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn request_workspace_approval(
    path: String,
    store: State<'_, crate::state::AppStateStore>,
) -> Result<(), String> {
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("invalid path: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    store.update(|st| st.approve_workspace(canonical_str)).await;
    Ok(())
}

#[tauri::command]
pub async fn is_workspace_approved(
    path: String,
    store: State<'_, crate::state::AppStateStore>,
) -> Result<bool, String> {
    let canonical = std::fs::canonicalize(&path).map_err(|e| format!("invalid path: {}", e))?;
    let canonical_str = canonical.to_string_lossy().to_string();

    Ok(store.is_approved(&canonical_str).await)
}

/// 列出所有项目（cwd）的会话，按 timestamp 倒序，不做 cwd 过滤。
/// 与 `list_pi_sessions` 的区别：后者只返回 cwd 匹配当前 workspace 的会话，
/// 本命令返回 `~/.pi/agent/sessions` 下全部带 cwd 的会话，供侧边栏按项目分组。
#[tauri::command]
pub async fn list_all_sessions() -> Result<Vec<SessionInfo>, String> {
    let t0 = Instant::now();
    let dir = match sessions_dir() {
        Some(d) => d,
        None => return Ok(vec![]),
    };
    let mut files = Vec::new();
    collect_session_files(&dir, &mut files);

    let mut out = Vec::new();
    for path in files {
        if let Ok(contents) = read_first_line(&path) {
            let path_str = canonical_display_path(&path);
            if let Some(info) = parse_session_header(&contents, &path_str) {
                // 仅保留带 cwd 的会话（cwd 即"项目"，无 cwd 无法分组）
                if info.cwd.is_some() {
                    out.push(info);
                }
            }
        }
    }
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    perf_log(
        &format!("list_all_sessions count={}", out.len()),
        t0.elapsed().as_millis(),
    );
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_session_header_first_line() {
        let jsonl = "{\"type\":\"session\",\"version\":3,\"id\":\"abc\",\"cwd\":\"/ws/a\",\"timestamp\":\"2026-06-10T00:00:00Z\"}\n{\"type\":\"message_start\"}\n";
        let info = parse_session_header(jsonl, "/tmp/abc.jsonl").unwrap();
        assert_eq!(info.id, "abc");
        assert_eq!(info.cwd.as_deref(), Some("/ws/a"));
        assert_eq!(info.path, "/tmp/abc.jsonl");
    }

    #[test]
    fn returns_none_for_non_session_first_line() {
        assert!(parse_session_header("{\"type\":\"message_start\"}\n", "/x").is_none());
        assert!(parse_session_header("", "/x").is_none());
    }

    #[test]
    fn normalize_path_str_unifies_separators_and_trailing() {
        assert_eq!(normalize_path_str("C:\\ws\\a\\"), "C:/ws/a");
        assert_eq!(normalize_path_str("/ws/a/"), "/ws/a");
    }

    #[test]
    fn paths_equivalent_falls_back_to_normalized_compare() {
        // 不存在的路径 → 走规范化回退分支
        assert!(paths_equivalent("/nope/ws/a", "/nope/ws/a/"));
        assert!(paths_equivalent("C:\\nope\\ws", "C:/nope/ws"));
    }

    #[test]
    fn list_all_keeps_only_sessions_with_cwd() {
        // list_all_sessions 仅保留带 cwd 的会话：验证过滤判据
        let with_cwd =
            "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"/ws/a\",\"timestamp\":\"2026-06-10T00:00:00Z\"}\n";
        let no_cwd = "{\"type\":\"session\",\"id\":\"b\",\"timestamp\":\"2026-06-10T00:00:00Z\"}\n";
        assert!(parse_session_header(with_cwd, "/tmp/a.jsonl")
            .unwrap()
            .cwd
            .is_some());
        assert!(parse_session_header(no_cwd, "/tmp/b.jsonl")
            .unwrap()
            .cwd
            .is_none());
    }
}
