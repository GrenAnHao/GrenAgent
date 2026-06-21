use std::path::PathBuf;
use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
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
    // tmp 名带 pid + 纳秒，避免同目录并发写（多窗口/连续保存）撞同一个 .tmp 互相覆盖。
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{}.{}.tmp", std::process::id(), nonce));
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
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            truncate_body(&text)
        ));
    }
    Ok(text)
}

/// 解析 OpenAI / Anthropic 风格的 `{ data: [{ id }] }`；失败时附原始响应开头，便于排查
/// （常见为 Base URL 路径不对导致返回 HTML/空，而非 JSON）。
fn parse_id_list(text: &str) -> Result<Vec<String>, String> {
    serde_json::from_str::<DataModels>(text)
        .map(|p| p.data.into_iter().map(|m| m.id).collect())
        .map_err(|e| {
            format!(
                "解析响应失败（响应可能不是预期 JSON，请检查 Base URL 路径）: {e}；响应开头: {}",
                truncate_body(text)
            )
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
                match get_text(
                    client
                        .get(url)
                        .header("authorization", format!("Bearer {key}")),
                )
                .await
                {
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

#[derive(serde::Deserialize)]
struct ModelsFile {
    #[serde(default)]
    providers: std::collections::HashMap<String, ProviderEntry>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderEntry {
    #[serde(default)]
    api: String,
    #[serde(default)]
    base_url: String,
    #[serde(default)]
    api_key: String,
    #[serde(default)]
    headers: std::collections::HashMap<String, String>,
}

/// 从模型返回文本里抽取 mermaid 代码：优先取首个 ``` 围栏内容（含 ```mermaid 语言标记），
/// 没有围栏时返回整段 trim 后的文本。
fn extract_mermaid(text: &str) -> String {
    let t = text.trim();
    if let Some(start) = t.find("```") {
        let after = &t[start + 3..];
        // 跳过紧随其后的语言标记行（如 `mermaid\n`）。
        let body_start = after.find('\n').map(|i| i + 1).unwrap_or(0);
        let body = &after[body_start..];
        if let Some(end) = body.find("```") {
            return body[..end].trim().to_string();
        }
        return body.trim().to_string();
    }
    t.to_string()
}

/// OpenAI chat/completions 的 message.content 可能是 string，也可能是
/// `[{ "type": "text", "text": "..." }]` 数组（新版 API / 部分代理）。
fn extract_openai_message_content(message: &serde_json::Value) -> Option<String> {
    let content = message.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    let arr = content.as_array()?;
    let mut acc = String::new();
    for part in arr {
        if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
            acc.push_str(t);
        } else if let Some(s) = part.as_str() {
            acc.push_str(s);
        }
    }
    if acc.is_empty() {
        return None;
    }
    Some(acc)
}

/// 按 provider 的 api 类型发一次「非流式」补全请求，返回模型输出的纯文本。
/// 复用 models.json 里该 provider 的 baseUrl / apiKey / headers，端点与鉴权按 api 区分：
/// - anthropic-messages: POST {base}/v1/messages，x-api-key + anthropic-version
/// - google-generative-ai: POST {base}/v1beta/models/{model}:generateContent?key=...
/// - openai-responses: POST {base}/v1/responses，Authorization: Bearer
/// - 其它（openai-completions / OpenAI 兼容）: POST {base}/v1/chat/completions，Bearer，stream:false
async fn call_llm_oneshot(
    entry: &ProviderEntry,
    model_id: &str,
    system: &str,
    user: &str,
) -> Result<String, String> {
    let base = entry.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("provider baseUrl 为空".into());
    }
    let key = entry.api_key.trim();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let (url, body): (String, serde_json::Value) = match entry.api.as_str() {
        "anthropic-messages" => {
            let url = if base.ends_with("/v1") {
                format!("{base}/messages")
            } else {
                format!("{base}/v1/messages")
            };
            let body = serde_json::json!({
                "model": model_id,
                "max_tokens": 4096,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            });
            (url, body)
        }
        "google-generative-ai" => {
            let root = if base.ends_with("/v1beta") || base.ends_with("/v1") {
                base.to_string()
            } else {
                format!("{base}/v1beta")
            };
            let url = format!("{root}/models/{model_id}:generateContent");
            let body = serde_json::json!({
                "systemInstruction": { "parts": [{ "text": system }] },
                "contents": [{ "role": "user", "parts": [{ "text": user }] }],
            });
            (url, body)
        }
        "openai-responses" => {
            let url = if base.ends_with("/v1") {
                format!("{base}/responses")
            } else {
                format!("{base}/v1/responses")
            };
            let body = serde_json::json!({
                "model": model_id,
                "input": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user },
                ],
            });
            (url, body)
        }
        _ => {
            let url = if base.ends_with("/v1") {
                format!("{base}/chat/completions")
            } else {
                format!("{base}/v1/chat/completions")
            };
            let body = serde_json::json!({
                "model": model_id,
                "messages": [
                    { "role": "system", "content": system },
                    { "role": "user", "content": user },
                ],
                "stream": false,
            });
            (url, body)
        }
    };

    let mut rb = client
        .post(&url)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?);
    rb = match entry.api.as_str() {
        "anthropic-messages" => rb
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01"),
        "google-generative-ai" => rb.query(&[("key", key)]),
        _ => rb.header("authorization", format!("Bearer {key}")),
    };
    // 附加 provider 自定义 headers（如 User-Agent）；放最后，但鉴权头已先设，避免被无意覆盖语义。
    for (k, v) in &entry.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }

    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            truncate_body(&text)
        ));
    }

    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("解析响应失败: {e}；响应开头: {}", truncate_body(&text)))?;

    let content = match entry.api.as_str() {
        "anthropic-messages" => v
            .get("content")
            .and_then(|c| c.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find_map(|b| b.get("text").and_then(|t| t.as_str()))
            })
            .map(|s| s.to_string()),
        "google-generative-ai" => v
            .get("candidates")
            .and_then(|c| c.as_array())
            .and_then(|arr| arr.first())
            .and_then(|c| c.get("content"))
            .and_then(|c| c.get("parts"))
            .and_then(|p| p.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find_map(|p| p.get("text").and_then(|t| t.as_str()))
            })
            .map(|s| s.to_string()),
        "openai-responses" => v
            .get("output_text")
            .and_then(|t| t.as_str())
            .map(|s| s.to_string())
            .or_else(|| {
                v.get("output").and_then(|o| o.as_array()).map(|items| {
                    let mut acc = String::new();
                    for item in items {
                        if let Some(carr) = item.get("content").and_then(|c| c.as_array()) {
                            for c in carr {
                                if let Some(t) = c.get("text").and_then(|t| t.as_str()) {
                                    acc.push_str(t);
                                }
                            }
                        }
                    }
                    acc
                })
            }),
        _ => extract_openai_message_content(
            v.get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|c| c.get("message"))
                .unwrap_or(&serde_json::Value::Null),
        ),
    };

    let content = content.unwrap_or_default();
    if content.trim().is_empty() {
        return Err(format!(
            "模型未返回有效内容；响应开头: {}",
            truncate_body(&text)
        ));
    }
    Ok(content)
}

