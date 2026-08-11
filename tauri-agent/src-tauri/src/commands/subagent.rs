use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use crate::commands::knowledge::open_readonly;
use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubAgentItem {
    pub id: String,
    pub task: String,
    pub status: String,
    pub model: Option<String>,
    /// 已解析能力档案的 JSON（含 fs/name 等），前端据此推断「类型（只读/工作）」。
    pub profile: Option<String>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub exit_code: Option<i64>,
    /// 原始 `--mode json` JSONL transcript（运行期增量写入），前端据此实时回放子代理；旧库无该列时为 None。
    pub transcript: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

fn subagents_dir(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("subagents"))
}

fn registry_db_path(workspace: &str) -> Result<PathBuf, String> {
    Ok(subagents_dir(workspace)?.join("registry.db"))
}

fn cancel_requests_path(workspace: &str) -> Result<PathBuf, String> {
    Ok(subagents_dir(workspace)?.join("cancel-requests.jsonl"))
}

fn read_subagent_list(path: &Path, limit: i64) -> Result<Vec<SubAgentItem>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    // 扩展端会频繁写心跳（touch）；只读端等待而非立刻报 SQLITE_BUSY。
    conn.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='subagents'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Ok(vec![]);
    }
    // transcript 列不在列表查询里返回：单个子代理的完整 JSONL 可达数 MB，50 行同时传输
    // 会造成显著的 IPC 压力与 JS heap 峰值。需要时通过 subagent_get_transcript 按需单独拉取。
    let sql = "SELECT id, task, status, model, output, error, exitCode, \
               createdAt, updatedAt, profile \
               FROM subagents ORDER BY createdAt DESC LIMIT ?1";
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([limit], |r| {
            Ok(SubAgentItem {
                id: r.get(0)?,
                task: r.get(1)?,
                status: r.get(2)?,
                model: r.get(3)?,
                output: r.get(4)?,
                error: r.get(5)?,
                exit_code: r.get(6)?,
                created_at: r.get(7)?,
                updated_at: r.get(8)?,
                profile: r.get(9)?,
                transcript: None, // 不在列表查询中返回；使用 subagent_get_transcript 按需获取
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

fn append_cancel_request(path: &Path, agent_id: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let line = serde_json::json!({ "agentId": agent_id, "at": at }).to_string() + "\n";
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn subagent_list(workspace: String) -> Result<Vec<SubAgentItem>, String> {
    read_subagent_list(&registry_db_path(&workspace)?, 50)
}

/// 从已打开的 registry DB 读取单个代理的 transcript（IO 逻辑，便于单测）。
fn read_transcript(path: &Path, agent_id: &str) -> Result<Option<String>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(None);
    };
    conn.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    // 探测 transcript 列是否存在（旧库可能无该列）
    let has_col: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM pragma_table_info('subagents') WHERE name='transcript'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if has_col == 0 {
        return Ok(None);
    }
    let result: rusqlite::Result<Option<String>> = conn.query_row(
        "SELECT transcript FROM subagents WHERE id = ?1",
        [agent_id],
        |r| r.get(0),
    );
    match result {
        Ok(v) => Ok(v),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 按需拉取单个子代理的完整 JSONL transcript（用于打开详情面板，不在轮询路径中）。
/// transcript 列不存在或该代理不存在时返回 None（非错误）。
#[tauri::command]
pub fn subagent_get_transcript(
    workspace: String,
    agent_id: String,
) -> Result<Option<String>, String> {
    let id = agent_id.trim();
    if id.is_empty() {
        return Err("agentId is required".into());
    }
    read_transcript(&registry_db_path(&workspace)?, id)
}

#[tauri::command]
pub fn subagent_cancel(workspace: String, agent_id: String) -> Result<(), String> {
    let id = agent_id.trim();
    if id.is_empty() {
        return Err("agentId is required".into());
    }
    append_cancel_request(&cancel_requests_path(&workspace)?, id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("subagent-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn make_registry(path: &Path, rows: &[(&str, &str, &str)]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE subagents(
               id TEXT PRIMARY KEY,
               task TEXT NOT NULL,
               profile TEXT,
               model TEXT,
               status TEXT NOT NULL,
               output TEXT,
               error TEXT,
               exitCode INTEGER,
               createdAt INTEGER NOT NULL,
               updatedAt INTEGER NOT NULL
             );",
        )
        .unwrap();
        for (id, task, status) in rows {
            conn.execute(
                "INSERT INTO subagents(id,task,profile,model,status,output,error,exitCode,createdAt,updatedAt)
                 VALUES(?1,?2,NULL,NULL,?3,NULL,NULL,NULL,100,100)",
                rusqlite::params![id, task, status],
            )
            .unwrap();
        }
    }

    #[test]
    fn list_reads_rows_desc() {
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        make_registry(
            &db,
            &[("sa-1", "task a", "running"), ("sa-2", "task b", "done")],
        );
        let list = read_subagent_list(&db, 50).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, "sa-1");
        assert_eq!(list[0].status, "running");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn list_includes_profile_json() {
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE subagents(
                   id TEXT PRIMARY KEY,
                   task TEXT NOT NULL,
                   profile TEXT,
                   model TEXT,
                   status TEXT NOT NULL,
                   output TEXT,
                   error TEXT,
                   exitCode INTEGER,
                   createdAt INTEGER NOT NULL,
                   updatedAt INTEGER NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO subagents(id,task,profile,model,status,output,error,exitCode,createdAt,updatedAt)
                 VALUES('sa-p','t','{\"name\":\"explore\",\"fs\":\"readonly\"}',NULL,'done',NULL,NULL,NULL,100,100)",
                [],
            )
            .unwrap();
        }
        let list = read_subagent_list(&db, 50).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(
            list[0].profile.as_deref(),
            Some("{\"name\":\"explore\",\"fs\":\"readonly\"}")
        );
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn missing_registry_is_empty() {
        let dir = tmp_dir();
        let list = read_subagent_list(&dir.join("missing.db"), 50).unwrap();
        assert!(list.is_empty());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn append_cancel_request_writes_jsonl() {
        let dir = tmp_dir();
        let path = dir.join("cancel-requests.jsonl");
        append_cancel_request(&path, "sa-abc").unwrap();
        let raw = fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(parsed["agentId"], "sa-abc");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn list_never_returns_transcript_even_when_column_present() {
        // transcript 列存在也不在 list 查询里返回——避免 50 行全量 JSONL 走 IPC。
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE subagents(
                   id TEXT PRIMARY KEY,
                   task TEXT NOT NULL,
                   profile TEXT,
                   model TEXT,
                   status TEXT NOT NULL,
                   output TEXT,
                   error TEXT,
                   exitCode INTEGER,
                   transcript TEXT,
                   createdAt INTEGER NOT NULL,
                   updatedAt INTEGER NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO subagents(id,task,profile,model,status,output,error,exitCode,transcript,createdAt,updatedAt)
                 VALUES('sa-t','t',NULL,NULL,'running',NULL,NULL,NULL,'{\"type\":\"message_update\"}',100,100)",
                [],
            )
            .unwrap();
        }
        let list = read_subagent_list(&db, 50).unwrap();
        assert_eq!(list.len(), 1);
        // list 永远不返回 transcript，应为 None
        assert_eq!(list[0].transcript, None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn list_works_without_transcript_column() {
        // 旧库（无 transcript 列）不报错——查询不再引用该列。
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        make_registry(&db, &[("sa-old", "task", "done")]);
        let list = read_subagent_list(&db, 50).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].transcript, None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn get_transcript_returns_jsonl_when_present() {
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(
                "CREATE TABLE subagents(
                   id TEXT PRIMARY KEY,
                   task TEXT NOT NULL,
                   profile TEXT,
                   model TEXT,
                   status TEXT NOT NULL,
                   output TEXT,
                   error TEXT,
                   exitCode INTEGER,
                   transcript TEXT,
                   createdAt INTEGER NOT NULL,
                   updatedAt INTEGER NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO subagents(id,task,profile,model,status,output,error,exitCode,transcript,createdAt,updatedAt)
                 VALUES('sa-t','my task',NULL,NULL,'done',NULL,NULL,NULL,'{\"type\":\"agent_end\"}',100,100)",
                [],
            )
            .unwrap();
        }
        let t = read_transcript(&db, "sa-t").unwrap();
        assert_eq!(t.as_deref(), Some("{\"type\":\"agent_end\"}"));
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn get_transcript_returns_none_for_missing_id() {
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        make_registry(&db, &[("sa-1", "t", "done")]);
        let t = read_transcript(&db, "nonexistent").unwrap();
        assert_eq!(t, None);
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn get_transcript_returns_none_without_transcript_column() {
        let dir = tmp_dir();
        let db = dir.join("registry.db");
        make_registry(&db, &[("sa-1", "t", "done")]);
        // make_registry 建的是无 transcript 列的旧库
        let t = read_transcript(&db, "sa-1").unwrap();
        assert_eq!(t, None);
        fs::remove_dir_all(dir).ok();
    }
}
