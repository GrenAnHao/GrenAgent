use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::commands::sessions::{
    collect_session_files, parse_session_header, paths_equivalent, read_first_line, sessions_dir,
};
use crate::pi::PiManager;
use crate::state::AppStateStore;

/// works 根目录：~/.pi/agent/works（与 sessions 同源）。
fn works_dir() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("works"))
}

/// 去掉 Windows 扩展长度前缀 `\\?\`（canonicalize 产物），返回普通路径。
/// pi 进程报告的 session.cwd 是规范化的普通路径，前端据此做 isUnder/分组比较；
/// 若这里返回 `\\?\` 前缀会与之不一致，且 PTY/git 对 `\\?\` 兼容性差。
fn strip_verbatim(p: &std::path::Path) -> String {
    let s = p.to_string_lossy().to_string();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    }
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
        cwd: strip_verbatim(&cwd),
    })
}

/// 供前端做"是否对话"前缀判断：返回 ~/.pi/agent/works 的 canonical 路径。
#[tauri::command]
pub async fn get_works_dir() -> Result<String, String> {
    let base = works_dir().ok_or("works directory unavailable")?;
    std::fs::create_dir_all(&base).map_err(|e| format!("create works dir failed: {e}"))?;
    let canon = std::fs::canonicalize(&base).map_err(|e| format!("canonicalize failed: {e}"))?;
    Ok(strip_verbatim(&canon))
}

/// 收集所有「已落盘会话」的 header.cwd（原始字符串，比较交给 paths_equivalent）。
fn session_cwds() -> Vec<String> {
    let mut out = Vec::new();
    let sessions_root = match sessions_dir() {
        Some(s) => s,
        None => return out,
    };
    let canonical = match std::fs::canonicalize(&sessions_root) {
        Ok(c) => c,
        Err(_) => return out,
    };
    let mut files = Vec::new();
    collect_session_files(&canonical, &mut files);
    for path in files {
        if let Ok(first) = read_first_line(&path) {
            let path_str = path.to_string_lossy().to_string();
            if let Some(cwd) = parse_session_header(&first, &path_str).and_then(|i| i.cwd) {
                out.push(cwd);
            }
        }
    }
    out
}

/// 清理核心（可测）：删除 `works_root` 直接子目录中「既不在 used 也不在 keep」的目录，返回删除条数。
/// 仅处理真实目录、跳过符号链接、双重校验仍在 works 根内；删除失败（如被占用）静默跳过。
fn prune_orphans_in(works_root: &std::path::Path, used: &[String], keep: &[String]) -> usize {
    let canonical_works = match std::fs::canonicalize(works_root) {
        Ok(c) => c,
        Err(_) => return 0,
    };
    let entries = match std::fs::read_dir(&canonical_works) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    let mut count = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let canon = match std::fs::canonicalize(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        if !canon.starts_with(&canonical_works) {
            continue;
        }
        let dir_str = strip_verbatim(&canon);
        // 保留：显式 keep（当前草稿）或仍有已落盘会话的真实对话。
        if keep.iter().any(|k| paths_equivalent(k, &dir_str)) {
            continue;
        }
        if used.iter().any(|c| paths_equivalent(c, &dir_str)) {
            continue;
        }
        if std::fs::remove_dir_all(&canon).is_ok() {
            count += 1;
        }
    }
    count
}

/// 清理 works 下所有「无对应会话」的孤儿对话目录（保留 keep 列表），返回删除条数。
///
/// 用途：空白对话（draft）会预建 `works/<uuid>` 临时目录支撑模型选择/预热；用户未发消息就关闭
/// 会留下无会话的空壳。启动时调用此命令清掉历史与崩溃残留，配合「统一复用未使用 draft」把空目录
/// 数量收敛到最多 1 个。
///
/// 安全：works 是「对话」模式自动建的临时 cwd，从不含用户文件（仅 app 生成的 .pi 等），
/// 故「无会话即可整目录删除」是安全的。绝不触碰用户自选的「项目」目录（它们不在 works 根下）。
#[tauri::command]
pub async fn prune_orphan_conversations(keep: Vec<String>) -> Result<usize, String> {
    let works_root = match works_dir() {
        Some(w) => w,
        None => return Ok(0),
    };
    Ok(prune_orphans_in(&works_root, &session_cwds(), &keep))
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
    fn strip_verbatim_removes_windows_prefix() {
        use std::path::Path;
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\a\b")), r"C:\a\b");
        assert_eq!(strip_verbatim(Path::new("/a/b")), "/a/b");
    }

    #[test]
    fn delete_matcher_uses_paths_equivalent() {
        let with = "{\"type\":\"session\",\"id\":\"a\",\"cwd\":\"C:/ws/a\",\"timestamp\":\"t\"}\n";
        let info = parse_session_header(with, "/tmp/a.jsonl").unwrap();
        assert!(paths_equivalent(info.cwd.as_deref().unwrap(), "C:\\ws\\a"));
    }

    #[test]
    fn prune_removes_orphans_keeps_used_and_kept() {
        let base = std::env::temp_dir().join(format!("pi-prune-{}", uuid::Uuid::new_v4()));
        let works = base.join("works");
        let used = works.join("used");
        let orphan = works.join("orphan");
        let keep = works.join("keep");
        std::fs::create_dir_all(&used).unwrap();
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::create_dir_all(&keep).unwrap();
        // 模拟孤儿目录里的 app 产物（.pi），确认非空也会被整目录清理。
        std::fs::create_dir_all(orphan.join(".pi")).unwrap();

        let used_str = strip_verbatim(&std::fs::canonicalize(&used).unwrap());
        let keep_str = strip_verbatim(&std::fs::canonicalize(&keep).unwrap());

        let removed = prune_orphans_in(&works, &[used_str], &[keep_str]);

        assert_eq!(removed, 1);
        assert!(used.exists(), "有会话的目录应保留");
        assert!(keep.exists(), "keep 列表中的目录应保留");
        assert!(!orphan.exists(), "无会话的孤儿目录应被删除");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn prune_missing_works_root_is_noop() {
        let missing = std::env::temp_dir().join(format!("pi-prune-missing-{}", uuid::Uuid::new_v4()));
        assert_eq!(prune_orphans_in(&missing, &[], &[]), 0);
    }
}
