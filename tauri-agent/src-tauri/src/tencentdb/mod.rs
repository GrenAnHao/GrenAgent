use std::collections::HashMap;
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

impl Default for MemoryMode {
    fn default() -> Self {
        Self::Local
    }
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConnectionConfig {
    #[serde(default)]
    pub mode: MemoryMode,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default = "default_service_id")]
    pub service_id: String,
    #[serde(default = "default_team_id")]
    pub team_id: String,
    #[serde(default = "default_agent_id")]
    pub agent_id: String,
    #[serde(default = "default_user_id")]
    pub user_id: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub llm_base_url: Option<String>,
    #[serde(default)]
    pub llm_model: Option<String>,
    #[serde(default)]
    pub last_success_at: Option<String>,
}

impl Default for MemoryConnectionConfig {
    fn default() -> Self {
        Self {
            mode: MemoryMode::Local,
            endpoint: String::new(),
            service_id: default_service_id(),
            team_id: default_team_id(),
            agent_id: default_agent_id(),
            user_id: default_user_id(),
            task_id: None,
            llm_base_url: None,
            llm_model: None,
            last_success_at: None,
        }
    }
}

impl MemoryConnectionConfig {
    pub fn normalized(mut self) -> Result<Self> {
        self.service_id = required_value("serviceId", self.service_id)?;
        self.team_id = required_value("teamId", self.team_id)?;
        self.agent_id = required_value("agentId", self.agent_id)?;
        self.user_id = required_value("userId", self.user_id)?;
        self.task_id = optional_value(self.task_id);
        self.llm_base_url = optional_value(self.llm_base_url);
        self.llm_model = optional_value(self.llm_model);

        if self
            .task_id
            .as_deref()
            .is_some_and(looks_like_local_path)
        {
            bail!("TencentDB taskId must not be a local absolute path");
        }

        self.endpoint = self.endpoint.trim().trim_end_matches('/').to_string();
        if self.mode == MemoryMode::Remote {
            let url = reqwest::Url::parse(&self.endpoint)
                .context("TencentDB remote endpoint must be a valid URL")?;
            if !matches!(url.scheme(), "http" | "https") {
                bail!("TencentDB remote endpoint must use HTTP or HTTPS");
            }
        }
        Ok(self)
    }

    pub fn sidecar_env(&self, endpoint: &str, api_key: &str) -> HashMap<String, String> {
        let mut env = HashMap::from([
            ("TDAI_MEMORY_ENDPOINT".to_string(), endpoint.to_string()),
            ("TDAI_MEMORY_API_KEY".to_string(), api_key.to_string()),
            (
                "TDAI_MEMORY_SERVICE_ID".to_string(),
                self.service_id.clone(),
            ),
            ("TDAI_MEMORY_TEAM_ID".to_string(), self.team_id.clone()),
            (
                "TDAI_MEMORY_AGENT_ID".to_string(),
                self.agent_id.clone(),
            ),
            ("TDAI_MEMORY_USER_ID".to_string(), self.user_id.clone()),
        ]);
        if let Some(task_id) = &self.task_id {
            env.insert("TDAI_MEMORY_TASK_ID".to_string(), task_id.clone());
        }
        env
    }
}

pub struct MemoryCredentialStore;

impl MemoryCredentialStore {
    const SERVICE: &'static str = "com.rxstudio.grenagent.tencentdb-memory";
    const GATEWAY_ACCOUNT: &'static str = "gateway-api-key";
    const LLM_ACCOUNT: &'static str = "llm-api-key";

    pub fn gateway_api_key() -> Result<Option<String>> {
        Self::read(Self::GATEWAY_ACCOUNT)
    }

    pub fn set_gateway_api_key(value: &str) -> Result<()> {
        Self::write(Self::GATEWAY_ACCOUNT, value)
    }

    pub fn clear_gateway_api_key() -> Result<()> {
        Self::clear(Self::GATEWAY_ACCOUNT)
    }

    pub fn llm_api_key() -> Result<Option<String>> {
        Self::read(Self::LLM_ACCOUNT)
    }

    pub fn set_llm_api_key(value: &str) -> Result<()> {
        Self::write(Self::LLM_ACCOUNT, value)
    }

