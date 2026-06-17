use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use serde_json::Value;
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

use crate::pi::sink::EventSink;
use crate::pi::transport::PiTransport;
use crate::pi::types::{PiInbound, PiOutbound, RpcResponse};

/// 单个工作区的 pi 客户端。负责给命令分配 id、关联响应、把事件交给 sink。
pub struct PiClient {
    workspace: String,
    transport: Arc<dyn PiTransport>,
    sink: Arc<dyn EventSink>,
    pending: Mutex<HashMap<String, oneshot::Sender<RpcResponse>>>,
}

impl PiClient {
    pub fn new(
        workspace: String,
        transport: Arc<dyn PiTransport>,
        sink: Arc<dyn EventSink>,
    ) -> Self {
        Self {
            workspace,
            transport,
            sink,
            pending: Mutex::new(HashMap::new()),
        }
    }

    /// 发送命令并等待匹配 id 的响应。若命令本身不带 id，则生成一个。
    pub async fn send(&self, mut cmd: PiOutbound) -> Result<RpcResponse> {
        let id = ensure_id(&mut cmd);
        let line = serde_json::to_string(&cmd)?;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        if let Err(e) = self.transport.write_line(line).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        rx.await
            .map_err(|_| anyhow!("pi client closed before response for {id}"))
    }

    /// 处理从 pi 读到的一行。非法 JSON 跳过（记录），不影响后续。
    pub async fn handle_line(&self, line: &str) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return;
        }
        match serde_json::from_str::<PiInbound>(trimmed) {
            Ok(PiInbound::Response(resp)) => {
                if let Some(id) = resp.id.clone() {
                    if let Some(tx) = self.pending.lock().await.remove(&id) {
                        let _ = tx.send(resp);
                        return;
                    }
                }
                self.sink.emit_event(
                    &self.workspace,
                    &serde_json::to_value(UnmatchedResponse::from(resp)).unwrap_or(Value::Null),
                );
            }
            Ok(PiInbound::ExtensionUiRequest(req)) => {
                let v = serde_json::to_value(&req).unwrap_or(Value::Null);
                self.sink.emit_ui_request(&self.workspace, &v);
            }
            Ok(PiInbound::Event(v)) => {
                // 诊断日志：打印每轮事件类型（跳过高频 delta），附带 error 字段（若有）。
                if let Some(t) = v.get("type").and_then(|x| x.as_str()) {
                    if t != "message_update" && t != "tool_execution_update" {
                        let err = v
                            .get("error")
                            .or_else(|| v.get("errorMessage"))
                            .and_then(|x| x.as_str())
                            .unwrap_or("");
                        if err.is_empty() {
                            eprintln!("[pi event:{}] {t}", self.workspace);
                        } else {
                            eprintln!("[pi event:{}] {t} error={err}", self.workspace);
                        }
                    }
                }
                self.sink.emit_event(&self.workspace, &v);
            }
            Err(e) => {
                eprintln!(
                    "[pi:{}] skip unparsable line: {e}: {trimmed}",
                    self.workspace
                );
            }
        }
    }

    /// 进程退出时调用：拒绝所有 pending，发 exit 事件。
    pub async fn handle_exit(&self, code: Option<i32>) {
        self.pending.lock().await.clear();
        self.sink.emit_exit(&self.workspace, code);
    }

    pub async fn kill(&self) -> Result<()> {
        self.transport.kill().await
    }

    /// 回传 extension UI 响应到 pi。
    pub async fn respond_ui(&self, response: Value) -> Result<()> {
        let line = serde_json::to_string(&response)?;
        self.transport.write_line(line).await
    }
}

