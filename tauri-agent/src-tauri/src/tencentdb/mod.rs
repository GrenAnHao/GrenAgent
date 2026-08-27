use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::pi::ProcessGuard;

pub mod knowledge;
pub mod panel;

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
    pub(crate) fn should_spawn_gateway(&self) -> bool {
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
    /// Optional Knowledge Service base URL. Remote deployments may expose it
    /// separately from the MemoryCore Gateway; local mode always overrides it
    /// with the supervised loopback service.
    #[serde(default)]
    pub knowledge_endpoint: Option<String>,
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
    pub last_success_at: Option<String>,
}

impl Default for MemoryConnectionConfig {
    fn default() -> Self {
        Self {
            mode: MemoryMode::Local,
            endpoint: String::new(),
            knowledge_endpoint: None,
            service_id: default_service_id(),
            team_id: default_team_id(),
            agent_id: default_agent_id(),
            user_id: default_user_id(),
            task_id: None,
            last_success_at: None,
        }
    }
}

impl MemoryConnectionConfig {
    pub fn normalized(mut self) -> Result<Self> {
        self.service_id = required_value("serviceId", self.service_id)?;
        self.team_id = required_value("teamId", self.team_id)?;
        if self.team_id == "personal:local" {
            self.team_id = default_team_id();
        }
        self.agent_id = required_value("agentId", self.agent_id)?;
        self.user_id = required_value("userId", self.user_id)?;
        if self.mode == MemoryMode::Local {
            let expected_team = default_team_id();
            let expected_agent = default_agent_id();
            let expected_user = default_user_id();
            if self.team_id != expected_team
                || self.agent_id != expected_agent
                || self.user_id != expected_user
            {
                bail!(
                    "TencentDB local mode uses the fixed single-user identity userId={expected_user}, teamId={expected_team}, agentId={expected_agent}; use remote mode for shared identities"
                );
            }
            self.endpoint.clear();
            self.knowledge_endpoint = None;
        }
        for (name, value) in [
            ("serviceId", &self.service_id),
            ("teamId", &self.team_id),
            ("agentId", &self.agent_id),
            ("userId", &self.user_id),
        ] {
            if !is_knowledge_id_segment(value) {
                bail!("TencentDB {name} must contain only letters, numbers, '-' or '_'");
            }
        }
        self.task_id = optional_value(self.task_id);
        self.knowledge_endpoint = self
            .knowledge_endpoint
            .and_then(|value| optional_value(Some(value)));

        if self.task_id.as_deref().is_some_and(looks_like_local_path) {
            bail!("TencentDB taskId must not be a local absolute path");
        }

        self.endpoint = self.endpoint.trim().trim_end_matches('/').to_string();
        if self.mode == MemoryMode::Remote {
            let url = reqwest::Url::parse(&self.endpoint)
                .context("TencentDB remote endpoint must be a valid URL")?;
            validate_remote_url(&url, "remote endpoint")?;
            if self.knowledge_endpoint.is_none() {
                bail!("TencentDB remote Knowledge endpoint is required");
            }
        }
        if let Some(endpoint) = self.knowledge_endpoint.as_mut() {
            *endpoint = endpoint.trim().trim_end_matches('/').to_string();
            let url = reqwest::Url::parse(endpoint)
                .context("TencentDB knowledge endpoint must be a valid URL")?;
            if self.mode == MemoryMode::Remote {
                validate_remote_url(&url, "remote Knowledge endpoint")?;
            }
        }
        Ok(self)
    }

    pub fn sidecar_env(
        &self,
        endpoint: &str,
        api_key: &str,
        user_key: &str,
    ) -> HashMap<String, String> {
        let mut env = HashMap::from([
            ("TDAI_MEMORY_ENDPOINT".to_string(), endpoint.to_string()),
            ("TDAI_MEMORY_API_KEY".to_string(), api_key.to_string()),
            (
                "TDAI_MEMORY_SERVICE_ID".to_string(),
                self.service_id.clone(),
            ),
            ("TDAI_MEMORY_TEAM_ID".to_string(), self.team_id.clone()),
            ("TDAI_MEMORY_AGENT_ID".to_string(), self.agent_id.clone()),
            ("TDAI_MEMORY_USER_ID".to_string(), self.user_id.clone()),
            ("TDAI_MEMORY_USER_KEY".to_string(), user_key.to_string()),
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
    const LOCAL_GATEWAY_ACCOUNT: &'static str = "local-gateway-api-key";
    const REMOTE_GATEWAY_ACCOUNT: &'static str = "remote-gateway-api-key";
    const USER_ACCOUNT: &'static str = "user-api-key";

    pub fn gateway_api_key(mode: &MemoryMode) -> Result<Option<String>> {
        Self::read(Self::gateway_account(mode))
    }

    pub fn set_gateway_api_key(mode: &MemoryMode, value: &str) -> Result<()> {
        Self::write(Self::gateway_account(mode), value)
    }

    pub fn clear_gateway_api_key(mode: &MemoryMode) -> Result<()> {
        Self::clear(Self::gateway_account(mode))
    }

    pub fn user_api_key() -> Result<Option<String>> {
        Self::read(Self::USER_ACCOUNT)
    }

    pub fn set_user_api_key(value: &str) -> Result<()> {
        Self::write(Self::USER_ACCOUNT, value)
    }

    pub fn clear_user_api_key() -> Result<()> {
        Self::clear(Self::USER_ACCOUNT)
    }

    fn gateway_account(mode: &MemoryMode) -> &'static str {
        match mode {
            MemoryMode::Local => Self::LOCAL_GATEWAY_ACCOUNT,
            MemoryMode::Remote => Self::REMOTE_GATEWAY_ACCOUNT,
        }
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
    "personal-local".to_string()
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

fn validate_remote_url(url: &reqwest::Url, label: &str) -> Result<()> {
    if url.scheme() != "https" {
        bail!("TencentDB {label} must use HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("TencentDB {label} must not contain embedded credentials");
    }
    if url.query().is_some() || url.fragment().is_some() {
        bail!("TencentDB {label} must not contain a query or fragment");
    }
    Ok(())
}

fn is_knowledge_id_segment(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 200
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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

    pub(crate) fn panel_entry(&self) -> Result<PathBuf> {
        self.required("panel/dist/index.js")
    }

    pub(crate) fn panel_root(&self) -> Result<PathBuf> {
        self.panel_entry()?
            .parent()
            .and_then(Path::parent)
            .map(Path::to_path_buf)
            .context("TencentDB Panel entry has no root directory")
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
}

#[cfg(windows)]
mod runtime_process_group {
    use std::ffi::c_void;
    use std::process::Child;
    #[cfg(test)]
    use std::sync::atomic::{AtomicUsize, Ordering};

    use anyhow::{anyhow, Result};
    use windows::core::PCWSTR;
    #[cfg(test)]
    use windows::Win32::Foundation::STILL_ACTIVE;
    use windows::Win32::Foundation::{CloseHandle, FALSE, HANDLE};
    #[cfg(test)]
    use windows::Win32::System::JobObjects::IsProcessInJob;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    #[cfg(test)]
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub(crate) struct RuntimeProcessGroup {
        job: HANDLE,
        #[cfg(test)]
        assign_attempts: AtomicUsize,
    }

    unsafe impl Send for RuntimeProcessGroup {}
    unsafe impl Sync for RuntimeProcessGroup {}

    impl RuntimeProcessGroup {
        pub(crate) fn new() -> Result<Self> {
            unsafe {
                let job = CreateJobObjectW(None, PCWSTR::null())
                    .map_err(|error| anyhow!("CreateJobObjectW failed: {error}"))?;
                let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if let Err(error) = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                ) {
                    let _ = CloseHandle(job);
                    return Err(anyhow!("SetInformationJobObject failed: {error}"));
                }
                Ok(Self {
                    job,
                    #[cfg(test)]
                    assign_attempts: AtomicUsize::new(0),
                })
            }
        }

        pub(crate) fn assign(&self, child: &Child) -> Result<()> {
            #[cfg(test)]
            self.assign_attempts.fetch_add(1, Ordering::Relaxed);
            let pid = child.id();
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid)
                    .map_err(|error| anyhow!("OpenProcess({pid}) failed: {error}"))?;
                let result = AssignProcessToJobObject(self.job, process);
                let _ = CloseHandle(process);
                result.map_err(|error| anyhow!("AssignProcessToJobObject({pid}) failed: {error}"))
            }
        }

        pub(crate) fn terminate_tree(&self) -> Result<()> {
            unsafe {
                TerminateJobObject(self.job, 1)
                    .map_err(|error| anyhow!("TerminateJobObject failed: {error}"))
            }
        }

        #[cfg(test)]
        pub(super) fn invalidate_for_test(&mut self) {
            unsafe {
                let _ = CloseHandle(self.job);
            }
            self.job = HANDLE::default();
        }

        #[cfg(test)]
        pub(super) fn child_is_in_any_job(child: &Child) -> Result<bool> {
            unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, child.id())
                    .map_err(|error| anyhow!("OpenProcess({}) failed: {error}", child.id()))?;
                let mut in_job = FALSE;
                let result = IsProcessInJob(process, HANDLE::default(), &mut in_job);
                let _ = CloseHandle(process);
                result.map_err(|error| anyhow!("IsProcessInJob failed: {error}"))?;
                Ok(in_job.as_bool())
            }
        }

        #[cfg(test)]
        pub(super) fn pid_is_running(pid: u32) -> bool {
            unsafe {
                match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid) {
                    Ok(process) => {
                        let mut exit_code = 0;
                        let inspected = GetExitCodeProcess(process, &mut exit_code).is_ok();
                        let _ = CloseHandle(process);
                        inspected && exit_code == STILL_ACTIVE.0 as u32
                    }
                    Err(_) => false,
                }
            }
        }

        #[cfg(test)]
        pub(super) fn assign_attempts(&self) -> usize {
            self.assign_attempts.load(Ordering::Relaxed)
        }
    }

