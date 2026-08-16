//! Read-first migration support for the legacy local memory stack.
//!
//! The scanner deals in source manifests rather than deleting or rewriting
//! legacy files. Import and cutover are explicit later states so a failed
//! Gateway connection can never destroy the only copy of a user's data.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, SecondsFormat, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::commands::sessions::{collect_session_files, sessions_dir};
use crate::pi::types::{PiOutbound, RpcResponse};
use crate::pi::PiManager;
use crate::state::AppStateStore;
use crate::tencentdb::MemoryRuntime;

const TENCENTDB_TEXT_LIMIT_UTF16: usize = 8192;
const WIKI_UPLOAD_CHUNK_BYTES: usize = 500 * 1024;
const PI_RECALL_PROBE_MESSAGE_TYPE: &str = "tencentdb-memory-probe";
const GATEWAY_HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationState {
    Scanned,
    Preview,
    Executing,
    Verifying,
    Migrated,
    Verified,
    Archived,
    Manual,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationSourceKind {
    MemorySqlite,
    SessionJsonl,
    Skill,
    Wiki,
    CodeGraph,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ManualResolutionKind {
    ExternalCompleted,
    ExplicitWaived,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualResolution {
    pub kind: ManualResolutionKind,
    pub note: String,
    pub resolved_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationItem {
    pub source_id: String,
    pub source_kind: MigrationSourceKind,
    pub source_path: String,
    pub state: MigrationState,
    pub item_count: u64,
    pub byte_count: u64,
    pub migrated_count: u64,
    pub target_id: Option<String>,
    pub error: Option<String>,
    pub retryable: bool,
    pub metadata: BTreeMap<String, String>,
    #[serde(default)]
    pub manual_resolution: Option<ManualResolution>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationBatch {
    pub source_id: String,
    pub target_id: Option<String>,
    pub count: u64,
    pub errors: Vec<String>,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationReport {
    pub gateway_healthy: bool,
    pub knowledge_healthy: bool,
    #[serde(default)]
    pub knowledge_ready: bool,
    pub counts_match: bool,
    pub sample_query: bool,
    pub pi_recall: bool,
    pub passed: bool,
    pub errors: Vec<String>,
    pub checked_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    pub run_id: String,
    pub workspace: String,
    pub state: MigrationState,
    pub items: Vec<MigrationItem>,
    pub total_count: u64,
    pub manual_count: u64,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRun {
    pub report: MigrationReport,
    #[serde(default)]
    pub batches: Vec<MigrationBatch>,
    /// The last explicit source selection. Persisting it prevents a restart
    /// from silently turning a partial import into a full import.
    #[serde(default)]
    pub selected_ids: Option<Vec<String>>,
    #[serde(default)]
    pub verification: Option<VerificationReport>,
    #[serde(default)]
    pub archived_at: Option<String>,
}

#[cfg(test)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CutoverPlan {
    pub verified: bool,
    pub disable_legacy_extensions: bool,
    pub remove_legacy_commands: bool,
    pub remove_codebase_resource: bool,
    pub preserve_legacy_data: bool,
    pub preserve_session_memory: bool,
}

#[cfg(test)]
impl CutoverPlan {
    pub fn keep_legacy_extensions(&self) -> bool {
        !self.disable_legacy_extensions
    }
}

#[cfg(test)]
pub fn cutover_plan(verified: bool) -> CutoverPlan {
    CutoverPlan {
        verified,
        disable_legacy_extensions: verified,
        remove_legacy_commands: false,
        remove_codebase_resource: false,
        // Physical deletion is intentionally outside this client. The user
        // must explicitly remove old data after an independently verified
        // backup; archive only changes runtime selection.
        preserve_legacy_data: true,
        preserve_session_memory: true,
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

pub(crate) fn workspace_run_key(workspace: &str) -> String {
    let normalized = normalized_workspace(workspace);
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in normalized.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("migration-{hash:016x}")
}

fn normalized_workspace(workspace: &str) -> String {
    let normalized = fs::canonicalize(workspace)
        .unwrap_or_else(|_| PathBuf::from(workspace))
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}

fn remote_count_matches(data: &Value, expected: u64) -> bool {
    data.get("total").and_then(Value::as_u64) == Some(expected)
}

fn sample_contains_target(data: &Value) -> bool {
    ["items", "messages"]
        .iter()
        .find_map(|key| data.get(*key).and_then(Value::as_array))
        .is_some_and(|items| {
            items.iter().any(|item| {
                let has_id = [
                    "id",
                    "memory_id",
                    "skill_id",
                    "wiki_id",
                    "code_graph_id",
                    "filename",
                    "path",
                ]
                .iter()
                .any(|key| {
                    item.get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                });
                let has_content = ["content", "text", "snippet"].iter().any(|key| {
                    item.get(*key)
                        .and_then(Value::as_str)
                        .is_some_and(|v| !v.is_empty())
                });
                has_id && has_content
            })
        })
}

fn core_recall_contains_content(data: &Value) -> bool {
    data.get("content")
        .and_then(Value::as_str)
        .is_some_and(|content| !content.trim().is_empty())
}

pub(crate) fn pi_probe_messages_contain_nonce(data: &Value, nonce: &str) -> bool {
    data.get("messages")
        .and_then(Value::as_array)
        .is_some_and(|messages| {
            messages.iter().any(|message| {
                // `get_messages` returns the AgentMessage directly, while a
                // session entry replay can wrap it under `message`.
                let message = message
                    .get("message")
                    .filter(|value| value.is_object())
                    .unwrap_or(message);
                message.get("role").and_then(Value::as_str) == Some("custom")
                    && message.get("customType").and_then(Value::as_str)
                        == Some(PI_RECALL_PROBE_MESSAGE_TYPE)
                    && message.get("content").and_then(Value::as_str) == Some(nonce)
                    && message
                        .get("details")
                        .and_then(|details| details.get("nonce"))
                        .and_then(Value::as_str)
                        == Some(nonce)
            })
        })
}

fn detail_contains_target_content(data: &Value, id_field: &str) -> bool {
    data.get(id_field)
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
        && data
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
}

fn code_graph_sample_contains_content(data: &Value) -> bool {
    data.get("isError").and_then(Value::as_bool) != Some(true)
        && data
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
}

fn source_id(kind: &MigrationSourceKind, path: &Path) -> String {
    let prefix = match kind {
        MigrationSourceKind::MemorySqlite => "memory",
        MigrationSourceKind::SessionJsonl => "session",
        MigrationSourceKind::Skill => "skill",
        MigrationSourceKind::Wiki => "wiki",
        MigrationSourceKind::CodeGraph => "codegraph",
    };
    format!("{prefix}:{}", path.to_string_lossy().replace('\\', "/"))
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

fn item(
    kind: MigrationSourceKind,
    path: &Path,
    count: u64,
    state: MigrationState,
    error: Option<String>,
) -> MigrationItem {
    MigrationItem {
        source_id: source_id(&kind, path),
        source_kind: kind,
        source_path: path.to_string_lossy().to_string(),
        state,
        item_count: count,
        byte_count: file_size(path),
        migrated_count: 0,
        target_id: None,
        error,
        retryable: false,
        metadata: BTreeMap::new(),
        manual_resolution: None,
    }
}

fn sqlite_has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

fn scan_memory_db(path: &Path) -> Option<MigrationItem> {
    if !path.is_file() {
        return None;
    }
    let mut result = item(
        MigrationSourceKind::MemorySqlite,
        path,
        0,
        MigrationState::Scanned,
        None,
    );
    match Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) if sqlite_has_table(&conn, "memories") => {
            result.item_count = conn
                .query_row("SELECT COUNT(*) FROM memories", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0)
                .max(0) as u64;
            // TencentDB's public v3 API deliberately exposes L1 update-only
            // semantics. It cannot create a record for an arbitrary legacy
            // ID, so pretending that `atomic/update` imported this database
            // would silently lose the whole source. Keep it visible and
            // require an explicit replay/export decision instead.
            result.state = MigrationState::Manual;
            result.error = Some(
                "TencentDB public L1 API cannot create legacy records; replay the source conversations or import this database manually".into(),
            );
            result.retryable = true;
            Some(result)
        }
        Ok(_) => None,
        Err(error) => {
            result.state = MigrationState::Manual;
            result.error = Some(format!("cannot read SQLite database: {error}"));
            result.retryable = true;
            Some(result)
        }
    }
}

fn collect_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_files(&path, out);
        } else {
            out.push(path);
        }
    }
}

/// Read the two required scalar fields from a SKILL.md frontmatter block.
/// TencentDB validates these fields against the body, so a directory name is
/// never a safe substitute for the declared Skill name.
fn skill_frontmatter(raw: &str) -> Result<(String, String)> {
    let text = raw.replace("\r\n", "\n").replace('\r', "\n");
    if !text.starts_with("---\n") {
        bail!("SKILL.md is missing the opening frontmatter fence");
    }
    let close = text[4..]
        .split_once("\n---")
        .map(|(_, tail)| tail)
        .and_then(|tail| tail.strip_prefix("\n").or(Some(tail)))
        .is_some();
    if !close {
        bail!("SKILL.md is missing the closing frontmatter fence");
    }
    let end = text[4..]
        .match_indices("\n---")
        .find_map(|(offset, _)| {
            let index = offset + 4;
            let after = text.as_bytes().get(index + 4).copied();
            (after.is_none() || after == Some(b'\n')).then_some(index)
        })
        .context("SKILL.md frontmatter closing fence is invalid")?;
    let mut name = None;
    let mut description = None;
    for line in text[4..end].lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value)
            .replace("\\\"", "\"")
            .replace("\\\\", "\\");
        match key.trim() {
            "name" => name = Some(value),
            "description" => description = Some(value),
            _ => {}
        }
    }
    let name = name
        .filter(|value| !value.trim().is_empty())
        .context("SKILL.md frontmatter name is missing")?;
    let description = description
        .filter(|value| !value.trim().is_empty() && value != "|" && value != ">")
        .context("SKILL.md frontmatter description is missing")?;
    if name.len() > 64
        || !name.chars().enumerate().all(|(index, value)| {
            value.is_ascii_lowercase() || value.is_ascii_digit() || value == '-' && index > 0
        })
    {
        bail!("SKILL.md frontmatter name is not a TencentDB-safe slug");
    }
    Ok((name, description))
}

/// Stable, source-derived suffix used to distinguish two documents named
/// `README.md` in different directories without exposing the full path.
fn stable_wiki_identity(source_id: &str) -> String {
    let basename = source_id
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("document.md");
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in source_id.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{basename}--{hash:012x}")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CodeGraphTargetStatus {
    SkipSync,
    RetrySync,
}

fn code_graph_target_status(data: &Value) -> Result<CodeGraphTargetStatus> {
    match data
        .get("status")
        .and_then(Value::as_str)
        .context("CodeGraph target status is missing")?
    {
        "pending" | "processing" | "ready" => Ok(CodeGraphTargetStatus::SkipSync),
        "failed" => Ok(CodeGraphTargetStatus::RetrySync),
        status => bail!("unknown CodeGraph target status: {status}"),
    }
}

fn scan_sessions(root: &Path, items: &mut Vec<MigrationItem>, seen: &mut HashSet<String>) {
    if !root.is_dir() {
        return;
    }
    let mut files = Vec::new();
    collect_session_files(root, &mut files);
    for path in files {
        let key = path.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        let contents = fs::read_to_string(&path).unwrap_or_default();
        let count = contents
            .lines()
            .filter(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .and_then(|v| {
                        v.get("type")
                            .and_then(Value::as_str)
                            .map(|t| t == "message")
                    })
                    .unwrap_or(false)
            })
            .count() as u64;
        let mut entry = item(
            MigrationSourceKind::SessionJsonl,
            &path,
            count,
            MigrationState::Scanned,
            None,
        );
        if let Some(session_id) = contents
            .lines()
            .find_map(|line| serde_json::from_str::<Value>(line).ok())
            .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_string))
        {
            entry.metadata.insert("sessionId".into(), session_id);
        }
        items.push(entry);
    }
}

