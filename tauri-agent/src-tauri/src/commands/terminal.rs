use serde::{Deserialize, Serialize};
use tauri::Emitter;
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum TerminalEvent {
    #[serde(rename = "output")]
    Output {
        data: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    #[serde(rename = "exit")]
    Exit {
        exit_code: i32,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
}

async fn emit_output(window: &tauri::Window, data: String) -> Result<(), String> {
    window
        .emit(
            "terminal-output",
            &TerminalEvent::Output {
                data,
                session_id: None,
            },
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn execute_command(
    command: String,
    args: Vec<String>,
    workspace: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    use crate::commands::sessions::resolve_workspace_dir;
    use crate::security;

    // Validate command against whitelist
    security::validate_command(&command)?;

    let cwd = match workspace {
        Some(ws) if !ws.is_empty() => Some(resolve_workspace_dir(&ws)?),
        _ => None,
    };

    // Build command (unified approach, no shell)
    let mut cmd = Command::new(&command);
    cmd.args(&args);

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| security::sanitize_error(format!("spawn failed: {}", e)))?;

    if let Some(stdout) = child.stdout.take() {
        let window = window.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = emit_output(&window, chunk).await;
                    }
                    Err(_) => break,
                }
            }
        });
    }

    if let Some(stderr) = child.stderr.take() {
        let window = window.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = emit_output(&window, chunk).await;
                    }
                    Err(_) => break,
                }
            }
        });
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let code = status.code().unwrap_or(1);

    window
        .emit(
            "terminal-output",
            &TerminalEvent::Exit {
                exit_code: code,
                session_id: None,
            },
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}
