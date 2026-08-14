use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

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

// 内联展示音频/图片用：放宽到 64MB。TTS（尤其 MiMo 强制无损 wav，约 2-3MB/分钟）
// 一段朗读音频常超旧的 4MB 上限，导致 read_file_binary 失败、卡片显示「音频加载失败」。
const MAX_BINARY_BYTES: u64 = 64 * 1024 * 1024;

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
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "webm" => "audio/webm",
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

    // Atomic write: tmp + rename。tmp 名带 pid + 纳秒，避免同 stem 不同扩展名的文件
    // 并发写时撞同一个 .tmp（例如同目录同时写 a.md 与 a.json）。
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp_path = safe_path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
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
        return Err("File too large (max 64MB)".to_string());
    }

    let bytes = fs::read(&safe_path).map_err(security::sanitize_error)?;
    Ok(BinaryFile {
        mime_type: mime_from_path(&safe_path).to_string(),
        data: STANDARD.encode(bytes),
        size: meta.len(),
    })
}

/// 拖放白名单：仅记录用户「主动拖入」的文件绝对路径，`read_dropped_file` 只允许读取其中的文件。
/// 会话级内存状态（不持久化）。用户拖放即视为对该文件的一次性读取授权，借此安全支持工作区外文件
/// 的内容引用——既不放开任意路径读取，也不暴露绝对路径给模型（前端用文件名标注）。
#[derive(Default)]
pub struct DroppedAllowlist(pub Mutex<HashSet<PathBuf>>);

// 白名单容量上限：超过则清空再记本次拖放，防长期运行无界增长。
const MAX_DROPPED_ENTRIES: usize = 500;

#[tauri::command]
pub fn register_dropped_files(
    paths: Vec<String>,
    allow: tauri::State<'_, DroppedAllowlist>,
) -> Result<(), String> {
    let mut set = allow
        .0
        .lock()
        .map_err(|_| "allowlist lock poisoned".to_string())?;
    if set.len() > MAX_DROPPED_ENTRIES {
        set.clear();
    }
    for p in paths {
        if let Ok(canon) = fs::canonicalize(&p) {
            set.insert(canon);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn read_dropped_file(
    path: String,
    allow: tauri::State<'_, DroppedAllowlist>,
) -> Result<BinaryFile, String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};

    // 用 canonicalize 后的绝对路径比对白名单，避免 ./ 、符号链接等绕过校验。
    let canon = fs::canonicalize(&path).map_err(|_| "File does not exist".to_string())?;
    {
        let set = allow
            .0
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?;
        if !set.contains(&canon) {
            return Err("File not in dropped allowlist".to_string());
        }
    }

    let meta = fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BINARY_BYTES {
        return Err("File too large (max 64MB)".to_string());
    }

    let bytes = fs::read(&canon).map_err(|e| e.to_string())?;
    Ok(BinaryFile {
        mime_type: mime_from_path(&canon).to_string(),
        data: STANDARD.encode(bytes),
        size: meta.len(),
    })
}

/// 把拖放白名单内的文件复制进工作区 `.pi/dropped/`，返回相对工作区根的路径（正斜杠）。
/// 用于二进制/非文本文件（表格、PDF、Word 等）：复制进工作区后，agent 才能用 read/python
/// 等工具读取解析——直接发工作区外的绝对路径，pi 的工具大多沙箱在工作区、读不到。
#[tauri::command]
pub fn import_dropped_file(
    workspace: String,
    path: String,
    allow: tauri::State<'_, DroppedAllowlist>,
) -> Result<String, String> {
    let canon = fs::canonicalize(&path).map_err(|_| "File does not exist".to_string())?;
    {
        let set = allow
            .0
            .lock()
            .map_err(|_| "allowlist lock poisoned".to_string())?;
        if !set.contains(&canon) {
            return Err("File not in dropped allowlist".to_string());
        }
    }

    let meta = fs::metadata(&canon).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BINARY_BYTES {
        return Err("File too large (max 64MB)".to_string());
    }

    let workspace_root = resolve_workspace_dir(&workspace)?;

    // file_name() 已去除路径分隔，避免 `../` 之类逃逸出 .pi/dropped。
    let name = canon
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    // 用源绝对路径的短 hash 做子目录：不同来源的同名文件互不覆盖；
    // 同一文件重复拖入命中同一子目录（覆盖即更新）。
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    canon.hash(&mut hasher);
    let sub = format!("{:x}", hasher.finish());

    let dest_dir = workspace_root.join(".pi").join("dropped").join(&sub);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let dest = dest_dir.join(name);
    fs::copy(&canon, &dest).map_err(|e| e.to_string())?;

    Ok(format!(".pi/dropped/{sub}/{name}"))
}

/// 将 HTML 内容写入系统临时目录，返回文件绝对路径。
/// 前端用 tauri-plugin-opener 的 openPath 打开（Blob URL 在 Tauri WebView 里不可用）。
#[tauri::command]
pub async fn write_temp_html(content: String) -> Result<String, String> {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let filename = format!("gren-visual-{}.html", ms);
    let path = std::env::temp_dir().join(&filename);
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    path.to_str().ok_or_else(|| "invalid path".to_string()).map(|s| s.to_owned())
}