fn scan_skills(root: &Path, items: &mut Vec<MigrationItem>, seen: &mut HashSet<String>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").is_file() {
            continue;
        }
        let key = path.to_string_lossy().to_string();
        if !seen.insert(key) {
            continue;
        }
        let mut files = Vec::new();
        collect_files(&path, &mut files);
        let bytes = files.iter().map(|p| file_size(p)).sum();
        let skill_file = path.join("SKILL.md");
        let frontmatter = fs::read_to_string(&skill_file)
            .ok()
            .and_then(|content| skill_frontmatter(&content).ok());
        let mut entry = item(
            MigrationSourceKind::Skill,
            &path,
            files.len() as u64,
            if frontmatter.is_some() {
                MigrationState::Scanned
            } else {
                MigrationState::Manual
            },
            frontmatter.is_none().then(|| {
                "SKILL.md must contain valid name and description frontmatter".to_string()
            }),
        );
        entry.byte_count = bytes;
        if let Some((name, description)) = frontmatter {
            entry.metadata.insert("name".into(), name);
            entry.metadata.insert("description".into(), description);
        }
        entry.retryable = entry.state == MigrationState::Manual;
        items.push(entry);
    }
}

fn scan_wiki_db(root: &Path, db_path: &Path, items: &mut Vec<MigrationItem>) {
    let Ok(conn) = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return;
    };
    if !sqlite_has_table(&conn, "chunks") {
        return;
    }
    let Ok(mut stmt) =
        conn.prepare("SELECT source, COUNT(*) FROM chunks GROUP BY source ORDER BY source")
    else {
        return;
    };
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    });
    let Ok(rows) = rows else { return };
    for row in rows.flatten() {
        let (source, count) = row;
        let source_path = PathBuf::from(&source);
        let path = if source_path.is_absolute() {
            source_path
        } else {
            root.join(&source_path)
        };
        let exists = path.is_file();
        let mut entry = item(
            MigrationSourceKind::Wiki,
            &path,
            1,
            if exists {
                MigrationState::Scanned
            } else {
                MigrationState::Manual
            },
            (!exists).then(|| format!("original wiki document is missing: {source}")),
        );
        entry.metadata.insert("source".into(), source);
        entry.metadata.insert(
            "relativePath".into(),
            path.strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/"),
        );
        entry
            .metadata
            .insert("legacyChunkCount".into(), count.max(0).to_string());
        entry.retryable = !exists;
        items.push(entry);
    }
}

fn git_remote(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .args([
            "-C",
            root.to_string_lossy().as_ref(),
            "remote",
            "get-url",
            "origin",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn git_branch(root: &Path) -> Option<String> {
    let output = Command::new("git")
        .args([
            "-C",
            root.to_string_lossy().as_ref(),
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && *line != "HEAD")
        .map(str::to_string)
}

fn scan_code_graph(root: &Path, items: &mut Vec<MigrationItem>) {
    let marker_candidates = [
        root.join(".pi").join("codebase-memory"),
        root.join(".pi").join("codebase-memory.json"),
        root.join(".codegraph"),
    ];
    let marker = marker_candidates.iter().find(|path| path.exists()).cloned();
    let remote = git_remote(root);
    let git_dir = root.join(".git");
    if remote.is_none() && marker.is_none() && !git_dir.exists() {
        return;
    }
    let path = marker.unwrap_or(git_dir);
    let mut entry = item(
        MigrationSourceKind::CodeGraph,
        &path,
        1,
        remote
            .as_ref()
            .map(|_| MigrationState::Scanned)
            .unwrap_or(MigrationState::Manual),
        remote
            .is_none()
            .then(|| "Git remote is unavailable; rebuild requires a remote URL".to_string()),
    );
    if let Some(remote) = remote {
        entry.metadata.insert("remote".into(), remote);
    }
    entry.metadata.insert(
        "branch".into(),
        git_branch(root).unwrap_or_else(|| "main".into()),
    );
    entry.retryable = entry.state == MigrationState::Manual;
    items.push(entry);
}

/// Scan only sources rooted under root. This entry point never touches the
/// user's real home directory and is used by migration tests.
#[cfg(test)]
pub fn scan_legacy_sources(root: &Path) -> Result<MigrationReport> {
    scan_legacy_sources_with_home(root, None)
}

pub fn scan_legacy_sources_with_home(root: &Path, home: Option<&Path>) -> Result<MigrationReport> {
    let mut items = Vec::new();
    let mut seen_sessions = HashSet::new();
    let mut seen_skills = HashSet::new();

    for path in [
        root.join(".pi/memory/memory.db"),
        root.join(".pi/memory.db"),
        root.join(".pi/agent/long-term-memory.db"),
    ] {
        if let Some(entry) = scan_memory_db(&path) {
            items.push(entry);
        }
    }
    scan_sessions(
        &root.join(".pi/agent/sessions"),
        &mut items,
        &mut seen_sessions,
    );
    scan_sessions(&root.join(".pi/sessions"), &mut items, &mut seen_sessions);
    scan_skills(&root.join(".agents/skills"), &mut items, &mut seen_skills);
    scan_skills(&root.join(".pi/agent/skills"), &mut items, &mut seen_skills);

    let wiki_db = root.join(".pi/knowledge/default.db");
    if wiki_db.is_file() {
        scan_wiki_db(root, &wiki_db, &mut items);
    }
    scan_code_graph(root, &mut items);

    if let Some(home) = home {
        for path in [
            home.join(".pi/agent/long-term-memory.db"),
            home.join(".pi/agent/memory.db"),
        ] {
            if let Some(entry) = scan_memory_db(&path) {
                if !items
                    .iter()
                    .any(|item| item.source_path == entry.source_path)
                {
                    items.push(entry);
                }
            }
        }
        if let Some(dir) = sessions_dir() {
            scan_sessions(&dir, &mut items, &mut seen_sessions);
        }
        scan_sessions(
            &home.join(".pi/agent/sessions"),
            &mut items,
            &mut seen_sessions,
        );
        scan_skills(&home.join(".agents/skills"), &mut items, &mut seen_skills);
        scan_skills(&home.join(".pi/agent/skills"), &mut items, &mut seen_skills);
    }

    items.sort_by_key(|entry| {
        (
            if entry.state == MigrationState::Manual {
                0
            } else {
                1
            },
            entry.source_path.clone(),
        )
    });
    let total_count = items.iter().map(|entry| entry.item_count).sum();
    let manual_count = items
        .iter()
        .filter(|entry| entry.state == MigrationState::Manual)
        .count() as u64;
    Ok(MigrationReport {
        run_id: uuid::Uuid::new_v4().simple().to_string(),
        workspace: root.to_string_lossy().to_string(),
        state: MigrationState::Scanned,
        items,
        total_count,
        manual_count,
        updated_at: now(),
    })
}

fn run_path_for_workspace(app: &tauri::AppHandle, workspace: Option<&str>) -> Result<PathBuf> {
    let root = app.path().app_data_dir()?.join("tencentdb-memory");
    Ok(match workspace.filter(|value| !value.trim().is_empty()) {
        Some(workspace) => root.join(format!("{}.json", workspace_run_key(workspace))),
        None => root.join("migration.json"),
    })
}

fn read_run(app: &tauri::AppHandle) -> Result<MigrationRun> {
    let path = run_path_for_workspace(app, None)?;
    let data = fs::read_to_string(&path).context("TencentDB migration has not been scanned")?;
    serde_json::from_str(&data).context("TencentDB migration state is invalid")
}

fn read_run_for_workspace(app: &tauri::AppHandle, workspace: Option<&str>) -> Result<MigrationRun> {
    let Some(workspace) = workspace.filter(|value| !value.trim().is_empty()) else {
        return read_run(app);
    };
    let path = run_path_for_workspace(app, Some(workspace))?;
    let data = fs::read_to_string(&path).with_context(|| {
        format!("TencentDB migration has not been scanned for workspace {workspace}")
    })?;
    let run: MigrationRun =
        serde_json::from_str(&data).context("TencentDB migration state is invalid")?;
    if normalized_workspace(&run.report.workspace) != normalized_workspace(workspace) {
        bail!("TencentDB migration state belongs to a different workspace");
    }
    Ok(run)
}

fn is_not_found_error(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::NotFound)
    })
}

fn write_run(app: &tauri::AppHandle, run: &MigrationRun) -> Result<()> {
    let path = run_path_for_workspace(app, Some(&run.report.workspace))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(run)?)?;
    replace_run_file(&tmp, &path)
}