    impl Drop for RuntimeProcessGroup {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.job);
            }
        }
    }
}

#[cfg(not(windows))]
mod runtime_process_group {
    use std::process::Child;

    use anyhow::Result;

    pub(crate) struct RuntimeProcessGroup;

    impl RuntimeProcessGroup {
        pub(crate) fn new() -> Result<Self> {
            Ok(Self)
        }

        pub(crate) fn assign(&self, _child: &Child) -> Result<()> {
            Ok(())
        }
    }
}

use runtime_process_group::RuntimeProcessGroup;

struct LocalProcesses {
    core: Option<Child>,
    knowledge: Option<Child>,
    core_endpoint: String,
    knowledge_endpoint: String,
    ready: bool,
    poisoned: bool,
    core_in_process_group: bool,
    knowledge_in_process_group: bool,
    process_group: RuntimeProcessGroup,
}

const RUNTIME_STOPPED: u8 = 0;
const RUNTIME_STARTING: u8 = 1;
const RUNTIME_READY: u8 = 2;
const RUNTIME_FAILED: u8 = 3;

#[cfg(target_os = "macos")]
const PARENT_GUARD_IMPORT: &str = concat!(
    "data:text/javascript;base64,",
    "Y29uc3QgcGFyZW50ID0gTnVtYmVyKHByb2Nlc3MuZW52LkdSRU5BR0VOVF9QQVJFTlRfUElEKTsg",
    "c2V0SW50ZXJ2YWwoKCkgPT4geyBpZiAocHJvY2Vzcy5wcGlkICE9PSBwYXJlbnQpIHsgdHJ5IHsg",
    "cHJvY2Vzcy5raWxsKC1wcm9jZXNzLnBpZCwgIlNJR0tJTEwiKTsgfSBjYXRjaCB7IHByb2Nlc3Mu",
    "ZXhpdCgxKTsgfSB9IH0sIDUwMCk7"
);

pub struct MemoryRuntime {
    lifecycle_operations: Mutex<()>,
    processes: Mutex<Option<LocalProcesses>>,
    process_guard: Option<Arc<ProcessGuard>>,
    lifecycle: AtomicU8,
    restart_required: AtomicBool,
    shutting_down: AtomicBool,
}

