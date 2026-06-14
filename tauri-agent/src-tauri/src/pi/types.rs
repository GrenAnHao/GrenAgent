use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 发往 pi（stdin）的命令。序列化为 RPC JSON，省略 None 字段。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PiOutbound {
    Prompt {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<Value>>,
        #[serde(rename = "streamingBehavior", skip_serializing_if = "Option::is_none")]
        streaming_behavior: Option<String>,
    },
    Steer {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    FollowUp {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
    },
    Abort {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    NewSession {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SwitchSession {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(rename = "sessionPath")]
        session_path: String,
    },
    Fork {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(rename = "entryId")]
        entry_id: String,
    },
    Clone {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetForkMessages {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetSessionName {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        name: String,
    },
    GetState {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetMessages {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetSessionStats {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetCommands {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetAvailableModels {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    CycleModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetThinkingLevel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        level: String,
    },
    CycleThinkingLevel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    Compact {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(rename = "customInstructions", skip_serializing_if = "Option::is_none")]
        custom_instructions: Option<String>,
    },
    SetAutoCompaction {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        enabled: bool,
    },
    AbortRetry {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
}

/// pi RPC 命令成功/失败响应。
#[derive(Debug, Clone, Deserialize)]
pub struct RpcResponse {
    #[serde(default)]
    pub id: Option<String>,
    pub command: String,
    pub success: bool,
    #[serde(default)]
    pub data: Option<Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// extension UI 请求（原样转发前端，保留所有字段）。
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ExtensionUiRequest {
    pub id: String,
    pub method: String,
    #[serde(flatten)]
    pub rest: Value,
}

/// 从 pi（stdout）读到的一行 JSON 的分类结果。
#[derive(Debug, Clone)]
pub enum PiInbound {
    Response(RpcResponse),
    ExtensionUiRequest(ExtensionUiRequest),
    /// 其余所有 agent 事件，原样转发前端。
    Event(Value),
}

impl<'de> Deserialize<'de> for PiInbound {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let ty = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match ty {
            "response" => {
                let r: RpcResponse =
                    serde_json::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(PiInbound::Response(r))
            }
            "extension_ui_request" => {
                let r: ExtensionUiRequest =
                    serde_json::from_value(value).map_err(serde::de::Error::custom)?;
                Ok(PiInbound::ExtensionUiRequest(r))
            }
            _ => Ok(PiInbound::Event(value)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_prompt_command_with_id() {
        let cmd = PiOutbound::Prompt {
            id: Some("r1".into()),
            message: "hello".into(),
            images: None,
            streaming_behavior: None,
        };
        let json = serde_json::to_string(&cmd).unwrap();
        assert!(json.contains("\"type\":\"prompt\""));
        assert!(json.contains("\"id\":\"r1\""));
        assert!(json.contains("\"message\":\"hello\""));
        assert!(!json.contains("images"));
        assert!(!json.contains("streamingBehavior"));
    }

    #[test]
    fn parses_response_inbound() {
        let line = r#"{"id":"r1","type":"response","command":"prompt","success":true}"#;
        let inbound: PiInbound = serde_json::from_str(line).unwrap();
        match inbound {
            PiInbound::Response(r) => {
                assert_eq!(r.id.as_deref(), Some("r1"));
                assert_eq!(r.command, "prompt");
                assert!(r.success);
            }
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn parses_extension_ui_request_inbound() {
        let line = r#"{"type":"extension_ui_request","id":"u1","method":"confirm","title":"OK?"}"#;
        let inbound: PiInbound = serde_json::from_str(line).unwrap();
        assert!(matches!(inbound, PiInbound::ExtensionUiRequest(_)));
    }

    #[test]
    fn parses_event_inbound_as_raw() {
        let line = r#"{"type":"message_update","message":{},"assistantMessageEvent":{"type":"text_delta","delta":"hi"}}"#;
        let inbound: PiInbound = serde_json::from_str(line).unwrap();
        match inbound {
            PiInbound::Event(v) => assert_eq!(v["type"], "message_update"),
            _ => panic!("expected event"),
        }
    }

    #[test]
    fn serializes_renamed_required_fields() {
        let s = serde_json::to_string(&PiOutbound::SwitchSession {
            id: None,
            session_path: "/p/a.jsonl".into(),
        })
        .unwrap();
        assert!(s.contains("\"sessionPath\":\"/p/a.jsonl\""), "got: {s}");

        let m = serde_json::to_string(&PiOutbound::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude".into(),
        })
        .unwrap();
        assert!(m.contains("\"modelId\":\"claude\""), "got: {m}");

        let f = serde_json::to_string(&PiOutbound::Fork {
            id: None,
            entry_id: "e1".into(),
        })
        .unwrap();
        assert!(f.contains("\"entryId\":\"e1\""), "got: {f}");
    }

    #[test]
    fn unknown_or_missing_type_falls_back_to_event() {
        let unknown: PiInbound =
            serde_json::from_str(r#"{"type":"totally_new_event","x":1}"#).unwrap();
        assert!(matches!(unknown, PiInbound::Event(_)));

        let missing: PiInbound = serde_json::from_str(r#"{"foo":"bar"}"#).unwrap();
        assert!(matches!(missing, PiInbound::Event(_)));
    }
}
