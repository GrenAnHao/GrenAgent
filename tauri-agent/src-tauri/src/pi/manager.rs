use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::Mutex;

use crate::pi::client::PiClient;

/// 工作区 -> 客户端 的映射。每个工作区复用同一个 pi 进程。
#[derive(Default)]
pub struct PiManager {
    clients: Mutex<HashMap<String, Arc<PiClient>>>,
}

impl PiManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 取已存在的客户端；不存在则用 `factory` 创建并缓存。
    ///
    /// 契约：`factory` 必须快速、非阻塞（不得在其中做 I/O 或 await）——
    /// 它在持有全局 clients 锁期间被调用，慢工厂会阻塞其它工作区的 get/close。
    /// 锁内调用 factory 是有意为之：保证同一新工作区不会被并发重复创建。
    pub async fn get_or_open<F>(&self, workspace: &str, factory: F) -> Result<Arc<PiClient>>
    where
        F: FnOnce() -> Result<Arc<PiClient>>,
    {
        let mut guard = self.clients.lock().await;
        if let Some(c) = guard.get(workspace) {
            return Ok(c.clone());
        }
        let client = factory()?;
        guard.insert(workspace.to_string(), client.clone());
        Ok(client)
    }

    pub async fn get(&self, workspace: &str) -> Option<Arc<PiClient>> {
        self.clients.lock().await.get(workspace).cloned()
    }

    /// 返回所有已打开 workspace 的 (路径, client) 快照，用于向全部 pi 进程广播。
    pub async fn all(&self) -> Vec<(String, Arc<PiClient>)> {
        self.clients
            .lock()
            .await
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    pub async fn close(&self, workspace: &str) {
        if let Some(c) = self.clients.lock().await.remove(workspace) {
            if let Err(e) = c.kill().await {
                eprintln!("[pi:{workspace}] kill failed on close: {e}");
            }
        }
    }

    pub async fn close_all(&self) {
        let mut guard = self.clients.lock().await;
        for (ws, c) in guard.drain() {
            if let Err(e) = c.kill().await {
                eprintln!("[pi:{ws}] kill failed on close_all: {e}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi::sink::CollectingSink;
    use crate::pi::transport::ChannelTransport;
    use std::sync::Arc;

    fn fake_client(ws: &str) -> Arc<PiClient> {
        let (transport, _rx) = ChannelTransport::new();
        Arc::new(PiClient::new(
            ws.into(),
            Arc::new(transport),
            Arc::new(CollectingSink::default()),
        ))
    }

    #[tokio::test]
    async fn reuses_client_per_workspace() {
        let mgr = PiManager::new();
        let c1 = mgr
            .get_or_open("/ws/a", || Ok(fake_client("/ws/a")))
            .await
            .unwrap();
        let c2 = mgr
            .get_or_open("/ws/a", || panic!("should not create twice"))
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&c1, &c2));
    }

    #[tokio::test]
    async fn all_returns_every_open_client() {
        let mgr = PiManager::new();
        mgr.get_or_open("/ws/a", || Ok(fake_client("/ws/a")))
            .await
            .unwrap();
        mgr.get_or_open("/ws/b", || Ok(fake_client("/ws/b")))
            .await
            .unwrap();
        let all = mgr.all().await;
        assert_eq!(all.len(), 2);
        let mut keys: Vec<String> = all.into_iter().map(|(k, _)| k).collect();
        keys.sort();
        assert_eq!(keys, vec!["/ws/a".to_string(), "/ws/b".to_string()]);
    }

    #[tokio::test]
    async fn close_removes_client_and_kills() {
        use crate::pi::transport::ChannelTransport;
        let (t, _rx) = ChannelTransport::new();
        let transport = Arc::new(t);
        let client = Arc::new(PiClient::new(
            "/ws/a".into(),
            transport.clone(),
            Arc::new(CollectingSink::default()),
        ));

        let mgr = PiManager::new();
        mgr.get_or_open("/ws/a", || Ok(client.clone()))
            .await
            .unwrap();
        mgr.close("/ws/a").await;

        assert!(mgr.get("/ws/a").await.is_none());
        assert!(transport.is_killed());
    }
}
