use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::Mutex;

use crate::state::AppState;

fn is_preserved_runtime_key(key: &str) -> bool {
    key == "APPROVAL_POLICY"
        || key.starts_with("APPROVAL_POLICY:")
        || key == "AGENT_MODE"
        || key.starts_with("AGENT_MODE:")
        || key.starts_with("CONTEXT_EXCLUSION_OP:")
}

fn read_runtime_map(path: &Path) -> HashMap<String, String> {
    let Ok(text) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    match serde_json::from_str::<HashMap<String, String>>(&text) {
        Ok(map) => map,
        Err(_) => HashMap::new(),
    }
}

fn write_runtime_map(path: &Path, map: &HashMap<String, String>) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match serde_json::to_string_pretty(map) {
        Ok(json) => {
            let tmp = path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
        Err(e) => eprintln!("[runtime-config] serialize failed: {e}"),
    }
}

/// 线程安全的 AppState 持有者 + 持久化路径。作为 Tauri managed state。
#[derive(Clone)]
pub struct AppStateStore {
    inner: Arc<Mutex<AppState>>,
    path: PathBuf,
    runtime_path: PathBuf,
}

impl AppStateStore {
    pub fn new(path: PathBuf) -> Self {
        let state = AppState::load(&path);
        let runtime_path = path
            .parent()
            .map(|p| p.join("runtime-settings.json"))
            .unwrap_or_else(|| PathBuf::from("runtime-settings.json"));
        Self {
            inner: Arc::new(Mutex::new(state)),
            path,
            runtime_path,
        }
    }

    /// 修改并立即持久化（错误打印，不致命）。
    pub async fn update<F: FnOnce(&mut AppState)>(&self, f: F) {
        let mut guard = self.inner.lock().await;
        f(&mut guard);
        if let Err(e) = guard.save(&self.path) {
            eprintln!("[app-state] save failed: {e}");
        }
    }

    pub async fn last_session_for(&self, workspace: &str) -> Option<String> {
        self.inner
            .lock()
            .await
            .last_session(workspace)
            .map(str::to_string)
    }

    pub async fn is_approved(&self, workspace: &str) -> bool {
        self.inner.lock().await.is_workspace_approved(workspace)
    }

    /// 读取要注入 sidecar 的 env 设置（已过滤空值）。
    pub async fn settings_env(&self) -> std::collections::HashMap<String, String> {
        self.inner.lock().await.settings_env()
    }

    /// 读取完整设置表（含空值，供前端表单回填）。
    pub async fn settings_all(&self) -> std::collections::HashMap<String, String> {
        self.inner.lock().await.settings.clone()
    }

    /// 整体替换设置并持久化。
    pub async fn replace_settings(&self, settings: std::collections::HashMap<String, String>) {
        self.update(|st| st.replace_settings(settings)).await;
    }


    /// 运行时配置文件路径（注入 sidecar 供扩展热更新读取）。
    pub fn runtime_path(&self) -> PathBuf {
        self.runtime_path.clone()
    }

    /// 把当前 settings_env 原子写到运行时配置文件，供扩展热更新读取。
    pub async fn write_runtime_config(&self) {
        let env = self.settings_env().await;
        let path = self.runtime_path.clone();
        let preserved: HashMap<String, String> = read_runtime_map(&path)
            .into_iter()
            .filter(|(key, _)| is_preserved_runtime_key(key))
            .collect();
        let mut merged = env;
        for (key, value) in preserved {
            merged.entry(key).or_insert(value);
        }
        write_runtime_map(&path, &merged);
    }

    /// 合并写入运行时配置（审批切换走侧信道，不发假 prompt）。
    pub async fn merge_runtime_patch(&self, patch: HashMap<String, String>) {
        let path = self.runtime_path.clone();
        let mut current = read_runtime_map(&path);
        current.extend(patch);
        write_runtime_map(&path, &current);
    }
}