/// Mermaid 渲染失败时的「非流式一次性修复」：取当前会话所选模型，按其 provider 的 api 类型
/// 发一次非流式补全请求，让模型只返回修正后的 mermaid 代码。整个过程不进入对话历史，结果由
/// 前端直接替换到失败的图表组件上重渲染。
#[tauri::command]
pub async fn fix_mermaid_diagram(
    workspace: String,
    code: String,
    error: String,
    app: tauri::AppHandle,
    mgr: State<'_, Arc<PiManager>>,
) -> Result<String, String> {
    // 1. 取当前会话选定的模型（provider + id）。
    let client = mgr
        .get(&workspace)
        .await
        .ok_or_else(|| format!("workspace not open: {workspace}"))?;
    let state = client
        .send(PiOutbound::GetState { id: None })
        .await
        .map_err(|e| e.to_string())?;
    if !state.success {
        return Err(state.error.unwrap_or_else(|| "get_state failed".into()));
    }
    let data = state.data.ok_or("当前会话状态为空")?;
    let model = data.get("model").ok_or("当前会话尚未选定模型")?;
    let model_id = model
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or("无法获取当前模型 id")?;
    let provider_key = model
        .get("provider")
        .and_then(|v| v.as_str())
        .ok_or("无法获取当前模型的 provider")?;

    // 2. 读 models.json 定位该 provider 的连接配置。
    let dir = agent_dir(&app)?;
    let models_json =
        read_opt(&dir.join("models.json")).ok_or("找不到 models.json，无法定位 provider 配置")?;
    let parsed: ModelsFile =
        serde_json::from_str(&models_json).map_err(|e| format!("models.json 解析失败: {e}"))?;
    let entry = parsed
        .providers
        .get(provider_key)
        .ok_or_else(|| format!("models.json 中找不到 provider: {provider_key}"))?;
    if entry.api_key.trim().is_empty() {
        return Err(format!("provider {provider_key} 未配置 apiKey"));
    }

    // 3. 发非流式请求并抽取 mermaid 代码。
    // prompt 显式列出最常见的 mermaid 报错根因（标签里的特殊字符 / 裸引号），否则模型常原样产出
    // 同样会再次解析失败的代码（即「AI 修复后仍渲染失败」）。
    let system = r#"You are a Mermaid diagram syntax repair tool. The user provides a Mermaid diagram source that failed to render plus the error message. Reply with ONLY the corrected Mermaid source wrapped in a single ```mermaid fenced code block — no explanation. Preserve the original intent, language, and diagram type.

Most render failures come from labels. Apply these rules:
1. If a node or edge label contains any of these characters: " [ ] ( ) { } | : ; # < > or a slash, wrap the WHOLE label in double quotes, e.g. A["text (x)"] or A -->|"a/b"| B.
2. To show a literal double-quote INSIDE a label, write the entity #quot; — never leave a raw double-quote in the middle of a label. e.g. A["he said #quot;hi#quot;"].
3. Node ids must be simple (letters, digits, underscore) with no spaces or punctuation; move any such text into the quoted label instead.
4. Use <br/> for line breaks inside labels, not real newlines.
5. Change as little as possible beyond fixing the error."#;
    let user = format!(
        "The Mermaid diagram failed to render.\n\nError:\n{error}\n\nOriginal Mermaid source:\n```mermaid\n{code}\n```\n\nReturn the corrected Mermaid source."
    );
    let raw = call_llm_oneshot(entry, model_id, system, &user).await?;
    let fixed = extract_mermaid(&raw);
    if fixed.trim().is_empty() {
        return Err("模型未返回可用的 mermaid 代码".into());
    }
    Ok(fixed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnoseResult {
    pub ok: bool,
    pub error: Option<String>,
    pub content: String,
    pub ttft_ms: u64,
    pub total_ms: u64,
    pub prompt_tokens: Option<u64>,
    pub completion_tokens: Option<u64>,
    pub total_tokens: Option<u64>,
    pub tokens_per_sec: Option<f64>,
}

fn provider_entry(app: &tauri::AppHandle, provider_id: &str) -> Result<ProviderEntry, String> {
    let dir = agent_dir(app)?;
    let models_json =
        read_opt(&dir.join("models.json")).ok_or("找不到 models.json，无法定位 provider 配置")?;
    let parsed: ModelsFile =
        serde_json::from_str(&models_json).map_err(|e| format!("models.json 解析失败: {e}"))?;
    let entry = parsed
        .providers
        .get(provider_id)
        .ok_or_else(|| format!("models.json 中找不到 provider: {provider_id}"))?;
    if entry.api_key.trim().is_empty() {
        return Err(format!("provider {provider_id} 未配置 apiKey"));
    }
    Ok(ProviderEntry {
        api: entry.api.clone(),
        base_url: entry.base_url.clone(),
        api_key: entry.api_key.clone(),
        headers: entry.headers.clone(),
    })
}

/// 流式诊断 OpenAI 兼容 chat/completions：测首字(TTFT)、总耗时、token 用量与速率。
async fn diagnose_openai_stream(
    entry: &ProviderEntry,
    model_id: &str,
    prompt: &str,
    on_chunk: &Channel<String>,
) -> Result<DiagnoseResult, String> {
    use futures_util::StreamExt;
    use std::time::Instant;

    let base = entry.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("provider baseUrl 为空".into());
    }
    let key = entry.api_key.trim();
    let url = if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };
    let body = serde_json::json!({
        "model": model_id,
        "messages": [{ "role": "user", "content": prompt }],
        "stream": true,
        "stream_options": { "include_usage": true },
    });

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut rb = client
        .post(&url)
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {key}"))
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?);
    for (k, v) in &entry.headers {
        rb = rb.header(k.as_str(), v.as_str());
    }

    let start = Instant::now();
    let resp = rb.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            truncate_body(&text)
        ));
    }

    let mut ttft_ms = 0u64;
    let mut content = String::new();
    let mut prompt_tokens = None;
    let mut completion_tokens = None;
    let mut total_tokens = None;
    let mut got_first = false;
    let stream = resp.bytes_stream();
    tokio::pin!(stream);
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| e.to_string())?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf = buf[pos + 1..].to_string();
            if !line.starts_with("data:") {
                continue;
            }
            let data = line.trim_start_matches("data:").trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(u) = v.get("usage") {
                prompt_tokens = u.get("prompt_tokens").and_then(|x| x.as_u64());
                completion_tokens = u.get("completion_tokens").and_then(|x| x.as_u64());
                total_tokens = u.get("total_tokens").and_then(|x| x.as_u64());
            }
            if let Some(delta) = v
                .get("choices")
                .and_then(|c| c.as_array())
                .and_then(|arr| arr.first())
                .and_then(|c| c.get("delta"))
                .and_then(|d| d.get("content"))
                .and_then(|c| c.as_str())
            {
                if !delta.is_empty() {
                    if !got_first {
                        got_first = true;
                        ttft_ms = start.elapsed().as_millis() as u64;
                    }
                    content.push_str(delta);
                    let _ = on_chunk.send(delta.to_string());
                }
            }
        }
    }

    let total_ms = start.elapsed().as_millis() as u64;
    if !got_first {
        ttft_ms = total_ms;
    }
    let tokens_per_sec = completion_tokens.and_then(|c| {
        if total_ms == 0 {
            return None;
        }
        Some(c as f64 / (total_ms as f64 / 1000.0))
    });

    if content.trim().is_empty() {
        return Err("模型未返回有效内容".into());
    }

    Ok(DiagnoseResult {
        ok: true,
        error: None,
        content,
        ttft_ms,
        total_ms,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        tokens_per_sec,
    })
}

