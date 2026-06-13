use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::commands::knowledge::open_readonly;
use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewNote {
    pub id: String,
    pub file: String,
    pub line: Option<i64>,
    pub severity: String,
    pub message: String,
    pub created_at: i64,
}

fn review_db_path(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("reviews").join("reviews.db"))
}

fn read_review_notes(path: &Path) -> Result<Vec<ReviewNote>, String> {
    let Some(conn) = open_readonly(path)? else {
        return Ok(vec![]);
    };
    let mut stmt = conn
        .prepare("SELECT id, file, line, severity, message, createdAt FROM review_notes ORDER BY createdAt")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ReviewNote {
                id: r.get(0)?,
                file: r.get(1)?,
                line: r.get(2)?,
                severity: r.get(3)?,
                message: r.get(4)?,
                created_at: r.get(5)?,
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
pub fn rv_list(workspace: String) -> Result<Vec<ReviewNote>, String> {
    read_review_notes(&review_db_path(&workspace)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn tmp_db() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rvtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("reviews.db")
    }

    #[test]
    fn lists_notes_ordered_by_created() {
        let db = tmp_db();
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE review_notes(id TEXT PRIMARY KEY, file TEXT NOT NULL, line INTEGER, severity TEXT NOT NULL, message TEXT NOT NULL, createdAt INTEGER NOT NULL);
             INSERT INTO review_notes VALUES('n1','a.ts',10,'major','bug here',100);
             INSERT INTO review_notes VALUES('n2','b.ts',NULL,'nit','style',200);",
        )
        .unwrap();
        let notes = read_review_notes(&db).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].id, "n1");
        assert_eq!(notes[0].line, Some(10));
        assert_eq!(notes[1].line, None);
        assert_eq!(notes[1].severity, "nit");
        std::fs::remove_dir_all(db.parent().unwrap()).ok();
    }

    #[test]
    fn missing_db_is_empty() {
        assert!(read_review_notes(Path::new("/no/such/reviews.db"))
            .unwrap()
            .is_empty());
    }
}