#[cfg(windows)]
fn replace_run_file(tmp: &Path, path: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source: Vec<u16> = tmp
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // MoveFileExW performs the replacement in one filesystem operation. The
    // write-through flag keeps the durable run state from lagging behind a
    // successful command after a sudden process or machine stop.
    unsafe {
        MoveFileExW(
            PCWSTR(source.as_ptr()),
            PCWSTR(destination.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(|error| anyhow!("failed to replace TencentDB migration run: {error}"))
}

#[cfg(not(windows))]
fn replace_run_file(tmp: &Path, path: &Path) -> Result<()> {
    fs::rename(tmp, path).map_err(Into::into)
}

fn gateway_base(endpoint: &str, knowledge: bool) -> String {
    let mut base = endpoint.trim_end_matches('/').to_string();
    if knowledge && !base.ends_with("/v3") {
        base.push_str("/v3");
    }
    base
}

struct GatewayClient {
    core_endpoint: String,
    knowledge_endpoint: Option<String>,
    api_key: String,
    service_id: String,
    team_id: String,
    agent_id: String,
    user_id: String,
    task_id: Option<String>,
}

impl GatewayClient {
    fn insert_identity(&self, body: &mut serde_json::Map<String, Value>) {
        body.insert("team_id".into(), json!(self.team_id));
        body.insert("agent_id".into(), json!(self.agent_id));
        body.insert("user_id".into(), json!(self.user_id));
        if let Some(task_id) = &self.task_id {
            body.insert("task_id".into(), json!(task_id));
        }
    }

    async fn post_core(
        &self,
        path: &str,
        mut body: serde_json::Map<String, Value>,
    ) -> Result<Value> {
        self.insert_identity(&mut body);
        self.post_core_without_identity(path, body).await
    }

    async fn post_core_without_identity(
        &self,
        path: &str,
        body: serde_json::Map<String, Value>,
    ) -> Result<Value> {
        self.post(
            &gateway_base(&self.core_endpoint, false),
            path,
            body,
            Some(&self.service_id),
        )
        .await
    }

    async fn post_knowledge(
        &self,
        path: &str,
        mut body: serde_json::Map<String, Value>,
    ) -> Result<Value> {
        self.insert_identity(&mut body);
        self.post_knowledge_without_identity(path, body).await
    }

    async fn post_knowledge_without_identity(
        &self,
        path: &str,
        body: serde_json::Map<String, Value>,
    ) -> Result<Value> {
        let endpoint = self
            .knowledge_endpoint
            .as_deref()
            .context("TencentDB Knowledge endpoint is not configured")?;
        self.post(
            &gateway_base(endpoint, true),
            path,
            body,
            Some(&self.service_id),
        )
        .await
    }

    async fn post(
        &self,
        base: &str,
        path: &str,
        body: serde_json::Map<String, Value>,
        service_header: Option<&str>,
    ) -> Result<Value> {
        let url = format!(
            "{}/{}",
            base.trim_end_matches('/'),
            path.trim_start_matches('/')
        );
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        let mut request = client.post(url).bearer_auth(&self.api_key).json(&body);
        if let Some(service_id) = service_header {
            request = request.header("x-tdai-service-id", service_id);
        }
        let response = request.send().await?;
        let status = response.status();
        let envelope: Value = response
            .json()
            .await
            .context("TencentDB returned invalid JSON")?;
        let code = envelope.get("code").and_then(Value::as_i64).unwrap_or(0);
        if !status.is_success() || code != 0 {
            let message = envelope
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("TencentDB request failed");
            bail!("TencentDB request failed ({status}): {message}");
        }
        Ok(envelope.get("data").cloned().unwrap_or(envelope))
    }

    async fn health(&self) -> Result<bool> {
        let url = format!("{}/health", self.core_endpoint.trim_end_matches('/'));
        let client = reqwest::Client::builder()
            .timeout(GATEWAY_HEALTH_TIMEOUT)
            .build()?;
        let response = client.get(url).send().await?;
        Ok(response.status().is_success())
    }

    async fn knowledge_health(&self) -> bool {
        let Some(endpoint) = self.knowledge_endpoint.as_deref() else {
            return false;
        };
        let base = endpoint.trim_end_matches('/').trim_end_matches("/v3");
        let Ok(client) = reqwest::Client::builder()
            .timeout(GATEWAY_HEALTH_TIMEOUT)
            .build()
        else {
            return false;
        };
        client
            .get(format!("{base}/health"))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    }
}

async fn gateway_for(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    workspace: &str,
) -> Result<GatewayClient> {
    let workspace_path = Path::new(workspace);
    let env = crate::commands::tencentdb::prepare_memory_env_for_workspace(
        app,
        store,
        runtime,
        Some(workspace_path),
    )
    .await;
    let required = |key: &str| {
        env.get(key)
            .filter(|value| !value.trim().is_empty())
            .cloned()
            .with_context(|| format!("TencentDB environment value {key} is missing"))
    };
    Ok(GatewayClient {
        core_endpoint: required("TDAI_MEMORY_ENDPOINT")?,
        knowledge_endpoint: env.get("TDAI_KNOWLEDGE_ENDPOINT").cloned(),
        api_key: required("TDAI_MEMORY_API_KEY")?,
        service_id: required("TDAI_MEMORY_SERVICE_ID")?,
        team_id: required("TDAI_MEMORY_TEAM_ID")?,
        agent_id: required("TDAI_MEMORY_AGENT_ID")?,
        user_id: required("TDAI_MEMORY_USER_ID")?,
        task_id: env.get("TDAI_MEMORY_TASK_ID").cloned(),
    })
}

fn split_text_for_tencentdb(content: &str) -> Result<Vec<String>> {
    if content.trim().is_empty() {
        bail!("TencentDB text content is empty");
    }
    let mut parts = Vec::new();
    let mut start = 0;
    let mut utf16_units = 0;
    for (offset, value) in content.char_indices() {
        let width = value.len_utf16();
        if utf16_units + width > TENCENTDB_TEXT_LIMIT_UTF16 {
            parts.push(content[start..offset].to_string());
            start = offset;
            utf16_units = 0;
        }
        utf16_units += width;
    }
    parts.push(content[start..].to_string());
    Ok(parts)
}

async fn migrate_memory(
    _client: &GatewayClient,
    _entry: &MigrationItem,
) -> Result<(u64, Option<String>)> {
    bail!(
        "legacy L1 SQLite import requires manual handling: TencentDB atomic/update cannot create a new record"
    )
}

fn normalize_message_timestamp(value: &Value) -> Option<String> {
    if let Some(milliseconds) = value.as_i64() {
        return Utc
            .timestamp_millis_opt(milliseconds)
            .single()
            .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    let raw = value.as_str()?;
    if let Ok(milliseconds) = raw.parse::<i64>() {
        return Utc
            .timestamp_millis_opt(milliseconds)
            .single()
            .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true));
    }
    DateTime::parse_from_rfc3339(raw).ok().map(|date| {
        date.with_timezone(&Utc)
            .to_rfc3339_opts(SecondsFormat::Millis, true)
    })
}

fn json_message(value: &Value) -> Option<Value> {
    let raw = value.get("message").unwrap_or(value);
    let object = raw.as_object()?;
    let source_role = object.get("role").and_then(Value::as_str)?;
    let (role, annotation) = match source_role {
        "user" => ("user", None),
        "assistant" => ("assistant", None),
        "system" => ("assistant", Some("system")),
        "toolResult" | "tool_result" | "tool" => ("assistant", Some("tool_result")),
        "toolCall" | "tool_call" => ("assistant", Some("tool_call")),
        other => ("assistant", Some(other)),
    };
    let content = object.get("content")?;
    let mut content = content
        .as_str()
        .map(str::to_string)
        .unwrap_or_else(|| content.to_string());
    if content.trim().is_empty() {
        return None;
    }
    if let Some(annotation) = annotation {
        content = format!("[{annotation}]\n{content}");
    }
    let mut out = serde_json::Map::new();
    out.insert("role".into(), json!(role));
    out.insert("content".into(), json!(content));
    if let Some(timestamp) = object
        .get("timestamp")
        .or_else(|| value.get("timestamp"))
        .and_then(normalize_message_timestamp)
    {
        out.insert("timestamp".into(), json!(timestamp));
    }
    Some(Value::Object(out))
}

fn split_message_for_tencentdb(message: Value) -> Result<Vec<Value>> {
    let object = message
        .as_object()
        .context("migration message is not a JSON object")?;
    let content = object
        .get("content")
        .and_then(Value::as_str)
        .context("migration message content is not text")?;
    split_text_for_tencentdb(content)?
        .into_iter()
        .map(|part| {
            let mut split = object.clone();
            split.insert("content".into(), json!(part));
            Ok(Value::Object(split))
        })
        .collect()
}

fn accepted_message_count(result: &Value, expected: usize) -> Result<u64> {
    let accepted_ids = result
        .get("accepted_ids")
        .and_then(Value::as_array)
        .context("TencentDB conversation response is missing accepted_ids")?;
    let accepted = accepted_ids.len();
    if accepted != expected {
        bail!("TencentDB accepted {accepted} of {expected} conversation messages");
    }
    Ok(accepted as u64)
}

fn matching_message_prefix(existing: &[Value], planned: &[Value]) -> Result<usize> {
    if existing.len() > planned.len() {
        bail!(
            "TencentDB migration session has {} messages, but the source only has {}",
            existing.len(),
            planned.len()
        );
    }
    for (index, (remote, source)) in existing.iter().zip(planned).enumerate() {
        let remote_role = remote.get("role").and_then(Value::as_str);
        let remote_content = remote.get("content").and_then(Value::as_str);
        let source_role = source.get("role").and_then(Value::as_str);
        let source_content = source.get("content").and_then(Value::as_str);
        if remote_role != source_role || remote_content != source_content {
            bail!("TencentDB migration session diverges from the source at message {index}");
        }
    }
    Ok(existing.len())
}

async fn read_session_messages(client: &GatewayClient, session_id: &str) -> Result<Vec<Value>> {
    let mut messages = Vec::new();
    loop {
        let mut body = serde_json::Map::new();
        body.insert("session_id".into(), json!(session_id));
        body.insert("limit".into(), json!(100));
        body.insert("offset".into(), json!(messages.len()));
        let result = client.post_core("v3/conversation/query", body).await?;
        let page = result
            .get("messages")
            .and_then(Value::as_array)
            .context("TencentDB conversation query did not return messages")?;
        let total = result
            .get("total")
            .and_then(Value::as_u64)
            .context("TencentDB conversation query did not return total")?
            as usize;
        if page.is_empty() {
            if messages.len() < total {
                bail!("TencentDB conversation query returned an incomplete page");
            }
            break;
        }
        messages.extend(page.iter().cloned());
        if messages.len() >= total {
            break;
        }
    }
    Ok(messages)
}

async fn migrate_session(
    client: &GatewayClient,
    entry: &MigrationItem,
    on_target: &mut (dyn FnMut(&str) -> Result<()> + Send),
) -> Result<(u64, Option<String>)> {
    let contents = fs::read_to_string(&entry.source_path)?;
    let mut messages = Vec::new();
    for line in contents.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        if let Some(message) = json_message(&value) {
            messages.extend(split_message_for_tencentdb(message)?);
        }
    }
    if messages.is_empty() {
        return Ok((0, None));
    }
    let source_session_id = entry
        .metadata
        .get("sessionId")
        .cloned()
        .unwrap_or_else(|| entry.source_id.replace([':', '/', '\\'], "-"));
    let session_id = format!("legacy-{source_session_id}");
    on_target(&session_id)?;
    let existing = read_session_messages(client, &session_id).await?;
    let imported = matching_message_prefix(&existing, &messages)?;
    let mut accepted = imported as u64;
    for chunk in messages[imported..].chunks(100) {
        let mut body = serde_json::Map::new();
        body.insert("session_id".into(), json!(session_id));
        body.insert("messages".into(), json!(chunk));
        let result = client.post_core("v3/conversation/add", body).await?;
        accepted += accepted_message_count(&result, chunk.len())?;
    }
    Ok((accepted, Some(session_id)))
}

fn skill_resources(path: &Path) -> Result<Vec<Value>> {
    let mut files = Vec::new();
    collect_files(path, &mut files);
    let mut resources = Vec::new();
    for file in files {
        if file.file_name().and_then(|n| n.to_str()) == Some("SKILL.md") {
            continue;
        }
        let relative = file
            .strip_prefix(path)?
            .to_string_lossy()
            .replace('\\', "/");
        let bytes = fs::read(&file)?;
        if let Ok(content) = String::from_utf8(bytes.clone()) {
            resources.push(json!({ "path": relative, "content": content, "encoding": "utf-8" }));
        } else {
            resources.push(json!({
                "path": relative,
                "content": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
                "encoding": "base64"
            }));
        }
    }
    Ok(resources)
}

fn find_existing_skill_id(data: &Value, name: &str, source_id: &str) -> Result<Option<String>> {
    let Some(items) = data.get("items").and_then(Value::as_array) else {
        bail!("TencentDB skill list did not return items");
    };
    for item in items
        .iter()
        .filter(|item| item.get("name").and_then(Value::as_str) == Some(name))
    {
        let migration_source = item
            .get("metadata")
            .and_then(|metadata| metadata.get("migration_source_id"))
            .and_then(Value::as_str);
        if migration_source != Some(source_id) {
            bail!("TencentDB already contains a skill with the same name: {name}");
        }
        let skill_id = item
            .get("skill_id")
            .and_then(Value::as_str)
            .context("TencentDB skill list item has no skill_id")?;
        return Ok(Some(skill_id.to_string()));
    }
    Ok(None)
}

async fn migrate_skill(
    client: &GatewayClient,
    entry: &MigrationItem,
    on_target: &mut (dyn FnMut(&str) -> Result<()> + Send),
) -> Result<(u64, Option<String>)> {
    let content = fs::read_to_string(Path::new(&entry.source_path).join("SKILL.md"))?;
    let (name, description) = skill_frontmatter(&content)?;
    let mut list = serde_json::Map::new();
    list.insert(
        "filters".into(),
        json!({ "owner_agent_id": client.agent_id, "name_prefix": name }),
    );
    list.insert("pagination".into(), json!({ "limit": 10, "offset": 0 }));
    let existing = client.post_core("v3/skill/list", list).await?;
    if let Some(skill_id) = find_existing_skill_id(&existing, &name, &entry.source_id)? {
        on_target(&skill_id)?;
        return Ok((entry.item_count, Some(skill_id)));
    }
    let resources = skill_resources(Path::new(&entry.source_path))?;
    if resources.len() > 100 {
        bail!("TencentDB Skill accepts at most 100 resource files");
    }
    let mut body = serde_json::Map::new();
    body.insert("name".into(), json!(name));
    body.insert("content".into(), json!(content));
    body.insert("description".into(), json!(description));
    body.insert("resources".into(), Value::Array(resources));
    body.insert(
        "metadata".into(),
        json!({ "migration_source_id": entry.source_id }),
    );
    let result = client.post_core("v3/skill/create", body).await?;
    let target = result
        .get("skill_id")
        .and_then(Value::as_str)
        .context("TencentDB skill create did not return skill_id")?
        .to_string();
    on_target(&target)?;
    Ok((entry.item_count, Some(target)))
}

fn wiki_upload_filename(source: &Path) -> Result<String> {
    source
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .context("wiki source has no safe filename")
}

fn stable_wiki_upload_name(basename: &str, identity: &str) -> Result<String> {
    let suffix = identity
        .rsplit_once("--")
        .map(|(_, suffix)| suffix)
        .filter(|value| !value.is_empty())
        .context("wiki identity has no stable suffix")?;
    let path = Path::new(basename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .context("wiki source filename has no stem")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .filter(|value| matches!(value.as_str(), "md" | "txt"))
        .unwrap_or_else(|| "md".to_string());
    // MemoryKnowledge only ingests lowercase .md/.txt files. Legacy sources
    // with another text extension are uploaded as Markdown so they are not
    // silently accepted by raw/write and then skipped by ingestion.
    Ok(format!("{stem}--{suffix}.{extension}"))
}

fn wiki_upload_files(filename: &str, content: &str) -> Result<Vec<Value>> {
    if content.len() <= WIKI_UPLOAD_CHUNK_BYTES {
        return Ok(vec![json!({ "filename": filename, "content": content })]);
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .context("wiki source filename has no stem")?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let mut files = Vec::new();
    let mut start = 0;
    while start < content.len() {
        let mut end = (start + WIKI_UPLOAD_CHUNK_BYTES).min(content.len());
        while end > start && !content.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            bail!("wiki source cannot be split at a UTF-8 boundary");
        }
        files.push(json!({
            "filename": format!("{stem}.part-{:04}{extension}", files.len() + 1),
            "content": &content[start..end],
        }));
        start = end;
    }
    Ok(files)
}

async fn migrate_wiki(
    client: &GatewayClient,
    entry: &MigrationItem,
    on_target: &mut (dyn FnMut(&str) -> Result<()> + Send),
) -> Result<(u64, Option<String>)> {
    let source = Path::new(&entry.source_path);
    let basename = wiki_upload_filename(source)?;
    let filename = stable_wiki_identity(&entry.source_id);
    let wiki_id = if let Some(target) = entry.target_id.clone() {
        target
    } else {
        let mut create = serde_json::Map::new();
        create.insert("name".into(), json!(format!("Migrated Wiki - {filename}")));
        let created = client.post_knowledge("wiki/create", create).await?;
        created
            .get("wiki_id")
            .and_then(Value::as_str)
            .context("Knowledge service did not return wiki_id")?
            .to_string()
    };
    on_target(&wiki_id)?;
    let content = fs::read_to_string(source)?;
    // Keep the original basename visible to users while the stable suffix
    // prevents same-named documents from overwriting one another.
    let upload_name = stable_wiki_upload_name(&basename, &filename)?;
    let files = wiki_upload_files(&upload_name, &content)?;
    for page in files.chunks(10) {
        let mut write = serde_json::Map::new();
        write.insert("wiki_id".into(), json!(wiki_id));
        write.insert("files".into(), Value::Array(page.to_vec()));
        client.post_knowledge("wiki/raw/write", write).await?;
    }
    let mut ingest = serde_json::Map::new();
    ingest.insert("wiki_id".into(), json!(wiki_id));
    ingest.insert("user_id".into(), json!(client.user_id));
    client.post_knowledge("wiki/ingest", ingest).await?;
    Ok((1, Some(wiki_id)))
}

async fn migrate_code_graph(
    client: &GatewayClient,
    entry: &MigrationItem,
    on_target: &mut (dyn FnMut(&str) -> Result<()> + Send),
) -> Result<(u64, Option<String>)> {
    let repo_url = entry
        .metadata
        .get("remote")
        .cloned()
        .context("Git remote is missing")?;
    let graph_id = if let Some(target) = entry.target_id.clone() {
        target
    } else {
        let mut create = serde_json::Map::new();
        create.insert("repo_url".into(), json!(repo_url));
        create.insert(
            "branch".into(),
            json!(entry
                .metadata
                .get("branch")
                .cloned()
                .unwrap_or_else(|| "main".into())),
        );
        let created = client.post_knowledge("code-graph/create", create).await?;
        created
            .get("code_graph_id")
            .and_then(Value::as_str)
            .context("Knowledge service did not return code_graph_id")?
            .to_string()
    };
    on_target(&graph_id)?;
    // `create` already enqueues the initial build. A second immediate sync
    // races that build and is rejected with 409; only failed targets need an
    // explicit retry after a later status check.
    let mut status_body = serde_json::Map::new();
    status_body.insert("code_graph_id".into(), json!(graph_id));
    let status = client.post_knowledge("code-graph/get", status_body).await?;
    if code_graph_target_status(&status)? == CodeGraphTargetStatus::RetrySync {
        let mut sync = serde_json::Map::new();
        sync.insert("code_graph_id".into(), json!(graph_id));
        sync.insert("user_id".into(), json!(client.user_id));
        client.post_knowledge("code-graph/sync", sync).await?;
    }
    Ok((1, Some(graph_id)))
}

async fn migrate_item(
    client: &GatewayClient,
    entry: &MigrationItem,
    on_target: &mut (dyn FnMut(&str) -> Result<()> + Send),
) -> Result<(u64, Option<String>)> {
    match entry.source_kind {
        MigrationSourceKind::MemorySqlite => migrate_memory(client, entry).await,
        MigrationSourceKind::SessionJsonl => migrate_session(client, entry, on_target).await,
        MigrationSourceKind::Skill => migrate_skill(client, entry, on_target).await,
        MigrationSourceKind::Wiki => migrate_wiki(client, entry, on_target).await,
        MigrationSourceKind::CodeGraph => migrate_code_graph(client, entry, on_target).await,
    }
}

fn recompute_report_counts(report: &mut MigrationReport) {
    report.total_count = report.items.iter().map(|entry| entry.item_count).sum();
    report.manual_count = report
        .items
        .iter()
        .filter(|entry| entry.state == MigrationState::Manual && entry.manual_resolution.is_none())
        .count() as u64;
    report.updated_at = now();
}

fn select_items(report: &MigrationReport, selected_ids: Option<&[String]>) -> Vec<usize> {
    report
        .items
        .iter()
        .enumerate()
        .filter(|(_, entry)| {
            matches!(
                entry.state,
                MigrationState::Scanned | MigrationState::Preview | MigrationState::Failed
            )
        })
        .filter(|(_, entry)| {
            selected_ids
                .map(|ids| ids.iter().any(|id| id == &entry.source_id))
                .unwrap_or(true)
        })
        .map(|(index, _)| index)
        .collect()
}

fn persist_target_id(
    run: &mut MigrationRun,
    item_index: usize,
    batch_index: usize,
    target_id: &str,
) {
    let target_id = target_id.to_string();
    run.report.items[item_index].target_id = Some(target_id.clone());
    if let Some(batch) = run.batches.get_mut(batch_index) {
        batch.target_id = Some(target_id);
    }
}

fn recover_interrupted_run(run: &mut MigrationRun) -> bool {
    if run.report.state != MigrationState::Executing {
        return false;
    }
    let mut changed = false;
    for batch in &mut run.batches {
        if batch.retryable && batch.errors.is_empty() {
            let message = "migration process stopped before this batch completed".to_string();
            batch.errors.push(message.clone());
            if let Some(item) = run
                .report
                .items
                .iter_mut()
                .find(|item| item.source_id == batch.source_id)
            {
                if !matches!(
                    item.state,
                    MigrationState::Migrated | MigrationState::Manual
                ) {
                    item.state = MigrationState::Failed;
                    item.error = Some(message);
                    item.retryable = true;
                }
            }
            changed = true;
        }
    }
    let next_state = execution_result_state(&run.report.items);
    if run.report.state != next_state {
        run.report.state = next_state;
        changed = true;
    }
    recompute_report_counts(&mut run.report);
    changed
}

fn can_execute_from(state: &MigrationState) -> bool {
    matches!(
        state,
        MigrationState::Scanned
            | MigrationState::Preview
            | MigrationState::Executing
            | MigrationState::Failed
    )
}

fn execution_result_state(items: &[MigrationItem]) -> MigrationState {
    if items
        .iter()
        .any(|entry| entry.state == MigrationState::Failed)
    {
        MigrationState::Failed
    } else if items.iter().any(|entry| {
        entry.state != MigrationState::Manual && entry.state != MigrationState::Migrated
    }) {
        MigrationState::Preview
    } else if items
        .iter()
        .any(|entry| entry.state == MigrationState::Manual)
    {
        // Manual sources are an explicit user-visible hold point, not a
        // transport failure. Verification will fail until every item has an
        // explicit persisted resolution.
        MigrationState::Migrated
    } else {
        MigrationState::Verifying
    }
}

fn resolve_manual_item(
    run: &mut MigrationRun,
    run_id: &str,
    source_id: &str,
    kind: ManualResolutionKind,
    note: &str,
) -> Result<()> {
    if run.report.run_id != run_id {
        bail!("manual migration resolution belongs to a different run");
    }
    if matches!(
        run.report.state,
        MigrationState::Executing | MigrationState::Verified | MigrationState::Archived
    ) {
        bail!(
            "manual migration items cannot be resolved from state {:?}",
            run.report.state
        );
    }
    let note = note.trim();
    if note.is_empty() {
        bail!("manual migration resolution requires a note");
    }
    if note.chars().count() > 1000 {
        bail!("manual migration resolution note exceeds 1000 characters");
    }
    let entry = run
        .report
        .items
        .iter_mut()
        .find(|entry| entry.source_id == source_id)
        .context("manual migration source was not found")?;
    if entry.state != MigrationState::Manual {
        bail!("only manual migration sources can be resolved");
    }
    if let Some(existing) = entry.manual_resolution.as_ref() {
        if existing.kind == kind && existing.note == note {
            return Ok(());
        }
        bail!("manual migration source has already been resolved");
    }
    entry.manual_resolution = Some(ManualResolution {
        kind,
        note: note.to_string(),
        resolved_at: now(),
    });
    entry.retryable = false;
    run.verification = None;
    if run.report.state == MigrationState::Verifying {
        run.report.state = MigrationState::Migrated;
    }
    recompute_report_counts(&mut run.report);
    Ok(())
}

fn local_migration_counts_match(report: &MigrationReport) -> bool {
    report.manual_count == 0
        && report.items.iter().all(|entry| match entry.state {
            MigrationState::Migrated => entry.migrated_count >= entry.item_count,
            MigrationState::Manual => entry.manual_resolution.is_some(),
            _ => false,
        })
}

fn verification_result_state(passed: bool) -> MigrationState {
    if passed {
        MigrationState::Verified
    } else {
        MigrationState::Verifying
    }
}

fn knowledge_target_is_ready(data: &Value) -> Result<bool> {
    let status = data
        .get("status")
        .and_then(Value::as_str)
        .context("Knowledge service target status is missing")?;
    Ok(status == "ready")
}

fn wiki_target_is_ready(data: &Value) -> Result<bool> {
    if !knowledge_target_is_ready(data)? {
        return Ok(false);
    }
    let page_count = data
        .get("page_count")
        .and_then(Value::as_u64)
        .context("Knowledge Wiki page_count is missing")?;
    Ok(page_count > 0)
}

fn code_graph_target_is_ready(data: &Value) -> Result<bool> {
    if !knowledge_target_is_ready(data)? {
        return Ok(false);
    }
    let files = data
        .get("stats")
        .and_then(|stats| stats.get("files"))
        .and_then(Value::as_u64)
        .context("CodeGraph stats.files is missing")?;
    Ok(files > 0)
}

fn page_refs(data: &Value) -> Vec<String> {
    data.get("items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("id")
                        .or_else(|| item.get("ref"))
                        .or_else(|| item.get("path"))
                        .and_then(Value::as_str)
                        .filter(|value| !value.trim().is_empty())
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn page_read_contains_content(data: &Value) -> bool {
    data.get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("ref")
                    .and_then(Value::as_str)
                    .is_some_and(|value| !value.trim().is_empty())
                    && item
                        .get("content")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty())
            })
        })
}