impl Default for MemoryRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl MemoryRuntime {
    pub fn new() -> Self {
        Self {
            lifecycle_operations: Mutex::new(()),
            processes: Mutex::new(None),
            process_guard: None,
            lifecycle: AtomicU8::new(RUNTIME_STOPPED),
            restart_required: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn with_process_guard(process_guard: Arc<ProcessGuard>) -> Self {
        Self {
            lifecycle_operations: Mutex::new(()),
            processes: Mutex::new(None),
            process_guard: Some(process_guard),
            lifecycle: AtomicU8::new(RUNTIME_STOPPED),
            restart_required: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
        }
    }

    pub fn mark_restart_required(&self) {
        self.restart_required.store(true, Ordering::Release);
    }

    pub fn clear_restart_required(&self) {
        self.restart_required.store(false, Ordering::Release);
    }

    pub fn requires_restart(&self) -> bool {
        self.restart_required.load(Ordering::Acquire)
    }

    pub async fn start_local(
        &self,
        layout: BundledLayout,
        data_dir: &Path,
        gateway_api_key: &str,
        config: &LocalRuntimeConfig,
    ) -> Result<GatewayStatus> {
        let _lifecycle_operation = self.lifecycle_operations.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            bail!("TencentDB runtime is shutting down");
        }
        self.lifecycle.store(RUNTIME_STARTING, Ordering::Release);
        let result = self
            .start_local_inner(layout, data_dir, gateway_api_key, config)
            .await;
        self.lifecycle.store(
            if result.is_ok() {
                RUNTIME_READY
            } else {
                RUNTIME_FAILED
            },
            Ordering::Release,
        );
        result
    }

    async fn start_local_inner(
        &self,
        layout: BundledLayout,
        data_dir: &Path,
        gateway_api_key: &str,
        _config: &LocalRuntimeConfig,
    ) -> Result<GatewayStatus> {
        #[cfg(windows)]
        if self.process_guard.is_none() {
            bail!("TencentDB local runtime requires ProcessGuard on Windows");
        }

        let mut processes = self.processes.lock().await;
        if self.shutting_down.load(Ordering::Acquire) {
            bail!("TencentDB runtime is shutting down");
        }
        if let Some(running) = processes.as_mut() {
            if running.poisoned {
                bail!("TencentDB runtime generation is poisoned; explicit stop is required");
            }
            let core_running = child_is_running(running.core.as_mut(), "MemoryCore")?;
            let knowledge_running =
                child_is_running(running.knowledge.as_mut(), "MemoryKnowledge")?;
            if running.ready && core_running && knowledge_running {
                return Ok(GatewayStatus {
                    mode: MemoryMode::Local,
                    state: "ready".to_string(),
                    endpoint: running.core_endpoint.clone(),
                    knowledge_endpoint: Some(running.knowledge_endpoint.clone()),
                });
            }

            let cleanup = stop_local_processes(running).await;
            release_processes_if_stopped(&mut processes, cleanup.is_ok());
            cleanup.context("failed to clean up the previous TencentDB runtime")?;
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
        let core_dir = core_working_dir(&core_entry)?;
        let knowledge_dir = knowledge_entry
            .parent()
            .context("TencentDB MemoryKnowledge entry has no parent directory")?;

        let core_data_dir = data_dir.join("core");
        let knowledge_data_dir = data_dir.join("knowledge");
        let local_source_allowlist = local_source_allowlist_path(data_dir);
        std::fs::create_dir_all(&core_data_dir)?;
        std::fs::create_dir_all(&knowledge_data_dir)?;
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&local_source_allowlist)
            .context("failed to initialize TencentDB local source allow-list")?;

        let process_group = RuntimeProcessGroup::new()
            .context("failed to create TencentDB runtime process group")?;

        let mut core = Command::new(&node);
        apply_parent_guard(&mut core);
        core.args(["--import", "tsx", "src/gateway/server.ts"])
            .current_dir(core_dir)
            .env("TDAI_GATEWAY_CONFIG", core_config)
            .env("TDAI_GATEWAY_HOST", "127.0.0.1")
            .env("TDAI_GATEWAY_PORT", core_port.to_string())
            .env("TDAI_GATEWAY_API_KEY", gateway_api_key)
            .env("TDAI_DATA_DIR", &core_data_dir);
        apply_core_runtime_env(&mut core);
        crate::pi::guard::prepare_command(&mut core)?;
        let core =
            spawn_managed_child(&mut core).context("failed to start TencentDB MemoryCore")?;
        let mut starting = LocalProcesses {
            core: Some(core),
            knowledge: None,
            core_endpoint: core_endpoint.clone(),
            knowledge_endpoint: knowledge_endpoint.clone(),
            ready: false,
            poisoned: false,
            core_in_process_group: false,
            knowledge_in_process_group: false,
            process_group,
        };
        if let Err(error) = self.supervise_child(
            &starting.process_group,
            starting.core.as_ref().expect("MemoryCore child is present"),
            "MemoryCore",
        ) {
            starting.poisoned = true;
            let cleanup = cleanup_failed_start(&mut processes, starting).await;
            return Err(with_cleanup_error(
                error.context("failed to supervise TencentDB MemoryCore process tree"),
                cleanup,
            ));
        }
        starting.core_in_process_group = true;

        if let Err(error) = wait_for_health(&core_endpoint, &self.shutting_down).await {
            let cleanup = cleanup_failed_start(&mut processes, starting).await;
            return Err(with_cleanup_error(
                error.context("TencentDB MemoryCore did not become healthy"),
                cleanup,
            ));
        }
        let mut knowledge = Command::new(&node);
        apply_parent_guard(&mut knowledge);
        knowledge
            .arg(&knowledge_entry)
            .current_dir(knowledge_dir)
            .env("HOST", "127.0.0.1")
            .env("PORT", knowledge_port.to_string())
            .env("KNOWLEDGE_DATA_DIR", &knowledge_data_dir)
            .env("KNOWLEDGE_DB_PATH", knowledge_data_dir.join("knowledge.db"))
            .env("KNOWLEDGE_PUBLIC_BASE_URL", &knowledge_endpoint)
            .env("TDAI_LOCAL_SOURCE_ALLOWLIST", &local_source_allowlist)
            .env("LLM_MODE", "custom");
        apply_knowledge_runtime_env(&mut knowledge, gateway_api_key);
        if let Err(error) = crate::pi::guard::prepare_command(&mut knowledge) {
            let cleanup = cleanup_failed_start(&mut processes, starting).await;
            return Err(with_cleanup_error(error.into(), cleanup))
                .context("failed to prepare TencentDB MemoryKnowledge");
        }
        let knowledge = match spawn_managed_child(&mut knowledge) {
            Ok(child) => child,
            Err(error) => {
                let cleanup = cleanup_failed_start(&mut processes, starting).await;
                return Err(with_cleanup_error(error.into(), cleanup))
                    .context("failed to start TencentDB MemoryKnowledge");
            }
        };
        starting.knowledge = Some(knowledge);
        if let Err(error) = self.supervise_child(
            &starting.process_group,
            starting
                .knowledge
                .as_ref()
                .expect("MemoryKnowledge child is present"),
            "MemoryKnowledge",
        ) {
            starting.poisoned = true;
            let cleanup = cleanup_failed_start(&mut processes, starting).await;
            return Err(with_cleanup_error(
                error.context("failed to supervise TencentDB MemoryKnowledge process tree"),
                cleanup,
            ));
        }
        starting.knowledge_in_process_group = true;

        let knowledge_health = format!("http://127.0.0.1:{knowledge_port}");
        if let Err(error) = wait_for_health(&knowledge_health, &self.shutting_down).await {
            let cleanup = cleanup_failed_start(&mut processes, starting).await;
            return Err(with_cleanup_error(
                error.context("TencentDB MemoryKnowledge did not become healthy"),
                cleanup,
            ));
        }

        starting.ready = true;
        *processes = Some(starting);

        Ok(GatewayStatus {
            mode: MemoryMode::Local,
            state: "ready".to_string(),
            endpoint: core_endpoint,
            knowledge_endpoint: Some(knowledge_endpoint),
        })
    }

    fn supervise_child(
        &self,
        process_group: &RuntimeProcessGroup,
        child: &Child,
        name: &str,
    ) -> Result<()> {
        if let Some(guard) = self.process_guard.as_ref() {
            guard.assign(child.id()).with_context(|| {
                format!(
                    "failed to assign {name} (pid {}) to ProcessGuard",
                    child.id()
                )
            })?;
        } else {
            #[cfg(windows)]
            bail!("TencentDB local runtime requires ProcessGuard on Windows");
        }
        process_group
            .assign(child)
            .with_context(|| format!("failed to assign {name} to runtime process group"))
    }

    pub async fn stop(&self) -> Result<()> {
        let _lifecycle_operation = self.lifecycle_operations.lock().await;
        self.stop_inner().await
    }

    async fn stop_inner(&self) -> Result<()> {
        let mut process_slot = self.processes.lock().await;
        let Some(processes) = process_slot.as_mut() else {
            self.lifecycle.store(RUNTIME_STOPPED, Ordering::Release);
            return Ok(());
        };

        let result = stop_local_processes(processes).await;
        release_processes_if_stopped(&mut process_slot, result.is_ok());
        self.lifecycle.store(
            if result.is_ok() {
                RUNTIME_STOPPED
            } else {
                RUNTIME_FAILED
            },
            Ordering::Release,
        );
        result
    }

    pub async fn shutdown(&self) -> Result<()> {
        self.shutting_down.store(true, Ordering::Release);
        let _lifecycle_operation = self.lifecycle_operations.lock().await;
        self.stop_inner().await
    }

    pub async fn local_status(&self) -> GatewayStatus {
        let _lifecycle_operation = self.lifecycle_operations.lock().await;
        let mut process_slot = self.processes.lock().await;
        let Some(running) = process_slot.as_mut() else {
            return GatewayStatus {
                mode: MemoryMode::Local,
                state: lifecycle_name(self.lifecycle.load(Ordering::Acquire)).to_string(),
                endpoint: String::new(),
                knowledge_endpoint: None,
            };
        };

        if running.poisoned {
            self.lifecycle.store(RUNTIME_FAILED, Ordering::Release);
            return GatewayStatus {
                mode: MemoryMode::Local,
                state: "failed".to_string(),
                endpoint: running.core_endpoint.clone(),
                knowledge_endpoint: Some(running.knowledge_endpoint.clone()),
            };
        }

        let core_running = child_is_running(running.core.as_mut(), "MemoryCore");
        let knowledge_running = child_is_running(running.knowledge.as_mut(), "MemoryKnowledge");
        if running.ready
            && matches!(&core_running, Ok(true))
            && matches!(&knowledge_running, Ok(true))
        {
            return GatewayStatus {
                mode: MemoryMode::Local,
                state: "ready".to_string(),
                endpoint: running.core_endpoint.clone(),
                knowledge_endpoint: Some(running.knowledge_endpoint.clone()),
            };
        }

        let endpoint = running.core_endpoint.clone();
        let knowledge_endpoint = Some(running.knowledge_endpoint.clone());
        if let Err(error) = &core_running {
            eprintln!("[tencentdb-memory] failed to inspect managed child status: {error}");
        }
        if let Err(error) = &knowledge_running {
            eprintln!("[tencentdb-memory] failed to inspect managed child status: {error}");
        }
        let cleanup = stop_local_processes(running).await;
        if let Err(error) = &cleanup {
            eprintln!("[tencentdb-memory] failed to clean managed child status: {error}");
        }
        release_processes_if_stopped(&mut process_slot, cleanup.is_ok());
        self.lifecycle.store(RUNTIME_FAILED, Ordering::Release);
        GatewayStatus {
            mode: MemoryMode::Local,
            state: "failed".to_string(),
            endpoint,
            knowledge_endpoint,
        }
    }
}

fn lifecycle_name(state: u8) -> &'static str {
    match state {
        RUNTIME_STARTING => "starting",
        RUNTIME_READY => "ready",
        RUNTIME_FAILED => "failed",
        _ => "stopped",
    }
}

