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
struct ProbeModelsOut {
    ok: bool,
    #[serde(default)]
    models: Vec<serde_json::Value>,
    #[serde(default)]
    error: Option<String>,
}

/// 项目无关地列出 ModelRegistry 解析后的模型：spawn 短命 `pi probe-models`（不起 RPC 运行时、不要
/// workspace），解析其 stdout 的单行 JSON。供未打开项目 / 冷启动 / 真对话模式的模型选择器使用。
/// 失败时调用方可回退 fetch_provider_models（仅 id 列表）。复用 probe_mcp_server 同款 sidecar spawn。
#[tauri::command]
pub async fn list_models_global(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    use tauri_plugin_shell::ShellExt;
    let package_dir = crate::pi::sidecar::pi_package_dir(&app).map_err(|e| e.to_string())?;
    let output = app
        .shell()
        .sidecar("pi")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args(["probe-models"])
        .env("PI_PACKAGE_DIR", package_dir)
        .output()
        .await
        .map_err(|e| format!("probe-models spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "probe-models exited ({:?}): {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().last().unwrap_or("").trim();
    let parsed: ProbeModelsOut =
        serde_json::from_str(line).map_err(|e| format!("probe-models 输出解析失败: {e}; 原文: {line}"))?;
    if !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| "probe-models failed".into()));
    }
    Ok(parsed.models)
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

/// 起一次性 `pi oneshot` 子进程（走 pi-ai dispatch），逐行把 stdout 的 JSONL 交给 `on_line`，
/// 阻塞至子进程结束。mermaid 修复（非流式单行）与健康检查（流式 delta + done）共用。
async fn run_oneshot_lines<F: FnMut(&str)>(
    app: &tauri::AppHandle,
    request: &serde_json::Value,
    mut on_line: F,
) -> Result<(), String> {
    use tauri_plugin_shell::process::CommandEvent;
    use tauri_plugin_shell::ShellExt;
    let package_dir = crate::pi::sidecar::pi_package_dir(app).map_err(|e| e.to_string())?;
    let (mut rx, _child) = app
        .shell()
        .sidecar("pi")
        .map_err(|e| format!("sidecar lookup failed: {e}"))?
        .args(["oneshot"])
        .env("PI_PACKAGE_DIR", package_dir)
        .env("ONESHOT_REQUEST", request.to_string())
        .spawn()
        .map_err(|e| format!("oneshot spawn failed: {e}"))?;
    // 默认行模式下每个 Stdout 事件是切好的整行；仍做一次缓冲兜底跨事件残行。
    let mut buf = String::new();
    while let Some(ev) = rx.recv().await {
        match ev {
            CommandEvent::Stdout(bytes) => {
                buf.push_str(&String::from_utf8_lossy(&bytes));
                while let Some(pos) = buf.find('\n') {
                    let line = buf[..pos].trim().to_string();
                    buf = buf[pos + 1..].to_string();
                    if !line.is_empty() {
                        on_line(&line);
                    }
                }
            }
            CommandEvent::Terminated(_) => break,
            _ => {}
        }
    }
    let tail = buf.trim();
    if !tail.is_empty() {
        on_line(tail);
    }
    Ok(())
}

#[derive(serde::Deserialize)]
struct OneshotNonStream {
    ok: bool,
    #[serde(default)]
    content: String,
    #[serde(default)]
    error: Option<String>,
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

    // 2. 发非流式 oneshot 请求并抽取 mermaid 代码（provider 解析 / 鉴权在 sidecar 内由 pi-ai 完成）。
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
    let req =
        serde_json::json!({ "provider": provider_key, "modelId": model_id, "system": system, "user": user });
    let mut out_line = String::new();
    run_oneshot_lines(&app, &req, |line| out_line = line.to_string()).await?;
    let parsed: OneshotNonStream = serde_json::from_str(&out_line)
        .map_err(|e| format!("oneshot 输出解析失败: {e}; 原文: {out_line}"))?;
    if !parsed.ok {
        return Err(parsed.error.unwrap_or_else(|| "oneshot failed".into()));
    }
    let fixed = extract_mermaid(&parsed.content);
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

    let user = if prompt.trim().is_empty() { "Who are you?".to_string() } else { prompt };
    let req =
        serde_json::json!({ "provider": provider_id, "modelId": model_id, "user": user, "stream": stream });

    let start = Instant::now();
    let mut content = String::new();
    let mut ttft_ms = 0u64;
    let mut got_first = false;
    let mut prompt_tokens: Option<u64> = None;
    let mut completion_tokens: Option<u64> = None;
    let mut total_tokens: Option<u64> = None;
    let mut err: Option<String> = None;

    // oneshot 流式输出精简 JSONL：{type:"delta",text} / {type:"done"|"error",usage}；
    // 非流式输出单行 {ok,content,usage}。两种都在此统一解析，delta 同步推 on_chunk 并测 TTFT。
    run_oneshot_lines(&app, &req, |line| {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { return };
        match v.get("type").and_then(|t| t.as_str()) {
            Some("delta") => {
                if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                    if !got_first {
                        got_first = true;
                        ttft_ms = start.elapsed().as_millis() as u64;
                    }
                    content.push_str(t);
                    let _ = on_chunk.send(t.to_string());
                }
            }
            Some(kind @ ("done" | "error")) => {
                if let Some(u) = v.get("usage") {
                    prompt_tokens = u.get("input").and_then(|x| x.as_u64());
                    completion_tokens = u.get("output").and_then(|x| x.as_u64());
                    total_tokens = u.get("totalTokens").and_then(|x| x.as_u64());
                }
                if kind == "error" {
                    err = Some(
                        v.get("error")
                            .and_then(|e| e.as_str())
                            .unwrap_or("模型返回错误")
                            .to_string(),
                    );
                }
            }
            // 非流式单行：{ ok, content, usage }
            None => {
                if let Some(c) = v.get("content").and_then(|c| c.as_str()) {
                    if !got_first {
                        got_first = true;
                        ttft_ms = start.elapsed().as_millis() as u64;
                    }
                    content.push_str(c);
                    let _ = on_chunk.send(c.to_string());
                }
                if v.get("ok").and_then(|o| o.as_bool()) == Some(false) {
                    err = v.get("error").and_then(|e| e.as_str()).map(|s| s.to_string());
                }
            }
            _ => {}
        }
    })
    .await?;

    let total_ms = start.elapsed().as_millis() as u64;
    if !got_first {
        ttft_ms = total_ms;
    }
    if let Some(e) = err {
        return Ok(DiagnoseResult {
            ok: false,
            error: Some(e),
            content,
            ttft_ms: 0,
            total_ms,
            prompt_tokens,
            completion_tokens,
            total_tokens,
            tokens_per_sec: None,
        });
    }
    if content.trim().is_empty() {
        return Ok(DiagnoseResult {
            ok: false,
            error: Some("模型未返回有效内容".into()),
            content,
            ttft_ms: 0,
            total_ms,
            prompt_tokens: None,
            completion_tokens: None,
            total_tokens: None,
            tokens_per_sec: None,
        });
    }
    let tokens_per_sec =
        completion_tokens.and_then(|c| if total_ms == 0 { None } else { Some(c as f64 / (total_ms as f64 / 1000.0)) });
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
    fn atomic_write_then_read_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("pi-prov-{}.json", std::process::id()));
        atomic_write(&tmp, "{\"providers\":{}}").unwrap();
        assert_eq!(read_opt(&tmp).as_deref(), Some("{\"providers\":{}}"));
        let _ = std::fs::remove_file(&tmp);
    }
}
