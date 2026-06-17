use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State};

use crate::pi::types::PiOutbound;
use crate::pi::PiManager;

/// 解析 ~/.pi/agent 目录（与 pi getAgentDir 默认一致）：
/// 优先 PI_CODING_AGENT_DIR，否则 home/.pi/agent。
fn agent_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("PI_CODING_AGENT_DIR") {
        if !dir.is_empty() {
            return Ok(PathBuf::from(dir));
        }
    }
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    Ok(home.join(".pi").join("agent"))
}

fn read_opt(path: &PathBuf) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// 原子写：先写 .tmp 再 rename，避免 pi 进程读到半写文件。
fn atomic_write(path: &PathBuf, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigPayload {
    pub models_json: Option<String>,
    pub auth_json: Option<String>,
    pub agent_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedWorkspace {
    pub workspace: String,
    pub error: String,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub refreshed: Vec<String>,
    pub failed: Vec<FailedWorkspace>,
}

/// 让每个已打开 workspace 的 pi 进程重读 models.json/auth.json：
/// 取当前 sessionFile 后 switch_session 到同一会话 → runtime 重建（新建 ModelRegistry +
/// AuthStorage 重新读盘），会话历史保留。sidecar 用的是 npm pi 包，没有自定义刷新 RPC，
/// 故复用既有 get_state + switch_session 达到热重载。
async fn broadcast_refresh(mgr: &PiManager) -> RefreshResult {
    let mut out = RefreshResult::default();
    for (ws, client) in mgr.all().await {
        let session_file = match client.send(PiOutbound::GetState { id: None }).await {
            Ok(resp) if resp.success => resp
                .data
                .as_ref()
                .and_then(|d| d.get("sessionFile"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            Ok(resp) => {
                out.failed.push(FailedWorkspace {
                    workspace: ws.clone(),
                    error: resp.error.unwrap_or_else(|| "get_state failed".into()),
                });
                continue;
            }
            Err(e) => {
                out.failed.push(FailedWorkspace {
                    workspace: ws.clone(),
                    error: e.to_string(),
                });
                continue;
            }
        };

        // 无当前会话：runtime 尚未绑定，下次新建会话即读到新配置，视为成功。
        let Some(path) = session_file else {
            out.refreshed.push(ws);
            continue;
        };

        match client
            .send(PiOutbound::SwitchSession {
                id: None,
                session_path: path,
            })
            .await
        {
            Ok(resp) if resp.success => out.refreshed.push(ws),
            Ok(resp) => out.failed.push(FailedWorkspace {
                workspace: ws,
                error: resp.error.unwrap_or_else(|| "switch_session failed".into()),
            }),
            Err(e) => out.failed.push(FailedWorkspace {
                workspace: ws,
                error: e.to_string(),
            }),
        }
    }
    out
}

#[tauri::command]
pub async fn get_provider_config(app: tauri::AppHandle) -> Result<ProviderConfigPayload, String> {
    let dir = agent_dir(&app)?;
    Ok(ProviderConfigPayload {
        models_json: read_opt(&dir.join("models.json")),
        auth_json: read_opt(&dir.join("auth.json")),
        agent_dir: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
pub async fn set_provider_config(
    models_json: String,
    auth_json: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<RefreshResult, String> {
    // 校验是合法 JSON，避免写坏 pi 配置文件。
    serde_json::from_str::<serde_json::Value>(&models_json)
        .map_err(|e| format!("models.json 不是合法 JSON: {e}"))?;
    serde_json::from_str::<serde_json::Value>(&auth_json)
        .map_err(|e| format!("auth.json 不是合法 JSON: {e}"))?;

    let dir = agent_dir(&app)?;
    atomic_write(&dir.join("models.json"), &models_json)?;
    atomic_write(&dir.join("auth.json"), &auth_json)?;

    Ok(broadcast_refresh(&mgr).await)
}

#[tauri::command]
pub async fn refresh_model_registry(
    mgr: State<'_, Arc<PiManager>>,
) -> Result<RefreshResult, String> {
    Ok(broadcast_refresh(&mgr).await)
}

#[derive(serde::Deserialize)]
struct IdModel {
    id: String,
}
#[derive(serde::Deserialize)]
struct DataModels {
    data: Vec<IdModel>,
}
#[derive(serde::Deserialize)]
struct NameModel {
    name: String,
}
#[derive(serde::Deserialize)]
struct GoogleModels {
    models: Vec<NameModel>,
}

/// 错误响应体可能很长，截断到前 300 字符（按 char 边界，避免 panic）。
fn truncate_body(s: &str) -> String {
    let t = s.trim();
    let cut: String = t.chars().take(300).collect();
    if cut.chars().count() < t.chars().count() {
        format!("{cut}…")
    } else {
        cut
    }
}

async fn get_text(rb: reqwest::RequestBuilder) -> Result<String, String> {
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status.as_u16(), truncate_body(&text)));
    }
    Ok(text)
}

/// 解析 OpenAI / Anthropic 风格的 `{ data: [{ id }] }`；失败时附原始响应开头，便于排查
/// （常见为 Base URL 路径不对导致返回 HTML/空，而非 JSON）。
fn parse_id_list(text: &str) -> Result<Vec<String>, String> {
    serde_json::from_str::<DataModels>(text)
        .map(|p| p.data.into_iter().map(|m| m.id).collect())
        .map_err(|e| {
            format!("解析响应失败（响应可能不是预期 JSON，请检查 Base URL 路径）: {e}；响应开头: {}", truncate_body(text))
        })
}

/// 调供应商自身的「列模型」接口，返回模型 id 列表。按 api 类型选择端点与鉴权：
/// - openai-completions / openai-responses: `GET {base}/models`，`Authorization: Bearer`
/// - anthropic-messages: `GET {base}/v1/models`，`x-api-key` + `anthropic-version`
/// - google-generative-ai: `GET {base}/v1beta/models?key=...`
#[tauri::command]
pub async fn fetch_provider_models(
    base_url: String,
    api_key: String,
    api: String,
) -> Result<Vec<String>, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Base URL 为空".into());
    }
    let key = api_key.trim();
    if key.is_empty() {
        return Err("API Key 为空".into());
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let models: Vec<String> = match api.as_str() {
        "anthropic-messages" => {
            let url = if base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1/models")
            };
            let text = get_text(
                client
                    .get(&url)
                    .header("x-api-key", key)
                    .header("anthropic-version", "2023-06-01"),
            )
            .await?;
            parse_id_list(&text)?
        }
        "google-generative-ai" => {
            let url = if base.ends_with("/v1beta") || base.ends_with("/v1") {
                format!("{base}/models")
            } else {
                format!("{base}/v1beta/models")
            };
            let text = get_text(client.get(&url).query(&[("key", key)])).await?;
            serde_json::from_str::<GoogleModels>(&text)
                .map_err(|e| format!("解析响应失败: {e}；响应开头: {}", truncate_body(&text)))?
                .models
                .into_iter()
                .map(|m| {
                    m.name
                        .strip_prefix("models/")
                        .unwrap_or(&m.name)
                        .to_string()
                })
                .collect()
        }
        // openai-completions / openai-responses / 其它 OpenAI 兼容
        _ => {
            // base 不含 /v1 时先试 {base}/v1/models 再回退 {base}/models（不同代理路径约定不一）。
            let candidates: Vec<String> = if base.ends_with("/v1") {
                vec![format!("{base}/models")]
            } else {
                vec![format!("{base}/v1/models"), format!("{base}/models")]
            };
            let mut last_err = String::from("无可用端点");
            let mut found: Option<Vec<String>> = None;
            for url in &candidates {
                match get_text(client.get(url).header("authorization", format!("Bearer {key}"))).await {
                    Ok(text) => match parse_id_list(&text) {
                        Ok(ids) => {
                            found = Some(ids);
                            break;
                        }
                        Err(e) => last_err = e,
                    },
                    Err(e) => last_err = e,
                }
            }
            match found {
                Some(ids) => ids,
                None => return Err(last_err),
            }
        }
    };

    Ok(models)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn atomic_write_then_read_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("pi-prov-{}.json", std::process::id()));
        atomic_write(&tmp, "{\"providers\":{}}").unwrap();
        assert_eq!(read_opt(&tmp).as_deref(), Some("{\"providers\":{}}"));
        let _ = std::fs::remove_file(&tmp);
    }
}
