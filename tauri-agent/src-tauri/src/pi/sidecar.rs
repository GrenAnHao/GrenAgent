use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use tauri::async_runtime;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::pi::client::PiClient;
use crate::pi::framing::JsonlBuffer;
use crate::pi::transport::PiTransport;

/// 基于 Tauri shell sidecar 的传输。
pub struct SidecarTransport {
    child: Mutex<Option<CommandChild>>,
}

#[async_trait]
impl PiTransport for SidecarTransport {
    async fn write_line(&self, mut line: String) -> Result<()> {
        line.push('\n');
        let mut guard = self.child.lock().await;
        let child = guard
            .as_mut()
            .ok_or_else(|| anyhow!("sidecar already terminated"))?;
        child.write(line.as_bytes())?;
        Ok(())
    }

    async fn kill(&self) -> Result<()> {
        if let Some(child) = self.child.lock().await.take() {
            child.kill()?;
        }
        Ok(())
    }
}

/// Bun 编译的 pi 需在 exe 旁放 theme/assets；Tauri 只复制 sidecar 本体到 target/debug，
/// 因此通过 PI_PACKAGE_DIR 指向 `src-tauri/binaries/`（build:sidecar 产物目录）。
pub(crate) fn pi_package_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries")
}

/// 起一个 pi RPC sidecar，绑定到 `cwd`，返回已接好 stdout 读取循环的 PiClient。
pub fn spawn_pi_client(
    app: &tauri::AppHandle,
    workspace: String,
    cwd: &str,
    sink: Arc<dyn crate::pi::sink::EventSink>,
    env: std::collections::HashMap<String, String>,
) -> Result<Arc<PiClient>> {
    let package_dir = pi_package_dir();
    let (mut rx, child) = app
        .shell()
        .sidecar("pi")
        .map_err(|e| anyhow!("sidecar lookup failed: {e}"))?
        .args(["--mode", "rpc"])
        .env("PI_PACKAGE_DIR", &package_dir)
        .envs(env)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| anyhow!("sidecar spawn failed: {e}"))?;

    let transport = Arc::new(SidecarTransport {
        child: Mutex::new(Some(child)),
    });
    let client = Arc::new(PiClient::new(workspace, transport, sink));

    let client_for_loop = client.clone();
    async_runtime::spawn(async move {
        let mut buf = JsonlBuffer::new();
        let mut exit_code: Option<i32> = None;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    // 注意：默认行模式下每个 Stdout 事件是按 \n/\r 切好的整行，
                    // 分隔符均为 ASCII，from_utf8_lossy 不会切断多字节 UTF-8。
                    // 若将来启用 set_raw_out(true)（裸字节），需改为字节级缓冲。
                    let chunk = String::from_utf8_lossy(&bytes);
                    for line in buf.push(&chunk) {
                        client_for_loop.handle_line(&line).await;
                    }
                }
                CommandEvent::Stderr(bytes) => {
                    eprintln!("[pi stderr] {}", String::from_utf8_lossy(&bytes));
                }
                CommandEvent::Terminated(payload) => {
                    exit_code = payload.code;
                    break;
                }
                CommandEvent::Error(err) => {
                    eprintln!("[pi error] {err}");
                    // 不 break：让 channel 自然关闭，统一在循环外做退出处理
                }
                _ => {}
            }
        }
        // 兜底：无论因 Terminated / Error / channel 关闭退出，都恰好处理一次退出
        client_for_loop.handle_exit(exit_code).await;
    });

    Ok(client)
}