    pub fn clear_llm_api_key() -> Result<()> {
        Self::clear(Self::LLM_ACCOUNT)
    }

    fn entry(account: &str) -> Result<keyring::Entry> {
        keyring::Entry::new(Self::SERVICE, account).context("failed to open OS credential store")
    }

    fn read(account: &str) -> Result<Option<String>> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(error).context("failed to read OS credential store"),
        }
    }

    fn write(account: &str, value: &str) -> Result<()> {
        let value = value.trim();
        if value.is_empty() {
            bail!("credential must not be empty");
        }
        Self::entry(account)?
            .set_password(value)
            .context("failed to write OS credential store")
    }

    fn clear(account: &str) -> Result<()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(error).context("failed to clear OS credential store"),
        }
    }
}

fn default_service_id() -> String {
    "personal-memory".to_string()
}

fn default_team_id() -> String {
    "personal:local".to_string()
}

fn default_agent_id() -> String {
    "pi-personal".to_string()
}

fn default_user_id() -> String {
    "local".to_string()
}

fn required_value(name: &str, value: String) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("TencentDB {name} must not be empty");
    }
    Ok(value.to_string())
}

fn optional_value(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

fn looks_like_local_path(value: &str) -> bool {
    Path::new(value).is_absolute()
        || value.starts_with("\\\\")
        || value
            .as_bytes()
            .get(1)
            .is_some_and(|separator| *separator == b':')
}

#[derive(Clone, Debug)]
pub struct BundledLayout {
    root: PathBuf,
}

impl BundledLayout {
    pub fn from_resource_dir(resource_dir: &Path) -> Self {
        Self {
            root: resource_dir
                .join("binaries")
                .join("tencentdb-memory")
                .join(platform_dir()),
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

    pub async fn local_status(&self) -> GatewayStatus {
        let mut processes = self.processes.lock().await;
        let Some(running) = processes.as_mut() else {
            return GatewayStatus {
                mode: MemoryMode::Local,
                state: "stopped".to_string(),
                endpoint: String::new(),
                knowledge_endpoint: None,
            };
        };

        let core_running = running.core.try_wait().ok().flatten().is_none();
        let knowledge_running = running.knowledge.try_wait().ok().flatten().is_none();
        if core_running && knowledge_running {
            return GatewayStatus {
                mode: MemoryMode::Local,
                state: "ready".to_string(),
                endpoint: running.core_endpoint.clone(),
                knowledge_endpoint: Some(running.knowledge_endpoint.clone()),
            };
        }

        if core_running {
            let _ = running.core.kill();
        }
        if knowledge_running {
            let _ = running.knowledge.kill();
        }
        let endpoint = running.core_endpoint.clone();
        let knowledge_endpoint = Some(running.knowledge_endpoint.clone());
        *processes = None;
        GatewayStatus {
            mode: MemoryMode::Local,
            state: "failed".to_string(),
            endpoint,
            knowledge_endpoint,
        }
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

    use super::{BundledLayout, MemoryConnectionConfig, MemoryMode};

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

    #[test]
    fn remote_config_is_normalized_and_builds_minimal_sidecar_env() {
        let config = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: " https://memory.example.com/ ".to_string(),
            service_id: " personal-memory ".to_string(),
            team_id: " personal:alice ".to_string(),
            agent_id: " coding ".to_string(),
            user_id: " alice ".to_string(),
            task_id: Some(" project-1 ".to_string()),
            ..MemoryConnectionConfig::default()
        }
        .normalized()
        .unwrap();

        assert_eq!(config.endpoint, "https://memory.example.com");
        let env = config.sidecar_env(&config.endpoint, "secret");
        assert_eq!(env.len(), 7);
        assert_eq!(env.get("TDAI_MEMORY_TEAM_ID").map(String::as_str), Some("personal:alice"));
        assert!(!env.contains_key("TDAI_LLM_API_KEY"));
    }

    #[test]
    fn local_absolute_task_id_is_rejected() {
        let config = MemoryConnectionConfig {
            task_id: Some("C:\\workspace\\project".to_string()),
            ..MemoryConnectionConfig::default()
        };
        assert!(config.normalized().is_err());
    }
}