fn apply_core_runtime_env(command: &mut Command) {
    command.env("TDAI_SKILL_ENABLED", "true");
}

fn apply_knowledge_runtime_env(command: &mut Command, api_key: &str) {
    command.env("KNOWLEDGE_API_TOKEN", api_key.trim());
}

pub fn local_source_allowlist_path(data_dir: &Path) -> PathBuf {
    data_dir.join("local-source-allowlist.jsonl")
}

fn apply_parent_guard(command: &mut Command) {
    #[cfg(target_os = "macos")]
    command
        .args(["--import", PARENT_GUARD_IMPORT])
        .env("GRENAGENT_PARENT_PID", std::process::id().to_string());

    #[cfg(not(target_os = "macos"))]
    let _ = command;
}

fn core_working_dir(entry: &Path) -> Result<&Path> {
    entry
        .parent()
        .and_then(Path::parent)
        .and_then(Path::parent)
        .context("TencentDB MemoryCore entry has no root directory")
}

pub(crate) fn available_loopback_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StopAction {
    Poll,
    TerminateTree,
}

fn stop_action(now: tokio::time::Instant, deadline: tokio::time::Instant) -> StopAction {
    if now < deadline {
        StopAction::Poll
    } else {
        StopAction::TerminateTree
    }
}

fn release_processes_if_stopped<T>(processes: &mut Option<T>, stopped: bool) {
    if stopped {
        *processes = None;
    }
}

pub(crate) fn spawn_managed_child(command: &mut Command) -> std::io::Result<Child> {
    command.stdin(Stdio::piped()).spawn()
}

pub(crate) fn request_graceful_stop(child: &mut Child) {
    drop(child.stdin.take());
}

#[cfg(test)]
async fn stop_managed_child(child: &mut Child, name: &str) -> Result<()> {
    request_graceful_stop(child);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    wait_for_graceful_exit(child, name, deadline).await
}

pub(crate) fn child_is_running(child: Option<&mut Child>, name: &str) -> Result<bool> {
    let Some(child) = child else {
        return Ok(false);
    };
    match child.try_wait() {
        Ok(Some(_)) => Ok(false),
        Ok(None) => Ok(true),
        Err(error) => Err(error).with_context(|| format!("failed to inspect TencentDB {name}")),
    }
}

async fn cleanup_failed_start(
    process_slot: &mut Option<LocalProcesses>,
    mut starting: LocalProcesses,
) -> Result<()> {
    let result = stop_local_processes(&mut starting).await;
    if starting.poisoned || result.is_err() {
        *process_slot = Some(starting);
    }
    result
}