async fn verify_knowledge_targets(
    client: &GatewayClient,
    items: &[MigrationItem],
) -> (bool, Vec<String>) {
    let mut errors = Vec::new();
    for entry in items.iter().filter(|entry| {
        entry.state == MigrationState::Migrated
            && matches!(
                entry.source_kind,
                MigrationSourceKind::Wiki | MigrationSourceKind::CodeGraph
            )
    }) {
        let Some(target_id) = entry.target_id.as_deref() else {
            errors.push(format!("知识资产缺少目标 ID：{}", entry.source_id));
            continue;
        };
        let (path, field) = match entry.source_kind {
            MigrationSourceKind::Wiki => ("wiki/get", "wiki_id"),
            MigrationSourceKind::CodeGraph => ("code-graph/get", "code_graph_id"),
            _ => unreachable!(),
        };
        let mut body = serde_json::Map::new();
        body.insert(field.into(), json!(target_id));
        match client.post_knowledge(path, body).await {
            Ok(data) => {
                let ready = match entry.source_kind {
                    MigrationSourceKind::Wiki => wiki_target_is_ready(&data),
                    MigrationSourceKind::CodeGraph => code_graph_target_is_ready(&data),
                    _ => unreachable!(),
                };
                let ready_ok = matches!(&ready, Ok(true));
                match ready {
                    Ok(true) => {}
                    Ok(false) => {
                        let status = data
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown");
                        errors.push(format!("知识资产仍未完成：{target_id} ({status})"));
                    }
                    Err(error) => errors.push(format!("知识资产状态无效：{target_id}: {error}")),
                }
                if ready_ok {
                    match entry.source_kind {
                        MigrationSourceKind::Wiki => {
                            let mut list_body = serde_json::Map::new();
                            list_body.insert("wiki_id".into(), json!(target_id));
                            match client
                                .post_knowledge_without_identity("wiki/page/ls", list_body)
                                .await
                            {
                                Ok(listed) => {
                                    let refs = page_refs(&listed);
                                    if refs.is_empty() {
                                        errors.push(format!("Wiki 没有已加工页面：{target_id}"));
                                    } else {
                                        let mut read_body = serde_json::Map::new();
                                        read_body.insert("wiki_id".into(), json!(target_id));
                                        read_body.insert(
                                            "refs".into(),
                                            json!([refs.first().cloned().unwrap_or_default()]),
                                        );
                                        match client
                                            .post_knowledge_without_identity(
                                                "wiki/page/read",
                                                read_body,
                                            )
                                            .await
                                        {
                                            Ok(read) if page_read_contains_content(&read) => {}
                                            Ok(_) => errors
                                                .push(format!("Wiki 页面读取为空：{target_id}")),
                                            Err(error) => errors.push(format!(
                                                "Wiki 页面读取失败：{target_id}: {error}"
                                            )),
                                        }
                                    }
                                }
                                Err(error) => {
                                    errors.push(format!("Wiki 页面列表失败：{target_id}: {error}"))
                                }
                            }
                        }
                        MigrationSourceKind::CodeGraph => {
                            let mut files_body = serde_json::Map::new();
                            files_body.insert("code_graph_id".into(), json!(target_id));
                            files_body.insert("format".into(), json!("flat"));
                            files_body.insert("includeMetadata".into(), json!(false));
                            match client
                                .post_knowledge_without_identity("code-graph/files", files_body)
                                .await
                            {
                                Ok(files) if code_graph_sample_contains_content(&files) => {}
                                Ok(_) => {
                                    errors.push(format!("CodeGraph 文件列表为空：{target_id}"))
                                }
                                Err(error) => errors
                                    .push(format!("CodeGraph 文件读取失败：{target_id}: {error}")),
                            }
                        }
                        _ => unreachable!(),
                    }
                }
            }
            Err(error) => errors.push(format!("知识资产验证失败：{target_id}: {error}")),
        }
    }
    (errors.is_empty(), errors)
}

