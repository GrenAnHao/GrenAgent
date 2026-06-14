use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::commands::git::FileStatus;
use crate::commands::sessions::resolve_workspace_dir;

const MAX_DEPTH: usize = 6;
const MAX_CHILDREN: usize = 200;

const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "target",
    ".pi",
    "__pycache__",
    ".next",
    "coverage",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub children: Option<Vec<FileNode>>,
    pub git_status: Option<String>,
    pub size: Option<u64>,
}

fn should_skip_entry(name: &str, is_dir: bool) -> bool {
    if name.starts_with('.') && name != "." {
        return true;
    }
    if is_dir && SKIP_DIR_NAMES.iter().any(|s| *s == name) {
        return true;
    }
    false
}

fn build_tree(path: &Path, depth: usize) -> Result<FileNode, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let is_dir = meta.is_dir();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("workspace")
        .to_string();
    let path_str = path.to_string_lossy().to_string();

    if !is_dir {
        return Ok(FileNode {
            name,
            path: path_str,
            kind: "file".to_string(),
            children: None,
            git_status: None,
            size: Some(meta.len()),
        });
    }

    let mut children = Vec::new();
    if depth < MAX_DEPTH {
        let mut entries: Vec<PathBuf> = fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                let is_dir = p.is_dir();
                !should_skip_entry(name, is_dir)
            })
            .collect();
        entries.sort_by(|a, b| {
            let a_dir = a.is_dir();
            let b_dir = b.is_dir();
            match (a_dir, b_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a
                    .file_name()
                    .unwrap_or_default()
                    .cmp(b.file_name().unwrap_or_default()),
            }
        });

        for child in entries.into_iter().take(MAX_CHILDREN) {
            children.push(build_tree(&child, depth + 1)?);
        }
    }

    Ok(FileNode {
        name,
        path: path_str,
        kind: "directory".to_string(),
        children: if children.is_empty() {
            None
        } else {
            Some(children)
        },
        git_status: None,
        size: None,
    })
}

fn relative_path_from_root(root: &Path, abs_path: &str) -> Option<String> {
    let p = Path::new(abs_path);
    p.strip_prefix(root)
        .ok()
        .map(|r| r.to_string_lossy().replace('\\', "/"))
}

fn apply_git_status(node: &mut FileNode, root: &Path, status_map: &HashMap<String, String>) {
    if node.kind == "file" {
        if let Some(rel) = relative_path_from_root(root, &node.path) {
            if let Some(status) = status_map.get(&rel) {
                node.git_status = Some(status.clone());
            }
        }
    }
    if let Some(children) = node.children.as_mut() {
        for child in children.iter_mut() {
            apply_git_status(child, root, status_map);
        }
    }
}

async fn git_status_map(workspace: &str, _root: &Path) -> HashMap<String, String> {
    let statuses = crate::commands::git::get_git_status(workspace.to_string())
        .await
        .unwrap_or_default();
    statuses
        .into_iter()
        .map(|FileStatus { path, status }| (path.replace('\\', "/"), status))
        .collect()
}

#[tauri::command]
pub async fn get_file_tree(
    workspace: String,
    include_git_status: bool,
) -> Result<FileNode, String> {
    let root = resolve_workspace_dir(&workspace)?;
    if !root.exists() {
        return Err("workspace path does not exist".to_string());
    }
    let mut tree = build_tree(&root, 0)?;
    if include_git_status {
        let map = git_status_map(&workspace, &root).await;
        apply_git_status(&mut tree, &root, &map);
    }
    Ok(tree)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryFile {
    pub mime_type: String,
    pub data: String,
    pub size: u64,
}

const MAX_BINARY_BYTES: u64 = 4 * 1024 * 1024;

fn mime_from_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub async fn read_file(workspace: String, path: String) -> Result<String, String> {
    use crate::commands::sessions::resolve_workspace_dir;
    use crate::security;

    let workspace_root = resolve_workspace_dir(&workspace)?;
    let safe_path = security::validate_path_in_workspace(&workspace_root, &path)
        .map_err(security::sanitize_error)?;

    if !safe_path.exists() {
        return Err("File does not exist".to_string());
    }

    let meta = fs::metadata(&safe_path).map_err(security::sanitize_error)?;
    if meta.len() > 512 * 1024 {
        return Err("File too large to preview (max 512KB)".to_string());
    }

    fs::read_to_string(safe_path).map_err(security::sanitize_error)
}

#[tauri::command]
pub async fn write_file(workspace: String, path: String, content: String) -> Result<(), String> {
    use crate::commands::sessions::resolve_workspace_dir;
    use crate::security;

    let workspace_root = resolve_workspace_dir(&workspace)?;
    let safe_path = security::validate_path_in_workspace(&workspace_root, &path)
        .map_err(security::sanitize_error)?;

    // Atomic write: tmp + rename
    let tmp_path = safe_path.with_extension("tmp");
    fs::write(&tmp_path, &content).map_err(security::sanitize_error)?;
    fs::rename(&tmp_path, &safe_path).map_err(security::sanitize_error)?;

    Ok(())
}

#[tauri::command]
pub async fn read_file_binary(workspace: String, path: String) -> Result<BinaryFile, String> {
    use crate::security;
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    let workspace_root = resolve_workspace_dir(&workspace)?;
    let safe_path = security::validate_path_in_workspace(&workspace_root, &path)
        .map_err(security::sanitize_error)?;

    if !safe_path.exists() {
        return Err("File does not exist".to_string());
    }

    let meta = fs::metadata(&safe_path).map_err(security::sanitize_error)?;
    if meta.len() > MAX_BINARY_BYTES {
        return Err("File too large (max 4MB)".to_string());
    }

    let bytes = fs::read(&safe_path).map_err(security::sanitize_error)?;
    Ok(BinaryFile {
        mime_type: mime_from_path(&safe_path).to_string(),
        data: STANDARD.encode(bytes),
        size: meta.len(),
    })
}