fn with_cleanup_error(primary: anyhow::Error, cleanup: Result<()>) -> anyhow::Error {
    match cleanup {
        Ok(()) => primary,
        Err(cleanup_error) => primary.context(format!(
            "TencentDB startup cleanup failed; child ownership was retained: {cleanup_error}"
        )),
    }
}

async fn stop_local_processes(processes: &mut LocalProcesses) -> Result<()> {
    stop_local_processes_with_grace(processes, Duration::from_secs(5)).await
}

async fn stop_local_processes_with_grace(
    processes: &mut LocalProcesses,
    grace_period: Duration,
) -> Result<()> {
    if let Some(knowledge) = processes.knowledge.as_mut() {
        request_graceful_stop(knowledge);
    }
    if let Some(core) = processes.core.as_mut() {
        request_graceful_stop(core);
    }
    let deadline = tokio::time::Instant::now() + grace_period;

    loop {
        let knowledge_running = child_is_running(processes.knowledge.as_mut(), "MemoryKnowledge")?;
        let core_running = child_is_running(processes.core.as_mut(), "MemoryCore")?;
        if !knowledge_running && !core_running {
            return Ok(());
        }

        match stop_action(tokio::time::Instant::now(), deadline) {
            StopAction::Poll => tokio::time::sleep(Duration::from_millis(50)).await,
            StopAction::TerminateTree => return terminate_process_tree(processes).await,
        }
    }
}

#[cfg(windows)]
async fn terminate_process_tree(processes: &mut LocalProcesses) -> Result<()> {
    let grouped_children = (processes.core_in_process_group && processes.core.is_some())
        || (processes.knowledge_in_process_group && processes.knowledge.is_some());
    let group_result = if grouped_children {
        processes.process_group.terminate_tree()
    } else {
        Ok(())
    };
    let knowledge_result = if processes.knowledge_in_process_group {
        Ok(())
    } else {
        match processes.knowledge.as_mut() {
            Some(knowledge) => terminate_unassigned_child(knowledge, "MemoryKnowledge").await,
            None => Ok(()),
        }
    };
    let core_result = if processes.core_in_process_group {
        Ok(())
    } else {
        match processes.core.as_mut() {
            Some(core) => terminate_unassigned_child(core, "MemoryCore").await,
            None => Ok(()),
        }
    };
    group_result.and(knowledge_result).and(core_result)?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
    loop {
        let knowledge_running = child_is_running(processes.knowledge.as_mut(), "MemoryKnowledge")?;
        let core_running = child_is_running(processes.core.as_mut(), "MemoryCore")?;
        if !knowledge_running && !core_running {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!("failed to confirm TencentDB runtime process tree termination");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

#[cfg(not(windows))]
async fn terminate_process_tree(processes: &mut LocalProcesses) -> Result<()> {
    let knowledge_result = match processes.knowledge.as_mut() {
        Some(knowledge) => kill_child(knowledge, "MemoryKnowledge"),
        None => Ok(()),
    };
    let core_result = match processes.core.as_mut() {
        Some(core) => kill_child(core, "MemoryCore"),
        None => Ok(()),
    };
    knowledge_result.and(core_result)
}

#[cfg(windows)]
async fn terminate_unassigned_child(child: &mut Child, name: &str) -> Result<()> {
    match child.try_wait() {
        Ok(Some(_)) => return Ok(()),
        Ok(None) => {}
        Err(error) => {
            return Err(error).with_context(|| format!("failed to inspect TencentDB {name}"));
        }
    }

    let pid = child.id().to_string();
    let output = Command::new("taskkill")
        .args(["/PID", &pid, "/T", "/F"])
        .output()
        .with_context(|| format!("failed to launch tree cleanup for TencentDB {name}"))?;
    if !output.status.success() && !matches!(child.try_wait(), Ok(Some(_))) {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        bail!(
            "failed to stop TencentDB {name} process tree{}",
            if detail.is_empty() {
                String::new()
            } else {
                format!(": {detail}")
            }
        );
    }
    child
        .wait()
        .with_context(|| format!("failed to reap TencentDB {name}"))?;
    Ok(())
}

#[cfg(test)]
async fn wait_for_graceful_exit(
    child: &mut Child,
    name: &str,
    deadline: tokio::time::Instant,
) -> Result<()> {
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) if tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            Ok(None) => return kill_child(child, name),
            Err(error) => {
                return Err(error).with_context(|| format!("failed to inspect TencentDB {name}"));
            }
        }
    }
}

pub(crate) fn kill_child(child: &mut Child, name: &str) -> Result<()> {
    match child.try_wait() {
        Ok(Some(_)) => Ok(()),
        Ok(None) => {
            #[cfg(unix)]
            {
                let pid = child.id() as libc::pid_t;
                let group_killed = unsafe { libc::kill(-pid, libc::SIGKILL) } == 0;
                if !group_killed {
                    if let Err(error) = child.kill() {
                        if !matches!(child.try_wait(), Ok(Some(_))) {
                            return Err(error)
                                .with_context(|| format!("failed to stop TencentDB {name}"));
                        }
                    }
                }
            }
            #[cfg(not(unix))]
            child
                .kill()
                .with_context(|| format!("failed to stop TencentDB {name}"))?;
            child
                .wait()
                .with_context(|| format!("failed to reap TencentDB {name}"))?;
            Ok(())
        }
        Err(error) => Err(error).with_context(|| format!("failed to inspect TencentDB {name}")),
    }
}

pub(crate) async fn wait_for_health(endpoint: &str, shutting_down: &AtomicBool) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut last_error: Option<anyhow::Error> = None;

    while tokio::time::Instant::now() < deadline {
        if shutting_down.load(Ordering::Acquire) {
            bail!("TencentDB runtime is shutting down");
        }
        let response = tokio::select! {
            response = client.get(format!("{endpoint}/health")).send() => response,
            _ = wait_until_shutdown(shutting_down) => {
                bail!("TencentDB runtime is shutting down");
            }
        };
        match response {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) => {
                last_error = Some(anyhow!("health check returned {}", response.status()))
            }
            Err(error) => last_error = Some(error.into()),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            _ = wait_until_shutdown(shutting_down) => {
                bail!("TencentDB runtime is shutting down");
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("health check timed out")))
}

pub(crate) async fn wait_for_panel_health(
    endpoint: &str,
    shared_secret: &str,
    shutting_down: &AtomicBool,
) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    let mut last_error: Option<anyhow::Error> = None;

    while tokio::time::Instant::now() < deadline {
        if shutting_down.load(Ordering::Acquire) {
            bail!("TencentDB runtime is shutting down");
        }
        let response = tokio::select! {
            response = client
                .get(format!("{endpoint}/__grenagent/health"))
                .header("x-tdai-panel-shared-secret", shared_secret)
                .send() => response,
            _ = wait_until_shutdown(shutting_down) => {
                bail!("TencentDB runtime is shutting down");
            }
        };
        match response {
            Ok(response) if response.status().is_success() => return Ok(()),
            Ok(response) if response.status().is_client_error() => {
                return Err(anyhow!("Panel health check returned {}", response.status()));
            }
            Ok(response) => {
                last_error = Some(anyhow!("Panel health check returned {}", response.status()))
            }
            Err(error) => last_error = Some(error.into()),
        }
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            _ = wait_until_shutdown(shutting_down) => {
                bail!("TencentDB runtime is shutting down");
            }
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("Panel health check timed out")))
}

