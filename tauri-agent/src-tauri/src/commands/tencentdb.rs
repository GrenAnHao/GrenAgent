use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
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

/// 为单个 Pi sidecar 准备最小 TencentDB 环境。失败时不阻塞 Agent 启动。
pub async fn prepare_memory_env(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
) -> HashMap<String, String> {
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
        env.shrink_to_fit();
        Ok::<_, anyhow::Error>(env)
    }
    .await;

    match prepared {
        Ok(env) => env,
        Err(error) => {
            eprintln!("[tencentdb-memory] sidecar integration unavailable: {error}");
            HashMap::new()
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
    use super::TencentdbStatus;
    use crate::tencentdb::MemoryMode;

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