/// 供应商模型测活：发一条用户消息，返回连通性、首字耗时、总耗时、token 与速率。
#[tauri::command]
pub async fn diagnose_provider_model(
    provider_id: String,
    model_id: String,
    prompt: String,
    stream: bool,
    on_chunk: Channel<String>,
    app: tauri::AppHandle,
) -> Result<DiagnoseResult, String> {
    use std::time::Instant;

    let entry = provider_entry(&app, &provider_id)?;
    let user = if prompt.trim().is_empty() { "Who are you?".to_string() } else { prompt };

    // OpenAI 兼容类型（含未显式指定 api 的默认情况）均支持流式
    let is_openai_compat = entry.api.is_empty()
        || entry.api.starts_with("openai")
        || entry.api == "openai-completions"
        || entry.api == "openai-responses";
    if stream && is_openai_compat {
        return diagnose_openai_stream(&entry, &model_id, &user, &on_chunk).await;
    }

    // 非流式：一次性请求，内容整体推给前端一次
    let start = Instant::now();
    match call_llm_oneshot(&entry, &model_id, "", &user).await {
        Ok(content) => {
            let _ = on_chunk.send(content.clone());
            let total_ms = start.elapsed().as_millis() as u64;
            Ok(DiagnoseResult { ok: true, error: None, content, ttft_ms: total_ms, total_ms,
                prompt_tokens: None, completion_tokens: None, total_tokens: None, tokens_per_sec: None })
        }
        Err(e) => Ok(DiagnoseResult { ok: false, error: Some(e), content: String::new(),
            ttft_ms: 0, total_ms: start.elapsed().as_millis() as u64,
            prompt_tokens: None, completion_tokens: None, total_tokens: None, tokens_per_sec: None }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_mermaid_from_fenced_block() {
        let out = extract_mermaid("好的，这是修正版：\n```mermaid\ngantt\n  title X\n```\n完成");
        assert_eq!(out, "gantt\n  title X");
    }

    #[test]
    fn extract_mermaid_plain_passthrough() {
        assert_eq!(
            extract_mermaid("  flowchart TD\n  A-->B  "),
            "flowchart TD\n  A-->B"
        );
    }

    #[test]
    fn extract_openai_message_content_string() {
        let msg = serde_json::json!({ "content": "hello" });
        assert_eq!(
            extract_openai_message_content(&msg).as_deref(),
            Some("hello")
        );
    }

    #[test]
    fn extract_openai_message_content_array() {
        let msg = serde_json::json!({
            "content": [{ "type": "text", "text": "```mermaid\nflowchart TD\n  A-->B\n```" }]
        });
        assert!(extract_openai_message_content(&msg)
            .unwrap()
            .contains("flowchart TD"));
    }

    #[test]
    fn atomic_write_then_read_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("pi-prov-{}.json", std::process::id()));
        atomic_write(&tmp, "{\"providers\":{}}").unwrap();
        assert_eq!(read_opt(&tmp).as_deref(), Some("{\"providers\":{}}"));
        let _ = std::fs::remove_file(&tmp);
    }
}
