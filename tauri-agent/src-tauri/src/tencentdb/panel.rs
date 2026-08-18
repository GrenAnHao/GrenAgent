use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{fs, io};

use anyhow::{bail, Context, Result};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::pi::ProcessGuard;
use crate::tencentdb::{
    child_is_running, kill_child, request_graceful_stop, spawn_managed_child,
    wait_for_panel_health, BundledLayout, MemoryMode, RuntimeProcessGroup,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PanelConnection {
    pub mode: MemoryMode,
    pub service_id: String,
    pub user_id: String,
    pub gateway_endpoint: String,
    pub knowledge_endpoint: String,
    pub gateway_api_key: String,
    pub user_key: String,
}

pub fn panel_url(endpoint: &str, token: &str) -> anyhow::Result<String> {
    let url = reqwest::Url::parse(endpoint).context("TencentDB Panel endpoint is invalid")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("TencentDB Panel endpoint must be an exact loopback HTTP endpoint");
    }
    if token.trim().is_empty() {
        bail!("TencentDB Panel bootstrap token must not be empty");
    }
    let mut result = url;
    result.set_path("/__grenagent/bootstrap");
    result.set_fragment(Some(&format!("tdai-bootstrap={token}")));
    Ok(result.to_string())
}

impl PanelConnection {
    pub fn fingerprint(&self) -> String {
        let mut hasher = Sha256::new();
        for value in [
            format!("{:?}", self.mode),
            self.service_id.clone(),
            self.user_id.clone(),
            self.gateway_endpoint.clone(),
            self.knowledge_endpoint.clone(),
            self.gateway_api_key.clone(),
            self.user_key.clone(),
        ] {
            hasher.update(value.as_bytes());
            hasher.update([0]);
        }
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

struct PanelProcess {
    child: Child,
    endpoint: String,
    fingerprint: String,
    shared_secret: String,
    process_group: RuntimeProcessGroup,
}

const PANEL_BOOTSTRAP_REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const PANEL_BOOTSTRAP_TTL: Duration = Duration::from_secs(60);
const PANEL_START_ATTEMPTS: usize = 3;
const PANEL_STARTUP_TIMEOUT: Duration = Duration::from_secs(20);

pub struct PanelRuntime {
    lifecycle_operations: Mutex<()>,
    process: Mutex<Option<PanelProcess>>,
    process_guard: Option<Arc<ProcessGuard>>,
    shutting_down: AtomicBool,
}

impl Default for PanelRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl PanelRuntime {
    pub fn new() -> Self {
        Self {
            lifecycle_operations: Mutex::new(()),
            process: Mutex::new(None),
            process_guard: None,
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn with_process_guard(process_guard: Arc<ProcessGuard>) -> Self {
        Self {
            lifecycle_operations: Mutex::new(()),
            process: Mutex::new(None),
            process_guard: Some(process_guard),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub async fn ensure_started(
        &self,
        layout: &BundledLayout,
        connection: &PanelConnection,
    ) -> Result<String> {
        let _operation = self.lifecycle_operations.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            bail!("TencentDB Panel runtime is shutting down");
        }
        #[cfg(windows)]
        if self.process_guard.is_none() {
            bail!("TencentDB Panel runtime requires ProcessGuard on Windows");
        }

        let mut slot = self.process.lock().await;
        if let Some(process) = slot.as_mut() {
            let running = child_is_running(Some(&mut process.child), "MemoryPanel")?;
            if running && process.fingerprint == connection.fingerprint() {
                return Ok(process.endpoint.clone());
            }
            stop_panel_process(process).await?;
            *slot = None;
        }

        if connection.gateway_api_key.trim().is_empty() || connection.user_key.trim().is_empty() {
            bail!("TencentDB Panel credentials must not be empty");
        }
        let node = layout.node()?;
        let entry = layout.panel_entry()?;
        let panel_root = layout.panel_root()?;
        let ui_dist = panel_root.join("web").join("dist");
        let registry = serde_json::to_string(&json!([{
            "id": connection.service_id,
            "name": connection.service_id,
            "gateway_endpoint": connection.gateway_endpoint,
            "proxy_endpoint": connection.gateway_endpoint,
            "api_key": connection.gateway_api_key,
        }]))?;
        let mut last_health_error = None;
        for attempt in 0..PANEL_START_ATTEMPTS {
            let port_file = panel_port_file()?;
            let shared_secret = uuid::Uuid::new_v4().simple().to_string();
            let mut command = Command::new(&node);
            command
                .arg(&entry)
                .current_dir(&panel_root)
                .env("HOST", "127.0.0.1")
                .env("PORT", "0")
                .env("TDAI_PANEL_PORT_FILE", &port_file)
                .env("UI_DIST_DIR", &ui_dist)
                .env("KNOWLEDGE_SERVICE_URL", &connection.knowledge_endpoint)
                .env("KNOWLEDGE_AUTH_TOKEN", &connection.gateway_api_key)
                .env("TDAI_PANEL_INSTANCES_JSON", &registry)
                .env("TDAI_PANEL_BOOTSTRAP_SECRET", &shared_secret)
                .env("KNOWLEDGE_LLM_BINDING_SYNC", "false");
            if let Err(error) = crate::pi::guard::prepare_command(&mut command) {
                cleanup_panel_port_file(&port_file);
                return Err(error);
            }
            let process_group = match RuntimeProcessGroup::new() {
                Ok(group) => group,
                Err(error) => {
                    cleanup_panel_port_file(&port_file);
                    return Err(error).context("failed to create TencentDB Panel process group");
                }
            };
            let mut child = match spawn_managed_child(&mut command) {
                Ok(child) => child,
                Err(error) => {
                    cleanup_panel_port_file(&port_file);
                    return Err(error).context("failed to start TencentDB MemoryPanel");
                }
            };
            if let Err(error) = self.supervise_child(&process_group, &child) {
                request_graceful_stop(&mut child);
                let _ = kill_child(&mut child, "MemoryPanel");
                cleanup_panel_port_file(&port_file);
                return Err(error);
            }
            let startup_result =
                match wait_for_panel_port(&port_file, &mut child, &self.shutting_down).await {
                    Ok(port) => {
                        let endpoint = format!("http://127.0.0.1:{port}");
                        wait_for_panel_health(&endpoint, &shared_secret, &self.shutting_down)
                            .await
                            .map(|()| endpoint)
                    }
                    Err(error) => Err(error),
                };
            cleanup_panel_port_file(&port_file);
            match startup_result {
                Ok(endpoint) => {
                    *slot = Some(PanelProcess {
                        child,
                        endpoint: endpoint.clone(),
                        fingerprint: connection.fingerprint(),
                        shared_secret,
                        process_group,
                    });
                    return Ok(endpoint);
                }
                Err(error) => {
                    request_graceful_stop(&mut child);
                    #[cfg(windows)]
                    let _ = process_group.terminate_tree();
                    let _ = kill_child(&mut child, "MemoryPanel");
                    last_health_error = Some(error);
                    if attempt + 1 == PANEL_START_ATTEMPTS {
                        break;
                    }
                }
            }
        }
        Err(last_health_error
            .unwrap_or_else(|| anyhow::anyhow!("TencentDB Panel failed to start"))
            .context("TencentDB MemoryPanel did not become healthy after retries"))
    }

    fn supervise_child(&self, process_group: &RuntimeProcessGroup, child: &Child) -> Result<()> {
        if let Some(guard) = &self.process_guard {
            guard
                .assign(child.id())
                .context("failed to assign TencentDB Panel to ProcessGuard")?;
        } else {
            #[cfg(windows)]
            bail!("TencentDB Panel runtime requires ProcessGuard on Windows");
        }
        process_group
            .assign(child)
            .context("failed to supervise TencentDB MemoryPanel process tree")?;
        Ok(())
    }

    pub async fn register_bootstrap(&self, connection: &PanelConnection) -> Result<String> {
        let token = uuid::Uuid::new_v4().simple().to_string();
        let connection_fingerprint = connection.fingerprint();
        let (endpoint, shared_secret) = {
            let mut slot = self.process.lock().await;
            let process = slot
                .as_mut()
                .context("TencentDB Panel runtime is not started")?;
            if !child_is_running(Some(&mut process.child), "MemoryPanel")? {
                bail!("TencentDB Panel runtime is not running");
            }
            if process.fingerprint != connection_fingerprint {
                bail!("TencentDB Panel connection changed; restart is required");
            }
            (process.endpoint.clone(), process.shared_secret.clone())
        };
        let expires_at = SystemTime::now()
            .checked_add(PANEL_BOOTSTRAP_TTL)
            .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .context("failed to create TencentDB Panel bootstrap expiry")?;
        let client = reqwest::Client::builder()
            .timeout(PANEL_BOOTSTRAP_REQUEST_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .context("failed to create TencentDB Panel bootstrap client")?;
        client
            .post(format!("{endpoint}/__grenagent/bootstrap/register"))
            .header("x-tdai-panel-shared-secret", shared_secret)
            .json(&json!({
                "token": token,
                "instance_id": connection.service_id,
                "user_key": connection.user_key,
                "expires_at": expires_at,
            }))
            .send()
            .await
            .context("failed to register TencentDB Panel bootstrap")?
            .error_for_status()
            .context("TencentDB Panel rejected bootstrap registration")?;
        Ok(token)
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.shutting_down.store(true, Ordering::Release);
        self.stop().await
    }

    pub async fn stop(&self) -> Result<()> {
        let _operation = self.lifecycle_operations.lock().await;
        let mut slot = self.process.lock().await;
        if let Some(process) = slot.as_mut() {
            stop_panel_process(process).await?;
        }
        *slot = None;
        Ok(())
    }
}

fn panel_port_file() -> Result<PathBuf> {
    let directory =
        std::env::temp_dir().join(format!("grenagent-panel-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&directory).with_context(|| {
        format!(
            "failed to create TencentDB Panel startup directory: {}",
            directory.display()
        )
    })?;
    Ok(directory.join("port"))
}

fn cleanup_panel_port_file(path: &Path) {
    let _ = fs::remove_file(path);
    if let Some(parent) = path.parent() {
        let _ = fs::remove_dir(parent);
    }
}

fn parse_panel_port(value: &str) -> Result<u16> {
    if value.is_empty() || value.trim() != value {
        bail!("Panel reported an invalid port");
    }
    let port = value
        .parse::<u16>()
        .context("Panel reported an invalid port")?;
    if port == 0 {
        bail!("Panel reported port 0");
    }
    Ok(port)
}

async fn wait_for_panel_port(
    path: &Path,
    child: &mut Child,
    shutting_down: &AtomicBool,
) -> Result<u16> {
    let deadline = tokio::time::Instant::now() + PANEL_STARTUP_TIMEOUT;
    let mut last_error: Option<anyhow::Error> = None;
    while tokio::time::Instant::now() < deadline {
        if shutting_down.load(Ordering::Acquire) {
            bail!("TencentDB runtime is shutting down");
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                bail!("TencentDB MemoryPanel exited before reporting its port: {status}")
            }
            Ok(None) => {}
            Err(error) => return Err(error).context("failed to inspect TencentDB MemoryPanel"),
        }
        match fs::read_to_string(path) {
            Ok(raw) => match parse_panel_port(&raw) {
                Ok(port) => return Ok(port),
                Err(error) => last_error = Some(error),
            },
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => last_error = Some(error.into()),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            _ = wait_until_panel_shutdown(shutting_down) => {
                bail!("TencentDB runtime is shutting down");
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Panel did not report a listening port")))
}

async fn wait_until_panel_shutdown(shutting_down: &AtomicBool) {
    while !shutting_down.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn stop_panel_process(process: &mut PanelProcess) -> Result<()> {
    request_graceful_stop(&mut process.child);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while child_is_running(Some(&mut process.child), "MemoryPanel")? {
        if tokio::time::Instant::now() >= deadline {
            #[cfg(windows)]
            process.process_group.terminate_tree()?;
            kill_child(&mut process.child, "MemoryPanel")?;
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    process
        .child
        .wait()
        .context("failed to reap TencentDB MemoryPanel")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::atomic::AtomicBool;

    use super::*;

    fn connection() -> PanelConnection {
        PanelConnection {
            mode: MemoryMode::Remote,
            service_id: "service-a".into(),
            user_id: "user-a".into(),
            gateway_endpoint: "https://gateway.example".into(),
            knowledge_endpoint: "https://knowledge.example/v3".into(),
            gateway_api_key: "gateway-secret".into(),
            user_key: "user-secret".into(),
        }
    }

    #[test]
    fn panel_url_only_accepts_exact_loopback_http_endpoint() {
        assert_eq!(
            panel_url("http://127.0.0.1:43123", "token-1").unwrap(),
            "http://127.0.0.1:43123/__grenagent/bootstrap#tdai-bootstrap=token-1"
        );
        for endpoint in [
            "https://127.0.0.1:43123",
            "http://localhost:43123",
            "http://127.0.0.1:43123/extra",
            "http://user@127.0.0.1:43123",
            "http://127.0.0.1:43123?x=1",
            "http://127.0.0.1:43123#fragment",
        ] {
            assert!(panel_url(endpoint, "token").is_err(), "accepted {endpoint}");
        }
    }

    #[test]
    fn panel_connection_fingerprint_changes_with_connection_inputs() {
        let base = connection();
        for mutate in [
            |c: &mut PanelConnection| c.gateway_endpoint.push_str("/v2"),
            |c: &mut PanelConnection| c.knowledge_endpoint.push_str("/v4"),
            |c: &mut PanelConnection| c.user_id.push_str("-other"),
        ] {
            let mut changed = base.clone();
            mutate(&mut changed);
            assert_ne!(base.fingerprint(), changed.fingerprint());
        }
        assert_eq!(base.fingerprint(), base.clone().fingerprint());
    }

    #[test]
    fn managed_panel_port_file_accepts_only_valid_tcp_ports() {
        assert_eq!(parse_panel_port("43123").unwrap(), 43123);
        for value in ["", "0", "65536", "12x", " 43123 "] {
            assert!(
                parse_panel_port(value).is_err(),
                "accepted invalid port {value:?}"
            );
        }
    }

    #[tokio::test]
    async fn bootstrap_registration_does_not_block_runtime_stop() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let request_received = Arc::new(AtomicBool::new(false));
        let server_received = request_received.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0_u8; 1024];
            let _ = stream.read(&mut buffer);
            server_received.store(true, Ordering::Release);
            std::thread::sleep(Duration::from_secs(4));
        });

        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "more > nul"]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "cat >/dev/null"]);
            command
        };
        let child = spawn_managed_child(&mut command).unwrap();
        let runtime = Arc::new(PanelRuntime::new());
        let panel_connection = connection();
        *runtime.process.lock().await = Some(PanelProcess {
            child,
            endpoint,
            fingerprint: panel_connection.fingerprint(),
            shared_secret: "test-secret".into(),
            process_group: RuntimeProcessGroup::new().unwrap(),
        });

        let registration_runtime = runtime.clone();
        let registration = tokio::spawn(async move {
            registration_runtime
                .register_bootstrap(&panel_connection)
                .await
        });
        while !request_received.load(Ordering::Acquire) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let stopped = tokio::time::timeout(Duration::from_millis(250), runtime.stop()).await;
        let registration_result = registration.await.unwrap();
        server.join().unwrap();
        if stopped.is_err() {
            runtime.stop().await.unwrap();
        }

        assert!(
            registration_result.is_err(),
            "bootstrap request did not time out"
        );
        assert!(stopped.is_ok(), "bootstrap request held the process lock");
    }

    #[cfg(windows)]
    #[test]
    fn panel_supervision_joins_shared_guard_before_its_private_job() {
        let guard = Arc::new(ProcessGuard::new().unwrap());
        let runtime = PanelRuntime::with_process_guard(guard.clone());
        let shared_sibling_group = RuntimeProcessGroup::new().unwrap();
        let panel_group = RuntimeProcessGroup::new().unwrap();

        let mut sibling_command = Command::new("cmd");
        sibling_command.args(["/C", "more > nul"]);
        let mut sibling = spawn_managed_child(&mut sibling_command).unwrap();
        guard.assign(sibling.id()).unwrap();
        shared_sibling_group.assign(&sibling).unwrap();

        let mut panel_command = Command::new("cmd");
        panel_command.args(["/C", "more > nul"]);
        let mut panel = spawn_managed_child(&mut panel_command).unwrap();
        let result = runtime.supervise_child(&panel_group, &panel);

        let _ = panel_group.terminate_tree();
        let _ = shared_sibling_group.terminate_tree();
        let _ = panel.wait();
        let _ = sibling.wait();
        drop(runtime);
        if let Ok(guard) = Arc::try_unwrap(guard) {
            let _ = guard.close_for_test();
        }

        result.unwrap();
    }
}
