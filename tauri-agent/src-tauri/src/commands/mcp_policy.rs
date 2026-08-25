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

#[tauri::command]
pub async fn read_mcp_tools_cache() -> Result<String, String> {
    let path = pi_dir()?.join("mcp-tools-cache.json");
    match fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub async fn probe_mcp_server(
    app: tauri::AppHandle,
    config_json: String,
) -> Result<String, String> {
    use tauri_plugin_shell::ShellExt;
    let package_dir = crate::pi::sidecar::pi_package_dir(&app).map_err(|e| e.to_string())?;
    let output = app
        .shell()
        .sidecar("pi")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args(["probe-mcp"])
        .env("PI_PACKAGE_DIR", package_dir)
        .env("MCP_PROBE_CONFIG", config_json)
        .output()
        .await
        .map_err(|e| format!("probe spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "probe exited ({:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
