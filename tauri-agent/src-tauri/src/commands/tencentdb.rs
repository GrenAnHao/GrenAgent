use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Manager, State};

use crate::state::AppStateStore;
use crate::tencentdb::{
    BundledLayout, GatewayStatus, LocalRuntimeConfig, MemoryConnectionConfig,
    MemoryCredentialStore, MemoryMode, MemoryRuntime,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTencentdbConnection {
    pub config: MemoryConnectionConfig,
    pub gateway_api_key: Option<String>,
    #[serde(default)]
    pub clear_gateway_api_key: bool,
    pub llm_api_key: Option<String>,
    #[serde(default)]
    pub clear_llm_api_key: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentdbStatus {
    pub mode: MemoryMode,
    pub endpoint: String,
    pub knowledge_endpoint: Option<String>,
    pub state: String,
    pub credential_configured: bool,
    pub last_success_at: Option<String>,
}

fn public_error(error: anyhow::Error) -> String {
    error.to_string()
}

fn ensure_gateway_api_key(mode: &MemoryMode) -> Result<String> {
    if let Some(value) = MemoryCredentialStore::gateway_api_key()? {
        return Ok(value);
    }
    if *mode == MemoryMode::Remote {
        bail!("TencentDB remote Gateway credential is not configured");
    }
    let value = uuid::Uuid::new_v4().simple().to_string();
    MemoryCredentialStore::set_gateway_api_key(&value)?;
    Ok(value)
}

fn bundled_layout(app: &tauri::AppHandle) -> Result<BundledLayout> {
    let resource_dir = app
        .path()
        .resource_dir()
        .context("failed to resolve Tauri resource directory")?;
    let bundled = BundledLayout::from_resource_dir(&resource_dir);
    if bundled.node().is_ok() || !cfg!(debug_assertions) {
        return Ok(bundled);
    }
    Ok(BundledLayout::from_resource_dir(Path::new(env!(
        "CARGO_MANIFEST_DIR"
    ))))
}

async fn start_local_runtime(
    app: &tauri::AppHandle,
    runtime: &MemoryRuntime,
    config: &MemoryConnectionConfig,
    gateway_api_key: &str,
) -> Result<GatewayStatus> {
    let data_dir = app
        .path()
        .app_data_dir()
        .context("failed to resolve application data directory")?
        .join("tencentdb-memory");
    let runtime_config = LocalRuntimeConfig {
        llm_api_key: MemoryCredentialStore::llm_api_key()?,
        llm_base_url: config.llm_base_url.clone(),
        llm_model: config.llm_model.clone(),
    };
    runtime
        .start_local(
            bundled_layout(app)?,
            &data_dir,
            gateway_api_key,
            &runtime_config,
        )
        .await
}

async fn current_status(
    store: &AppStateStore,
    runtime: &MemoryRuntime,
) -> Result<TencentdbStatus> {
    let config = store.tencentdb_config().await.normalized()?;
    let credential_configured = MemoryCredentialStore::gateway_api_key()?.is_some();
    if config.mode == MemoryMode::Local {
        let local = runtime.local_status().await;
        return Ok(TencentdbStatus {
            mode: MemoryMode::Local,
            endpoint: local.endpoint,
            knowledge_endpoint: local.knowledge_endpoint,
            state: local.state,
            credential_configured,
            last_success_at: config.last_success_at,
        });
    }

    Ok(TencentdbStatus {
        mode: MemoryMode::Remote,
        endpoint: config.endpoint,
        knowledge_endpoint: config.knowledge_endpoint,
        state: if config.last_success_at.is_some() {
            "ready".to_string()
        } else {
            "stopped".to_string()
        },
        credential_configured,
        last_success_at: config.last_success_at,
    })
}

fn insert_knowledge_env(env: &mut HashMap<String, String>, endpoint: Option<&str>) {
    if let Some(endpoint) = endpoint.filter(|value| !value.trim().is_empty()) {
        env.insert("TDAI_KNOWLEDGE_ENDPOINT".to_string(), endpoint.to_string());
        env.insert("TDAI_KNOWLEDGE_MCP".to_string(), "1".to_string());
    }
}

fn managed_skill_root(app: &tauri::AppHandle, agent_id: &str) -> Result<PathBuf> {
    let component: String = agent_id
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '-' | '_') {
                value
            } else {
                '_'
            }
        })
        .collect();
    let component = if component.is_empty() { "agent" } else { &component };
    Ok(app
        .path()
        .app_data_dir()
        .context("failed to resolve application data directory")?
        .join("tencentdb-memory")
        .join("skills")
        .join(component))
}

