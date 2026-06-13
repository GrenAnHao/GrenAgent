use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Serialize;

use crate::commands::sessions::resolve_workspace_dir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageItem {
    pub name: String,
    pub bytes: u64,
    pub modified_ms: i64,
}

fn images_dir(workspace: &str) -> Result<PathBuf, String> {
    let cwd = resolve_workspace_dir(workspace)?;
    Ok(cwd.join(".pi").join("images"))
}

fn read_image_list(dir: &Path) -> Result<Vec<ImageItem>, String> {
    if !dir.exists() {
        return Ok(vec![]);
    }
    let entries = std::fs::read_dir(dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("png"))
            != Some(true)
        {
            continue;
        }
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(ImageItem {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string(),
            bytes: meta.len(),
            modified_ms,
        });
    }
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms));
    Ok(out)
}

/// 安全读取 images 目录内某个图片为 base64（拒绝路径穿越：name 必须是纯文件名）。
fn read_image_base64(dir: &Path, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid image name".to_string());
    }
    let path = dir.join(name);
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

#[tauri::command]
pub fn create_list(workspace: String) -> Result<Vec<ImageItem>, String> {
    read_image_list(&images_dir(&workspace)?)
}

#[tauri::command]
pub fn create_image(workspace: String, name: String) -> Result<String, String> {
    read_image_base64(&images_dir(&workspace)?, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("crtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_png_files_sorted_desc() {
        let dir = tmp_dir();
        std::fs::write(dir.join("img_1.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(dir.join("img_2.png"), [4u8, 5]).unwrap();
        std::fs::write(dir.join("notes.txt"), b"x").unwrap();
        let list = read_image_list(&dir).unwrap();
        assert_eq!(list.len(), 2); // .txt 被过滤
        assert!(list.iter().all(|i| i.name.ends_with(".png")));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn reads_base64_and_rejects_traversal() {
        let dir = tmp_dir();
        std::fs::write(dir.join("img_1.png"), [0u8, 1, 2, 3]).unwrap();
        let b64 = read_image_base64(&dir, "img_1.png").unwrap();
        assert_eq!(
            b64,
            base64::engine::general_purpose::STANDARD.encode([0u8, 1, 2, 3])
        );
        assert!(read_image_base64(&dir, "../secret.png").is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_dir_is_empty() {
        assert!(read_image_list(Path::new("/no/such/images"))
            .unwrap()
            .is_empty());
    }
}