/// Verify the durable count returned by TencentDB for every imported session.
/// The local JSONL count is only a planning estimate (system/tool records can
/// be normalized and long messages can be split), so the remote `total` and
/// the persisted migrated count are the authoritative pair here.
async fn verify_session_counts(
    client: &GatewayClient,
    items: &[MigrationItem],
) -> (bool, Vec<String>) {
    let mut errors = Vec::new();
    for entry in items.iter().filter(|entry| {
        entry.state == MigrationState::Migrated
            && entry.source_kind == MigrationSourceKind::SessionJsonl
    }) {
        let Some(session_id) = entry.target_id.as_deref() else {
            errors.push(format!("会话缺少远端 session ID：{}", entry.source_id));
            continue;
        };
        let mut body = serde_json::Map::new();
        body.insert("session_id".into(), json!(session_id));
        body.insert("limit".into(), json!(1));
        body.insert("offset".into(), json!(0));
        match client.post_core("v3/conversation/query", body).await {
            Ok(data) if remote_count_matches(&data, entry.migrated_count) => {}
            Ok(data) => {
                let actual = data
                    .get("total")
                    .and_then(Value::as_u64)
                    .map(|value| value.to_string())
                    .unwrap_or_else(|| "缺失".to_string());
                errors.push(format!(
                    "会话数量不匹配：{}（本地记录 {}, 远端 total {}）",
                    entry.source_id, entry.migrated_count, actual
                ));
            }
            Err(error) => errors.push(format!("会话数量验证失败：{}: {error}", entry.source_id)),
        }
    }
    (errors.is_empty(), errors)
}

