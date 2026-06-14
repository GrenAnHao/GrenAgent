use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::knowledge::open_readonly;
use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemStats {
    pub project: i64,
    pub global: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemItem {
    pub id: String,
    pub text: String,
    pub category: Option<String>,
    pub created_at: i64,
    pub scope: String,
}

fn mem_project_path(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("memory").join("memory.db"))
}

/// 全局记忆 db：env `MEMORY_GLOBAL_DB` 优先，否则 `~/.pi/agent/long-term-memory.db`。
fn mem_global_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("MEMORY_GLOBAL_DB") {
        if !p.trim().is_empty() {
            return Some(PathBuf::from(p));
        }
    }
    dirs::home_dir().map(|h| h.join(".pi").join("agent").join("long-term-memory.db"))
}

fn read_mem_count(path: &Path) -> Result<i64, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(0);
    };
    conn.query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))
        .map_err(|e| e.to_string())
}

fn read_mem_list(path: &Path, scope: &str) -> Result<Vec<MemItem>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT id, text, category, createdAt FROM memories ORDER BY createdAt DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(MemItem {
                id: r.get(0)?,
                text: r.get(1)?,
                category: r.get(2)?,
                created_at: r.get(3)?,
                scope: scope.to_string(),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn mem_stats(workspace: String) -> Result<MemStats, String> {
    let project = read_mem_count(&mem_project_path(&workspace)?)?;
    let global = match mem_global_path() {
        Some(p) => read_mem_count(&p)?,
        None => 0,
    };
    Ok(MemStats { project, global })
}

#[tauri::command]
pub fn mem_list(workspace: String) -> Result<Vec<MemItem>, String> {
    let mut out = read_mem_list(&mem_project_path(&workspace)?, "project")?;
    if let Some(p) = mem_global_path() {
        out.extend(read_mem_list(&p, "global")?);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemHistoryItem {
    pub history_id: i64,
    pub memory_id: String,
    pub op: String,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub old_category: Option<String>,
    pub new_category: Option<String>,
    pub reason: Option<String>,
    pub version: i64,
    pub created_at: i64,
    pub scope: String,
}

fn read_mem_history(
    path: &Path,
    scope: &str,
    memory_id: Option<&str>,
) -> Result<Vec<MemHistoryItem>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    // memory_history may not exist on a pre-migration db.
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='memory_history'",
            [],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists == 0 {
        return Ok(vec![]);
    }
    let cols = "historyId, memoryId, op, oldText, newText, oldCategory, newCategory, reason, version, createdAt";
    let map_row = |r: &rusqlite::Row| {
        Ok(MemHistoryItem {
            history_id: r.get(0)?,
            memory_id: r.get(1)?,
            op: r.get(2)?,
            old_text: r.get(3)?,
            new_text: r.get(4)?,
            old_category: r.get(5)?,
            new_category: r.get(6)?,
            reason: r.get(7)?,
            version: r.get(8)?,
            created_at: r.get(9)?,
            scope: scope.to_string(),
        })
    };
    let mut out = Vec::new();
    if let Some(id) = memory_id {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {cols} FROM memory_history WHERE memoryId = ?1 ORDER BY historyId DESC"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([id], map_row).map_err(|e| e.to_string())?;
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
    } else {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT {cols} FROM memory_history ORDER BY historyId DESC LIMIT 200"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], map_row).map_err(|e| e.to_string())?;
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn mem_history(
    workspace: String,
    memory_id: Option<String>,
) -> Result<Vec<MemHistoryItem>, String> {
    let mut out = read_mem_history(&mem_project_path(&workspace)?, "project", memory_id.as_deref())?;
    if let Some(p) = mem_global_path() {
        out.extend(read_mem_history(&p, "global", memory_id.as_deref())?);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn make_mem(path: &Path, rows: &[(&str, &str, Option<&str>, i64)]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT, createdAt INTEGER NOT NULL, embedding BLOB);",
        )
        .unwrap();
        for (id, text, cat, ts) in rows {
            conn.execute(
                "INSERT INTO memories(id,text,category,createdAt,embedding) VALUES(?1,?2,?3,?4,NULL)",
                rusqlite::params![id, text, cat, ts],
            )
            .unwrap();
        }
    }

    fn tmp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("memtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn count_and_list_with_scope_tag() {
        let db = tmp_db("memory.db");
        make_mem(
            &db,
            &[
                ("m1", "likes dark mode", Some("preference"), 100),
                ("m2", "uses pnpm", None, 200),
            ],
        );
        assert_eq!(read_mem_count(&db).unwrap(), 2);
        let list = read_mem_list(&db, "project").unwrap();
        assert_eq!(list.len(), 2);
        // createdAt DESC：m2(200) 在前
        assert_eq!(list[0].id, "m2");
        assert_eq!(list[0].scope, "project");
        assert_eq!(list[1].category.as_deref(), Some("preference"));
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn missing_db_is_empty() {
        assert_eq!(read_mem_count(Path::new("/no/such/memory.db")).unwrap(), 0);
        assert!(read_mem_list(Path::new("/no/such/memory.db"), "global")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn history_reads_rows_desc_with_scope() {
        let db = tmp_db("memory.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE memory_history(historyId INTEGER PRIMARY KEY AUTOINCREMENT, memoryId TEXT NOT NULL, op TEXT NOT NULL, oldText TEXT, newText TEXT, oldCategory TEXT, newCategory TEXT, reason TEXT, model TEXT, version INTEGER NOT NULL, createdAt INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_history(memoryId,op,oldText,newText,version,createdAt) VALUES('m1','ADD',NULL,'a',1,100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO memory_history(memoryId,op,oldText,newText,version,createdAt) VALUES('m1','UPDATE','a','b',2,200)",
            [],
        )
        .unwrap();
        let rows = read_mem_history(&db, "project", None).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].op, "UPDATE"); // historyId DESC
        assert_eq!(rows[0].scope, "project");
        let filtered = read_mem_history(&db, "project", Some("m1")).unwrap();
        assert_eq!(filtered.len(), 2);
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn history_missing_db_is_empty() {
        assert!(read_mem_history(Path::new("/no/such/memory.db"), "global", None)
            .unwrap()
            .is_empty());
    }
}
