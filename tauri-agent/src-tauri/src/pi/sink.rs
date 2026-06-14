use serde_json::{json, Value};

/// PiClient 把要送到前端的内容交给 EventSink。
/// `workspace` 用于前端路由。
pub trait EventSink: Send + Sync + 'static {
    fn emit_event(&self, workspace: &str, event: &Value);
    fn emit_ui_request(&self, workspace: &str, request: &Value);
    fn emit_exit(&self, workspace: &str, code: Option<i32>);
}

/// 生产实现：通过 Tauri AppHandle 发事件。
pub struct TauriSink {
    pub app: tauri::AppHandle,
}

impl EventSink for TauriSink {
    fn emit_event(&self, workspace: &str, event: &Value) {
        use tauri::Emitter;
        let _ = self.app.emit(
            "pi://event",
            json!({ "workspace": workspace, "event": event }),
        );
    }
    fn emit_ui_request(&self, workspace: &str, request: &Value) {
        use tauri::Emitter;
        let _ = self.app.emit(
            "pi://ui-request",
            json!({ "workspace": workspace, "request": request }),
        );
    }
    fn emit_exit(&self, workspace: &str, code: Option<i32>) {
        use tauri::Emitter;
        let _ = self
            .app
            .emit("pi://exit", json!({ "workspace": workspace, "code": code }));
    }
}

/// 测试用：收集发出的内容。
#[cfg(test)]
#[derive(Default, Clone)]
pub struct CollectingSink {
    pub events: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    pub ui_requests: std::sync::Arc<std::sync::Mutex<Vec<Value>>>,
    pub exits: std::sync::Arc<std::sync::Mutex<Vec<Option<i32>>>>,
}

#[cfg(test)]
impl EventSink for CollectingSink {
    fn emit_event(&self, _workspace: &str, event: &Value) {
        self.events.lock().unwrap().push(event.clone());
    }
    fn emit_ui_request(&self, _workspace: &str, request: &Value) {
        self.ui_requests.lock().unwrap().push(request.clone());
    }
    fn emit_exit(&self, _workspace: &str, code: Option<i32>) {
        self.exits.lock().unwrap().push(code);
    }
}
