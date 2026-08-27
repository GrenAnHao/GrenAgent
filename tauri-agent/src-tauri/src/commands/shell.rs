use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};
use tokio::sync::Mutex;
use uuid::Uuid;

use crate::commands::sessions::resolve_workspace_dir;
use crate::commands::terminal::TerminalEvent;

pub struct ShellManager {
    sessions: Mutex<HashMap<String, ShellSession>>,
}

struct ShellSession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send>,
}

impl ShellManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

fn shell_cwd(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        let raw = path.to_string_lossy();
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShellStartResult {
    pub session_id: String,
}

async fn emit_shell_output(
    window: &tauri::Window,
    session_id: String,
    data: String,
) -> Result<(), String> {
    window
        .emit(
            "shell-output",
            &TerminalEvent::Output {
                data,
                session_id: Some(session_id),
            },
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shell_start(
    workspace: Option<String>,
    window: tauri::Window,
    mgr: State<'_, Arc<ShellManager>>,
) -> Result<ShellStartResult, String> {
    let cwd = match workspace {
        Some(ws) if !ws.is_empty() => resolve_workspace_dir(&ws)?,
        _ => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let cwd = shell_cwd(cwd);

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("pty open failed: {e}"))?;

    let mut cmd = if cfg!(windows) {
        let mut c = CommandBuilder::new("powershell.exe");
        c.arg("-NoLogo");
        c
    } else {
        let mut c = CommandBuilder::new("bash");
        c.arg("-l");
        c
    };
    cmd.cwd(cwd);

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("shell spawn failed: {e}"))?;
    drop(pair.slave);

    let master = pair.master;
    let mut reader = master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;

    let session_id = Uuid::new_v4().to_string();
    let win = window.clone();
    let sid = session_id.clone();

    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // 跨 read 边界的不完整 UTF-8 尾字节缓存：方块/画线/中文都是多字节，
        // 若一个字符被 4096 边界切断，直接 from_utf8_lossy 会把残缺字节替成 �（花屏）。
        // 保留尾部不完整序列，拼到下一次 read 再解码。
        let mut carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    carry.extend_from_slice(&buf[..n]);
                    // 找到最后一个完整 UTF-8 字符的结束位置，只发送完整部分。
                    let valid_up_to = match std::str::from_utf8(&carry) {
                        Ok(_) => carry.len(),
                        Err(e) => e.valid_up_to(),
                    };
                    if valid_up_to > 0 {
                        // valid_up_to 处一定是字符边界，可安全无损解码。
                        let chunk = String::from_utf8_lossy(&carry[..valid_up_to]).into_owned();
                        carry.drain(..valid_up_to);
                        let _ = tauri::async_runtime::block_on(emit_shell_output(
                            &win,
                            sid.clone(),
                            chunk,
                        ));
                    }
                }
                Err(_) => break,
            }
        }
        // 流结束：刷出残留字节（此时不完整就只能 lossy）。
        if !carry.is_empty() {
            let chunk = String::from_utf8_lossy(&carry).into_owned();
            let _ = tauri::async_runtime::block_on(emit_shell_output(&win, sid.clone(), chunk));
        }
        let _ = win.emit(
            "shell-output",
            &TerminalEvent::Exit {
                exit_code: 0,
                session_id: Some(sid),
            },
        );
    });

    mgr.sessions.lock().await.insert(
        session_id.clone(),
        ShellSession {
            master,
            writer,
            child,
        },
    );

    Ok(ShellStartResult { session_id })
}

#[tauri::command]
pub async fn shell_write(
    session_id: String,
    data: String,
    mgr: State<'_, Arc<ShellManager>>,
) -> Result<(), String> {
    let mut sessions = mgr.sessions.lock().await;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("shell write failed: {e}"))?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn shell_resize(
    session_id: String,
    rows: u16,
    cols: u16,
    mgr: State<'_, Arc<ShellManager>>,
) -> Result<(), String> {
    if rows == 0 || cols == 0 {
        return Ok(());
    }
    let sessions = mgr.sessions.lock().await;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "shell session not found".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("shell resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn shell_stop(
    session_id: String,
    mgr: State<'_, Arc<ShellManager>>,
) -> Result<(), String> {
    let mut sessions = mgr.sessions.lock().await;
    if let Some(mut session) = sessions.remove(&session_id) {
        let _ = session.child.kill();
    }
    Ok(())
}