/// Query every migrated target and require a non-empty item/message.
/// A successful HTTP envelope with an empty result is not evidence that the
/// import is readable, so it must fail the verification gate.
async fn sample_migrated_targets(
    client: &GatewayClient,
    items: &[MigrationItem],
) -> (bool, Vec<String>) {
    let mut checked = false;
    let mut errors = Vec::new();
    for entry in items
        .iter()
        .filter(|entry| entry.state == MigrationState::Migrated && entry.migrated_count > 0)
    {
        checked = true;
        let Some(target_id) = entry.target_id.as_deref() else {
            errors.push(format!("迁移目标缺少 ID：{}", entry.source_id));
            continue;
        };
        let result: Result<bool> = async {
            match entry.source_kind {
                MigrationSourceKind::SessionJsonl => {
                    let mut body = serde_json::Map::new();
                    body.insert("session_id".into(), json!(target_id));
                    body.insert("limit".into(), json!(1));
                    body.insert("offset".into(), json!(0));
                    client
                        .post_core("v3/conversation/query", body)
                        .await
                        .map(|data| sample_contains_target(&data))
                }
                MigrationSourceKind::Skill => {
                    let mut body = serde_json::Map::new();
                    body.insert("skill_id".into(), json!(target_id));
                    client
                        .post_core_without_identity("v3/skill/get", body)
                        .await
                        .map(|data| detail_contains_target_content(&data, "skill_id"))
                }
                MigrationSourceKind::Wiki => {
                    let mut list_body = serde_json::Map::new();
                    list_body.insert("wiki_id".into(), json!(target_id));
                    let listed = client
                        .post_knowledge_without_identity("wiki/page/ls", list_body)
                        .await?;
                    let reference = page_refs(&listed)
                        .into_iter()
                        .next()
                        .context("migrated wiki has no processed pages")?;
                    let mut read_body = serde_json::Map::new();
                    read_body.insert("wiki_id".into(), json!(target_id));
                    read_body.insert("refs".into(), json!([reference]));
                    client
                        .post_knowledge_without_identity("wiki/page/read", read_body)
                        .await
                        .map(|data| page_read_contains_content(&data))
                }
                MigrationSourceKind::CodeGraph => {
                    let mut body = serde_json::Map::new();
                    body.insert("code_graph_id".into(), json!(target_id));
                    body.insert("format".into(), json!("flat"));
                    body.insert("includeMetadata".into(), json!(false));
                    client
                        .post_knowledge_without_identity("code-graph/files", body)
                        .await
                        .map(|data| code_graph_sample_contains_content(&data))
                }
                MigrationSourceKind::MemorySqlite => Ok(true),
            }
        }
        .await;
        match result {
            Ok(true) => {}
            Ok(false) => errors.push(format!("迁移目标内容为空：{}", entry.source_id)),
            Err(error) => errors.push(format!("迁移目标抽样失败：{}: {error}", entry.source_id)),
        }
    }
    (checked && errors.is_empty(), errors)
}