fn legacy_cutover_env(active: bool) -> HashMap<String, String> {
    if !active {
        return HashMap::new();
    }
    HashMap::from([
        ("TDAI_LEGACY_CUTOVER".to_string(), "1".to_string()),
        ("MEMORY_AUTO_INJECT".to_string(), "0".to_string()),
        ("MEMORY_AUTO_CAPTURE".to_string(), "0".to_string()),
        ("MEMORY_EXTRACT".to_string(), "0".to_string()),
        ("KB_AUTO_INJECT".to_string(), "0".to_string()),
        ("CODE_INTEL".to_string(), "off".to_string()),
    ])
}

fn normalize_workspace_marker_path(path: &Path) -> String {
    let normalized = fs::canonicalize(path)
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .trim_start_matches(r"\\?\")
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    if cfg!(windows) {
        normalized.to_ascii_lowercase()
    } else {
        normalized
    }
}

pub(crate) fn workspace_cutover_marker_path(
    app_data_dir: &Path,
    workspace: &Path,
) -> PathBuf {
    let normalized = normalize_workspace_marker_path(workspace);
    let key = crate::commands::migration::workspace_run_key(&normalized);
    app_data_dir
        .join("tencentdb-memory")
        .join("cutovers")
        .join(format!("{key}.json"))
}

fn read_cutover_marker(
    path: &Path,
    workspace: Option<&Path>,
    require_workspace: bool,
) -> Option<bool> {
    let data = match fs::read_to_string(path) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(_) => return Some(true),
    };
    let marker = match serde_json::from_str::<Value>(&data) {
        Ok(marker) => marker,
        Err(_) => return Some(true),
    };
    if marker.get("verified").and_then(Value::as_bool) != Some(true) {
        return Some(false);
    }
    if !require_workspace {
        let Some(marker_workspace) = marker.get("workspace").and_then(Value::as_str) else {
            return Some(true);
        };
        let Some(workspace) = workspace else {
            return Some(true);
        };
        return Some(
            normalize_workspace_marker_path(Path::new(marker_workspace))
                == normalize_workspace_marker_path(workspace),
        );
    }
    let Some(marker_workspace) = marker.get("workspace").and_then(Value::as_str) else {
        return Some(true);
    };
    let Some(workspace) = workspace else {
        return Some(true);
    };
    Some(
        normalize_workspace_marker_path(Path::new(marker_workspace))
            == normalize_workspace_marker_path(workspace),
    )
}

fn legacy_cutover_active_for_workspace(
    app_data_dir: &Path,
    workspace: Option<&Path>,
) -> bool {
    if let Some(workspace) = workspace {
        let scoped = workspace_cutover_marker_path(app_data_dir, workspace);
        if let Some(active) = read_cutover_marker(&scoped, Some(workspace), true) {
            return active;
        }
    }
    let legacy = app_data_dir.join("tencentdb-memory").join("cutover.json");
    read_cutover_marker(&legacy, workspace, false).unwrap_or(false)
}

fn cutover_env_for_app(
    app: &tauri::AppHandle,
    workspace: Option<&Path>,
) -> HashMap<String, String> {
    let active = app.path().app_data_dir().ok().is_some_and(|dir| {
        legacy_cutover_active_for_workspace(&dir, workspace)
    });
    legacy_cutover_env(active)
}

async fn probe_gateway(
    endpoint: &str,
    api_key: &str,
    config: &MemoryConnectionConfig,
) -> Result<()> {
    let mut body = serde_json::Map::from_iter([
        ("team_id".to_string(), json!(config.team_id)),
        ("agent_id".to_string(), json!(config.agent_id)),
        ("user_id".to_string(), json!(config.user_id)),
    ]);
    if let Some(task_id) = &config.task_id {
        body.insert("task_id".to_string(), json!(task_id));
    }
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()?
        .post(format!("{}/v3/core/read", endpoint.trim_end_matches('/')))
        .bearer_auth(api_key)
        .header("x-tdai-service-id", &config.service_id)
        .json(&body)
        .send()
        .await
        .context("failed to reach TencentDB Gateway")?;
    let status = response.status();
    let body: serde_json::Value = response
        .json()
        .await
        .context("TencentDB Gateway returned an invalid response")?;
    if !status.is_success() || body.get("code").and_then(serde_json::Value::as_i64) != Some(0) {
        let message = body
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("connection test failed");
        bail!("TencentDB Gateway rejected the connection ({status}): {message}");
    }
    Ok(())
}

