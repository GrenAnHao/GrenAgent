//! UI 完整历史持久化：每会话一个 `<workspace>/.pi/ui-history/<sessionKey>.jsonl`。
//!
//! 背景：pi 后端 auto-compaction 会物理压缩会话，`agent_get_messages` 返回的历史随之变短。
//! 前端把「流式积累的完整历史」（reducer 不删）每轮结束覆盖写到这里，作为 UI 显示的权威来源，
//! 加载时优先读它，从而 UI 不再被压缩后的短历史覆盖（模型上下文仍照常压缩，互不影响）。

use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::sessions::resolve_workspace_dir;

/// `<workspace>/.pi/ui-history` 目录。
fn ui_history_dir(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("ui-history"))
}

/// 清洗 sessionKey：只当文件名用，禁止路径分隔与 `..`（防目录穿越）。
fn sanitize_key(session_key: &str) -> Result<String, String> {
    let k = session_key.trim();
    if k.is_empty() {
        return Err("session_key is required".into());
    }
    if k.contains('/') || k.contains('\\') || k.contains("..") {
        return Err("invalid session_key".into());
    }
    Ok(k.to_string())
}

/// 读指定目录下某会话历史 jsonl 全文；文件不存在返回空串（非错误）。IO 与 `resolve_workspace_dir`
/// 解耦，便于单测（命令层负责解析目录，这里只做纯文件 IO）。
fn read_history_at(dir: &Path, session_key: &str) -> Result<String, String> {
    let key = sanitize_key(session_key)?;
    let path = dir.join(format!("{key}.jsonl"));
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// 覆盖写某会话历史（原子：先写 `.tmp` 再 rename，避免半写留下损坏文件）。
fn write_history_at(dir: &Path, session_key: &str, content: &str) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    // 临时文件唯一化：进程号（跨进程）+ 进程内自增序号（同进程并发，如 flush 与 loadMessages 首次写盘
    // 同时发起）。若共用同名 tmp，一方 rename 后另一方会 rename 到已被移走的 tmp 而失败、丢失该次写。
    static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
    let key = sanitize_key(session_key)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{key}.jsonl"));
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{key}.jsonl.{}.{}.tmp", std::process::id(), seq));
    fs::write(&tmp, content.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// 删除某会话历史（不存在忽略）。
fn delete_history_at(dir: &Path, session_key: &str) -> Result<(), String> {
    let key = sanitize_key(session_key)?;
    let path = dir.join(format!("{key}.jsonl"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn ui_history_read(workspace: String, session_key: String) -> Result<String, String> {
    read_history_at(&ui_history_dir(&workspace)?, &session_key)
}

#[tauri::command]
pub fn ui_history_write(
    workspace: String,
    session_key: String,
    content: String,
) -> Result<(), String> {
    write_history_at(&ui_history_dir(&workspace)?, &session_key, &content)
}

#[tauri::command]
pub fn ui_history_delete(workspace: String, session_key: String) -> Result<(), String> {
    delete_history_at(&ui_history_dir(&workspace)?, &session_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("uihist-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_then_read_roundtrip() {
        let dir = tmp_dir();
        write_history_at(&dir, "sess-1", "{\"a\":1}\n{\"b\":2}\n").unwrap();
        assert_eq!(
            read_history_at(&dir, "sess-1").unwrap(),
            "{\"a\":1}\n{\"b\":2}\n"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn read_missing_returns_empty() {
        let dir = tmp_dir();
        assert_eq!(read_history_at(&dir, "nope").unwrap(), "");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn write_overwrites_existing() {
        let dir = tmp_dir();
        write_history_at(&dir, "s", "first").unwrap();
        write_history_at(&dir, "s", "second").unwrap();
        assert_eq!(read_history_at(&dir, "s").unwrap(), "second");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn delete_then_read_empty() {
        let dir = tmp_dir();
        write_history_at(&dir, "s", "x").unwrap();
        delete_history_at(&dir, "s").unwrap();
        assert_eq!(read_history_at(&dir, "s").unwrap(), "");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn delete_missing_is_ok() {
        let dir = tmp_dir();
        assert!(delete_history_at(&dir, "nope").is_ok());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn concurrent_writes_leave_valid_file() {
        // tmp 唯一化后：并发写同一 session 不会因抢占同名 tmp 而破坏最终文件（内容必为某一次的完整写入）。
        let dir = tmp_dir();
        let dir2 = dir.clone();
        let h = std::thread::spawn(move || {
            for _ in 0..50 {
                write_history_at(&dir2, "s", "AAAA").unwrap();
            }
        });
        for _ in 0..50 {
            write_history_at(&dir, "s", "BBBB").unwrap();
        }
        h.join().unwrap();
        let got = read_history_at(&dir, "s").unwrap();
        assert!(
            got == "AAAA" || got == "BBBB",
            "unexpected content: {got:?}"
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn sanitize_rejects_traversal_and_separators() {
        assert!(sanitize_key("../evil").is_err());
        assert!(sanitize_key("a/b").is_err());
        assert!(sanitize_key("a\\b").is_err());
        assert!(sanitize_key("").is_err());
        assert_eq!(sanitize_key("  ok-key  ").unwrap(), "ok-key");
    }
}