async fn wait_until_shutdown(shutting_down: &AtomicBool) {
    while !shutting_down.load(Ordering::Acquire) {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
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
    use std::process::Command;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use super::{
        apply_core_runtime_env, apply_knowledge_runtime_env, core_working_dir,
        release_processes_if_stopped, spawn_managed_child, stop_action, stop_managed_child,
        wait_for_health, BundledLayout, MemoryConnectionConfig, MemoryCredentialStore, MemoryMode,
        MemoryRuntime, StopAction, RUNTIME_READY, RUNTIME_STARTING, RUNTIME_STOPPED,
    };

    #[test]
    fn remote_mode_never_spawns_a_child() {
        assert!(!MemoryMode::Remote.should_spawn_gateway());
    }

    #[test]
    fn gateway_credentials_use_distinct_accounts_across_mode_switches() {
        let local_before = MemoryCredentialStore::gateway_account(&MemoryMode::Local);
        let remote = MemoryCredentialStore::gateway_account(&MemoryMode::Remote);
        let local_after = MemoryCredentialStore::gateway_account(&MemoryMode::Local);

        assert_eq!(local_before, "local-gateway-api-key");
        assert_eq!(remote, "remote-gateway-api-key");
        assert_eq!(local_after, local_before);
        assert_ne!(local_before, remote);
    }

    #[test]
    fn missing_bundled_entry_is_rejected() {
        assert!(BundledLayout::from_resource_dir(Path::new("C:/missing"))
            .core_entry()
            .is_err());
    }

    #[test]
    fn core_working_dir_is_runtime_root() {
        let entry = Path::new("runtime/core/src/gateway/server.ts");
        assert_eq!(core_working_dir(entry).unwrap(), Path::new("runtime/core"));
    }

    #[test]
    fn remote_config_is_normalized_and_builds_minimal_sidecar_env() {
        let config = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: " https://memory.example.com/ ".to_string(),
            knowledge_endpoint: Some(" https://knowledge.example.com/v3/ ".to_string()),
            service_id: " personal-memory ".to_string(),
            team_id: " personal-alice ".to_string(),
            agent_id: " coding ".to_string(),
            user_id: " alice ".to_string(),
            task_id: Some(" project-1 ".to_string()),
            ..MemoryConnectionConfig::default()
        }
        .normalized()
        .unwrap();

        assert_eq!(config.endpoint, "https://memory.example.com");
        assert_eq!(
            config.knowledge_endpoint.as_deref(),
            Some("https://knowledge.example.com/v3")
        );
        let env = config.sidecar_env(&config.endpoint, "secret", "user-secret");
        assert_eq!(env.len(), 8);
        assert_eq!(
            env.get("TDAI_MEMORY_TEAM_ID").map(String::as_str),
            Some("personal-alice")
        );
        assert_eq!(
            env.get("TDAI_MEMORY_USER_KEY").map(String::as_str),
            Some("user-secret")
        );
        assert!(!env.contains_key("TDAI_LLM_API_KEY"));
    }

    #[test]
    fn local_mode_uses_the_managed_single_user_identity() {
        let invalid = MemoryConnectionConfig {
            mode: MemoryMode::Local,
            service_id: "custom-service".to_string(),
            team_id: "custom-team".to_string(),
            agent_id: "coding".to_string(),
            user_id: "alice".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let error = invalid.normalized().unwrap_err();
        assert!(error.to_string().contains("fixed single-user identity"));

        let config = MemoryConnectionConfig {
            mode: MemoryMode::Local,
            endpoint: "https://remote.example.com".to_string(),
            knowledge_endpoint: Some("https://knowledge.example.com/v3".to_string()),
            service_id: "custom-service".to_string(),
            ..MemoryConnectionConfig::default()
        }
        .normalized()
        .unwrap();

        assert_eq!(config.endpoint, "");
        assert_eq!(config.knowledge_endpoint, None);
        assert_eq!(config.service_id, "custom-service");
        assert_eq!(config.team_id, "personal-local");
        assert_eq!(config.agent_id, "pi-personal");
        assert_eq!(config.user_id, "local");
    }

    #[test]
    fn local_absolute_task_id_is_rejected() {
        let config = MemoryConnectionConfig {
            task_id: Some("C:\\workspace\\project".to_string()),
            ..MemoryConnectionConfig::default()
        };
        assert!(config.normalized().is_err());
    }

    #[test]
    fn invalid_knowledge_endpoint_is_rejected() {
        let config = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: "https://memory.example.com".to_string(),
            knowledge_endpoint: Some("file:///tmp/knowledge".to_string()),
            ..MemoryConnectionConfig::default()
        };
        assert!(config.normalized().is_err());
    }

    #[test]
    fn knowledge_identity_rejects_path_unsafe_team_ids() {
        let config = MemoryConnectionConfig {
            team_id: "personal:alice".to_string(),
            ..MemoryConnectionConfig::default()
        };
        assert!(config.normalized().is_err());
    }

    #[test]
    fn legacy_local_default_is_normalized_to_a_knowledge_safe_id() {
        let config = MemoryConnectionConfig {
            team_id: "personal:local".to_string(),
            ..MemoryConnectionConfig::default()
        }
        .normalized()
        .unwrap();
        assert_eq!(config.team_id, "personal-local");
    }

    #[test]
    fn remote_mode_requires_https_even_for_loopback() {
        let loopback = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: "http://127.0.0.1:39752".to_string(),
            knowledge_endpoint: Some("https://knowledge.example.com".to_string()),
            ..MemoryConnectionConfig::default()
        };
        assert!(loopback.normalized().is_err());

        let public = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: "http://memory.example.com".to_string(),
            knowledge_endpoint: Some("https://knowledge.example.com".to_string()),
            ..MemoryConnectionConfig::default()
        };
        assert!(public.normalized().is_err());
    }

    #[test]
    fn remote_mode_requires_a_knowledge_endpoint() {
        let config = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: "https://memory.example.com".to_string(),
            knowledge_endpoint: None,
            ..MemoryConnectionConfig::default()
        };
        assert!(config.normalized().is_err());
    }

    #[test]
    fn remote_endpoints_reject_embedded_credentials_query_and_fragment() {
        for endpoint in [
            "https://user:pass@memory.example.com",
            "https://memory.example.com?token=leak",
            "https://memory.example.com/#fragment",
        ] {
            let config = MemoryConnectionConfig {
                mode: MemoryMode::Remote,
                endpoint: endpoint.to_string(),
                knowledge_endpoint: Some("https://knowledge.example.com".to_string()),
                ..MemoryConnectionConfig::default()
            };
            assert!(
                config.normalized().is_err(),
                "accepted unsafe endpoint: {endpoint}"
            );
        }

        for knowledge_endpoint in [
            "https://user:pass@knowledge.example.com",
            "https://knowledge.example.com?token=leak",
            "https://knowledge.example.com/#fragment",
        ] {
            let config = MemoryConnectionConfig {
                mode: MemoryMode::Remote,
                endpoint: "https://memory.example.com".to_string(),
                knowledge_endpoint: Some(knowledge_endpoint.to_string()),
                ..MemoryConnectionConfig::default()
            };
            assert!(
                config.normalized().is_err(),
                "accepted unsafe Knowledge endpoint: {knowledge_endpoint}"
            );
        }
    }

    #[test]
    fn local_core_runtime_enables_tencentdb_skills() {
        let mut command = Command::new("node");
        apply_core_runtime_env(&mut command);
        let enabled = command
            .get_envs()
            .find(|(name, _)| name.to_string_lossy() == "TDAI_SKILL_ENABLED")
            .and_then(|(_, value)| value)
            .and_then(|value| value.to_str());
        assert_eq!(enabled, Some("true"));
    }

    #[test]
    fn local_knowledge_runtime_receives_the_api_token_only_in_its_environment() {
        let mut command = Command::new("node");
        apply_knowledge_runtime_env(&mut command, "knowledge-secret");
        let token = command
            .get_envs()
            .find(|(name, _)| name.to_string_lossy() == "KNOWLEDGE_API_TOKEN")
            .and_then(|(_, value)| value)
            .and_then(|value| value.to_str());

        assert_eq!(token, Some("knowledge-secret"));
        assert!(!command
            .get_args()
            .any(|arg| arg.to_string_lossy().contains("knowledge-secret")));
    }

    #[test]
    fn managed_child_keeps_a_piped_stdin_for_graceful_shutdown() {
        #[cfg(windows)]
        let mut command = {
            let mut command = Command::new("cmd");
            command.args(["/C", "exit", "0"]);
            command
        };
        #[cfg(unix)]
        let mut command = {
            let mut command = Command::new("sh");
            command.args(["-c", "exit 0"]);
            command
        };

        let mut child = spawn_managed_child(&mut command).unwrap();
        assert!(child.stdin.take().is_some());
        child.wait().unwrap();
    }

    #[tokio::test]
    async fn managed_child_exits_cleanly_after_stdin_eof() {
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

        let mut child = spawn_managed_child(&mut command).unwrap();
        stop_managed_child(&mut child, "test child").await.unwrap();

        assert!(child.try_wait().unwrap().unwrap().success());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_generation_job_assignment_keeps_the_real_child_in_process_guard() {
        let guard = Arc::new(crate::pi::ProcessGuard::new().unwrap());
        let runtime = MemoryRuntime::with_process_guard(guard);
        let mut command = Command::new("cmd");
        command.args(["/C", "ping -t 127.0.0.1 > nul"]);
        let child = spawn_managed_child(&mut command).unwrap();
        let mut process_group = super::RuntimeProcessGroup::new().unwrap();
        process_group.invalidate_for_test();

        let error = runtime
            .supervise_child(&process_group, &child, "test child")
            .unwrap_err();

        assert!(error.to_string().contains("runtime process group"));
        assert!(super::RuntimeProcessGroup::child_is_in_any_job(&child).unwrap());
        let starting = super::LocalProcesses {
            core: Some(child),
            knowledge: None,
            core_endpoint: String::new(),
            knowledge_endpoint: String::new(),
            ready: false,
            poisoned: true,
            core_in_process_group: false,
            knowledge_in_process_group: false,
            process_group,
        };
        let mut process_slot = None;

        super::cleanup_failed_start(&mut process_slot, starting)
            .await
            .unwrap();

        assert!(process_slot
            .as_ref()
            .is_some_and(|processes| processes.poisoned));
        *runtime.processes.lock().await = process_slot;

        let status = runtime.local_status().await;
        assert_eq!(status.state, "failed");
        assert!(runtime.processes.lock().await.is_some());

        let error = runtime
            .start_local(
                BundledLayout::from_resource_dir(Path::new("C:/missing")),
                Path::new("C:/unused"),
                "local-key",
                &super::LocalRuntimeConfig::default(),
            )
            .await
            .unwrap_err();
        assert!(error.to_string().contains("explicit stop"));

        runtime.stop().await.unwrap();
        assert!(runtime.processes.lock().await.is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn windows_local_start_fails_closed_without_a_process_guard() {
        let runtime = MemoryRuntime::new();

        let error = runtime
            .start_local(
                BundledLayout::from_resource_dir(Path::new("C:/missing")),
                Path::new("C:/unused"),
                "local-key",
                &super::LocalRuntimeConfig::default(),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("ProcessGuard"));
    }

    #[cfg(windows)]
    #[test]
    fn process_guard_assignment_failure_skips_the_generation_job() {
        let guard = Arc::new(crate::pi::ProcessGuard::new().unwrap());
        let runtime = MemoryRuntime::with_process_guard(guard);
        let mut command = Command::new("cmd");
        command.args(["/C", "exit", "0"]);
        let mut child = spawn_managed_child(&mut command).unwrap();
        child.wait().unwrap();
        let process_group = super::RuntimeProcessGroup::new().unwrap();

        let error = runtime
            .supervise_child(&process_group, &child, "exited child")
            .unwrap_err();

        assert!(error.to_string().contains("ProcessGuard"));
        assert_eq!(process_group.assign_attempts(), 0);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn generation_job_terminates_a_real_managed_child() {
        let mut command = Command::new("cmd");
        command.args(["/C", "more > nul"]);
        let child = spawn_managed_child(&mut command).unwrap();
        let process_group = super::RuntimeProcessGroup::new().unwrap();
        process_group.assign(&child).unwrap();
        let mut processes = super::LocalProcesses {
            core: Some(child),
            knowledge: None,
            core_endpoint: String::new(),
            knowledge_endpoint: String::new(),
            ready: false,
            poisoned: false,
            core_in_process_group: true,
            knowledge_in_process_group: false,
            process_group,
        };

        super::terminate_process_tree(&mut processes).await.unwrap();

        assert!(!super::child_is_running(processes.core.as_mut(), "test child").unwrap());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn non_poisoned_startup_cleanup_releases_the_generation_for_retry() {
        let mut command = Command::new("cmd");
        command.args(["/C", "more > nul"]);
        let child = spawn_managed_child(&mut command).unwrap();
        let process_group = super::RuntimeProcessGroup::new().unwrap();
        process_group.assign(&child).unwrap();
        let starting = super::LocalProcesses {
            core: Some(child),
            knowledge: None,
            core_endpoint: String::new(),
            knowledge_endpoint: String::new(),
            ready: false,
            poisoned: false,
            core_in_process_group: true,
            knowledge_in_process_group: false,
            process_group,
        };
        let mut process_slot = None;

        super::cleanup_failed_start(&mut process_slot, starting)
            .await
            .unwrap();

        assert!(process_slot.is_none());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_generation_job_assignment_can_reap_a_real_unassigned_child() {
        let pid_file = std::env::temp_dir().join(format!(
            "grenagent-runtime-descendant-{}.pid",
            uuid::Uuid::new_v4()
        ));
        let escaped_pid_file = pid_file.to_string_lossy().replace('\'', "''");
        let script = format!(
            "$child = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath '{escaped_pid_file}' -Value $child.Id; Wait-Process -Id $child.Id"
        );
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-Command", &script]);
        let mut child = spawn_managed_child(&mut command).unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !pid_file.is_file() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let descendant_pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        assert!(super::RuntimeProcessGroup::pid_is_running(descendant_pid));

        super::terminate_unassigned_child(&mut child, "test child")
            .await
            .unwrap();

        assert!(!super::child_is_running(Some(&mut child), "test child").unwrap());
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while super::RuntimeProcessGroup::pid_is_running(descendant_pid)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let descendant_still_running = super::RuntimeProcessGroup::pid_is_running(descendant_pid);
        if descendant_still_running {
            let _ = Command::new("taskkill")
                .args(["/PID", &descendant_pid.to_string(), "/T", "/F"])
                .output();
        }
        let _ = std::fs::remove_file(pid_file);
        assert!(!descendant_still_running, "descendant process was orphaned");
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn production_stop_path_delivers_eof_then_terminates_the_descendant_tree() {
        let test_id = uuid::Uuid::new_v4();
        let temp_dir = std::env::temp_dir();
        let go_file = temp_dir.join(format!("grenagent-runtime-{test_id}.go"));
        let pid_file = temp_dir.join(format!("grenagent-runtime-{test_id}.pid"));
        let eof_file = temp_dir.join(format!("grenagent-runtime-{test_id}.eof"));
        let escape = |path: &Path| path.to_string_lossy().replace('\'', "''");
        let script = format!(
            "while (!(Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 10 }}; $child = Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Set-Content -LiteralPath '{}' -Value $child.Id; [Console]::In.ReadToEnd() | Out-Null; Set-Content -LiteralPath '{}' -Value eof; Wait-Process -Id $child.Id",
            escape(&go_file),
            escape(&pid_file),
            escape(&eof_file),
        );
        let mut command = Command::new("powershell");
        command.args(["-NoProfile", "-Command", &script]);
        let child = spawn_managed_child(&mut command).unwrap();
        let process_group = super::RuntimeProcessGroup::new().unwrap();
        process_group.assign(&child).unwrap();
        std::fs::write(&go_file, "go").unwrap();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while !pid_file.is_file() && tokio::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let descendant_pid = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let mut processes = super::LocalProcesses {
            core: Some(child),
            knowledge: None,
            core_endpoint: String::new(),
            knowledge_endpoint: String::new(),
            ready: false,
            poisoned: false,
            core_in_process_group: true,
            knowledge_in_process_group: false,
            process_group,
        };

        super::stop_local_processes_with_grace(&mut processes, Duration::from_millis(250))
            .await
            .unwrap();

        assert!(
            eof_file.is_file(),
            "managed child did not observe stdin EOF"
        );
        assert!(!super::RuntimeProcessGroup::pid_is_running(descendant_pid));
        for path in [go_file, pid_file, eof_file] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn process_guard_kill_on_close_reaps_a_real_managed_child() {
        let guard = crate::pi::ProcessGuard::new().unwrap();
        let mut command = Command::new("cmd");
        command.args(["/C", "ping -t 127.0.0.1 > nul"]);
        let mut child = spawn_managed_child(&mut command).unwrap();
        guard.assign(child.id()).unwrap();

        guard.close_for_test().unwrap();

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while super::child_is_running(Some(&mut child), "test child").unwrap()
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let still_running = super::child_is_running(Some(&mut child), "test child").unwrap();
        if still_running {
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .output();
        }
        assert!(
            !still_running,
            "ProcessGuard close did not terminate its child"
        );
    }

    #[tokio::test]
    async fn health_wait_cancels_immediately_during_shutdown() {
        let shutting_down = AtomicBool::new(true);
        let started = Instant::now();

        let error = wait_for_health("http://127.0.0.1:9", &shutting_down)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("shutting down"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn stop_waits_for_an_in_flight_start_before_publishing_stopped() {
        let runtime = Arc::new(MemoryRuntime::new());
        let start_operation = runtime.lifecycle_operations.lock().await;
        runtime.lifecycle.store(RUNTIME_STARTING, Ordering::Release);

        let stopping_runtime = Arc::clone(&runtime);
        let mut stop = tokio::spawn(async move { stopping_runtime.stop().await });
        tokio::task::yield_now().await;
        assert!(tokio::time::timeout(Duration::from_millis(50), &mut stop)
            .await
            .is_err());

        runtime.lifecycle.store(RUNTIME_READY, Ordering::Release);
        drop(start_operation);
        stop.await.unwrap().unwrap();

        assert_eq!(runtime.lifecycle.load(Ordering::Acquire), RUNTIME_STOPPED);
    }

    #[test]
    fn failed_cleanup_retains_process_ownership() {
        let mut processes = Some("owned child handles");

        release_processes_if_stopped(&mut processes, false);
        assert_eq!(processes, Some("owned child handles"));

        release_processes_if_stopped(&mut processes, true);
        assert!(processes.is_none());
    }

    #[test]
    fn graceful_stop_escalates_to_tree_termination_only_at_the_deadline() {
        let now = tokio::time::Instant::now();

        assert_eq!(
            stop_action(now, now + Duration::from_secs(5)),
            StopAction::Poll
        );
        assert_eq!(stop_action(now, now), StopAction::TerminateTree);
    }

    #[tokio::test]
    async fn shutdown_prevents_a_late_local_start() {
        let runtime = super::MemoryRuntime::new();
        runtime.shutdown().await.unwrap();

        let error = runtime
            .start_local(
                BundledLayout::from_resource_dir(Path::new("C:/missing")),
                Path::new("C:/unused"),
                "local-key",
                &super::LocalRuntimeConfig::default(),
            )
            .await
            .unwrap_err();

        assert!(error.to_string().contains("shutting down"));
    }
}
