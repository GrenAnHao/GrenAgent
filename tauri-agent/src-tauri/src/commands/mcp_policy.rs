use std::fs;
use std::path::PathBuf;

fn pi_dir() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "cannot resolve home directory".to_string())?;
    Ok(home.join(".pi"))
}

#[tauri::command]
pub async fn read_mcp_policy() -> Result<String, String> {
    let path = pi_dir()?.join("mcp-policy.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn write_mcp_policy(content: String) -> Result<(), String> {
    let dir = pi_dir()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("mcp-policy.json");
    let tmp = dir.join("mcp-policy.json.tmp");
    fs::write(&tmp, content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn read_mcp_audit() -> Result<String, String> {
    let path = pi_dir()?.join("mcp-audit.jsonl");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}
