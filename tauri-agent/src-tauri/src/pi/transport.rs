use anyhow::Result;
use async_trait::async_trait;
#[cfg(test)]
use tokio::sync::mpsc;

/// 与 pi 进程的出站 JSONL 传输（写入命令 + 终止进程）。
/// 读取入站行不在此 trait：由 sidecar 读取循环把 stdout 喂给 `PiClient::handle_line`。
#[async_trait]
pub trait PiTransport: Send + Sync + 'static {
    /// 写入一行 JSON（实现负责追加 `\n`）。
    async fn write_line(&self, line: String) -> Result<()>;
    /// 终止底层进程。
    async fn kill(&self) -> Result<()>;
}

/// 测试用内存传输：写入的行进入 `outbox`，可注入收到的行/退出。
#[cfg(test)]
pub struct ChannelTransport {
    pub outbox: mpsc::UnboundedSender<String>,
    killed: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl ChannelTransport {
    pub fn new() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        (
            Self {
                outbox: tx,
                killed: std::sync::atomic::AtomicBool::new(false),
            },
            rx,
        )
    }

    /// 测试用：是否已调用过 kill。
    pub fn is_killed(&self) -> bool {
        self.killed.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[cfg(test)]
#[async_trait]
impl PiTransport for ChannelTransport {
    async fn write_line(&self, line: String) -> Result<()> {
        self.outbox.send(line)?;
        Ok(())
    }
    async fn kill(&self) -> Result<()> {
        self.killed.store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }
}