async fn managed_pi_client(
    manager: &PiManager,
    workspace: &str,
) -> Option<(String, Arc<crate::pi::PiClient>)> {
    manager
        .all()
        .await
        .into_iter()
        .find(|(key, _)| normalized_workspace(key) == normalized_workspace(workspace))
}

pub(crate) async fn close_pi_sidecar(manager: &PiManager, workspace: &str) {
    // PiManager keys preserve the spelling used when the workspace was opened.
    // Resolve the real key first so canonical/relative and Windows case variants
    // cannot leave an old sidecar running after cutover.
    if let Some((key, _)) = managed_pi_client(manager, workspace).await {
        manager.close(&key).await;
    }
}

async fn pi_sidecar_is_alive(manager: &PiManager, workspace: &str) -> bool {
    let Some((_, client)) = managed_pi_client(manager, workspace).await else {
        return false;
    };
    matches!(
        tokio::time::timeout(
            Duration::from_secs(5),
            client.send(PiOutbound::GetState { id: None }),
        )
        .await,
        Ok(Ok(response)) if response.success
    )
}

fn pi_response_data(response: RpcResponse, command: &str) -> Result<Value> {
    if response.success {
        Ok(response.data.unwrap_or(Value::Null))
    } else {
        bail!(
            "Pi {command} failed: {}",
            response.error.unwrap_or_else(|| "unknown RPC error".into())
        )
    }
}

async fn pi_request(client: &crate::pi::PiClient, command: PiOutbound) -> Result<RpcResponse> {
    tokio::time::timeout(Duration::from_secs(5), client.send(command))
        .await
        .context("Pi RPC timed out")?
        .context("Pi RPC transport failed")
}