#[derive(serde::Serialize)]
struct UnmatchedResponse {
    #[serde(rename = "type")]
    ty: &'static str,
    command: String,
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl From<RpcResponse> for UnmatchedResponse {
    fn from(r: RpcResponse) -> Self {
        Self {
            ty: "unmatched_response",
            command: r.command,
            success: r.success,
            error: r.error,
        }
    }
}

/// 若命令缺少 id 则注入一个并返回；否则返回已有 id。
fn ensure_id(cmd: &mut PiOutbound) -> String {
    let new_id = || Uuid::new_v4().to_string();
    macro_rules! fill {
        ($id:expr) => {{
            $id.get_or_insert_with(new_id).clone()
        }};
    }
    use PiOutbound::*;
    match cmd {
        Prompt { id, .. }
        | Steer { id, .. }
        | FollowUp { id, .. }
        | Abort { id }
        | NewSession { id }
        | SwitchSession { id, .. }
        | Fork { id, .. }
        | Clone { id }
        | GetForkMessages { id }
        | SetSessionName { id, .. }
        | GetState { id }
        | GetMessages { id }
        | GetSessionStats { id }
        | GetCommands { id }
        | GetAvailableModels { id }
        | SetModel { id, .. }
        | CycleModel { id }
        | SetThinkingLevel { id, .. }
        | CycleThinkingLevel { id }
        | Compact { id, .. }
        | SetAutoCompaction { id, .. }
        | AbortRetry { id } => fill!(id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi::sink::CollectingSink;
    use crate::pi::transport::ChannelTransport;
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test]
    async fn correlates_response_to_request() {
        let (transport, mut outbox) = ChannelTransport::new();
        let sink = CollectingSink::default();
        let client = Arc::new(PiClient::new(
            "ws1".into(),
            Arc::new(transport),
            Arc::new(sink),
        ));

        let client2 = client.clone();
        let handle = tokio::spawn(async move {
            client2
                .send(PiOutbound::GetState { id: None })
                .await
                .unwrap()
        });

        let line = outbox.recv().await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        let id = v["id"].as_str().unwrap().to_string();
        assert_eq!(v["type"], "get_state");

        client
            .handle_line(&format!(
                r#"{{"id":"{id}","type":"response","command":"get_state","success":true,"data":{{"isStreaming":false}}}}"#
            ))
            .await;

        let resp = tokio::time::timeout(Duration::from_secs(1), handle)
            .await
            .unwrap()
            .unwrap();
        assert!(resp.success);
        assert_eq!(resp.data.unwrap()["isStreaming"], false);
    }

    #[tokio::test]
    async fn forwards_agent_events_to_sink() {
        let (transport, _outbox) = ChannelTransport::new();
        let sink = CollectingSink::default();
        let client = PiClient::new("ws1".into(), Arc::new(transport), Arc::new(sink.clone()));

        client.handle_line(r#"{"type":"agent_start"}"#).await;
        client
            .handle_line(r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}"#)
            .await;

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "agent_start");
    }

    #[tokio::test]
    async fn routes_extension_ui_request_to_sink() {
        let (transport, _outbox) = ChannelTransport::new();
        let sink = CollectingSink::default();
        let client = PiClient::new("ws1".into(), Arc::new(transport), Arc::new(sink.clone()));

        client
            .handle_line(
                r#"{"type":"extension_ui_request","id":"u1","method":"confirm","title":"OK?"}"#,
            )
            .await;

        let reqs = sink.ui_requests.lock().unwrap();
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0]["id"], "u1");
        assert_eq!(reqs[0]["method"], "confirm");
    }

    #[tokio::test]
    async fn malformed_line_is_skipped_not_fatal() {
        let (transport, _outbox) = ChannelTransport::new();
        let sink = CollectingSink::default();
        let client = PiClient::new("ws1".into(), Arc::new(transport), Arc::new(sink.clone()));

        client.handle_line("not json").await;
        client
            .handle_line(r#"{"type":"agent_end","messages":[]}"#)
            .await;
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn unmatched_response_is_emitted_as_event() {
        let (transport, _outbox) = ChannelTransport::new();
        let sink = CollectingSink::default();
        let client = PiClient::new("ws1".into(), Arc::new(transport), Arc::new(sink.clone()));

        // 没有对应 pending 的响应（id 未注册）
        client
            .handle_line(r#"{"id":"ghost","type":"response","command":"get_state","success":false,"error":"boom"}"#)
            .await;

        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["type"], "unmatched_response");
        assert_eq!(events[0]["command"], "get_state");
        assert_eq!(events[0]["success"], false);
        assert_eq!(events[0]["error"], "boom");
    }

    #[tokio::test]
    async fn handle_exit_rejects_pending_and_emits_exit() {
        let (transport, mut outbox) = ChannelTransport::new();
        let sink = CollectingSink::default();
        let client = Arc::new(PiClient::new(
            "ws1".into(),
            Arc::new(transport),
            Arc::new(sink.clone()),
        ));

        let client2 = client.clone();
        let handle =
            tokio::spawn(async move { client2.send(PiOutbound::GetState { id: None }).await });

        // 确保命令已发出、pending 已注册
        let _ = outbox.recv().await.unwrap();

        client.handle_exit(Some(1)).await;

        let result = tokio::time::timeout(std::time::Duration::from_secs(1), handle)
            .await
            .unwrap()
            .unwrap();
        assert!(result.is_err()); // pending 被拒绝
        assert_eq!(*sink.exits.lock().unwrap(), vec![Some(1)]);
    }

    #[tokio::test]
    async fn kill_propagates_to_transport() {
        let (t, _outbox) = ChannelTransport::new();
        let transport = Arc::new(t);
        let sink = CollectingSink::default();
        let client = PiClient::new("ws1".into(), transport.clone(), Arc::new(sink));
        client.kill().await.unwrap();
        assert!(transport.is_killed());
    }
}
