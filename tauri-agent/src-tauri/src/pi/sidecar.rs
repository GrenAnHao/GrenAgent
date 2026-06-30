use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use tauri::async_runtime;
use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::Mutex;

use crate::pi::client::PiClient;
use crate::pi::diag::forward_log;
use crate::pi::framing::JsonlBuffer;
use crate::pi::guard::ProcessGuard;
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
    runtime_config: &str,
) -> Result<Arc<PiClient>> {
    let package_dir = pi_package_dir();
    let (mut rx, child) = app
        .shell()
        .sidecar("pi")
        .map_err(|e| anyhow!("sidecar lookup failed: {e}"))?
        .args(["--mode", "rpc"])
        .env("PI_PACKAGE_DIR", &package_dir)
        // 与画布侧共用同一索引目录：agent 的 codebase-memory MCP server 经 process.env
        // 继承 CBM_CACHE_DIR，确保 explore 子代理查到的 project 与画布 index 的是同一份。
        .env("CBM_CACHE_DIR", crate::commands::code_intel::cbm_cache_dir(app))
        .env("PI_RUNTIME_CONFIG", runtime_config)
        .envs(env)
        .current_dir(cwd)
        .spawn()
        .map_err(|e| anyhow!("sidecar spawn failed: {e}"))?;

    // 把 sidecar 加入 kill-on-close job：主进程崩溃时由 OS 兜底回收。失败仅降级，
    // cli 侧 stdin-EOF 自杀仍覆盖常见崩溃。spawn→assign 之间的极短窗口也由后者兜住。
    if let Some(guard) = app.try_state::<Arc<ProcessGuard>>() {
        let pid = child.pid();
        if let Err(e) = guard.assign(pid) {
            forward_log(&format!("[pi] failed to assign sidecar (pid {pid}) to job: {e}"));
        }
    }

    let transport = Arc::new(SidecarTransport {
        child: Mutex::new(Some(child)),
    });
    let client = Arc::new(PiClient::new(workspace, transport, sink));

    // 守卫探针：定制 sidecar 启动会在 stderr 打 `[grenagent-sidecar] ready ... safety=on`。
    // 若 spawn 到的是上游原版 pi（未编译进 safety/permission 护栏），这条 marker 不会出现 →
    // 超时后大声告警，避免护栏静默失效却无人察觉（例如忘了跑 `npm run build:sidecar`）。
    let banner_seen = Arc::new(AtomicBool::new(false));
    {
        let banner_for_timer = banner_seen.clone();
        async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            if !banner_for_timer.load(Ordering::Relaxed) {
                forward_log(
                    "[pi] WARNING: GrenAgent sidecar startup marker not seen within 10s. The spawned `pi` may be a plain upstream binary WITHOUT GrenAgent guardrails (safety/permission). Rebuild the sidecar via `npm run build:sidecar`."
                );
            }
        });
    }

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
                    let s = String::from_utf8_lossy(&bytes);
                    if s.contains("[grenagent-sidecar] ready") {
                        banner_seen.store(true, Ordering::Relaxed);
                        if !s.contains("safety=on") {
                            forward_log(&format!(
                                "[pi] WARNING: sidecar reports guardrails are NOT active (safety off): {}",
                                s.trim()
                            ));
                        }
                    }
                    forward_log(&format!("[pi stderr] {s}"));
                }
                CommandEvent::Terminated(payload) => {
                    exit_code = payload.code;
                    break;
                }
                CommandEvent::Error(err) => {
                    forward_log(&format!("[pi error] {err}"));
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
