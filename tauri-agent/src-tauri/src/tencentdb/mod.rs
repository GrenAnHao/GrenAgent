use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MemoryMode {
    Local,
    Remote,
}

impl MemoryMode {
    pub fn should_spawn_gateway(&self) -> bool {
        matches!(self, Self::Local)
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct GatewayStatus {
    pub mode: MemoryMode,
    pub state: String,
    pub endpoint: String,
    pub knowledge_endpoint: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BundledLayout {
    root: PathBuf,
}

impl BundledLayout {
    pub fn from_resource_dir(resource_dir: &Path) -> Self {
        Self {
            root: resource_dir.join("tencentdb-memory").join(platform_dir()),
        }
    }

    pub fn core_entry(&self) -> Result<PathBuf> {
        self.required("core/src/gateway/server.ts")
    }

    pub fn knowledge_entry(&self) -> Result<PathBuf> {
        self.required("knowledge/bin/server.mjs")
    }

    pub fn node(&self) -> Result<PathBuf> {
        self.required(node_relative_path())
    }

    pub fn core_config(&self) -> Result<PathBuf> {
        self.required("core/tdai-gateway.standalone.yaml")
    }

    fn required(&self, relative: &str) -> Result<PathBuf> {
        let path = self.root.join(relative);
        if path.is_file() {
            Ok(path)
        } else {
            bail!(
                "TencentDB bundled runtime entry is missing: {}",
                path.display()
            );
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct LocalRuntimeConfig {
    pub llm_api_key: Option<String>,
    pub llm_base_url: Option<String>,
    pub llm_model: Option<String>,
}

struct LocalProcesses {
    core: Child,
    knowledge: Child,
    core_endpoint: String,
    knowledge_endpoint: String,
}

pub struct MemoryRuntime {
    processes: Mutex<Option<LocalProcesses>>,
}

impl Default for MemoryRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryRuntime {
    pub fn new() -> Self {
        Self {
            processes: Mutex::new(None),
        }
    }

    pub async fn start_local(
        &self,
        layout: BundledLayout,
        data_dir: &Path,
        gateway_api_key: &str,
        config: &LocalRuntimeConfig,
    ) -> Result<GatewayStatus> {
        let mut processes = self.processes.lock().await;
        if let Some(running) = processes.as_ref() {
            return Ok(GatewayStatus {
                mode: MemoryMode::Local,
                state: "ready".to_string(),
                endpoint: running.core_endpoint.clone(),
                knowledge_endpoint: Some(running.knowledge_endpoint.clone()),
            });
        }

        if gateway_api_key.trim().is_empty() {
            bail!("TencentDB local gateway API key must not be empty");
        }

        let node = layout.node()?;
        let core_entry = layout.core_entry()?;
        let knowledge_entry = layout.knowledge_entry()?;
        let core_config = layout.core_config()?;
        let core_port = available_loopback_port()?;
        let knowledge_port = available_loopback_port()?;
        let core_endpoint = format!("http://127.0.0.1:{core_port}");
        let knowledge_endpoint = format!("http://127.0.0.1:{knowledge_port}/v3");
        let core_dir = core_entry
            .parent()
            .and_then(Path::parent)
            .context("TencentDB MemoryCore entry has no parent directory")?;
        let knowledge_dir = knowledge_entry
            .parent()
            .context("TencentDB MemoryKnowledge entry has no parent directory")?;

        let core_data_dir = data_dir.join("core");
        let knowledge_data_dir = data_dir.join("knowledge");
        std::fs::create_dir_all(&core_data_dir)?;
        std::fs::create_dir_all(&knowledge_data_dir)?;

        let mut core = Command::new(&node);
        core.args(["--import", "tsx", "src/gateway/server.ts"])
            .current_dir(core_dir)
            .env("TDAI_GATEWAY_CONFIG", core_config)
            .env("TDAI_GATEWAY_HOST", "127.0.0.1")
            .env("TDAI_GATEWAY_PORT", core_port.to_string())
            .env("TDAI_GATEWAY_API_KEY", gateway_api_key)
            .env("TDAI_DATA_DIR", &core_data_dir);
        apply_llm_env(&mut core, config);
        let mut core = core
            .spawn()
            .context("failed to start TencentDB MemoryCore")?;

        if let Err(error) = wait_for_health(&core_endpoint).await {
            let _ = core.kill();
            return Err(error.context("TencentDB MemoryCore did not become healthy"));
        }

        let mut knowledge = Command::new(&node);
        knowledge
            .arg(&knowledge_entry)
            .current_dir(knowledge_dir)
            .env("HOST", "127.0.0.1")
            .env("PORT", knowledge_port.to_string())
            .env("KNOWLEDGE_DATA_DIR", &knowledge_data_dir)
            .env("KNOWLEDGE_DB_PATH", knowledge_data_dir.join("knowledge.db"))
            .env("KNOWLEDGE_PUBLIC_BASE_URL", &knowledge_endpoint)
            .env("LLM_MODE", "custom");
        apply_llm_env(&mut knowledge, config);
        let mut knowledge = match knowledge.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = core.kill();
                return Err(error).context("failed to start TencentDB MemoryKnowledge");
            }
        };

        let knowledge_health = format!("http://127.0.0.1:{knowledge_port}/health");
        if let Err(error) = wait_for_health(&knowledge_health).await {
            let _ = knowledge.kill();
            let _ = core.kill();
            return Err(error.context("TencentDB MemoryKnowledge did not become healthy"));
        }

        *processes = Some(LocalProcesses {
            core,
            knowledge,
            core_endpoint: core_endpoint.clone(),
            knowledge_endpoint: knowledge_endpoint.clone(),
        });

        Ok(GatewayStatus {
            mode: MemoryMode::Local,
            state: "ready".to_string(),
            endpoint: core_endpoint,
            knowledge_endpoint: Some(knowledge_endpoint),
        })
    }

    pub async fn stop(&self) -> Result<()> {
        let Some(mut processes) = self.processes.lock().await.take() else {
            return Ok(());
        };

        kill_child(&mut processes.knowledge, "MemoryKnowledge")?;
        kill_child(&mut processes.core, "MemoryCore")?;
        Ok(())
    }
}

fn apply_llm_env(command: &mut Command, config: &LocalRuntimeConfig) {
    if let Some(value) = non_empty(&config.llm_api_key) {
        command.env("TDAI_LLM_API_KEY", value);
        command.env("LLM_API_KEY", value);
    }
    if let Some(value) = non_empty(&config.llm_base_url) {
        command.env("TDAI_LLM_BASE_URL", value);
        command.env("LLM_BASE_URL", value);
    }
    if let Some(value) = non_empty(&config.llm_model) {
        command.env("TDAI_LLM_MODEL", value);
        command.env("LLM_MODEL", value);
    }
}

fn non_empty(value: &Option<String>) -> Option<&str> {
    value.as_deref().filter(|value| !value.trim().is_empty())
}

fn available_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn kill_child(child: &mut Child, name: &str) -> Result<()> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => child
            .kill()
            .with_context(|| format!("failed to stop TencentDB {name}")),
        Err(error) => Err(error).with_context(|| format!("failed to inspect TencentDB {name}")),
    }
}

async fn wait_for_health(endpoint: &str) -> Result<()> {
    let client = reqwest::Client::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut last_error: Option<anyhow::Error> = None;

    while tokio::time::Instant::now() < deadline {
        match client.get(format!("{endpoint}/health")).send().await {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                last_error = Some(anyhow!("health check returned {}", response.status()))
            }
            Err(error) => last_error = Some(error.into()),
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }

    Err(last_error.unwrap_or_else(|| anyhow!("health check timed out")))
}

fn platform_dir() -> &'static str {
    if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
        "windows-x86_64"
    } else if cfg!(target_os = "windows") && cfg!(target_arch = "aarch64") {
        "windows-aarch64"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "darwin-aarch64"
    } else if cfg!(target_os = "macos") {
        "darwin-x86_64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-aarch64"
    } else {
        "linux-x86_64"
    }
}

fn node_relative_path() -> &'static str {
    if cfg!(target_os = "windows") {
        "node/node.exe"
    } else {
        "node/bin/node"
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{BundledLayout, MemoryMode};

    #[test]
    fn remote_mode_never_spawns_a_child() {
        assert!(!MemoryMode::Remote.should_spawn_gateway());
    }

    #[test]
    fn missing_bundled_entry_is_rejected() {
        assert!(BundledLayout::from_resource_dir(Path::new("C:/missing"))
            .core_entry()
            .is_err());
    }
}
