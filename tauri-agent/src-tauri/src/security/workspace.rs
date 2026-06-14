use std::fs;
use std::path::{Path, PathBuf};

pub fn validate_path_in_workspace(
    workspace_root: &Path,
    target_path: &str,
) -> Result<PathBuf, String> {
    let canonical_root =
        fs::canonicalize(workspace_root).map_err(|e| format!("invalid workspace root: {}", e))?;

    let target = if Path::new(target_path).is_absolute() {
        PathBuf::from(target_path)
    } else {
        canonical_root.join(target_path)
    };

    let canonical_target = if target.exists() {
        fs::canonicalize(&target).map_err(|e| e.to_string())?
    } else {
        let parent = target.parent().ok_or("invalid path")?;
        if !parent.exists() {
            return Err("parent directory does not exist".into());
        }
        let canonical_parent = fs::canonicalize(parent).map_err(|e| e.to_string())?;
        canonical_parent.join(target.file_name().ok_or("invalid file name")?)
    };

    if !canonical_target.starts_with(&canonical_root) {
        return Err("path outside workspace".into());
    }

    if let Ok(meta) = fs::symlink_metadata(&canonical_target) {
        if meta.is_symlink() {
            let link_target = fs::read_link(&canonical_target).map_err(|e| e.to_string())?;
            if !link_target.starts_with(&canonical_root) {
                return Err("symlink points outside workspace".into());
            }
        }
    }

    Ok(canonical_target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_absolute_path_escape() {
        let temp = std::env::temp_dir();
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let evil_path = if cfg!(windows) {
            "C:\\Windows\\System32\\calc.exe"
        } else {
            "/etc/passwd"
        };

        let result = validate_path_in_workspace(&workspace, evil_path);
        assert!(result.is_err());
    }

    #[test]
    fn rejects_relative_traversal() {
        let temp = std::env::temp_dir();
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        let result = validate_path_in_workspace(&workspace, "../../etc/passwd");
        assert!(result.is_err());
    }

    #[test]
    fn allows_valid_relative_path() {
        let temp = std::env::temp_dir();
        let workspace = temp.join("workspace");
        fs::create_dir_all(&workspace).unwrap();

        // Create subdirectory for the test
        let subdir = workspace.join("subdir");
        fs::create_dir_all(&subdir).unwrap();

        let result = validate_path_in_workspace(&workspace, "subdir/file.txt");
        assert!(result.is_ok());
        let safe = result.unwrap();
        let canonical_workspace = fs::canonicalize(&workspace).unwrap();
        assert!(safe.starts_with(&canonical_workspace));
    }
}
