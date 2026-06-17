use std::collections::HashMap;
use std::collections::HashSet;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// 仅存应用级元数据，会话本身由 pi 管理。
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct AppState {
    #[serde(default)]
    pub recent_workspaces: Vec<String>,
    /// workspace -> 最后活跃会话文件路径
    #[serde(default)]
    pub last_sessions: HashMap<String, String>,
    #[serde(default)]
    pub window: Option<WindowState>,
    #[serde(default)]
    pub approved_workspaces: HashSet<String>,
    /// extension env 设置（key=env 名，value=字符串值；空值视为未设）。
    #[serde(default)]
    pub settings: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
}

impl AppState {
    /// 读取；文件缺失返回默认；文件存在但解析失败则告警后返回默认。
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                eprintln!(
                    "[app-state] failed to parse {}: {e}; using defaults",
                    path.display()
                );
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(self)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// 把工作区移到最近列表最前（去重，最多 20 条）。
    pub fn touch_workspace(&mut self, ws: &str) {
        self.recent_workspaces.retain(|w| w != ws);
        self.recent_workspaces.insert(0, ws.to_string());
        self.recent_workspaces.truncate(20);
    }

    pub fn set_last_session(&mut self, ws: &str, session_path: &str) {
        self.last_sessions
            .insert(ws.to_string(), session_path.to_string());
    }

    pub fn last_session(&self, ws: &str) -> Option<&str> {
        self.last_sessions.get(ws).map(|s| s.as_str())
    }

    /// 从 recent_workspaces + last_sessions 中彻底移除一个 workspace。
    pub fn forget_workspace(&mut self, ws: &str) {
        self.recent_workspaces.retain(|w| w != ws);
        self.last_sessions.remove(ws);
    }

    pub fn is_workspace_approved(&self, path: &str) -> bool {
        self.approved_workspaces.contains(path)
    }

    pub fn approve_workspace(&mut self, path: String) {
        self.approved_workspaces.insert(path);
    }

    /// 整体替换 env 设置（前端每次提交完整表单）。
    pub fn replace_settings(&mut self, settings: HashMap<String, String>) {
        self.settings = settings;
    }

    /// 返回要注入 sidecar 的 env（过滤空值/空白）。
    /// titleModel 也注入：sidecar 内的 auto-title 扩展据此选标题模型（经 getConfig 读取）。
    pub fn settings_env(&self) -> HashMap<String, String> {
        self.settings
            .iter()
            .filter(|(_, v)| !v.trim().is_empty())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_recent_workspaces() {
        let dir = std::env::temp_dir().join(format!("pi-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app-state.json");

        let mut st = AppState::load(&path);
        st.touch_workspace("/ws/a");
        st.set_last_session("/ws/a", "/sessions/a.jsonl");
        st.save(&path).unwrap();

        let reloaded = AppState::load(&path);
        assert_eq!(
            reloaded.recent_workspaces.first().map(|s| s.as_str()),
            Some("/ws/a")
        );
        assert_eq!(reloaded.last_session("/ws/a"), Some("/sessions/a.jsonl"));
    }

    #[test]
    fn forget_workspace_removes_recent_and_last_session() {
        let mut st = AppState::default();
        st.touch_workspace("/ws/a");
        st.set_last_session("/ws/a", "/sessions/a.jsonl");
        st.forget_workspace("/ws/a");
        assert!(!st.recent_workspaces.iter().any(|w| w == "/ws/a"));
        assert!(st.last_session("/ws/a").is_none());
    }

    #[test]
    fn load_missing_file_returns_default() {
        let st = AppState::load(std::path::Path::new("/nonexistent/app-state.json"));
        assert!(st.recent_workspaces.is_empty());
    }

    #[test]
    fn touch_workspace_dedups_and_truncates_to_20() {
        let mut st = AppState::default();
        for i in 0..25 {
            st.touch_workspace(&format!("/ws/{i}"));
        }
        assert_eq!(st.recent_workspaces.len(), 20);
        assert_eq!(st.recent_workspaces[0], "/ws/24"); // 最近的置顶
                                                       // 重新 touch 一个已存在的：应置顶且不重复
        st.touch_workspace("/ws/10");
        assert_eq!(st.recent_workspaces[0], "/ws/10");
        assert_eq!(
            st.recent_workspaces
                .iter()
                .filter(|w| w.as_str() == "/ws/10")
                .count(),
            1
        );
    }

    #[test]
    fn settings_roundtrip_and_env_filters_empty() {
        let dir = std::env::temp_dir().join(format!("pi-set-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("app-state.json");

        let mut st = AppState::load(&path);
        let mut m = HashMap::new();
        m.insert("OPENAI_API_KEY".to_string(), "sk-x".to_string());
        m.insert("IMAGE_SIZE".to_string(), "  ".to_string());
        m.insert("titleModel".to_string(), "anthropic/claude-haiku".to_string());
        st.replace_settings(m);
        st.save(&path).unwrap();

        let reloaded = AppState::load(&path);
        assert_eq!(
            reloaded.settings.get("OPENAI_API_KEY").map(|s| s.as_str()),
            Some("sk-x")
        );
        let env = reloaded.settings_env();
        assert_eq!(env.get("OPENAI_API_KEY").map(|s| s.as_str()), Some("sk-x"));
        assert!(!env.contains_key("IMAGE_SIZE"));
        // titleModel 现在也注入 sidecar（供 auto-title 扩展读取标题模型）。
        assert_eq!(
            env.get("titleModel").map(|s| s.as_str()),
            Some("anthropic/claude-haiku")
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
