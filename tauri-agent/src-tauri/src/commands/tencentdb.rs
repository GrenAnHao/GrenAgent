use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppStateStore;
use crate::tencentdb::knowledge::{KnowledgeClient, WorkspaceKnowledgeAssets};
use crate::tencentdb::panel::{panel_url, PanelConnection, PanelRuntime};
use crate::tencentdb::{
    local_source_allowlist_path, BundledLayout, GatewayStatus, LocalRuntimeConfig,
    MemoryConnectionConfig, MemoryCredentialStore, MemoryMode, MemoryRuntime,
};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTencentdbConnection {
    pub config: MemoryConnectionConfig,
    pub gateway_api_key: Option<String>,
    #[serde(default)]
    pub clear_gateway_api_key: bool,
    pub user_api_key: Option<String>,
    #[serde(default)]
    pub clear_user_api_key: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentdbStatus {
    pub mode: MemoryMode,
    pub endpoint: String,
    pub knowledge_endpoint: Option<String>,
    pub state: String,
    pub credential_configured: bool,
    pub user_credential_configured: bool,
    pub last_success_at: Option<String>,
    pub restart_required: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentdbPanelOpen {
    pub url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentdbCoreRequest {
    pub route: String,
    #[serde(default)]
    pub body: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentdbLlmSyncInput {
    pub provider: String,
    pub model_id: String,
    pub api: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CoreRouteScope {
    ConfigIdentity,
    ChatMemoryClear,
    MetaAssetCreate,
    MetaAccessibleAssetList,
    AgentFixedAsset,
    AgentFixedAssetSet,
}

fn core_route_scope(route: &str) -> Result<CoreRouteScope> {
    match route {
        "/v3/conversation/query"
        | "/v3/conversation/search"
        | "/v3/conversation/delete"
        | "/v3/conversation/count"
        | "/v3/atomic/query"
        | "/v3/atomic/search"
        | "/v3/atomic/update"
        | "/v3/atomic/delete"
        | "/v3/atomic/count"
        | "/v3/scenario/ls"
        | "/v3/scenario/read"
        | "/v3/scenario/write"
        | "/v3/scenario/rm"
        | "/v3/scenario/count"
        | "/v3/core/read"
        | "/v3/core/write"
        | "/v3/core/count"
        | "/v3/skill/create"
        | "/v3/skill/update"
        | "/v3/skill/patch"
        | "/v3/skill/delete"
        | "/v3/skill/get"
        | "/v3/skill/list"
        | "/v3/skill/search"
        | "/v3/skill/versions"
        | "/v3/skill/files/write"
        | "/v3/skill/files/remove"
        | "/v3/skill/files/read"
        | "/v3/skill/listing" => Ok(CoreRouteScope::ConfigIdentity),
        "/v3/chat-memory/clear" => Ok(CoreRouteScope::ChatMemoryClear),
        "/v3/meta/asset/create" => Ok(CoreRouteScope::MetaAssetCreate),
        "/v3/meta/asset/list-accessible" => Ok(CoreRouteScope::MetaAccessibleAssetList),
        "/v3/meta/agent-fixed-asset/set" => Ok(CoreRouteScope::AgentFixedAssetSet),
        "/v3/meta/agent-fixed-asset/list" | "/v3/meta/agent-fixed-asset/list-with-detail" => {
            Ok(CoreRouteScope::AgentFixedAsset)
        }
        _ => bail!("TencentDB Core route is not allowed: {route}"),
    }
}

fn normalize_core_request_body(
    route: &str,
    mut body: serde_json::Map<String, serde_json::Value>,
    config: &MemoryConnectionConfig,
) -> Result<serde_json::Map<String, serde_json::Value>> {
    match core_route_scope(route)? {
        CoreRouteScope::ConfigIdentity => {
            body.insert("team_id".to_string(), json!(config.team_id));
            body.insert("agent_id".to_string(), json!(config.agent_id));
            body.insert("user_id".to_string(), json!(config.user_id));
            if let Some(task_id) = &config.task_id {
                body.insert("task_id".to_string(), json!(task_id));
            } else {
                body.remove("task_id");
            }
        }
        CoreRouteScope::ChatMemoryClear => {
            let ids = body
                .get("memory_ids")
                .and_then(serde_json::Value::as_array)
                .context("TencentDB Chat Memory clear requires memory_ids")?;
            if ids.is_empty() || ids.len() > 100 {
                bail!("TencentDB Chat Memory clear accepts 1 to 100 memory_ids");
            }
            let mut normalized = Vec::with_capacity(ids.len());
            for id in ids {
                let id = id
                    .as_str()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .context("TencentDB Chat Memory memory_ids must be non-empty strings")?;
                normalized.push(json!(id));
            }
            body.clear();
            body.insert("memory_ids".to_string(), json!(normalized));
        }
        CoreRouteScope::MetaAssetCreate => {
            body.insert("team_id".to_string(), json!(config.team_id));
            body.insert("owner_user_id".to_string(), json!(config.user_id));
            body.insert("source_type".to_string(), json!("knowledge"));
            body.insert("visibility".to_string(), json!("team"));
            body.insert("status".to_string(), json!("approved"));
        }
        CoreRouteScope::MetaAccessibleAssetList => {
            body.insert("team_id".to_string(), json!(config.team_id));
            body.insert("user_id".to_string(), json!(config.user_id));
            body.insert("agent_id".to_string(), json!(config.agent_id));
            body.insert("action".to_string(), json!("read"));
            body.remove("user_key");
            body.remove("owner_user_id");
        }
        CoreRouteScope::AgentFixedAsset => {
            body.insert("agent_id".to_string(), json!(config.agent_id));
        }
        CoreRouteScope::AgentFixedAssetSet => {
            body.insert("agent_id".to_string(), json!(config.agent_id));
            let bindings = body
                .get_mut("bindings")
                .and_then(serde_json::Value::as_array_mut)
                .context("TencentDB fixed asset bindings must be an array")?;
            for binding in bindings {
                let binding = binding
                    .as_object_mut()
                    .context("each TencentDB fixed asset binding must be an object")?;
                binding.insert("created_by".to_string(), json!(config.user_id));
            }
        }
    }
    Ok(body)
}

fn validate_remote_identity(
    config: &MemoryConnectionConfig,
    auth: &serde_json::Value,
    team: &serde_json::Value,
    member: &serde_json::Value,
    agent: &serde_json::Value,
) -> Result<()> {
    if auth.get("valid").and_then(serde_json::Value::as_bool) != Some(true) {
        bail!("TencentDB User Key is invalid for service {}", config.service_id);
    }
    let authenticated_user = auth
        .pointer("/user/user_id")
        .and_then(serde_json::Value::as_str)
        .context("TencentDB User Key did not resolve to a user")?;
    if authenticated_user != config.user_id {
        bail!(
            "TencentDB User Key belongs to user {authenticated_user}, expected {}",
            config.user_id
        );
    }

    let team_id = team
        .get("team_id")
        .and_then(serde_json::Value::as_str)
        .context("TencentDB Team response did not include team_id")?;
    if team_id != config.team_id {
        bail!(
            "TencentDB User Key resolved to Team {team_id}, expected {}",
            config.team_id
        );
    }
    let member_matches = member
        .get("team_id")
        .and_then(serde_json::Value::as_str)
        == Some(config.team_id.as_str())
        && member
            .get("user_id")
            .and_then(serde_json::Value::as_str)
            == Some(config.user_id.as_str())
        && member.get("status").and_then(serde_json::Value::as_str) == Some("active");
    if !member_matches {
        bail!(
            "TencentDB user {} is not a member of Team {}",
            config.user_id,
            config.team_id
        );
    }

    let agent_id = agent
        .get("agent_id")
        .and_then(serde_json::Value::as_str)
        .context("TencentDB Agent response did not include agent_id")?;
    if agent_id != config.agent_id {
        bail!(
            "TencentDB resolved Agent {agent_id}, expected {}",
            config.agent_id
        );
    }
    let agent_team = agent
        .get("team_id")
        .and_then(serde_json::Value::as_str)
        .context("TencentDB Agent response did not include team_id")?;
    if agent_team != config.team_id {
        bail!(
            "TencentDB Agent belongs to Team {agent_team}, expected {}",
            config.team_id
        );
    }
    Ok(())
}

fn validate_chat_memory_asset_owner(
    config: &MemoryConnectionConfig,
    asset: &serde_json::Value,
) -> Result<()> {
    if asset.get("asset_type").and_then(serde_json::Value::as_str) != Some("chat_memory") {
        bail!("TencentDB asset is not a Chat Memory asset");
    }
    if asset
        .get("owner_user_id")
        .and_then(serde_json::Value::as_str)
        != Some(config.user_id.as_str())
    {
        bail!(
            "TencentDB Chat Memory asset owner does not match configured user {}",
            config.user_id
        );
    }
    if asset.get("team_id").and_then(serde_json::Value::as_str) != Some(config.team_id.as_str()) {
        bail!(
            "TencentDB Chat Memory asset does not belong to configured Team {}",
            config.team_id
        );
    }
    Ok(())
}

fn validate_chat_memory_delete_permission(
    asset_id: &str,
    permission: &serde_json::Value,
) -> Result<()> {
    if permission
        .get("allowed")
        .and_then(serde_json::Value::as_bool)
        != Some(true)
    {
        let reason = permission
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("delete permission denied");
        bail!("TencentDB Chat Memory {asset_id} cannot be cleared: {reason}");
    }
    Ok(())
}

fn parse_core_envelope(
    status: reqwest::StatusCode,
    envelope: serde_json::Value,
) -> Result<serde_json::Value> {
    let object = envelope
        .as_object()
        .context("TencentDB Core response must be a JSON object")?;
    let code = object
        .get("code")
        .and_then(serde_json::Value::as_i64)
        .context("TencentDB Core response code must be an integer number")?;
    if !status.is_success() || code != 0 {
        let message = object
            .get("message")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("response did not include a message");
        bail!("TencentDB Core request failed ({status}, code {code}): {message}");
    }
    Ok(object.get("data").cloned().unwrap_or_else(|| json!({})))
}

fn core_redirect_policy() -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::none()
}

fn core_http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .redirect(core_redirect_policy())
        .build()
        .context("failed to build TencentDB Core client")
}

async fn send_core_request(
    client: &reqwest::Client,
    endpoint: &str,
    route: &str,
    api_key: &str,
    service_id: &str,
    user_key: Option<&str>,
    body: serde_json::Value,
) -> Result<serde_json::Value> {
    let mut request = client
        .post(format!("{}{}", endpoint.trim_end_matches('/'), route))
        .bearer_auth(api_key)
        .header("x-tdai-service-id", service_id)
        .json(&body);
    if let Some(user_key) = user_key {
        request = request.header("x-tdai-user-key", user_key);
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("failed to reach TencentDB Core route {route}"))?;
    let status = response.status();
    let envelope = response
        .json::<serde_json::Value>()
        .await
        .with_context(|| format!("TencentDB Core route {route} returned invalid JSON"))?;
    parse_core_envelope(status, envelope)
}

async fn verify_chat_memory_clear_ownership(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    user_key: &str,
    service_id: &str,
    body: &serde_json::Map<String, serde_json::Value>,
    config: &MemoryConnectionConfig,
) -> Result<()> {
    let ids = body
        .get("memory_ids")
        .and_then(serde_json::Value::as_array)
        .context("TencentDB Chat Memory clear requires memory_ids")?;
    for memory_id in ids {
        let memory_id = memory_id
            .as_str()
            .context("TencentDB Chat Memory memory_ids must be strings")?;
        let asset = send_core_request(
            client,
            endpoint,
            "/v3/meta/asset/get",
            api_key,
            service_id,
            Some(user_key),
            json!({ "asset_id": memory_id }),
        )
        .await
        .with_context(|| format!("failed to verify TencentDB Chat Memory asset {memory_id}"))?;
        validate_chat_memory_asset_owner(config, &asset)
            .with_context(|| format!("refusing to clear TencentDB Chat Memory asset {memory_id}"))?;
        let permission = send_core_request(
            client,
            endpoint,
            "/v3/meta/acl/check",
            api_key,
            service_id,
            Some(user_key),
            json!({
                "user_id": config.user_id,
                "asset_id": memory_id,
                "action": "delete",
                "agent_id": config.agent_id,
            }),
        )
        .await
        .with_context(|| format!("failed to verify delete permission for Chat Memory asset {memory_id}"))?;
        validate_chat_memory_delete_permission(memory_id, &permission)?;
    }
    Ok(())
}

async fn local_metadata_identity_is_ready(
    client: &reqwest::Client,
    endpoint: &str,
    api_key: &str,
    user_key: &str,
    config: &MemoryConnectionConfig,
) -> Result<bool> {
    let auth = send_core_request(
        client,
        endpoint,
        "/v3/meta/auth/verify",
        api_key,
        &config.service_id,
        None,
        json!({ "user_key": user_key }),
    )
    .await?;
    if auth.get("valid").and_then(serde_json::Value::as_bool) != Some(true) {
        return Ok(false);
    }
    let authenticated_user = auth
        .pointer("/user/user_id")
        .and_then(serde_json::Value::as_str)
        .context("TencentDB local User Key did not resolve to a user")?;
    if authenticated_user != config.user_id {
        bail!(
            "TencentDB local User Key belongs to user {authenticated_user}, expected {}",
            config.user_id
        );
    }

    let team = send_core_request(
        client,
        endpoint,
        "/v3/meta/team/get",
        api_key,
        &config.service_id,
        Some(user_key),
        json!({ "team_id": config.team_id }),
    )
    .await?;
    if team
        .get("owner_user_id")
        .and_then(serde_json::Value::as_str)
        != Some(config.user_id.as_str())
    {
        bail!("TencentDB local Team owner does not match the configured user");
    }

    let agent = send_core_request(
        client,
        endpoint,
        "/v3/meta/agent/get",
        api_key,
        &config.service_id,
        Some(user_key),
        json!({ "agent_id": config.agent_id }),
    )
    .await?;
    if agent.get("team_id").and_then(serde_json::Value::as_str) != Some(config.team_id.as_str())
        || agent
            .get("owner_user_id")
            .and_then(serde_json::Value::as_str)
            != Some(config.user_id.as_str())
    {
        bail!("TencentDB local Agent identity does not match the configured user and Team");
    }
    Ok(true)
}

async fn ensure_local_metadata_identity(
    endpoint: &str,
    api_key: &str,
    user_key: &str,
    config: &MemoryConnectionConfig,
) -> Result<()> {
    let client = core_http_client()?;
    if local_metadata_identity_is_ready(&client, endpoint, api_key, user_key, config).await? {
        return Ok(());
    }
    let init_result = send_core_request(
        &client,
        endpoint,
        "/v3/internal/meta/user/init-admin",
        api_key,
        &config.service_id,
        None,
        json!({
            "username": config.user_id,
            "user_key": user_key,
            "user_id": config.user_id,
            "team_id": config.team_id,
            "agent_id": config.agent_id,
        }),
    )
    .await;
    if let Err(init_error) = init_result {
        match local_metadata_identity_is_ready(&client, endpoint, api_key, user_key, config).await {
            Ok(true) => return Ok(()),
            Ok(false) => {
                return Err(init_error)
                    .context("failed to initialize the managed TencentDB user identity")
            }
            Err(verify_error) => {
                return Err(verify_error).context(format!(
                    "failed to verify the managed TencentDB user identity after initialization failed: {init_error}"
                ))
            }
        }
    }
    if !local_metadata_identity_is_ready(&client, endpoint, api_key, user_key, config).await? {
        bail!("TencentDB local identity initialization did not produce a usable User Key");
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TencentdbKnowledgeAssets {
    pub code_graphs: Vec<serde_json::Value>,
    pub wikis: Vec<serde_json::Value>,
    pub workspace: Option<WorkspaceKnowledgeAssetsDto>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceKnowledgeAssetsDto {
    pub code_graph_id: Option<String>,
    pub wiki_id: Option<String>,
    pub repo_url: Option<String>,
    pub branch: Option<String>,
    pub error: Option<String>,
    pub updated_at: Option<String>,
}

impl From<WorkspaceKnowledgeAssets> for WorkspaceKnowledgeAssetsDto {
    fn from(value: WorkspaceKnowledgeAssets) -> Self {
        Self {
            code_graph_id: value.code_graph_id,
            wiki_id: value.wiki_id,
            repo_url: value.repo_url,
            branch: value.branch,
            error: value.error,
            updated_at: value.updated_at,
        }
    }
}

fn public_error(error: anyhow::Error) -> String {
    error.to_string()
}

fn connection_settings_changed(
    mut previous: MemoryConnectionConfig,
    mut next: MemoryConnectionConfig,
    credential_changed: bool,
) -> bool {
    previous.last_success_at = None;
    next.last_success_at = None;
    credential_changed || previous != next
}

fn required_credential(value: Option<&str>, label: &str) -> Result<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .with_context(|| format!("TencentDB {label} is required before saving a remote connection"))
}

fn ensure_gateway_api_key(mode: &MemoryMode) -> Result<String> {
    if let Some(value) = MemoryCredentialStore::gateway_api_key(mode)? {
        return Ok(value);
    }
    if *mode == MemoryMode::Remote {
        bail!("TencentDB remote Gateway credential is not configured");
    }
    let value = uuid::Uuid::new_v4().simple().to_string();
    MemoryCredentialStore::set_gateway_api_key(mode, &value)?;
    Ok(value)
}

fn local_user_api_key(gateway_api_key: &str) -> String {
    let digest = Sha256::digest(
        [
            b"GrenAgent TencentDB managed user\0".as_slice(),
            gateway_api_key.as_bytes(),
        ]
        .concat(),
    );
    format!("sk-mem-{}", &format!("{digest:x}")[..32])
}

fn resolve_user_api_key(config: &MemoryConnectionConfig, gateway_api_key: &str) -> Result<String> {
    if config.mode == MemoryMode::Local {
        return Ok(local_user_api_key(gateway_api_key));
    }
    MemoryCredentialStore::user_api_key()?
        .filter(|value| !value.trim().is_empty())
        .context("TencentDB remote User Key is not configured")
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
    let data_dir = tencentdb_data_dir(app)?;
    // LLM routing is synchronized from Pi's active model through the Knowledge
    // binding endpoint; TencentDB runtime never reads a second model config.
    let runtime_config = LocalRuntimeConfig::default();
    let status = runtime
        .start_local(
            bundled_layout(app)?,
            &data_dir,
            gateway_api_key,
            &runtime_config,
        )
        .await?;
    let user_key = local_user_api_key(gateway_api_key);
    if let Err(error) =
        ensure_local_metadata_identity(&status.endpoint, gateway_api_key, &user_key, config).await
    {
        let cleanup = runtime.stop().await;
        return match cleanup {
            Ok(()) => Err(error),
            Err(cleanup_error) => Err(error.context(format!(
                "failed to stop TencentDB runtime after identity initialization failure: {cleanup_error}"
            ))),
        };
    }
    Ok(status)
}

fn tencentdb_data_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .context("failed to resolve application data directory")?
        .join("tencentdb-memory"))
}

async fn route_runtime_start<F, Fut>(mode: &MemoryMode, start_local: F) -> Result<()>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    if mode.should_spawn_gateway() {
        start_local().await?;
    }
    Ok(())
}

/// Start the configured TencentDB runtime as an application-level service.
/// Local mode owns the bundled child processes; remote mode only validates the
/// configuration and leaves process ownership to the remote deployment.
pub async fn ensure_runtime_started(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
) -> Result<TencentdbStatus> {
    let config = store.tencentdb_config().await.normalized()?;
    let api_key = ensure_gateway_api_key(&config.mode)?;
    route_runtime_start(&config.mode, || async {
        start_local_runtime(app, runtime, &config, &api_key).await?;
        Ok(())
    })
    .await?;
    current_status(store, runtime).await
}

async fn panel_connection(
    store: &AppStateStore,
    runtime: &MemoryRuntime,
) -> Result<PanelConnection> {
    let config = store.tencentdb_config().await.normalized()?;
    let gateway_api_key = ensure_gateway_api_key(&config.mode)?;
    let user_key = resolve_user_api_key(&config, &gateway_api_key)?;
    let (gateway_endpoint, knowledge_endpoint) = if config.mode == MemoryMode::Local {
        let status = runtime.local_status().await;
        (
            status.endpoint,
            status.knowledge_endpoint.unwrap_or_default(),
        )
    } else {
        (
            config.endpoint.clone(),
            config.knowledge_endpoint.clone().unwrap_or_default(),
        )
    };
    if gateway_endpoint.trim().is_empty() {
        bail!("TencentDB Gateway endpoint is unavailable");
    }
    Ok(PanelConnection {
        mode: config.mode,
        service_id: config.service_id,
        user_id: config.user_id,
        gateway_endpoint,
        knowledge_endpoint,
        gateway_api_key,
        user_key,
    })
}

/// Ensure the native Panel is running after its local dependencies, when applicable.
pub async fn ensure_panel_runtime_started(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    panel: &PanelRuntime,
) -> Result<(PanelConnection, String)> {
    ensure_panel_restart_not_required(runtime)?;
    let status = ensure_runtime_started(app, store, runtime).await?;
    ensure_panel_dependencies_ready(&status.state)?;
    let connection = panel_connection(store, runtime).await?;
    let endpoint = panel
        .ensure_started(&bundled_layout(app)?, &connection)
        .await?;
    Ok((connection, endpoint))
}

fn ensure_panel_restart_not_required(runtime: &MemoryRuntime) -> Result<()> {
    if runtime.requires_restart() {
        bail!("TencentDB Panel requires an application restart before it can be opened");
    }
    Ok(())
}

fn ensure_panel_dependencies_ready(state: &str) -> Result<()> {
    if state != "ready" {
        bail!("TencentDB Panel dependencies are not ready: {state}");
    }
    Ok(())
}

async fn current_status(store: &AppStateStore, runtime: &MemoryRuntime) -> Result<TencentdbStatus> {
    let config = store.tencentdb_config().await.normalized()?;
    let credential_configured = MemoryCredentialStore::gateway_api_key(&config.mode)?.is_some();
    let user_credential_configured = if config.mode == MemoryMode::Local {
        credential_configured
    } else {
        MemoryCredentialStore::user_api_key()?.is_some()
    };
    if config.mode == MemoryMode::Local {
        let local = runtime.local_status().await;
        let restart_required = runtime.requires_restart();
        return Ok(TencentdbStatus {
            mode: MemoryMode::Local,
            endpoint: local.endpoint,
            knowledge_endpoint: local.knowledge_endpoint,
            state: if restart_required {
                "restart_required".to_string()
            } else {
                local.state
            },
            credential_configured,
            user_credential_configured,
            last_success_at: config.last_success_at,
            restart_required,
        });
    }

    let core_reachable = match (
        MemoryCredentialStore::gateway_api_key(&config.mode)?,
        MemoryCredentialStore::user_api_key()?,
    ) {
        (Some(api_key), Some(user_key)) => match probe_gateway_with_timeout(
            &config.endpoint,
            &api_key,
            &user_key,
            &config,
            std::time::Duration::from_secs(3),
        )
        .await
        {
            Ok(()) => true,
            Err(error) => {
                eprintln!("[tencentdb-memory] remote status probe failed: {error}");
                false
            }
        },
        _ => false,
    };
    let knowledge_reachable = match (
        config.knowledge_endpoint.as_deref(),
        MemoryCredentialStore::gateway_api_key(&config.mode)?,
    ) {
        (Some(endpoint), Some(api_key)) => {
            let client = resolve_user_api_key(&config, &api_key).and_then(|user_key| {
                KnowledgeClient::new(endpoint, &api_key, &config.service_id, &user_key)
            });
            match client {
                Ok(client) => match client.get_health().await {
                    Ok(()) => true,
                    Err(error) => {
                        eprintln!("[tencentdb-memory] remote knowledge probe failed: {error}");
                        false
                    }
                },
                Err(error) => {
                    eprintln!("[tencentdb-memory] remote knowledge config invalid: {error}");
                    false
                }
            }
        }
        // A remote deployment may intentionally expose only MemoryCore. The
        // Knowledge MCP remains disabled until its endpoint is configured.
        (None, _) => true,
        (_, None) => false,
    };
    let reachable = core_reachable && knowledge_reachable;

    let restart_required = runtime.requires_restart();
    Ok(TencentdbStatus {
        mode: MemoryMode::Remote,
        endpoint: config.endpoint,
        knowledge_endpoint: config.knowledge_endpoint,
        state: if restart_required {
            "restart_required"
        } else if reachable {
            "ready"
        } else {
            "failed"
        }
        .to_string(),
        credential_configured,
        user_credential_configured,
        last_success_at: config.last_success_at,
        restart_required,
    })
}

fn insert_knowledge_env(env: &mut HashMap<String, String>, endpoint: Option<&str>) {
    if let Some(endpoint) = endpoint.filter(|value| !value.trim().is_empty()) {
        env.insert("TDAI_KNOWLEDGE_ENDPOINT".to_string(), endpoint.to_string());
        env.insert("TDAI_KNOWLEDGE_MCP".to_string(), "1".to_string());
    }
}

fn insert_knowledge_asset_env(
    env: &mut HashMap<String, String>,
    config: &MemoryConnectionConfig,
    assets: Option<&WorkspaceKnowledgeAssets>,
) {
    env.insert(
        "TDAI_KNOWLEDGE_SERVICE_ID".to_string(),
        config.service_id.clone(),
    );
    env.insert("TDAI_KNOWLEDGE_TEAM_ID".to_string(), config.team_id.clone());
    env.insert(
        "TDAI_KNOWLEDGE_AGENT_ID".to_string(),
        config.agent_id.clone(),
    );
    env.insert("TDAI_KNOWLEDGE_USER_ID".to_string(), config.user_id.clone());
    if let Some(task_id) = &config.task_id {
        env.insert("TDAI_KNOWLEDGE_TASK_ID".to_string(), task_id.clone());
    }
    if let Some(assets) = assets {
        if let Some(id) = &assets.code_graph_id {
            env.insert("TDAI_CODE_GRAPH_ID".to_string(), id.clone());
        }
        if let Some(id) = &assets.wiki_id {
            env.insert("TDAI_WIKI_ID".to_string(), id.clone());
        }
    }
}

fn git_value(workspace: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(workspace)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

fn normalize_remote_repo_url(value: &str) -> Result<String> {
    let value = value.trim();
    let url = reqwest::Url::parse(value).context("Git origin must be a valid HTTPS URL")?;
    if url.scheme() != "https" || url.host_str().is_none() {
        bail!("remote CodeGraph source must use HTTPS");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("remote CodeGraph source must not contain embedded credentials");
    }
    Ok(value.to_string())
}

fn normalize_repo_identity(value: &str) -> Result<String> {
    let value = normalize_remote_repo_url(value)?;
    let mut url = reqwest::Url::parse(&value).context("Git origin must be a valid HTTPS URL")?;
    url.set_query(None);
    url.set_fragment(None);
    if url.port() == Some(443) {
        url.set_port(None)
            .map_err(|_| anyhow::anyhow!("failed to normalize Git origin port"))?;
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    if path.len() >= 4 && path[path.len() - 4..].eq_ignore_ascii_case(".git") {
        path.truncate(path.len() - 4);
    }
    url.set_path(if path.is_empty() { "/" } else { &path });
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn workspace_source(
    workspace: &Path,
    mode: &MemoryMode,
) -> Result<(Option<String>, String, String, Option<String>)> {
    let normalized_origin = match mode {
        MemoryMode::Local => None,
        MemoryMode::Remote => {
            let remote = git_value(workspace, &["remote", "get-url", "origin"])
                .context("remote Knowledge requires a Git origin")?;
            Some(normalize_remote_repo_url(&remote)?)
        }
    };
    let branch = git_value(workspace, &["branch", "--show-current"])
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "main".to_string());
    let repo_url = if *mode == MemoryMode::Local {
        Some(
            reqwest::Url::from_directory_path(workspace)
                .map_err(|_| anyhow::anyhow!("failed to encode local workspace as a file URL"))?
                .to_string(),
        )
    } else {
        normalized_origin.clone()
    };
    let repo_name = workspace
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("workspace")
        .to_string();
    Ok((repo_url, branch, repo_name, normalized_origin))
}

fn same_path(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn normalize_canonical_local_path(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path
}

fn workspace_storage_key(path: &Path) -> String {
    normalize_canonical_local_path(path.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

const MAX_WORKSPACE_WIKI_NAME_BYTES: usize = 128;

fn workspace_wiki_name(
    workspace: &Path,
    mode: &MemoryMode,
    origin: Option<&str>,
) -> Result<String> {
    let (identity, label) = match mode {
        MemoryMode::Local => {
            let key = workspace_storage_key(workspace);
            let identity = if cfg!(windows) {
                key.to_lowercase()
            } else {
                key
            };
            let label = workspace
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("workspace")
                .to_string();
            (identity, label)
        }
        MemoryMode::Remote => {
            let origin = origin.context("remote Wiki requires a Git origin")?;
            let identity = normalize_repo_identity(origin)?;
            let url =
                reqwest::Url::parse(&identity).context("failed to parse normalized Git origin")?;
            let label = url
                .path_segments()
                .and_then(|segments| {
                    segments
                        .filter(|segment| !segment.is_empty())
                        .next_back()
                        .map(str::to_string)
                })
                .or_else(|| url.host_str().map(str::to_string))
                .context("Git origin must include a repository path or host")?;
            (identity, label)
        }
    };
    let label = sanitize_wiki_label(&label);
    let hash = Sha256::digest(identity.as_bytes());
    let mut digest = String::with_capacity(32);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in hash.iter().take(16) {
        digest.push(HEX[(byte >> 4) as usize] as char);
        digest.push(HEX[(byte & 0x0f) as usize] as char);
    }
    let prefix = "Pi · ";
    let suffix = format!(" · {digest}");
    let label = truncate_utf8_bytes(
        &label,
        MAX_WORKSPACE_WIKI_NAME_BYTES - prefix.len() - suffix.len(),
    );
    Ok(format!("{prefix}{label}{suffix}"))
}

fn sanitize_wiki_label(value: &str) -> String {
    let mut label = String::new();
    let mut separator = false;
    for character in value.chars() {
        if character.is_control() {
            continue;
        }
        if character.is_alphanumeric() || matches!(character, '-' | '_' | '.') {
            label.push(character);
            separator = false;
        } else if !separator && !label.is_empty() {
            label.push('-');
            separator = true;
        }
    }
    let label = label.trim_matches(|value| matches!(value, '-' | '_' | '.'));
    if label.is_empty() {
        "workspace".to_string()
    } else {
        label.to_string()
    }
}

fn truncate_utf8_bytes(value: &str, maximum: usize) -> &str {
    if value.len() <= maximum {
        return value;
    }
    let mut end = 0;
    for (index, character) in value.char_indices() {
        let next = index + character.len_utf8();
        if next > maximum {
            break;
        }
        end = next;
    }
    &value[..end]
}

fn register_local_source_at(allowlist: &Path, workspace: &Path) -> Result<PathBuf> {
    let canonical =
        normalize_canonical_local_path(std::fs::canonicalize(workspace).with_context(|| {
            format!("failed to canonicalize workspace {}", workspace.display())
        })?);
    if !canonical.is_dir() {
        bail!("TencentDB local source must be a directory");
    }
    let display = canonical.to_string_lossy();
    if display.starts_with("\\\\") || display.starts_with("//") {
        bail!("TencentDB local source must not be a network path");
    }
    if let Some(parent) = allowlist.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let already_registered = match std::fs::read_to_string(allowlist) {
        Ok(content) => content.lines().any(|line| {
            serde_json::from_str::<String>(line)
                .ok()
                .is_some_and(|value| same_path(Path::new(&value), &canonical))
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return Err(error).context("failed to read TencentDB local source allow-list")
        }
    };
    if !already_registered {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(allowlist)
            .context("failed to open TencentDB local source allow-list")?;
        writeln!(file, "{}", serde_json::to_string(&display.as_ref())?)?;
    }
    Ok(canonical)
}

fn register_local_source(app: &tauri::AppHandle, workspace: &Path) -> Result<PathBuf> {
    let data_dir = tencentdb_data_dir(app)?;
    register_local_source_at(&local_source_allowlist_path(&data_dir), workspace)
}

fn extract_asset_id(data: &serde_json::Value, field: &str) -> Option<String> {
    data.get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
}

fn normalize_knowledge_search(
    query: &str,
    limit: Option<u64>,
    maximum: u64,
) -> Result<(String, u64)> {
    let query = query.trim();
    if query.is_empty() {
        bail!("Knowledge search query must not be empty");
    }
    let limit = limit.unwrap_or(20);
    if limit == 0 || limit > maximum {
        bail!("Knowledge search limit must be between 1 and {maximum}");
    }
    Ok((query.to_string(), limit))
}

fn normalize_knowledge_text(value: &str, field: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("Knowledge {field} must not be empty");
    }
    Ok(value.to_string())
}

fn normalize_optional_knowledge_text(value: Option<&str>, field: &str) -> Result<Option<String>> {
    value
        .map(|value| normalize_knowledge_text(value, field))
        .transpose()
}

fn normalize_knowledge_count(
    value: Option<u64>,
    default: u64,
    maximum: u64,
    field: &str,
) -> Result<u64> {
    let value = value.unwrap_or(default);
    if value == 0 || value > maximum {
        bail!("Knowledge {field} must be between 1 and {maximum}");
    }
    Ok(value)
}

fn normalize_optional_knowledge_count(value: Option<u64>, field: &str) -> Result<Option<u64>> {
    if value == Some(0) {
        bail!("Knowledge {field} must be at least 1");
    }
    Ok(value)
}

fn normalize_code_graph_files_format(value: Option<&str>) -> Result<&str> {
    match value.unwrap_or("tree") {
        format @ ("tree" | "flat" | "grouped") => Ok(format),
        _ => bail!("Knowledge format must be tree, flat or grouped"),
    }
}

fn workspace_code_graph_matches(
    data: &serde_json::Value,
    team_id: &str,
    repo_url: &str,
    branch: &str,
) -> bool {
    data.get("code_graph_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value.starts_with("cg-"))
        && data.get("team_id").and_then(serde_json::Value::as_str) == Some(team_id)
        && data.get("repo_url").and_then(serde_json::Value::as_str) == Some(repo_url)
        && data.get("branch").and_then(serde_json::Value::as_str) == Some(branch)
}

fn workspace_wiki_matches(data: &serde_json::Value, team_id: &str, name: &str) -> bool {
    data.get("wiki_id")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|value| value.starts_with("wiki-"))
        && data.get("team_id").and_then(serde_json::Value::as_str) == Some(team_id)
        && data.get("name").and_then(serde_json::Value::as_str) == Some(name)
}

fn clear_workspace_asset_reference(
    assets: &mut WorkspaceKnowledgeAssets,
    asset_id: &str,
    code_graph: bool,
) -> bool {
    let reference = if code_graph {
        &mut assets.code_graph_id
    } else {
        &mut assets.wiki_id
    };
    if reference.as_deref() != Some(asset_id) {
        return false;
    }
    *reference = None;
    true
}

fn ensure_knowledge_asset_deleted(
    data: serde_json::Value,
    asset_id: &str,
) -> Result<serde_json::Value> {
    let deleted = data
        .get("deleted_ids")
        .and_then(serde_json::Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(asset_id)));
    if deleted {
        return Ok(data);
    }
    let reason = data
        .get("failed")
        .and_then(serde_json::Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find(|item| item.get("id").and_then(serde_json::Value::as_str) == Some(asset_id))
        })
        .and_then(|item| item.get("reason"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("delete was not acknowledged");
    bail!("TencentDB Knowledge did not delete {asset_id}: {reason}")
}

fn list_items(data: serde_json::Value) -> Vec<serde_json::Value> {
    data.get("items")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default()
}

async fn configured_knowledge_client(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
) -> Result<(MemoryConnectionConfig, KnowledgeClient)> {
    let config = store.tencentdb_config().await.normalized()?;
    let api_key = ensure_gateway_api_key(&config.mode)?;
    let user_key = resolve_user_api_key(&config, &api_key)?;
    let endpoint = if config.mode == MemoryMode::Local {
        start_local_runtime(app, runtime, &config, &api_key)
            .await?
            .knowledge_endpoint
            .context("TencentDB MemoryKnowledge endpoint is unavailable")?
    } else {
        config
            .knowledge_endpoint
            .clone()
            .context("TencentDB remote Knowledge endpoint is not configured")?
    };
    Ok((
        config.clone(),
        KnowledgeClient::new(&endpoint, &api_key, &config.service_id, &user_key)?,
    ))
}

/// Knowledge 和 Core 使用两张资产表：Knowledge 负责内容，Core 负责资产治理与 Agent 绑定。
/// 项目资产创建/复用后必须在 Core 补齐元数据，否则 Hub 的 Agent 资产列表会显示为 0。
async fn reconcile_knowledge_core_assets(
    config: &MemoryConnectionConfig,
    gateway_endpoint: &str,
    api_key: &str,
    user_key: &str,
    code_graph: Option<(&str, &str, &str)>,
    wiki: Option<(&str, &str, &str)>,
) -> Result<()> {
    let client = core_http_client()?;
    let mut new_bindings = Vec::new();

    for (asset_id, asset_type, name, source_ref) in [
        code_graph.map(|(id, name, source)| (id, "code_graph", name, source)),
        wiki.map(|(id, name, source)| (id, "llm_wiki", name, source)),
    ]
    .into_iter()
    .flatten()
    {
        let existing = send_core_request(
            &client,
            gateway_endpoint,
            "/v3/meta/asset/get",
            api_key,
            &config.service_id,
            Some(user_key),
            json!({ "asset_id": asset_id }),
        )
        .await;

        if existing.is_err() {
            let create = send_core_request(
                &client,
                gateway_endpoint,
                "/v3/meta/asset/create",
                api_key,
                &config.service_id,
                Some(user_key),
                json!({
                    "asset_id": asset_id,
                    "team_id": config.team_id,
                    "asset_type": asset_type,
                    "name": name,
                    "owner_user_id": config.user_id,
                    "source_type": "knowledge",
                    "source_ref": source_ref,
                    "content_ref": asset_id,
                    "visibility": "team",
                    "status": "approved",
                }),
            )
            .await;
            if let Err(create_error) = create {
                // 并发启动可能已经由另一个工作区请求创建成功，回读确认即可。
                send_core_request(
                    &client,
                    gateway_endpoint,
                    "/v3/meta/asset/get",
                    api_key,
                    &config.service_id,
                    Some(user_key),
                    json!({ "asset_id": asset_id }),
                )
                .await
                .with_context(|| format!("failed to register TencentDB {asset_type} asset {asset_id}: {create_error}"))?;
            }
        }
        new_bindings.push(json!({
            "asset_id": asset_id,
            "asset_type": asset_type,
            "injection_mode": "tool",
            "priority": 50,
            "created_by": config.user_id,
        }));
    }

    if new_bindings.is_empty() {
        return Ok(());
    }

    let mut current_items = Vec::new();
    let mut offset = 0u64;
    loop {
        let page = send_core_request(
            &client,
            gateway_endpoint,
            "/v3/meta/agent-fixed-asset/list-with-detail",
            api_key,
            &config.service_id,
            Some(user_key),
            json!({ "agent_id": config.agent_id, "limit": 100, "offset": offset }),
        )
        .await?;
        let items = page
            .get("items")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        let count = items.len() as u64;
        current_items.extend(items);
        offset += count;
        let total = page
            .get("total")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(offset);
        if count == 0 || offset >= total {
            break;
        }
    }
    let mut bindings = current_items
        .into_iter()
        .filter_map(|item| {
            Some(json!({
                "asset_id": item.get("asset_id")?.as_str()?,
                "asset_type": item.get("asset_type")?.as_str()?,
                "injection_mode": item.get("injection_mode").and_then(serde_json::Value::as_str).unwrap_or("reference"),
                "priority": item.get("priority").and_then(serde_json::Value::as_i64).unwrap_or(0),
                "created_by": config.user_id,
            }))
        })
        .collect::<Vec<_>>();
    let existing_ids = bindings
        .iter()
        .filter_map(|item| item.get("asset_id").and_then(serde_json::Value::as_str))
        .map(ToOwned::to_owned)
        .collect::<std::collections::HashSet<String>>();
    for binding in new_bindings {
        let Some(asset_id) = binding.get("asset_id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        if !existing_ids.contains(asset_id) {
            bindings.push(binding);
        }
    }

    send_core_request(
        &client,
        gateway_endpoint,
        "/v3/meta/agent-fixed-asset/set",
        api_key,
        &config.service_id,
        Some(user_key),
        json!({ "agent_id": config.agent_id, "bindings": bindings }),
    )
    .await?;
    Ok(())
}

async fn provision_workspace_assets(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    workspace: &Path,
) -> Result<WorkspaceKnowledgeAssets> {
    let (config, client) = configured_knowledge_client(app, store, runtime).await?;
    let gateway_api_key = ensure_gateway_api_key(&config.mode)?;
    let gateway_user_key = resolve_user_api_key(&config, &gateway_api_key)?;
    let gateway_endpoint = if config.mode == MemoryMode::Local {
        runtime.local_status().await.endpoint
    } else {
        config.endpoint.clone()
    };
    let workspace = if config.mode == MemoryMode::Local {
        register_local_source(app, workspace)?
    } else {
        workspace.to_path_buf()
    };
    let workspace_key = workspace_storage_key(&workspace);
    let (repo_url, branch, repo_name, normalized_origin) =
        workspace_source(&workspace, &config.mode)?;
    let repo_url = repo_url.context("workspace CodeGraph source is unavailable")?;
    let mut assets = store
        .knowledge_assets_for(&workspace_key)
        .await
        .unwrap_or_default();
    assets.repo_url = Some(repo_url.clone());
    assets.branch = Some(branch.clone());
    assets.error = None;

    let existing_matches = match assets.code_graph_id.as_deref() {
        Some(id) => client.get_code_graph(id).await.is_ok_and(|data| {
            workspace_code_graph_matches(&data, &config.team_id, &repo_url, &branch)
        }),
        None => false,
    };
    if !existing_matches {
        assets.code_graph_id = None;
        match client
            .create_code_graph(json!({
                "team_id": config.team_id,
                "repo_url": repo_url,
                "branch": branch,
                "repo_name": repo_name,
                "user_id": config.user_id,
                "agent_id": config.agent_id,
                "task_id": config.task_id,
            }))
            .await
        {
            Ok(data) => assets.code_graph_id = extract_asset_id(&data, "code_graph_id"),
            Err(error) => assets.error = Some(error.to_string()),
        }
    }

    let wiki_name = workspace_wiki_name(&workspace, &config.mode, normalized_origin.as_deref())?;
    let existing_wiki_matches = match assets.wiki_id.as_deref() {
        Some(id) => client
            .get_wiki(id)
            .await
            .is_ok_and(|data| workspace_wiki_matches(&data, &config.team_id, &wiki_name)),
        None => false,
    };
    if !existing_wiki_matches {
        assets.wiki_id = None;
        match client
            .create_wiki(json!({
                "team_id": config.team_id,
                "name": wiki_name,
                "user_id": config.user_id,
                "agent_id": config.agent_id,
                "task_id": config.task_id,
            }))
            .await
        {
            Ok(data) => assets.wiki_id = extract_asset_id(&data, "wiki_id"),
            Err(error) => {
                let message = error.to_string();
                assets.error = Some(match assets.error.take() {
                    Some(previous) => format!("{previous}; {message}"),
                    None => message,
                });
            }
        }
    }

    let code_graph_binding = assets.code_graph_id.as_deref().map(|id| {
        (id, repo_name.as_str(), repo_url.as_str())
    });
    let wiki_binding = assets.wiki_id.as_deref().map(|id| {
        (id, wiki_name.as_str(), wiki_name.as_str())
    });
    if let Err(error) = reconcile_knowledge_core_assets(
        &config,
        &gateway_endpoint,
        &gateway_api_key,
        &gateway_user_key,
        code_graph_binding,
        wiki_binding,
    )
    .await
    {
        assets.error = Some(match assets.error.take() {
            Some(previous) => format!("{previous}; {error}"),
            None => error.to_string(),
        });
    }

    assets.updated_at = Some(chrono::Utc::now().to_rfc3339());
    store
        .replace_knowledge_assets(workspace_key, assets.clone())
        .await;
    if assets.code_graph_id.is_none() && assets.wiki_id.is_none() {
        bail!(assets
            .error
            .unwrap_or_else(|| "TencentDB Knowledge assets were not created".to_string()));
    }
    Ok(assets)
}

fn managed_skill_scope(config: &MemoryConnectionConfig) -> String {
    let mode = match config.mode {
        MemoryMode::Local => "local",
        MemoryMode::Remote => "remote",
    };
    let endpoint = if config.mode == MemoryMode::Local {
        "managed-local"
    } else {
        config.endpoint.as_str()
    };
    let mut digest = Sha256::new();
    for value in [
        "grenagent-tencentdb-skills-v1",
        mode,
        endpoint,
        config.service_id.as_str(),
        config.team_id.as_str(),
        config.agent_id.as_str(),
        config.user_id.as_str(),
    ] {
        digest.update((value.len() as u64).to_be_bytes());
        digest.update(value.as_bytes());
    }
    format!("{:x}", digest.finalize())
}

fn managed_skill_root_at(app_data_dir: &Path, config: &MemoryConnectionConfig) -> PathBuf {
    app_data_dir
        .join("tencentdb-memory")
        .join("skills")
        .join(managed_skill_scope(config))
}

fn managed_skill_root(app: &tauri::AppHandle, config: &MemoryConnectionConfig) -> Result<PathBuf> {
    Ok(managed_skill_root_at(
        &app.path()
            .app_data_dir()
            .context("failed to resolve application data directory")?,
        config,
    ))
}

async fn bump_skill_reload_revision(store: &AppStateStore) -> String {
    let revision = uuid::Uuid::new_v4().simple().to_string();
    store
        .update(|state| {
            state
                .settings
                .insert("PI_RELOAD_REV".to_string(), revision.clone());
        })
        .await;
    revision
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
        ("CODE_SEARCH_ENABLED".to_string(), "0".to_string()),
    ])
}

fn cutover_env_for_app(
    _app: &tauri::AppHandle,
    _workspace: Option<&Path>,
) -> HashMap<String, String> {
    // This product is in a clean development phase. TencentDB is the only
    // memory backend immediately; no migration marker or legacy data gate is
    // consulted before disabling the old extensions.
    legacy_cutover_env(true)
}

async fn probe_gateway(
    endpoint: &str,
    api_key: &str,
    config: &MemoryConnectionConfig,
) -> Result<()> {
    let user_key = resolve_user_api_key(config, api_key)?;
    probe_gateway_with_timeout(
        endpoint,
        api_key,
        &user_key,
        config,
        std::time::Duration::from_secs(10),
    )
    .await
}

async fn probe_gateway_with_timeout(
    endpoint: &str,
    api_key: &str,
    user_key: &str,
    config: &MemoryConnectionConfig,
    timeout: std::time::Duration,
) -> Result<()> {
    let mut body = serde_json::Map::from_iter([
        ("team_id".to_string(), json!(config.team_id)),
        ("agent_id".to_string(), json!(config.agent_id)),
        ("user_id".to_string(), json!(config.user_id)),
    ]);
    if let Some(task_id) = &config.task_id {
        body.insert("task_id".to_string(), json!(task_id));
    }
    let client = reqwest::Client::builder().timeout(timeout).build()?;
    let auth = client
        .post(format!(
            "{}/v3/meta/auth/verify",
            endpoint.trim_end_matches('/')
        ))
        .bearer_auth(api_key)
        .header("x-tdai-service-id", &config.service_id)
        .json(&json!({ "user_key": user_key }))
        .send()
        .await
        .context("failed to verify the TencentDB User Key")?;
    let auth_status = auth.status();
    let auth_body: serde_json::Value = auth
        .json()
        .await
        .context("TencentDB User Key verification returned an invalid response")?;
    if !auth_status.is_success()
        || auth_body.get("code").and_then(serde_json::Value::as_i64) != Some(0)
        || auth_body
            .pointer("/data/valid")
            .and_then(serde_json::Value::as_bool)
            != Some(true)
    {
        bail!(
            "TencentDB User Key is invalid for service {}",
            config.service_id
        );
    }

    let auth_data = auth_body.get("data").cloned().unwrap_or_else(|| json!({}));
    let team = send_core_request(
        &client,
        endpoint,
        "/v3/meta/team/get",
        api_key,
        &config.service_id,
        Some(user_key),
        json!({ "team_id": config.team_id }),
    )
    .await
    .context("failed to verify TencentDB Team access")?;
    let member = send_core_request(
        &client,
        endpoint,
        "/v3/meta/team-member/get",
        api_key,
        &config.service_id,
        Some(user_key),
        json!({ "team_id": config.team_id, "user_id": config.user_id }),
    )
    .await
    .context("failed to verify TencentDB Team membership")?;
    let agent = send_core_request(
        &client,
        endpoint,
        "/v3/meta/agent/get",
        api_key,
        &config.service_id,
        Some(user_key),
        json!({ "agent_id": config.agent_id }),
    )
    .await
    .context("failed to verify TencentDB Agent access")?;
    validate_remote_identity(config, &auth_data, &team, &member, &agent)?;

    let response = client
        .post(format!("{}/v3/core/read", endpoint.trim_end_matches('/')))
        .bearer_auth(api_key)
        .header("x-tdai-service-id", &config.service_id)
        .header("x-tdai-user-key", user_key)
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

/// Prepare the sidecar environment for TencentDB. Legacy backends are always
/// disabled; workspace-scoped Knowledge assets are provisioned best-effort and
/// their non-sensitive IDs are passed to the bundled MCP server.
pub async fn prepare_memory_env_for_workspace(
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    workspace: Option<&Path>,
) -> HashMap<String, String> {
    // Keep the hard-cut switches even when configuration or bundled assets are
    // unavailable. A failed TencentDB startup must never revive an old backend.
    let cutover_env = cutover_env_for_app(app, workspace);
    let prepared = async {
        let config = store.tencentdb_config().await.normalized()?;
        let api_key = ensure_gateway_api_key(&config.mode)?;
        let user_key = resolve_user_api_key(&config, &api_key)?;
        let mut env = if config.mode == MemoryMode::Local {
            let status = start_local_runtime(app, runtime, &config, &api_key).await?;
            let mut env = config.sidecar_env(&status.endpoint, &api_key, &user_key);
            insert_knowledge_env(&mut env, status.knowledge_endpoint.as_deref());
            env
        } else {
            let mut env = config.sidecar_env(&config.endpoint, &api_key, &user_key);
            insert_knowledge_env(&mut env, config.knowledge_endpoint.as_deref());
            env
        };
        env.insert(
            "TDAI_SKILLS_ROOT".to_string(),
            managed_skill_root(app, &config)?
                .to_string_lossy()
                .into_owned(),
        );
        env.insert(
            "TDAI_SKILLS_SCOPE".to_string(),
            managed_skill_scope(&config),
        );
        env.insert("TDAI_SKILLS_SYNC".to_string(), "1".to_string());
        let workspace_assets = if let Some(workspace) =
            workspace.filter(|path| !crate::commands::agent::is_conversation_workspace(path))
        {
            let key = workspace_storage_key(workspace);
            match provision_workspace_assets(app, store, runtime, workspace).await {
                Ok(assets) => Some(assets),
                Err(error) => {
                    eprintln!(
                        "[tencentdb-memory] workspace Knowledge provisioning failed: {error}"
                    );
                    store.knowledge_assets_for(&key).await
                }
            }
        } else {
            None
        };
        insert_knowledge_asset_env(&mut env, &config, workspace_assets.as_ref());
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
pub async fn tencentdb_open_panel(
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
    panel: State<'_, Arc<PanelRuntime>>,
) -> Result<TencentdbPanelOpen, String> {
    let (connection, endpoint) = ensure_panel_runtime_started(&app, &store, &runtime, &panel)
        .await
        .map_err(public_error)?;
    let token = panel
        .register_bootstrap(&connection)
        .await
        .map_err(public_error)?;
    Ok(TencentdbPanelOpen {
        url: panel_url(&endpoint, &token).map_err(public_error)?,
    })
}

#[tauri::command]
pub async fn tencentdb_get_status(
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbStatus, String> {
    current_status(&store, &runtime).await.map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_reload_skills(store: State<'_, AppStateStore>) -> Result<(), String> {
    bump_skill_reload_revision(&store).await;
    store.write_runtime_config().await;
    Ok(())
}

#[tauri::command]
pub async fn tencentdb_sync_llm(
    input: TencentdbLlmSyncInput,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let protocol = match input.api.as_str() {
        "anthropic-messages" => "anthropic",
        "openai-completions" | "openai-responses" => "openai",
        _ => return Err("TencentDB Knowledge 不支持当前 Pi 模型协议".into()),
    };
    let (config, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    if input.model_id.trim().is_empty() || input.base_url.trim().is_empty() || input.api_key.trim().is_empty() {
        return Err("Pi 当前模型缺少可同步的 endpoint、model 或 API Key".into());
    }
    client
        .set_llm_binding(
            "byo",
            input.base_url.trim(),
            input.api_key.trim(),
            input.model_id.trim(),
            protocol,
        )
        .await
        .map_err(public_error)
        .map(|data| json!({ "provider": input.provider, "modelId": input.model_id, "protocol": protocol, "binding": data, "serviceId": config.service_id }))
}

#[tauri::command]
pub async fn tencentdb_core_request(
    input: TencentdbCoreRequest,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    core_route_scope(&input.route).map_err(public_error)?;
    let config = store
        .tencentdb_config()
        .await
        .normalized()
        .map_err(public_error)?;
    let body =
        normalize_core_request_body(&input.route, input.body, &config).map_err(public_error)?;
    let api_key = ensure_gateway_api_key(&config.mode).map_err(public_error)?;
    let user_key = resolve_user_api_key(&config, &api_key).map_err(public_error)?;
    let endpoint = if config.mode == MemoryMode::Local {
        start_local_runtime(&app, &runtime, &config, &api_key)
            .await
            .map_err(public_error)?
            .endpoint
    } else {
        config.endpoint.clone()
    };
    let client = core_http_client().map_err(public_error)?;
    if input.route == "/v3/chat-memory/clear" {
        verify_chat_memory_clear_ownership(
            &client,
            &endpoint,
            &api_key,
            &user_key,
            &config.service_id,
            &body,
            &config,
        )
        .await
        .map_err(public_error)?;
    }
    let response = client
        .post(format!("{}{}", endpoint.trim_end_matches('/'), input.route))
        .bearer_auth(api_key)
        .header("x-tdai-service-id", &config.service_id)
        .header("x-tdai-user-key", user_key)
        .json(&body)
        .send()
        .await
        .context("failed to reach TencentDB Core")
        .map_err(public_error)?;
    let status = response.status();
    let envelope = response
        .json::<serde_json::Value>()
        .await
        .context("TencentDB Core returned invalid JSON")
        .map_err(public_error)?;
    parse_core_envelope(status, envelope).map_err(public_error)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbProvisionWorkspace {
    pub workspace: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbSyncAsset {
    pub asset_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbSearchKnowledgeAsset {
    pub asset_id: String,
    pub query: String,
    pub limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbExploreCodeGraph {
    pub asset_id: String,
    pub query: String,
    pub max_files: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbCodeGraphSymbolLimit {
    pub asset_id: String,
    pub symbol: String,
    pub limit: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbCodeGraphImpact {
    pub asset_id: String,
    pub symbol: String,
    pub depth: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbCodeGraphNode {
    pub asset_id: String,
    pub symbol: String,
    pub include_code: Option<bool>,
    pub file: Option<String>,
    pub line: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbCodeGraphFiles {
    pub asset_id: String,
    pub path: Option<String>,
    pub pattern: Option<String>,
    pub format: Option<String>,
    pub include_metadata: Option<bool>,
    pub max_depth: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbReadWikiPages {
    pub asset_id: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbDeleteKnowledgeAsset {
    pub asset_id: String,
    pub workspace: Option<String>,
}

#[derive(Debug)]
struct TencentdbWikiFile {
    filename: String,
    content: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TencentdbImportWikiFiles {
    pub wiki_id: String,
}

fn validate_wiki_file(file: &TencentdbWikiFile) -> Result<serde_json::Value> {
    use std::path::Component;
    let path = Path::new(&file.filename);
    if file.filename.trim().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        bail!("Wiki file path must be relative and must not escape the asset root");
    }
    if file.content.len() > 512 * 1024 {
        bail!("Wiki file exceeds the 512 KiB limit");
    }
    Ok(json!({ "filename": file.filename, "content": file.content }))
}

const MAX_WIKI_IMPORT_FILES: usize = 50;
const MAX_WIKI_IMPORT_FILE_BYTES: usize = 512 * 1024;
const MAX_WIKI_IMPORT_TOTAL_BYTES: usize = 5 * 1024 * 1024;
const WIKI_IMPORT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "rst", "adoc", "json", "yaml", "yml",
];

fn path_has_network_prefix(path: &Path) -> bool {
    let value = path.to_string_lossy();
    value.starts_with(r"\\?\UNC\")
        || (value.starts_with(r"\\") && !value.starts_with(r"\\?\"))
        || value.starts_with("//")
}

#[cfg(windows)]
fn path_is_on_remote_drive(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDriveTypeW;
    use windows::Win32::System::WindowsProgramming::DRIVE_REMOTE;

    let drive = match path.components().next() {
        Some(Component::Prefix(prefix)) => match prefix.kind() {
            Prefix::Disk(value) | Prefix::VerbatimDisk(value) => value,
            Prefix::UNC(_, _) | Prefix::VerbatimUNC(_, _) => return true,
            _ => return false,
        },
        _ => return false,
    };
    let root = format!("{}:\\", drive as char);
    let wide = root
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) == DRIVE_REMOTE }
}

fn is_network_path(path: &Path) -> bool {
    if path_has_network_prefix(path) {
        return true;
    }
    #[cfg(windows)]
    {
        return path_is_on_remote_drive(path);
    }
    #[cfg(not(windows))]
    false
}

fn load_selected_wiki_files(paths: &[PathBuf]) -> Result<Vec<TencentdbWikiFile>> {
    if paths.is_empty() {
        bail!("select at least one Wiki document");
    }
    if paths.len() > MAX_WIKI_IMPORT_FILES {
        bail!("Wiki import accepts at most {MAX_WIKI_IMPORT_FILES} files");
    }
    let mut total = 0usize;
    let mut files = Vec::with_capacity(paths.len());
    for selected in paths {
        if is_network_path(selected) {
            bail!("Wiki import does not allow a network path");
        }
        if !selected.is_absolute() {
            bail!("Wiki import requires an absolute picker-selected path");
        }
        let path =
            normalize_canonical_local_path(std::fs::canonicalize(selected).with_context(|| {
                format!(
                    "failed to canonicalize Wiki document {}",
                    selected.display()
                )
            })?);
        if is_network_path(&path) {
            bail!("Wiki import does not allow a network path");
        }
        let metadata = std::fs::metadata(&path)
            .with_context(|| format!("failed to inspect Wiki document {}", path.display()))?;
        if !metadata.is_file() {
            bail!("Wiki import requires a regular file: {}", path.display());
        }
        let supported_extension = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|value| {
                WIKI_IMPORT_EXTENSIONS
                    .iter()
                    .any(|allowed| value.eq_ignore_ascii_case(allowed))
            });
        if !supported_extension {
            bail!(
                "Wiki import has an unsupported file extension: {}",
                path.display()
            );
        }
        if metadata.len() > MAX_WIKI_IMPORT_FILE_BYTES as u64 {
            bail!("Wiki document exceeds 512 KiB: {}", path.display());
        }
        let bytes = std::fs::read(&path)
            .with_context(|| format!("failed to read Wiki document {}", path.display()))?;
        if bytes.len() > MAX_WIKI_IMPORT_FILE_BYTES {
            bail!("Wiki document exceeds 512 KiB: {}", path.display());
        }
        total = total
            .checked_add(bytes.len())
            .context("Wiki import byte count overflow")?;
        if total > MAX_WIKI_IMPORT_TOTAL_BYTES {
            bail!("Wiki import exceeds the 5 MiB total limit");
        }
        let content = String::from_utf8(bytes)
            .with_context(|| format!("Wiki document must be UTF-8 text: {}", path.display()))?;
        let filename = path
            .file_name()
            .and_then(|value| value.to_str())
            .with_context(|| format!("Wiki document filename is invalid: {}", path.display()))?
            .to_string();
        files.push(TencentdbWikiFile { filename, content });
    }
    Ok(files)
}

#[tauri::command]
pub async fn tencentdb_list_knowledge_assets(
    workspace: Option<String>,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<TencentdbKnowledgeAssets, String> {
    let (config, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    let code_graphs = client
        .list_code_graphs(&config.team_id)
        .await
        .map(list_items)
        .map_err(public_error)?;
    let wikis = client
        .list_wikis(&config.team_id)
        .await
        .map(list_items)
        .map_err(public_error)?;
    let workspace = match workspace {
        Some(path) => {
            let resolved = crate::commands::sessions::resolve_workspace_dir(&path)?;
            let key = workspace_storage_key(&resolved);
            store
                .knowledge_assets_for(&key)
                .await
                .map(WorkspaceKnowledgeAssetsDto::from)
        }
        None => None,
    };
    Ok(TencentdbKnowledgeAssets {
        code_graphs,
        wikis,
        workspace,
    })
}

#[tauri::command]
pub async fn tencentdb_get_wiki(
    input: TencentdbSyncAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client.get_wiki(&input.asset_id).await.map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_get_code_graph(
    input: TencentdbSyncAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .get_code_graph(&input.asset_id)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_search_wiki(
    input: TencentdbSearchKnowledgeAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (query, limit) =
        normalize_knowledge_search(&input.query, input.limit, 100).map_err(public_error)?;
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .search_wiki(&input.asset_id, &query, limit)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_list_wiki_pages(
    input: TencentdbSyncAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .list_wiki_pages(&input.asset_id)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_read_wiki_pages(
    input: TencentdbReadWikiPages,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    if input.refs.is_empty()
        || input.refs.len() > 20
        || input.refs.iter().any(|value| value.trim().is_empty())
    {
        return Err("Wiki 页面引用必须为 1 到 20 个非空值".to_string());
    }
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .read_wiki_pages(&input.asset_id, &input.refs)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_search_code_graph(
    input: TencentdbSearchKnowledgeAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (query, limit) =
        normalize_knowledge_search(&input.query, input.limit, 100).map_err(public_error)?;
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .search_code_graph(&input.asset_id, &query, limit)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_explore_code_graph(
    input: TencentdbExploreCodeGraph,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let query = normalize_knowledge_text(&input.query, "query").map_err(public_error)?;
    let max_files =
        normalize_knowledge_count(input.max_files, 12, 200, "maxFiles").map_err(public_error)?;
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .explore_code_graph(&input.asset_id, &query, max_files)
        .await
        .map_err(public_error)
}

async fn query_code_graph_relations(
    input: TencentdbCodeGraphSymbolLimit,
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    callers: bool,
) -> Result<serde_json::Value, String> {
    let symbol = normalize_knowledge_text(&input.symbol, "symbol").map_err(public_error)?;
    let limit = normalize_knowledge_count(input.limit, 20, 200, "limit").map_err(public_error)?;
    let (_, client) = configured_knowledge_client(app, store, runtime)
        .await
        .map_err(public_error)?;
    if callers {
        client
            .code_graph_callers(&input.asset_id, &symbol, limit)
            .await
    } else {
        client
            .code_graph_callees(&input.asset_id, &symbol, limit)
            .await
    }
    .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_get_code_graph_callers(
    input: TencentdbCodeGraphSymbolLimit,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    query_code_graph_relations(input, &app, &store, &runtime, true).await
}

#[tauri::command]
pub async fn tencentdb_get_code_graph_callees(
    input: TencentdbCodeGraphSymbolLimit,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    query_code_graph_relations(input, &app, &store, &runtime, false).await
}

#[tauri::command]
pub async fn tencentdb_analyze_code_graph_impact(
    input: TencentdbCodeGraphImpact,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let symbol = normalize_knowledge_text(&input.symbol, "symbol").map_err(public_error)?;
    let depth = normalize_knowledge_count(input.depth, 2, 10, "depth").map_err(public_error)?;
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .analyze_code_graph_impact(&input.asset_id, &symbol, depth)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_get_code_graph_node(
    input: TencentdbCodeGraphNode,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let symbol = normalize_knowledge_text(&input.symbol, "symbol").map_err(public_error)?;
    let file =
        normalize_optional_knowledge_text(input.file.as_deref(), "file").map_err(public_error)?;
    let line = normalize_optional_knowledge_count(input.line, "line").map_err(public_error)?;
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .get_code_graph_node(
            &input.asset_id,
            &symbol,
            input.include_code.unwrap_or(false),
            file.as_deref(),
            line,
        )
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_get_code_graph_status(
    input: TencentdbSyncAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .get_code_graph_status(&input.asset_id)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_list_code_graph_files(
    input: TencentdbCodeGraphFiles,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let path =
        normalize_optional_knowledge_text(input.path.as_deref(), "path").map_err(public_error)?;
    let pattern = normalize_optional_knowledge_text(input.pattern.as_deref(), "pattern")
        .map_err(public_error)?;
    let format =
        normalize_code_graph_files_format(input.format.as_deref()).map_err(public_error)?;
    let max_depth =
        normalize_optional_knowledge_count(input.max_depth, "maxDepth").map_err(public_error)?;
    let (_, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .list_code_graph_files(
            &input.asset_id,
            path.as_deref(),
            pattern.as_deref(),
            format,
            input.include_metadata.unwrap_or(true),
            max_depth,
        )
        .await
        .map_err(public_error)
}

async fn delete_knowledge_asset(
    input: TencentdbDeleteKnowledgeAsset,
    app: &tauri::AppHandle,
    store: &AppStateStore,
    runtime: &MemoryRuntime,
    code_graph: bool,
) -> Result<serde_json::Value, String> {
    let workspace_key = match input.workspace.as_deref() {
        Some(workspace) => Some(workspace_storage_key(
            &crate::commands::sessions::resolve_workspace_dir(workspace)?,
        )),
        None => None,
    };
    let (_, client) = configured_knowledge_client(app, store, runtime)
        .await
        .map_err(public_error)?;
    let ids = [input.asset_id.clone()];
    let data = if code_graph {
        client.delete_code_graphs(&ids).await
    } else {
        client.delete_wikis(&ids).await
    }
    .and_then(|data| ensure_knowledge_asset_deleted(data, &input.asset_id))
    .map_err(public_error)?;

    if let Some(key) = workspace_key {
        if let Some(mut assets) = store.knowledge_assets_for(&key).await {
            if clear_workspace_asset_reference(&mut assets, &input.asset_id, code_graph) {
                store.replace_knowledge_assets(key, assets).await;
            }
        }
    }
    Ok(data)
}

#[tauri::command]
pub async fn tencentdb_delete_wiki(
    input: TencentdbDeleteKnowledgeAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    delete_knowledge_asset(input, &app, &store, &runtime, false).await
}

#[tauri::command]
pub async fn tencentdb_delete_code_graph(
    input: TencentdbDeleteKnowledgeAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    delete_knowledge_asset(input, &app, &store, &runtime, true).await
}

#[tauri::command]
pub async fn tencentdb_provision_workspace_assets(
    input: TencentdbProvisionWorkspace,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<WorkspaceKnowledgeAssetsDto, String> {
    let workspace = crate::commands::sessions::resolve_workspace_dir(&input.workspace)?;
    provision_workspace_assets(&app, &store, &runtime, &workspace)
        .await
        .map(WorkspaceKnowledgeAssetsDto::from)
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_sync_code_graph(
    input: TencentdbSyncAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (config, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .sync_code_graph(&input.asset_id, &config.user_id)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_sync_wiki(
    input: TencentdbSyncAsset,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<serde_json::Value, String> {
    let (config, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    client
        .sync_wiki(&input.asset_id, &config.user_id)
        .await
        .map_err(public_error)
}

#[tauri::command]
pub async fn tencentdb_import_wiki_files(
    input: TencentdbImportWikiFiles,
    app: tauri::AppHandle,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
) -> Result<Option<serde_json::Value>, String> {
    let picker_app = app.clone();
    let selected = tokio::task::spawn_blocking(move || {
        picker_app
            .dialog()
            .file()
            .add_filter("文本知识", WIKI_IMPORT_EXTENSIONS)
            .blocking_pick_files()
    })
    .await
    .map_err(|error| format!("Wiki 文件选择器失败: {error}"))?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let paths = selected
        .into_iter()
        .map(|path| {
            path.into_path()
                .map_err(|error| format!("Wiki 文件选择结果无效: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if paths.is_empty() {
        return Ok(None);
    }
    let files = load_selected_wiki_files(&paths).map_err(public_error)?;

    let (config, client) = configured_knowledge_client(&app, &store, &runtime)
        .await
        .map_err(public_error)?;
    let mut uploaded = 0usize;
    let mut batch = Vec::new();
    let mut batch_bytes = 0usize;
    for file in &files {
        let size = file.content.len();
        if !batch.is_empty() && (batch.len() == 10 || batch_bytes + size > 5 * 1024 * 1024) {
            client
                .write_wiki_files(&config.team_id, &input.wiki_id, &batch, &config.user_id)
                .await
                .map_err(public_error)?;
            uploaded += batch.len();
            batch.clear();
            batch_bytes = 0;
        }
        batch.push(validate_wiki_file(file).map_err(public_error)?);
        batch_bytes += size;
    }
    if !batch.is_empty() {
        client
            .write_wiki_files(&config.team_id, &input.wiki_id, &batch, &config.user_id)
            .await
            .map_err(public_error)?;
        uploaded += batch.len();
    }
    let sync = client
        .sync_wiki(&input.wiki_id, &config.user_id)
        .await
        .map_err(public_error)?;
    Ok(Some(json!({ "uploaded": uploaded, "sync": sync })))
}

#[tauri::command]
pub async fn tencentdb_save_connection(
    app: tauri::AppHandle,
    input: SaveTencentdbConnection,
    store: State<'_, AppStateStore>,
    runtime: State<'_, Arc<MemoryRuntime>>,
    panel: State<'_, Arc<PanelRuntime>>,
    mgr: State<'_, Arc<crate::pi::PiManager>>,
) -> Result<TencentdbStatus, String> {
    let previous = store.tencentdb_config().await;
    let mut config = input.config.normalized().map_err(public_error)?;
    config.last_success_at = None;

    if config.mode == MemoryMode::Remote {
        let stored_gateway_key = if input.gateway_api_key.is_none() && !input.clear_gateway_api_key {
            MemoryCredentialStore::gateway_api_key(&config.mode).map_err(public_error)?
        } else {
            None
        };
        let gateway_key = required_credential(
            if input.clear_gateway_api_key {
                None
            } else {
                input
                    .gateway_api_key
                    .as_deref()
                    .or(stored_gateway_key.as_deref())
            },
            "Gateway API key",
        )
        .map_err(public_error)?;

        let stored_user_key = if input.user_api_key.is_none() && !input.clear_user_api_key {
            MemoryCredentialStore::user_api_key().map_err(public_error)?
        } else {
            None
        };
        let user_key = required_credential(
            if input.clear_user_api_key {
                None
            } else {
                input.user_api_key.as_deref().or(stored_user_key.as_deref())
            },
            "User Key",
        )
        .map_err(public_error)?;

        probe_gateway_with_timeout(
            &config.endpoint,
            &gateway_key,
            &user_key,
            &config,
            std::time::Duration::from_secs(10),
        )
        .await
        .map_err(public_error)?;
        if let Some(knowledge_endpoint) = config.knowledge_endpoint.as_deref() {
            KnowledgeClient::new(
                knowledge_endpoint,
                &gateway_key,
                &config.service_id,
                &user_key,
            )
            .map_err(public_error)?
            .get_health()
            .await
            .map_err(public_error)?;
        }
    }

    if input.clear_gateway_api_key {
        MemoryCredentialStore::clear_gateway_api_key(&config.mode).map_err(public_error)?;
    } else if let Some(value) = input.gateway_api_key.as_deref() {
        MemoryCredentialStore::set_gateway_api_key(&config.mode, value).map_err(public_error)?;
    }
    if input.clear_user_api_key {
        MemoryCredentialStore::clear_user_api_key().map_err(public_error)?;
    } else if let Some(value) = input.user_api_key.as_deref() {
        MemoryCredentialStore::set_user_api_key(value).map_err(public_error)?;
    }
    if config.mode == MemoryMode::Local {
        ensure_gateway_api_key(&config.mode).map_err(public_error)?;
    }

    let credential_changed = input.gateway_api_key.is_some()
        || input.clear_gateway_api_key
        || input.user_api_key.is_some()
        || input.clear_user_api_key;
    let changed = connection_settings_changed(previous, config.clone(), credential_changed);
    let restart_required = changed && !mgr.all().await.is_empty();
    if changed {
        panel.stop().await.map_err(public_error)?;
    }
    if changed && !restart_required {
        runtime.stop().await.map_err(public_error)?;
        runtime.clear_restart_required();
    }
    store.replace_tencentdb_config(config).await;
    if restart_required {
        runtime.mark_restart_required();
        let mut status = current_status(&store, &runtime)
            .await
            .map_err(public_error)?;
        status.state = "restart_required".to_string();
        status.restart_required = true;
        return Ok(status);
    }
    ensure_panel_runtime_started(&app, &store, &runtime, &panel)
        .await
        .map_err(public_error)?;
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
    let user_key = resolve_user_api_key(&config, &api_key).map_err(public_error)?;
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
    if let Some(knowledge_endpoint) = config.knowledge_endpoint.as_deref() {
        KnowledgeClient::new(knowledge_endpoint, &api_key, &config.service_id, &user_key)
            .map_err(public_error)?
            .get_health()
            .await
            .map_err(public_error)?;
    }
    config.last_success_at = Some(chrono::Utc::now().to_rfc3339());
    store.replace_tencentdb_config(config).await;
    current_status(&store, &runtime).await.map_err(public_error)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{BufRead, BufReader, ErrorKind, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::{
        bump_skill_reload_revision, clear_workspace_asset_reference, connection_settings_changed,
        core_redirect_policy, core_route_scope, ensure_knowledge_asset_deleted,
        ensure_local_metadata_identity, ensure_panel_dependencies_ready,
        ensure_panel_restart_not_required, legacy_cutover_env,
        load_selected_wiki_files,
        local_user_api_key, managed_skill_root_at, managed_skill_scope,
        normalize_code_graph_files_format, normalize_core_request_body, normalize_knowledge_count,
        normalize_knowledge_search, normalize_knowledge_text, normalize_optional_knowledge_count,
        normalize_optional_knowledge_text, normalize_remote_repo_url, normalize_repo_identity,
        parse_core_envelope, register_local_source_at, route_runtime_start,
        required_credential,
        validate_chat_memory_asset_owner, validate_chat_memory_delete_permission,
        validate_remote_identity,
        workspace_code_graph_matches, workspace_source, workspace_storage_key,
        workspace_wiki_matches, workspace_wiki_name,
        TencentdbCoreRequest, TencentdbDeleteKnowledgeAsset, TencentdbImportWikiFiles,
        TencentdbProvisionWorkspace, TencentdbReadWikiPages, TencentdbSearchKnowledgeAsset,
        TencentdbStatus, TencentdbSyncAsset,
    };
    use crate::tencentdb::knowledge::WorkspaceKnowledgeAssets;
    use crate::tencentdb::{MemoryConnectionConfig, MemoryMode, MemoryRuntime};
    use reqwest::StatusCode;
    use serde_json::json;

    #[test]
    fn panel_start_is_rejected_while_runtime_restart_is_required() {
        let runtime = MemoryRuntime::new();
        assert!(ensure_panel_restart_not_required(&runtime).is_ok());

        runtime.mark_restart_required();
        let error = ensure_panel_restart_not_required(&runtime).unwrap_err();

        assert!(error.to_string().contains("restart"));
    }

    #[test]
    fn panel_start_is_rejected_when_dependencies_are_not_ready() {
        assert!(ensure_panel_dependencies_ready("ready").is_ok());

        let error = ensure_panel_dependencies_ready("failed").unwrap_err();

        assert!(error.to_string().contains("failed"));
    }

    #[tokio::test]
    async fn local_identity_init_tolerates_a_concurrent_winner() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let config = MemoryConnectionConfig::default().normalized().unwrap();
        let responses = vec![
            (
                "/v3/meta/auth/verify",
                "200 OK",
                json!({ "code": 0, "message": "ok", "data": { "valid": false } }).to_string(),
            ),
            (
                "/v3/internal/meta/user/init-admin",
                "409 Conflict",
                json!({ "code": 409, "message": "already initialized", "data": {} }).to_string(),
            ),
            (
                "/v3/meta/auth/verify",
                "200 OK",
                json!({
                    "code": 0,
                    "message": "ok",
                    "data": { "valid": true, "user": { "user_id": config.user_id } },
                })
                .to_string(),
            ),
            (
                "/v3/meta/team/get",
                "200 OK",
                json!({
                    "code": 0,
                    "message": "ok",
                    "data": { "owner_user_id": config.user_id },
                })
                .to_string(),
            ),
            (
                "/v3/meta/agent/get",
                "200 OK",
                json!({
                    "code": 0,
                    "message": "ok",
                    "data": {
                        "team_id": config.team_id,
                        "owner_user_id": config.user_id,
                    },
                })
                .to_string(),
            ),
        ];
        let stop = Arc::new(AtomicBool::new(false));
        let server_stop = stop.clone();
        let server = std::thread::spawn(move || {
            let mut handled = 0;
            while handled < responses.len() {
                let (mut stream, _) = match listener.accept() {
                    Ok(value) => value,
                    Err(error) if error.kind() == ErrorKind::WouldBlock => {
                        if server_stop.load(Ordering::Acquire) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(error) => panic!("test server accept failed: {error}"),
                };
                // The listener is non-blocking so the test can poll for startup;
                // each accepted connection should be read to completion normally.
                stream.set_nonblocking(false).unwrap();
                let mut reader = BufReader::new(&mut stream);
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                drop(reader);

                let (route, status, body) = &responses[handled];
                assert!(
                    request_line.contains(route),
                    "unexpected request: {request_line}"
                );
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len(),
                )
                .unwrap();
                stream.flush().unwrap();
                handled += 1;
            }
            handled
        });

        let result =
            ensure_local_metadata_identity(&endpoint, "gateway-key", "local-user-key", &config)
                .await;
        stop.store(true, Ordering::Release);
        let handled = server.join().unwrap();

        assert!(result.is_ok(), "identity initialization failed: {result:?}");
        assert_eq!(handled, 5);
    }

    #[tokio::test]
    async fn production_runtime_policy_starts_only_local_mode() {
        let calls = std::cell::Cell::new(0);

        route_runtime_start(&MemoryMode::Remote, || async {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(calls.get(), 0);

        route_runtime_start(&MemoryMode::Local, || async {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(calls.get(), 1);
    }

    #[test]
    fn cutover_fallback_env_keeps_legacy_switches_disabled() {
        let env = legacy_cutover_env(true);
        assert_eq!(
            env.get("TDAI_LEGACY_CUTOVER").map(String::as_str),
            Some("1")
        );
        assert_eq!(env.get("MEMORY_AUTO_INJECT").map(String::as_str), Some("0"));
        assert_eq!(
            env.get("MEMORY_AUTO_CAPTURE").map(String::as_str),
            Some("0")
        );
        assert_eq!(env.get("MEMORY_EXTRACT").map(String::as_str), Some("0"));
        assert_eq!(env.get("KB_AUTO_INJECT").map(String::as_str), Some("0"));
        assert_eq!(env.get("CODE_INTEL").map(String::as_str), Some("off"));
        assert_eq!(
            env.get("CODE_SEARCH_ENABLED").map(String::as_str),
            Some("0")
        );
        assert!(legacy_cutover_env(false).is_empty());
    }

    #[test]
    fn status_dto_never_serializes_credentials() {
        let value = serde_json::to_value(TencentdbStatus {
            mode: MemoryMode::Remote,
            endpoint: "https://memory.example.com".to_string(),
            knowledge_endpoint: Some("https://knowledge.example.com".to_string()),
            state: "ready".to_string(),
            credential_configured: true,
            user_credential_configured: true,
            last_success_at: None,
            restart_required: false,
        })
        .unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(
            object.get("credentialConfigured").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            object
                .get("userCredentialConfigured")
                .and_then(|v| v.as_bool()),
            Some(true)
        );
        assert!(!object
            .keys()
            .any(|key| key.to_ascii_lowercase().contains("key")));
    }

    #[test]
    fn local_user_key_is_stable_and_uses_the_tencentdb_format() {
        let key = local_user_api_key("gateway-secret");
        assert_eq!(key, local_user_api_key("gateway-secret"));
        assert_ne!(key, local_user_api_key("other-secret"));
        assert!(key.starts_with("sk-mem-"));
        assert_eq!(key.len(), 39);
    }

    #[test]
    fn managed_skill_cache_is_isolated_by_the_full_connection_scope() {
        let local = MemoryConnectionConfig::default().normalized().unwrap();
        let remote_a = MemoryConnectionConfig {
            mode: MemoryMode::Remote,
            endpoint: "https://memory-a.example.com".to_string(),
            knowledge_endpoint: Some("https://knowledge.example.com".to_string()),
            service_id: "service-a".to_string(),
            team_id: "team-a".to_string(),
            agent_id: "coding".to_string(),
            user_id: "alice".to_string(),
            ..MemoryConnectionConfig::default()
        }
        .normalized()
        .unwrap();
        let remote_b = MemoryConnectionConfig {
            endpoint: "https://memory-b.example.com".to_string(),
            team_id: "team-b".to_string(),
            ..remote_a.clone()
        }
        .normalized()
        .unwrap();

        let local_scope = managed_skill_scope(&local);
        let remote_a_scope = managed_skill_scope(&remote_a);
        let remote_b_scope = managed_skill_scope(&remote_b);

        assert_ne!(local_scope, remote_a_scope);
        assert_ne!(remote_a_scope, remote_b_scope);
        assert_eq!(remote_a_scope, managed_skill_scope(&remote_a));
        assert_eq!(remote_a_scope.len(), 64);
        assert_eq!(
            managed_skill_root_at(std::path::Path::new("C:/app-data"), &remote_a),
            std::path::Path::new("C:/app-data")
                .join("tencentdb-memory")
                .join("skills")
                .join(remote_a_scope)
        );
    }

    #[test]
    fn last_success_timestamp_does_not_require_a_runtime_restart() {
        let previous = MemoryConnectionConfig {
            last_success_at: Some("2026-08-17T12:00:00Z".to_string()),
            ..MemoryConnectionConfig::default()
        };
        let next = MemoryConnectionConfig::default();

        assert!(!connection_settings_changed(previous, next, false));
    }

    #[test]
    fn remote_code_graph_source_requires_https() {
        assert_eq!(
            normalize_remote_repo_url("https://github.com/example/repo.git").unwrap(),
            "https://github.com/example/repo.git"
        );
        for source in [
            "http://github.com/example/repo.git",
            "git@github.com:example/repo.git",
            "ssh://git@github.com/example/repo.git",
            "file:///tmp/repo",
        ] {
            assert!(normalize_remote_repo_url(source).is_err(), "{source}");
        }
    }

    #[test]
    fn local_source_registration_is_canonical_and_idempotent() {
        let root =
            std::env::temp_dir().join(format!("grenagent-local-source-{}", uuid::Uuid::new_v4()));
        let workspace = root.join("workspace");
        let allowlist = root.join("allowlist.jsonl");
        fs::create_dir_all(&workspace).unwrap();

        let canonical = register_local_source_at(&allowlist, &workspace).unwrap();
        register_local_source_at(&allowlist, &workspace).unwrap();

        if cfg!(windows) {
            assert!(!canonical.to_string_lossy().starts_with(r"\\?\"));
        }

        let entries: Vec<String> = fs::read_to_string(&allowlist)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries, vec![canonical.to_string_lossy().into_owned()]);
        fs::remove_dir_all(root).ok();
    }

    #[cfg(windows)]
    #[test]
    fn workspace_storage_keys_remove_windows_verbatim_prefixes() {
        assert_eq!(
            workspace_storage_key(std::path::Path::new(r"\\?\C:\work\project")),
            r"C:\work\project"
        );
        assert_eq!(
            workspace_storage_key(std::path::Path::new(r"\\?\UNC\server\share\project")),
            r"\\server\share\project"
        );
    }

    #[test]
    fn local_workspace_wiki_names_ignore_origin_and_distinguish_absolute_paths() {
        let root = std::env::temp_dir().join("grenagent-wiki-name-tests");
        let client = root.join("clients").join("app");
        let personal = root.join("personal").join("app");
        let origin = "https://example.com/shared/app.git";

        let client_name = workspace_wiki_name(&client, &MemoryMode::Local, Some(origin)).unwrap();

        assert_eq!(
            client_name,
            workspace_wiki_name(&client, &MemoryMode::Local, None).unwrap()
        );
        assert_ne!(
            client_name,
            workspace_wiki_name(&personal, &MemoryMode::Local, Some(origin)).unwrap()
        );
        assert!(client_name.starts_with("Pi · app · "));
    }

    #[test]
    fn remote_workspace_wiki_names_follow_normalized_origin_across_clone_paths() {
        let first_origin =
            normalize_remote_repo_url("https://GitHub.com/example/shared.git/").unwrap();
        let second_origin = normalize_remote_repo_url("https://github.com/example/shared").unwrap();
        let first = workspace_wiki_name(
            std::path::Path::new("/clients/app"),
            &MemoryMode::Remote,
            Some(&first_origin),
        )
        .unwrap();
        let second = workspace_wiki_name(
            std::path::Path::new("/different/device/renamed-clone"),
            &MemoryMode::Remote,
            Some(&second_origin),
        )
        .unwrap();

        assert_eq!(first, second);
        assert!(first.starts_with("Pi · shared · "));
        assert_eq!(
            normalize_repo_identity(&first_origin).unwrap(),
            normalize_repo_identity(&second_origin).unwrap()
        );
        assert_eq!(first_origin, "https://GitHub.com/example/shared.git/");
    }

    #[test]
    fn remote_workspace_wiki_names_distinguish_different_origins_with_same_basename() {
        let first_origin = normalize_remote_repo_url("https://example.com/one/app.git").unwrap();
        let second_origin = normalize_remote_repo_url("https://example.com/two/app.git").unwrap();

        assert_ne!(
            workspace_wiki_name(
                std::path::Path::new("/clients/app"),
                &MemoryMode::Remote,
                Some(&first_origin)
            )
            .unwrap(),
            workspace_wiki_name(
                std::path::Path::new("/personal/app"),
                &MemoryMode::Remote,
                Some(&second_origin)
            )
            .unwrap()
        );
    }

    #[test]
    fn remote_root_origin_wiki_names_use_the_host_across_clone_paths() {
        let first = workspace_wiki_name(
            std::path::Path::new("/clients/first-clone"),
            &MemoryMode::Remote,
            Some("https://example.com/"),
        )
        .unwrap();
        let second = workspace_wiki_name(
            std::path::Path::new("/different/device/second-clone"),
            &MemoryMode::Remote,
            Some("https://example.com"),
        )
        .unwrap();

        assert_eq!(first, second);
        assert!(first.starts_with("Pi · example.com · "));
    }

    #[test]
    fn remote_workspace_wiki_names_reject_missing_or_invalid_origins() {
        let workspace = std::path::Path::new("/workspace/app");

        assert!(workspace_wiki_name(workspace, &MemoryMode::Remote, None).is_err());
        for origin in [
            "http://example.com/app.git",
            "git@example.com:team/app.git",
            "file:///workspace/app",
        ] {
            assert!(
                workspace_wiki_name(workspace, &MemoryMode::Remote, Some(origin)).is_err(),
                "{origin}"
            );
        }
    }

    #[test]
    fn remote_workspace_source_requires_an_origin() {
        let root =
            std::env::temp_dir().join(format!("grenagent-no-origin-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();

        let result = workspace_source(&root, &MemoryMode::Remote);

        fs::remove_dir_all(root).ok();
        assert!(result.is_err());
    }

    #[test]
    fn workspace_wiki_names_are_nonempty_bounded_and_safe() {
        let long_name = format!("{}\ninvalid", "项目".repeat(100));
        let name = workspace_wiki_name(
            &std::path::Path::new("/workspace").join(long_name),
            &MemoryMode::Local,
            None,
        )
        .unwrap();
        let digest = name.rsplit(" · ").next().unwrap();

        assert!(!name.is_empty());
        assert!(name.len() <= 128, "name was {} bytes: {name}", name.len());
        assert!(!name.chars().any(char::is_control));
        assert_eq!(digest.len(), 32);
        assert!(digest.chars().all(|value| value.is_ascii_hexdigit()));
    }

    #[test]
    fn wiki_import_request_rejects_webview_supplied_paths() {
        assert!(serde_json::from_value::<TencentdbImportWikiFiles>(json!({
            "wikiId": "wiki-1",
            "paths": ["C:/private/notes.md"]
        }))
        .is_err());
    }

    #[test]
    fn tauri_command_surface_excludes_direct_wiki_file_writes() {
        let lib_rs = include_str!("../lib.rs");

        assert!(!lib_rs.contains("commands::tencentdb::tencentdb_write_wiki_files"));
    }

    #[test]
    fn wiki_import_accepts_a_picker_selected_local_text_file() {
        let root = wiki_import_test_root("selected");
        let path = root.join("notes.MD");
        fs::write(&path, "# 本地文档").unwrap();

        let files = load_selected_wiki_files(&[path]).unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].filename, "notes.MD");
        assert_eq!(files[0].content, "# 本地文档");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn wiki_import_rejects_unsupported_or_missing_extensions() {
        let root = wiki_import_test_root("extensions");
        let hidden = root.join(".env");
        let extensionless = root.join("README");
        fs::write(&hidden, "SECRET=value").unwrap();
        fs::write(&extensionless, "notes").unwrap();

        for path in [hidden, extensionless] {
            let error = load_selected_wiki_files(&[path]).unwrap_err().to_string();
            assert!(error.contains("unsupported file extension"), "{error}");
        }
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn wiki_import_rejects_network_paths_and_non_files() {
        let network_error =
            load_selected_wiki_files(&[std::path::PathBuf::from(r"\\server\share\notes.md")])
                .unwrap_err()
                .to_string();
        assert!(network_error.contains("network path"), "{network_error}");

        let root = wiki_import_test_root("directory");
        let error = load_selected_wiki_files(&[root.clone()])
            .unwrap_err()
            .to_string();
        assert!(error.contains("regular file"), "{error}");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn wiki_import_rejects_excessive_file_count_and_total_bytes() {
        let root = wiki_import_test_root("limits");
        let path = root.join("large.md");
        fs::write(&path, vec![b'x'; 512 * 1024]).unwrap();

        let count_error = load_selected_wiki_files(&vec![path.clone(); 51])
            .unwrap_err()
            .to_string();
        assert!(count_error.contains("at most 50"), "{count_error}");

        let total_error = load_selected_wiki_files(&vec![path; 11])
            .unwrap_err()
            .to_string();
        assert!(total_error.contains("5 MiB"), "{total_error}");
        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn wiki_import_preserves_per_file_size_and_utf8_checks() {
        let root = wiki_import_test_root("content-validation");
        let oversized = root.join("oversized.md");
        let binary = root.join("binary.txt");
        fs::write(&oversized, vec![b'x'; 512 * 1024 + 1]).unwrap();
        fs::write(&binary, [0xff, 0xfe]).unwrap();

        let size_error = load_selected_wiki_files(&[oversized])
            .unwrap_err()
            .to_string();
        assert!(size_error.contains("512 KiB"), "{size_error}");
        let utf8_error = load_selected_wiki_files(&[binary]).unwrap_err().to_string();
        assert!(utf8_error.contains("UTF-8"), "{utf8_error}");
        fs::remove_dir_all(root).ok();
    }

    fn wiki_import_test_root(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "grenagent-wiki-import-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn core_route_allowlist_is_exact() {
        for route in [
            "/v3/conversation/query",
            "/v3/conversation/search",
            "/v3/conversation/delete",
            "/v3/conversation/count",
            "/v3/atomic/query",
            "/v3/atomic/search",
            "/v3/atomic/update",
            "/v3/atomic/delete",
            "/v3/atomic/count",
            "/v3/scenario/ls",
            "/v3/scenario/read",
            "/v3/scenario/write",
            "/v3/scenario/rm",
            "/v3/scenario/count",
            "/v3/core/read",
            "/v3/core/write",
            "/v3/core/count",
            "/v3/chat-memory/clear",
            "/v3/meta/asset/create",
            "/v3/skill/create",
            "/v3/skill/update",
            "/v3/skill/patch",
            "/v3/skill/delete",
            "/v3/skill/get",
            "/v3/skill/list",
            "/v3/skill/search",
            "/v3/skill/versions",
            "/v3/skill/files/write",
            "/v3/skill/files/remove",
            "/v3/skill/files/read",
            "/v3/skill/listing",
            "/v3/meta/asset/list-accessible",
            "/v3/meta/agent-fixed-asset/set",
            "/v3/meta/agent-fixed-asset/list",
            "/v3/meta/agent-fixed-asset/list-with-detail",
        ] {
            assert!(
                core_route_scope(route).is_ok(),
                "expected allowed route: {route}"
            );
        }

        for route in [
            "/v3/core/read/",
            "/v3/core/reader",
            "/v3/core/read?team_id=other",
            "/v3/core/read#fragment",
            "https://attacker.example/v3/core/read",
            "//v3/core/read",
            "/v3/knowledge/list",
            "/v3/meta/asset/list",
            "/v3/meta/asset/listing",
            "/v3/meta/agent-fixed-asset/set/extra",
        ] {
            assert!(
                core_route_scope(route).is_err(),
                "expected rejected route: {route}"
            );
        }
    }

    #[test]
    fn core_request_body_overwrites_configured_identity_and_task_scope() {
        let config = MemoryConnectionConfig {
            team_id: "configured-team".to_string(),
            agent_id: "configured-agent".to_string(),
            user_id: "configured-user".to_string(),
            task_id: Some("configured-task".to_string()),
            ..MemoryConnectionConfig::default()
        };
        let body = json!({
            "team_id": "attacker-team",
            "agent_id": "attacker-agent",
            "user_id": "attacker-user",
            "task_id": "attacker-task",
            "query": "kept"
        })
        .as_object()
        .unwrap()
        .clone();

        let body = normalize_core_request_body("/v3/conversation/query", body, &config).unwrap();

        assert_eq!(body.get("team_id"), Some(&json!("configured-team")));
        assert_eq!(body.get("agent_id"), Some(&json!("configured-agent")));
        assert_eq!(body.get("user_id"), Some(&json!("configured-user")));
        assert_eq!(body.get("task_id"), Some(&json!("configured-task")));
        assert_eq!(body.get("query"), Some(&json!("kept")));

        let without_task = MemoryConnectionConfig {
            task_id: None,
            ..config
        };
        let body = normalize_core_request_body("/v3/core/read", body, &without_task).unwrap();
        assert!(!body.contains_key("task_id"));
    }

    #[test]
    fn core_asset_create_body_is_bound_to_configured_identity() {
        let config = MemoryConnectionConfig {
            team_id: "configured-team".to_string(),
            user_id: "configured-user".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let body = normalize_core_request_body(
            "/v3/meta/asset/create",
            json!({
                "asset_id": "cg-1",
                "asset_type": "code_graph",
                "team_id": "attacker-team",
                "owner_user_id": "attacker-user",
                "source_type": "manual",
                "visibility": "private",
                "status": "draft"
            })
            .as_object()
            .unwrap()
            .clone(),
            &config,
        )
        .unwrap();
        assert_eq!(body.get("team_id"), Some(&json!("configured-team")));
        assert_eq!(body.get("owner_user_id"), Some(&json!("configured-user")));
        assert_eq!(body.get("source_type"), Some(&json!("knowledge")));
        assert_eq!(body.get("visibility"), Some(&json!("team")));
        assert_eq!(body.get("status"), Some(&json!("approved")));
    }

    #[test]
    fn remote_identity_validation_accepts_a_team_member_and_matching_agent() {
        let config = MemoryConnectionConfig {
            user_id: "member-user".to_string(),
            team_id: "shared-team".to_string(),
            agent_id: "shared-agent".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let auth = json!({ "valid": true, "user": { "user_id": "member-user" } });
        let team = json!({ "team_id": "shared-team", "owner_user_id": "owner-user" });
        let member = json!({
            "team_id": "shared-team",
            "user_id": "member-user",
            "status": "active"
        });
        let agent = json!({ "agent_id": "shared-agent", "team_id": "shared-team" });

        assert!(validate_remote_identity(&config, &auth, &team, &member, &agent).is_ok());
    }

    #[test]
    fn remote_identity_validation_rejects_a_user_key_for_another_user() {
        let config = MemoryConnectionConfig {
            user_id: "configured-user".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let auth = json!({ "valid": true, "user": { "user_id": "different-user" } });
        let team = json!({ "team_id": config.team_id });
        let member = json!({
            "team_id": config.team_id,
            "user_id": config.user_id,
            "status": "active"
        });
        let agent = json!({ "team_id": config.team_id });

        let error = validate_remote_identity(&config, &auth, &team, &member, &agent).unwrap_err();
        assert!(error.to_string().contains("belongs to user"), "{error}");
    }

    #[test]
    fn remote_identity_validation_rejects_a_team_without_the_user() {
        let config = MemoryConnectionConfig {
            user_id: "configured-user".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let auth = json!({ "valid": true, "user": { "user_id": "configured-user" } });
        let team = json!({ "team_id": config.team_id });
        let member = json!({
            "team_id": config.team_id,
            "user_id": "other-user",
            "status": "active"
        });
        let agent = json!({ "team_id": config.team_id });

        let error = validate_remote_identity(&config, &auth, &team, &member, &agent).unwrap_err();
        assert!(error.to_string().contains("not a member"), "{error}");
    }

    #[test]
    fn chat_memory_clear_requires_the_configured_owner_and_team() {
        let config = MemoryConnectionConfig {
            user_id: "configured-user".to_string(),
            team_id: "configured-team".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let asset = json!({
            "asset_type": "chat_memory",
            "owner_user_id": "other-user",
            "team_id": "configured-team"
        });

        let error = validate_chat_memory_asset_owner(&config, &asset).unwrap_err();
        assert!(error.to_string().contains("owner"), "{error}");
    }

    #[test]
    fn remote_save_rejects_missing_or_blank_candidate_credentials() {
        for value in [None, Some(""), Some("   ")] {
            let error = required_credential(value, "Gateway API key").unwrap_err();
            assert!(error.to_string().contains("Gateway API key"), "{error}");
        }
        assert_eq!(
            required_credential(Some("  candidate  "), "User Key").unwrap(),
            "candidate"
        );
    }

    #[test]
    fn chat_memory_clear_requires_a_positive_acl_delete_result() {
        assert!(validate_chat_memory_delete_permission(
            "memory-1",
            &json!({ "allowed": true, "reason": "acl" }),
        )
        .is_ok());
        let error = validate_chat_memory_delete_permission(
            "memory-1",
            &json!({ "allowed": false, "reason": "team member is read-only" }),
        )
        .unwrap_err();
        assert!(error.to_string().contains("read-only"), "{error}");
    }

    #[test]
    fn chat_memory_clear_does_not_receive_ambient_identity() {
        let config = MemoryConnectionConfig {
            team_id: "configured-team".to_string(),
            agent_id: "configured-agent".to_string(),
            user_id: "configured-user".to_string(),
            task_id: Some("configured-task".to_string()),
            ..MemoryConnectionConfig::default()
        };
        let body = json!({ "memory_ids": ["memory-1"] })
            .as_object()
            .unwrap()
            .clone();

        let body = normalize_core_request_body("/v3/chat-memory/clear", body, &config).unwrap();

        assert_eq!(
            body,
            json!({ "memory_ids": ["memory-1"] })
                .as_object()
                .unwrap()
                .clone()
        );
    }

    #[test]
    fn meta_routes_overwrite_their_configured_scope() {
        let config = MemoryConnectionConfig {
            team_id: "configured-team".to_string(),
            agent_id: "configured-agent".to_string(),
            user_id: "configured-user".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let body = json!({
            "team_id": "other-team",
            "user_id": "other-user",
            "user_key": "attacker-key",
            "agent_id": "other-agent",
            "action": "delete"
        })
        .as_object()
        .unwrap()
        .clone();
        let body =
            normalize_core_request_body("/v3/meta/asset/list-accessible", body, &config).unwrap();
        assert_eq!(body.get("team_id"), Some(&json!("configured-team")));
        assert_eq!(body.get("user_id"), Some(&json!("configured-user")));
        assert_eq!(body.get("agent_id"), Some(&json!("configured-agent")));
        assert_eq!(body.get("action"), Some(&json!("read")));
        assert!(!body.contains_key("user_key"));
        assert!(!body.contains_key("owner_user_id"));

        let body = json!({ "agent_id": "other" }).as_object().unwrap().clone();
        let body = normalize_core_request_body(
            "/v3/meta/agent-fixed-asset/list-with-detail",
            body,
            &config,
        )
        .unwrap();
        assert_eq!(body.get("agent_id"), Some(&json!("configured-agent")));
    }

    #[test]
    fn fixed_asset_set_overwrites_binding_creator_and_rejects_invalid_bindings() {
        let config = MemoryConnectionConfig {
            agent_id: "configured-agent".to_string(),
            user_id: "configured-user".to_string(),
            ..MemoryConnectionConfig::default()
        };
        let body = json!({
            "agent_id": "attacker-agent",
            "bindings": [{ "asset_id": "asset-1", "created_by": "attacker-user" }]
        })
        .as_object()
        .unwrap()
        .clone();

        let body =
            normalize_core_request_body("/v3/meta/agent-fixed-asset/set", body, &config).unwrap();

        assert_eq!(body.get("agent_id"), Some(&json!("configured-agent")));
        assert_eq!(body["bindings"][0]["created_by"], json!("configured-user"));
        assert!(normalize_core_request_body(
            "/v3/meta/agent-fixed-asset/set",
            json!({ "bindings": "not-an-array" })
                .as_object()
                .unwrap()
                .clone(),
            &config,
        )
        .is_err());
        assert!(normalize_core_request_body(
            "/v3/meta/agent-fixed-asset/set",
            json!({ "bindings": [{} , "not-an-object"] })
                .as_object()
                .unwrap()
                .clone(),
            &config,
        )
        .is_err());
    }

    #[test]
    fn core_request_body_must_deserialize_as_an_object() {
        let request = serde_json::from_value::<TencentdbCoreRequest>(json!({
            "route": "/v3/core/read",
            "body": []
        }));
        assert!(request.is_err());
    }

    #[test]
    fn typed_knowledge_queries_reject_undeclared_fields() {
        assert!(
            serde_json::from_value::<TencentdbSearchKnowledgeAsset>(json!({
                "assetId": "cg-1",
                "query": "bootstrap",
                "unexpected": true
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<TencentdbSyncAsset>(json!({
            "assetId": "cg-1",
            "route": "/code-graph/delete"
        }))
        .is_err());
    }

    #[test]
    fn all_knowledge_command_dtos_reject_undeclared_fields() {
        assert!(serde_json::from_value::<TencentdbReadWikiPages>(json!({
            "assetId": "wiki-1",
            "refs": ["overview"],
            "route": "/wiki/delete"
        }))
        .is_err());
        assert!(
            serde_json::from_value::<TencentdbProvisionWorkspace>(json!({
                "workspace": "C:/work/project",
                "teamId": "other-team"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<TencentdbDeleteKnowledgeAsset>(json!({
                "assetId": "wiki-1",
                "workspace": "C:/work/project",
                "codeGraph": true
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<TencentdbImportWikiFiles>(json!({
            "wikiId": "wiki-1",
            "paths": ["C:/docs/overview.md"],
            "route": "/wiki/raw/write"
        }))
        .is_err());
    }

    #[test]
    fn core_envelope_returns_only_data_and_defaults_missing_data_to_object() {
        assert_eq!(
            parse_core_envelope(
                StatusCode::OK,
                json!({ "code": 0, "message": "ok", "data": { "value": 42 } }),
            )
            .unwrap(),
            json!({ "value": 42 })
        );
        assert_eq!(
            parse_core_envelope(StatusCode::OK, json!({ "code": 0, "message": "ok" })).unwrap(),
            json!({})
        );
    }

    #[test]
    fn core_envelope_rejects_invalid_or_failed_responses_with_message() {
        for envelope in [
            json!([]),
            json!({ "message": "missing code" }),
            json!({ "code": "0", "message": "wrong code type" }),
        ] {
            assert!(parse_core_envelope(StatusCode::OK, envelope).is_err());
        }

        let application_error = parse_core_envelope(
            StatusCode::OK,
            json!({ "code": 17, "message": "application failed" }),
        )
        .unwrap_err()
        .to_string();
        assert!(application_error.contains("application failed"));

        let http_error = parse_core_envelope(
            StatusCode::BAD_GATEWAY,
            json!({ "code": 0, "message": "upstream failed" }),
        )
        .unwrap_err()
        .to_string();
        assert!(http_error.contains("upstream failed"));
    }

    #[test]
    fn core_envelope_rejects_non_integer_codes_that_round_to_zero() {
        let underflow: serde_json::Value =
            serde_json::from_str(r#"{ "code": 1e-400, "message": "not zero" }"#).unwrap();
        assert_eq!(underflow["code"].as_f64(), Some(0.0));

        for envelope in [json!({ "code": 0.0, "message": "float zero" }), underflow] {
            assert!(parse_core_envelope(StatusCode::OK, envelope).is_err());
        }
    }

    #[test]
    fn core_http_client_disables_redirects() {
        assert_eq!(format!("{:?}", core_redirect_policy()), "Policy(None)");
    }

    #[test]
    fn persisted_workspace_asset_ids_require_matching_server_metadata() {
        let code_graph = json!({
            "code_graph_id": "cg-existing",
            "team_id": "personal-local",
            "repo_url": "file:///workspace/app/",
            "branch": "main"
        });
        assert!(workspace_code_graph_matches(
            &code_graph,
            "personal-local",
            "file:///workspace/app/",
            "main"
        ));
        assert!(!workspace_code_graph_matches(
            &code_graph,
            "other-team",
            "file:///workspace/app/",
            "main"
        ));
        assert!(!workspace_code_graph_matches(
            &code_graph,
            "personal-local",
            "file:///workspace/other/",
            "main"
        ));

        let wiki_name = workspace_wiki_name(
            std::path::Path::new("/workspace/app"),
            &MemoryMode::Local,
            None,
        )
        .unwrap();
        let wiki = json!({
            "wiki_id": "wiki-existing",
            "team_id": "personal-local",
            "name": wiki_name
        });
        assert!(workspace_wiki_matches(
            &wiki,
            "personal-local",
            &workspace_wiki_name(
                std::path::Path::new("/workspace/app"),
                &MemoryMode::Local,
                None
            )
            .unwrap()
        ));
        assert!(!workspace_wiki_matches(
            &wiki,
            "personal-local",
            &workspace_wiki_name(
                std::path::Path::new("/workspace/other"),
                &MemoryMode::Local,
                None
            )
            .unwrap()
        ));
    }

    #[test]
    fn knowledge_search_query_is_trimmed_and_bounded() {
        assert_eq!(
            normalize_knowledge_search("  symbol name  ", Some(25), 100).unwrap(),
            ("symbol name".to_string(), 25)
        );
        assert!(normalize_knowledge_search("   ", Some(10), 100).is_err());
        assert!(normalize_knowledge_search("query", Some(0), 100).is_err());
        assert!(normalize_knowledge_search("query", Some(101), 100).is_err());
    }

    #[test]
    fn code_graph_query_fields_are_trimmed_defaulted_and_bounded() {
        assert_eq!(
            normalize_knowledge_text("  bootstrap  ", "symbol").unwrap(),
            "bootstrap"
        );
        assert!(normalize_knowledge_text("   ", "symbol").is_err());
        assert_eq!(
            normalize_optional_knowledge_text(Some("  src/main.ts  "), "file").unwrap(),
            Some("src/main.ts".to_string())
        );
        assert!(normalize_optional_knowledge_text(Some("  "), "file").is_err());
        assert_eq!(
            normalize_knowledge_count(None, 12, 200, "maxFiles").unwrap(),
            12
        );
        assert_eq!(
            normalize_knowledge_count(Some(200), 12, 200, "maxFiles").unwrap(),
            200
        );
        assert!(normalize_knowledge_count(Some(0), 12, 200, "maxFiles").is_err());
        assert!(normalize_knowledge_count(Some(201), 12, 200, "maxFiles").is_err());
        assert!(normalize_knowledge_count(Some(11), 2, 10, "depth").is_err());
        assert_eq!(
            normalize_optional_knowledge_count(Some(1), "line").unwrap(),
            Some(1)
        );
        assert!(normalize_optional_knowledge_count(Some(0), "line").is_err());
        assert_eq!(normalize_code_graph_files_format(None).unwrap(), "tree");
        assert_eq!(
            normalize_code_graph_files_format(Some("grouped")).unwrap(),
            "grouped"
        );
        assert!(normalize_code_graph_files_format(Some("json")).is_err());
    }

    #[test]
    fn deleting_a_workspace_asset_clears_only_the_matching_reference() {
        let mut assets = WorkspaceKnowledgeAssets {
            code_graph_id: Some("cg-current".to_string()),
            wiki_id: Some("wiki-current".to_string()),
            ..WorkspaceKnowledgeAssets::default()
        };

        assert!(clear_workspace_asset_reference(
            &mut assets,
            "cg-current",
            true
        ));
        assert_eq!(assets.code_graph_id, None);
        assert_eq!(assets.wiki_id.as_deref(), Some("wiki-current"));
        assert!(!clear_workspace_asset_reference(
            &mut assets,
            "wiki-other",
            false
        ));
        assert_eq!(assets.wiki_id.as_deref(), Some("wiki-current"));
    }

    #[test]
    fn knowledge_delete_requires_the_requested_id_to_be_deleted() {
        assert!(ensure_knowledge_asset_deleted(
            json!({ "deleted_ids": ["wiki-current"], "failed": [] }),
            "wiki-current"
        )
        .is_ok());

        let error = ensure_knowledge_asset_deleted(
            json!({
                "deleted_ids": [],
                "failed": [{ "id": "wiki-current", "reason": "not found" }]
            }),
            "wiki-current",
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("not found"));
    }

    #[tokio::test]
    async fn skill_reload_revision_changes_atomically() {
        let root =
            std::env::temp_dir().join(format!("grenagent-skill-reload-{}", uuid::Uuid::new_v4()));
        let store = crate::state::AppStateStore::new(root.join("state.json"));

        let first = bump_skill_reload_revision(&store).await;
        let second = bump_skill_reload_revision(&store).await;

        assert_ne!(first, second);
        assert_eq!(
            store.settings_all().await.get("PI_RELOAD_REV"),
            Some(&second)
        );
        fs::remove_dir_all(root).ok();
    }
}