async fn wait_for_pi_idle(client: &crate::pi::PiClient) {
    for _ in 0..50 {
        let Ok(response) = pi_request(client, PiOutbound::GetState { id: None }).await else {
            return;
        };
        let Ok(data) = pi_response_data(response, "get_state") else {
            return;
        };
        if data.get("isStreaming").and_then(Value::as_bool) != Some(true) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_for_pi_probe_marker(client: &crate::pi::PiClient, nonce: &str) -> Result<bool> {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let response = pi_request(client, PiOutbound::GetMessages { id: None }).await?;
        let data = pi_response_data(response, "get_messages")?;
        if pi_probe_messages_contain_nonce(&data, nonce) {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn removable_probe_session(path: &str, original: &str) -> Option<PathBuf> {
    let root = fs::canonicalize(sessions_dir()?).ok()?;
    let file = fs::canonicalize(path).ok()?;
    if fs::canonicalize(original).ok().as_ref() == Some(&file) {
        return None;
    }
    file.starts_with(root).then_some(file)
}

async fn restore_pi_session(client: &crate::pi::PiClient, original_session: &str) -> Result<()> {
    let response = pi_request(
        client,
        PiOutbound::SwitchSession {
            id: None,
            session_path: original_session.to_string(),
        },
    )
    .await?;
    pi_response_data(response, "switch_session").map(|_| ())
}

pub(crate) async fn pi_recall_probe(manager: &PiManager, workspace: &str) -> Result<bool> {
    let Some((_, client)) = managed_pi_client(manager, workspace).await else {
        bail!("Pi sidecar is not open for workspace");
    };
    let original_state = pi_response_data(
        pi_request(&client, PiOutbound::GetState { id: None }).await?,
        "get_state",
    )?;
    if original_state.get("isStreaming").and_then(Value::as_bool) == Some(true) {
        bail!("Pi sidecar is busy; retry recall verification when idle");
    }
    let original_session = original_state
        .get("sessionFile")
        .and_then(Value::as_str)
        .context("Pi sidecar has no active session file")?
        .to_string();

    let new_data = match pi_request(&client, PiOutbound::NewSession { id: None })
        .await
        .and_then(|response| pi_response_data(response, "new_session"))
    {
        Ok(data) => data,
        Err(error) => {
            let _ = restore_pi_session(&client, &original_session).await;
            return Err(error);
        }
    };
    if new_data.get("cancelled").and_then(Value::as_bool) == Some(true) {
        let _ = restore_pi_session(&client, &original_session).await;
        bail!("Pi refused the temporary recall probe session");
    }
    let temp_session = match pi_request(&client, PiOutbound::GetState { id: None })
        .await
        .and_then(|response| pi_response_data(response, "get_state"))
        .and_then(|state| {
            state
                .get("sessionFile")
                .and_then(Value::as_str)
                .map(str::to_string)
                .context("Pi temporary probe session has no session file")
        }) {
        Ok(path) => path,
        Err(error) => {
            let _ = restore_pi_session(&client, &original_session).await;
            return Err(error);
        }
    };
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let prompt = format!("[tencentdb-memory-probe:{nonce}]");
    let probe_result = async {
        let response = pi_request(
            &client,
            PiOutbound::Prompt {
                id: None,
                message: prompt,
                images: None,
                streaming_behavior: None,
            },
        )
        .await?;
        let prompt_error = (!response.success).then(|| {
            response
                .error
                .unwrap_or_else(|| "unknown RPC error".to_string())
        });
        let marker_found = wait_for_pi_probe_marker(&client, &nonce).await?;
        if marker_found {
            return Ok(true);
        }
        if let Some(error) = prompt_error {
            bail!("Pi prompt failed before the recall marker was observed: {error}");
        }
        Ok(false)
    }
    .await;

    // The extension should already have aborted in before_provider_request;
    // this second abort closes the race if a provider hook was delayed.
    let _ = pi_request(&client, PiOutbound::Abort { id: None }).await;
    wait_for_pi_idle(&client).await;
    let restore_result = restore_pi_session(&client, &original_session).await;
    if let Some(path) = removable_probe_session(&temp_session, &original_session) {
        let _ = fs::remove_file(path);
    }
    restore_result?;
    probe_result
}

async fn execute_run(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    mut run: MigrationRun,
    selected_ids: Option<Vec<String>>,
) -> Result<MigrationRun> {
    if recover_interrupted_run(&mut run) {
        write_run(app, &run)?;
    }
    if !can_execute_from(&run.report.state) {
        bail!("migration cannot execute from state {:?}", run.report.state);
    }
    let selected_ids = selected_ids
        .or_else(|| run.selected_ids.clone())
        .unwrap_or_else(|| {
            run.report
                .items
                .iter()
                .filter(|entry| {
                    matches!(
                        entry.state,
                        MigrationState::Scanned | MigrationState::Preview | MigrationState::Failed
                    )
                })
                .map(|entry| entry.source_id.clone())
                .collect()
        });
    run.selected_ids = Some(selected_ids.clone());
    run.report.state = MigrationState::Executing;
    run.verification = None;
    write_run(app, &run)?;
    let client = gateway_for(app, store, runtime, &run.report.workspace).await?;
    for index in select_items(&run.report, Some(&selected_ids)) {
        let entry = run.report.items[index].clone();
        let batch_index = run.batches.len();
        run.batches.push(MigrationBatch {
            source_id: entry.source_id.clone(),
            target_id: None,
            count: 0,
            errors: Vec::new(),
            retryable: true,
        });
        write_run(app, &run)?;
        let result = {
            let mut on_target = |target_id: &str| {
                persist_target_id(&mut run, index, batch_index, target_id);
                // A target can be allocated before content upload or indexing;
                // persist it immediately so a crash can resume in place.
                write_run(app, &run)
            };
            migrate_item(&client, &entry, &mut on_target).await
        };
        match result {
            Ok((count, target)) => {
                run.report.items[index].migrated_count = count;
                run.report.items[index].target_id = target.clone();
                run.report.items[index].state = MigrationState::Migrated;
                run.report.items[index].error = None;
                run.report.items[index].retryable = false;
                run.batches[batch_index].target_id = target;
                run.batches[batch_index].count = count;
                run.batches[batch_index].retryable = false;
            }
            Err(error) => {
                let error = error.to_string();
                run.report.items[index].state = MigrationState::Failed;
                run.report.items[index].error = Some(error.clone());
                run.report.items[index].retryable = true;
                run.batches[batch_index].errors.push(error);
            }
        }
        recompute_report_counts(&mut run.report);
        write_run(app, &run)?;
    }
    run.report.state = execution_result_state(&run.report.items);
    recompute_report_counts(&mut run.report);
    write_run(app, &run)?;
    Ok(run)
}

async fn verify_run(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    manager: &PiManager,
    mut run: MigrationRun,
) -> Result<MigrationRun> {
    if !matches!(
        run.report.state,
        MigrationState::Verifying | MigrationState::Migrated
    ) {
        bail!("migration cannot verify from state {:?}", run.report.state);
    }
    let mut errors = Vec::new();
    let client = gateway_for(app, store, runtime, &run.report.workspace).await?;
    let gateway_healthy = client.health().await.unwrap_or(false);
    if !gateway_healthy {
        errors.push("MemoryCore health check failed".to_string());
    }
    let knowledge_healthy = match client.knowledge_endpoint.as_deref() {
        Some(_) => {
            let healthy = client.knowledge_health().await;
            if !healthy {
                errors.push("MemoryKnowledge health check failed".to_string());
            }
            healthy
        }
        None => {
            errors.push("MemoryKnowledge endpoint is not configured".to_string());
            false
        }
    };
    let (knowledge_ready, knowledge_errors) = if knowledge_healthy {
        verify_knowledge_targets(&client, &run.report.items).await
    } else {
        (false, Vec::new())
    };
    errors.extend(knowledge_errors);
    let local_counts_match = local_migration_counts_match(&run.report);
    let (session_counts_match, session_count_errors) = if gateway_healthy {
        verify_session_counts(&client, &run.report.items).await
    } else {
        (false, Vec::new())
    };
    errors.extend(session_count_errors);
    let counts_match = local_counts_match && session_counts_match;
    if !counts_match {
        errors.push("迁移数量或人工处理项未完成".to_string());
    }
    let (sample_query, sample_errors) = if counts_match && gateway_healthy {
        sample_migrated_targets(&client, &run.report.items).await
    } else {
        (false, Vec::new())
    };
    errors.extend(sample_errors);
    if !sample_query {
        errors.push("TencentDB 抽样查询未返回真实记忆或消息".to_string());
    }
    let core_recall = if gateway_healthy {
        match client
            .post_core("v3/core/read", serde_json::Map::new())
            .await
        {
            Ok(data) => core_recall_contains_content(&data),
            Err(error) => {
                errors.push(format!("L3 读取失败：{error}"));
                false
            }
        }
    } else {
        false
    };
    if !core_recall {
        errors.push("Pi 召回所需 L3 内容为空".to_string());
    }
    let sidecar_alive = pi_sidecar_is_alive(manager, &run.report.workspace).await;
    if !sidecar_alive {
        errors.push("当前 workspace 的 Pi sidecar 未运行或 RPC 无响应".to_string());
    }
    let pi_recall = if core_recall && sidecar_alive {
        match pi_recall_probe(manager, &run.report.workspace).await {
            Ok(true) => true,
            Ok(false) => {
                errors
                    .push("Pi before_agent_start 未产生匹配的 TencentDB 召回探针消息".to_string());
                false
            }
            Err(error) => {
                errors.push(format!("Pi 召回探针失败：{error}"));
                false
            }
        }
    } else {
        false
    };
    if !pi_recall {
        errors.push("Pi 召回链路验证失败".to_string());
    }
    let verification = VerificationReport {
        gateway_healthy,
        knowledge_healthy,
        knowledge_ready,
        counts_match,
        sample_query,
        pi_recall,
        passed: errors.is_empty(),
        errors,
        checked_at: now(),
    };
    run.report.state = verification_result_state(verification.passed);
    run.verification = Some(verification);
    recompute_report_counts(&mut run.report);
    write_run(app, &run)?;
    Ok(run)
}

fn write_cutover_marker(
    app: &tauri::AppHandle,
    run: &MigrationRun,
    archived_at: &str,
) -> Result<()> {
    let app_data_dir = app.path().app_data_dir()?;
    let path = crate::commands::tencentdb::workspace_cutover_marker_path(
        &app_data_dir,
        Path::new(&run.report.workspace),
    );
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let marker = json!({
        "verified": true,
        "archivedAt": archived_at,
        "runId": run.report.run_id,
        "workspace": run.report.workspace,
        "preserveLegacyData": true,
        "preserveSessionMemory": true,
    });
    let bytes = serde_json::to_vec_pretty(&marker)?;
    // An already valid marker is idempotent. This also makes retry safe on
    // platforms where rename cannot replace an existing file.
    if fs::read(&path).ok().as_deref() == Some(bytes.as_slice()) {
        return Ok(());
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &bytes)?;
    match fs::rename(&tmp, &path) {
        Ok(()) => {}
        Err(error) if path.exists() => {
            // Windows cannot replace an existing file with rename. Preserve
            // the idempotent retry behavior while keeping first writes atomic.
            let _ = fs::remove_file(&tmp);
            fs::write(&path, bytes)
                .with_context(|| format!("failed to replace TencentDB cutover marker: {error}"))?;
        }
        Err(error) => {
            let _ = fs::remove_file(&tmp);
            return Err(error.into());
        }
    }
    Ok(())
}

fn archive_allowed(run: &MigrationRun) -> bool {
    matches!(
        run.report.state,
        MigrationState::Verified | MigrationState::Archived
    ) && run
        .verification
        .as_ref()
        .is_some_and(|report| report.passed)
}

#[tauri::command]
pub async fn tencentdb_migration_status(
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<Option<MigrationRun>, String> {
    match read_run_for_workspace(&app, workspace.as_deref()) {
        Ok(mut run) => {
            if recover_interrupted_run(&mut run) {
                write_run(&app, &run).map_err(|error| error.to_string())?;
            }
            Ok(Some(run))
        }
        Err(error) if is_not_found_error(&error) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
pub async fn tencentdb_migration_scan(
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<MigrationRun, String> {
    let workspace = workspace
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "migration scan requires an explicit workspace".to_string())?;
    let root = fs::canonicalize(PathBuf::from(&workspace))
        .map_err(|error| format!("workspace is not accessible: {error}"))?;
    if !root.is_dir() {
        return Err("migration workspace must be a directory".into());
    }
    let home = dirs::home_dir();
    let report =
        scan_legacy_sources_with_home(&root, home.as_deref()).map_err(|e| e.to_string())?;
    let run = MigrationRun {
        report,
        batches: Vec::new(),
        selected_ids: None,
        verification: None,
        archived_at: None,
    };
    write_run(&app, &run).map_err(|e| e.to_string())?;
    Ok(run)
}

#[tauri::command]
pub async fn tencentdb_migration_preview(
    app: tauri::AppHandle,
    workspace: Option<String>,
) -> Result<MigrationRun, String> {
    let mut run = read_run_for_workspace(&app, workspace.as_deref()).map_err(|e| e.to_string())?;
    if run.report.state != MigrationState::Scanned {
        return Err(format!(
            "migration preview requires scanned state, got {:?}",
            run.report.state
        ));
    }
    run.report.state = MigrationState::Preview;
    run.report.updated_at = now();
    write_run(&app, &run).map_err(|e| e.to_string())?;
    Ok(run)
}

#[tauri::command]
pub async fn tencentdb_migration_execute(
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
    workspace: Option<String>,
    selected_ids: Option<Vec<String>>,
) -> Result<MigrationRun, String> {
    let run = read_run_for_workspace(&app, workspace.as_deref()).map_err(|e| e.to_string())?;
    execute_run(&app, &store, &runtime, run, selected_ids)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tencentdb_migration_resolve_manual(
    app: tauri::AppHandle,
    workspace: Option<String>,
    run_id: String,
    source_id: String,
    kind: ManualResolutionKind,
    note: String,
) -> Result<MigrationRun, String> {
    let mut run = read_run_for_workspace(&app, workspace.as_deref()).map_err(|e| e.to_string())?;
    resolve_manual_item(&mut run, &run_id, &source_id, kind, &note).map_err(|e| e.to_string())?;
    write_run(&app, &run).map_err(|e| e.to_string())?;
    Ok(run)
}

#[tauri::command]
pub async fn tencentdb_migration_verify(
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
    mgr: State<'_, Arc<PiManager>>,
    workspace: Option<String>,
) -> Result<MigrationRun, String> {
    let run = read_run_for_workspace(&app, workspace.as_deref()).map_err(|e| e.to_string())?;
    verify_run(&app, &store, &runtime, &mgr, run)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tencentdb_migration_archive(
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
    workspace: Option<String>,
) -> Result<MigrationRun, String> {
    let mut run = read_run_for_workspace(&app, workspace.as_deref()).map_err(|e| e.to_string())?;
    if !archive_allowed(&run) {
        return Err("migration must pass verification before archive".into());
    }
    let archived_at = run.archived_at.clone().unwrap_or_else(now);
    // The marker is the runtime cutover boundary. Keep the durable run in
    // `verified` when this write fails so the operation remains retryable.
    write_cutover_marker(&app, &run, &archived_at).map_err(|e| e.to_string())?;
    run.report.state = MigrationState::Archived;
    run.archived_at = Some(archived_at);
    run.report.updated_at = now();
    write_run(&app, &run).map_err(|e| e.to_string())?;
    close_pi_sidecar(&mgr, &run.report.workspace).await;
    Ok(run)
}

#[cfg(test)]
#[path = "tencentdb_test.rs"]
mod tests;