/// Prepare sidecar environment with a workspace-scoped cutover marker.
/// `None` preserves the legacy global-marker behavior for callers without a
/// workspace identity.
pub async fn prepare_memory_env_for_workspace(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    workspace: Option<&Path>,
) -> HashMap<String, String> {
    // Read the cutover marker before touching config, credentials, or the
    // supervised runtime. If any of those steps fails, returning these
    // switches still prevents the legacy extensions from waking up.
    let cutover_env = cutover_env_for_app(app, workspace);
    let prepared = async {
        let config = store.tencentdb_config().await.normalized()?;
        let api_key = ensure_gateway_api_key(&config.mode)?;
        let mut env = if config.mode == MemoryMode::Local {
            let status = start_local_runtime(app, runtime, &config, &api_key).await?;
            let mut env = config.sidecar_env(&status.endpoint, &api_key);
            insert_knowledge_env(&mut env, status.knowledge_endpoint.as_deref());
            env
        } else {
            let mut env = config.sidecar_env(&config.endpoint, &api_key);
            insert_knowledge_env(&mut env, config.knowledge_endpoint.as_deref());
            env
        };
        env.insert(
            "TDAI_SKILLS_ROOT".to_string(),
            managed_skill_root(app, &config.agent_id)?
                .to_string_lossy()
                .into_owned(),
        );
        env.insert("TDAI_SKILLS_SYNC".to_string(), "1".to_string());
        env.extend(cutover_env.clone());
        env.shrink_to_fit();
        Ok::<_, anyhow::Error>(env)
    }
    .await;

    match prepared {
        Ok(env) => env,
        Err(error) => {
            eprintln!("[tencentdb-memory] sidecar integration unavailable: {error}");
            cutover_env
        }
    }
}

