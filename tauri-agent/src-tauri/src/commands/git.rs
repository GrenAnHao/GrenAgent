use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileStatus {
    pub path: String,
    pub status: String, // "modified" | "staged" | "untracked"
}

fn porcelain_to_status(code: &str) -> String {
    if code == "??" {
        return "untracked".to_string();
    }
    let bytes = code.as_bytes();
    let index = bytes.first().copied().unwrap_or(b' ');
    let worktree = bytes.get(1).copied().unwrap_or(b' ');

    if worktree == b'M' || worktree == b'D' {
        return "modified".to_string();
    }
    if matches!(index, b'M' | b'A' | b'D' | b'R' | b'C') {
        return "staged".to_string();
    }
    "modified".to_string()
}

fn parse_porcelain_line(line: &str) -> Option<FileStatus> {
    if line.len() < 3 {
        return None;
    }
    let code = &line[0..2];
    let mut path = line[3..].trim().to_string();
    if let Some((_, new_path)) = path.split_once(" -> ") {
        path = new_path.to_string();
    }
    if path.is_empty() {
        return None;
    }
    Some(FileStatus {
        path,
        status: porcelain_to_status(code),
    })
}

fn run_git(cwd: &std::path::Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| format!("git spawn failed: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("git {} failed: {}", args.join(" "), stderr.trim()));
    }

    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn is_git_repo(cwd: &std::path::Path) -> bool {
    cwd.join(".git").exists()
}

#[tauri::command]
pub async fn get_git_status(workspace_path: String) -> Result<Vec<FileStatus>, String> {
    let cwd = resolve_workspace_dir(&workspace_path)?;
    if !is_git_repo(&cwd) {
        return Ok(vec![]);
    }

    let stdout = run_git(&cwd, &["status", "--porcelain"])?;
    Ok(stdout.lines().filter_map(parse_porcelain_line).collect())
}

#[tauri::command]
pub async fn get_git_diff(workspace_path: String, file_path: String) -> Result<String, String> {
    let cwd = resolve_workspace_dir(&workspace_path)?;
    if !is_git_repo(&cwd) {
        return Err("not a git repository".to_string());
    }

    run_git(&cwd, &["diff", "--", &file_path])
}