#[tauri::command]
pub async fn tencentdb_get_config(
    store: State<'_, AppStateStore>,
) -> Result<MemoryConnectionConfig, String> {
    store
        .tencentdb_config()
        .await
        .normalized()
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_get_status(
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbStatus, String> {
    current_status(&store, &runtime).await.map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_save_connection(
    input: SaveTencentdbConnection,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbStatus, String> {
    let previous = store.tencentdb_config().await;
    let mut config = input.config.normalized().map_err(public_error)?;
    config.last_success_at = None;

    if input.clear_gateway_api_key {
        MemoryCredentialStore::clear_gateway_api_key().map_err(public_error)?;
    } else if let Some(value) = input.gateway_api_key.as_deref() {
        MemoryCredentialStore::set_gateway_api_key(value).map_err(public_error)?;
    }
    if input.clear_llm_api_key {
        MemoryCredentialStore::clear_llm_api_key().map_err(public_error)?;
    } else if let Some(value) = input.llm_api_key.as_deref() {
        MemoryCredentialStore::set_llm_api_key(value).map_err(public_error)?;
    }
    if config.mode == MemoryMode::Local {
        ensure_gateway_api_key(&config.mode).map_err(public_error)?;
    }

    let credential_changed = input.gateway_api_key.is_some()
        || input.clear_gateway_api_key
        || input.llm_api_key.is_some()
        || input.clear_llm_api_key;
    if previous != config || credential_changed {
        runtime.stop().await.map_err(public_error)?;
    }
    store.replace_tencentdb_config(config).await;
    current_status(&store, &runtime).await.map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_test_connection(
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbStatus, String> {
    let mut config = store
        .tencentdb_config()
        .await
        .normalized()
        .map_err(public_error)?;
    let api_key = ensure_gateway_api_key(&config.mode).map_err(public_error)?;
    let endpoint = if config.mode == MemoryMode::Local {
        start_local_runtime(&app, &runtime, &config, &api_key)
            .await
            .map_err(public_error)?
            .endpoint
    } else {
        config.endpoint.clone()
    };
    probe_gateway(&endpoint, &api_key, &config)
        .await
        .map_err(public_error)?;
    config.last_success_at = Some(chrono::Utc::now().to_rfc3339());
    store.replace_tencentdb_config(config).await;
    current_status(&store, &runtime).await.map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_start_local(
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbStatus, String> {
    let config = store
        .tencentdb_config()
        .await
        .normalized()
        .map_err(public_error)?;
    if config.mode != MemoryMode::Local {
        return Err("TencentDB connection is not in local mode".to_string());
    }
    let api_key = ensure_gateway_api_key(&config.mode).map_err(public_error)?;
    start_local_runtime(&app, &runtime, &config, &api_key)
        .await
        .map_err(public_error)?;
    current_status(&store, &runtime).await.map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_stop_local(
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbStatus, String> {
    runtime.stop().await.map_err(public_error)?;
    current_status(&store, &runtime).await.map_err(public_error)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::{
        legacy_cutover_active_for_workspace, legacy_cutover_env,
        workspace_cutover_marker_path, TencentdbStatus,
    };
    use crate::tencentdb::MemoryMode;

    #[test]
    fn cutover_fallback_env_keeps_legacy_switches_disabled() {
        let env = legacy_cutover_env(true);
        assert_eq!(env.get("TDAI_LEGACY_CUTOVER").map(String::as_str), Some("1"));
        assert_eq!(env.get("MEMORY_AUTO_INJECT").map(String::as_str), Some("0"));
        assert_eq!(env.get("MEMORY_AUTO_CAPTURE").map(String::as_str), Some("0"));
        assert_eq!(env.get("MEMORY_EXTRACT").map(String::as_str), Some("0"));
        assert_eq!(env.get("KB_AUTO_INJECT").map(String::as_str), Some("0"));
        assert_eq!(env.get("CODE_INTEL").map(String::as_str), Some("off"));
        assert!(legacy_cutover_env(false).is_empty());
    }

    #[test]
    fn workspace_cutover_marker_only_applies_to_matching_workspace() {
        let root = std::env::temp_dir().join(format!("tdai-cutover-{}", uuid::Uuid::new_v4()));
        let marker_dir = root.join("tencentdb-memory");
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(
            marker_dir.join("cutover.json"),
            serde_json::json!({ "verified": true, "workspace": "C:/workspace/project-a" })
                .to_string(),
        )
        .unwrap();

        assert!(legacy_cutover_active_for_workspace(
            &root,
            Some(Path::new("C:/workspace/project-a"))
        ));
        assert!(!legacy_cutover_active_for_workspace(
            &root,
            Some(Path::new("C:/workspace/project-b"))
        ));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn malformed_existing_cutover_marker_fails_closed() {
        let root = std::env::temp_dir().join(format!("tdai-cutover-{}", uuid::Uuid::new_v4()));
        let marker_dir = root.join("tencentdb-memory");
        std::fs::create_dir_all(&marker_dir).unwrap();
        std::fs::write(marker_dir.join("cutover.json"), b"not-json").unwrap();
        assert!(legacy_cutover_active_for_workspace(
            &root,
            Some(Path::new("C:/workspace/project-a"))
        ));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn workspace_markers_are_independent_and_do_not_overwrite_each_other() {
        let root = std::env::temp_dir().join(format!("tdai-cutover-{}", uuid::Uuid::new_v4()));
        let alpha = Path::new("C:/workspace/project-a");
        let beta = Path::new("C:/workspace/project-b");
        let alpha_marker = workspace_cutover_marker_path(&root, alpha);
        let beta_marker = workspace_cutover_marker_path(&root, beta);
        assert_ne!(alpha_marker, beta_marker);
        fs::create_dir_all(alpha_marker.parent().unwrap()).unwrap();
        fs::write(
            &alpha_marker,
            serde_json::json!({ "verified": true, "workspace": alpha.to_string_lossy() })
                .to_string(),
        )
        .unwrap();
        fs::write(
            &beta_marker,
            serde_json::json!({ "verified": true, "workspace": beta.to_string_lossy() })
                .to_string(),
        )
        .unwrap();

        assert!(legacy_cutover_active_for_workspace(&root, Some(alpha)));
        assert!(legacy_cutover_active_for_workspace(&root, Some(beta)));
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn status_dto_never_serializes_credentials() {
        let value = serde_json::to_value(TencentdbStatus {
            mode: MemoryMode::Remote,
            endpoint: "https://memory.example.com".to_string(),
            knowledge_endpoint: Some("https://knowledge.example.com".to_string()),
            state: "ready".to_string(),
            credential_configured: true,
            last_success_at: None,
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.get("credentialConfigured").and_then(|v| v.as_bool()), Some(true));
        assert!(!object.keys().any(|key| key.to_ascii_lowercase().contains("key")));
    }
}
