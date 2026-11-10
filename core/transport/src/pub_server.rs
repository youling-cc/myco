//! PUB Server - ZeroMQ 发布订阅服务端
//!
//! 向订阅者广播事件

use zeromq::{PubSocket, Socket, SocketSend, ZmqMessage};
use std::sync::Arc;
use tokio::sync::Mutex;
use thiserror::Error;

/// PUB Server 错误
#[derive(Debug, Error)]
pub enum PubServerError {
    #[error("ZeroMQ error: {0}")]
    ZmqError(#[from] zeromq::ZmqError),
    #[error("Server not running")]
    NotRunning,
    #[error("Bind error: {0}")]
    BindError(String),
}

/// PUB Server 配置
#[derive(Debug, Clone)]
pub struct PubServerConfig {
    /// IPC 端点
    pub endpoint: String,
}

impl Default for PubServerConfig {
    fn default() -> Self {
        Self {
            endpoint: "ipc://myco.pub".to_string(),
        }
    }
}

/// PUB Server
pub struct PubServer {
    config: PubServerConfig,
    socket: Arc<Mutex<Option<PubSocket>>>,
}

impl PubServer {
    pub fn new(config: PubServerConfig) -> Self {
        Self {
            config,
            socket: Arc::new(Mutex::new(None)),
        }
    }

    /// 启动服务器
    pub async fn start(&self) -> Result<(), PubServerError> {
        let mut socket = PubSocket::new();
        socket.bind(&self.config.endpoint).await
            .map_err(|e| PubServerError::BindError(e.to_string()))?;

        *self.socket.lock().await = Some(socket);
        tracing::info!("PUB Server started on {}", self.config.endpoint);
        Ok(())
    }

    /// 发布消息
    pub async fn publish(&self, topic: &str, data: &[u8]) -> Result<(), PubServerError> {
        let mut socket_guard = self.socket.lock().await;
        let socket = socket_guard.as_mut().ok_or(PubServerError::NotRunning)?;

        // 组合 topic + data
        let mut msg_data = topic.as_bytes().to_vec();
        msg_data.push(0); // 分隔符
        msg_data.extend_from_slice(data);

        let msg = ZmqMessage::from(msg_data);
        socket.send(msg).await?;

        tracing::trace!("Published to topic {}: {} bytes", topic, data.len());
        Ok(())
    }

    /// 停止服务器
    pub async fn stop(&self) -> Result<(), PubServerError> {
        *self.socket.lock().await = None;
        tracing::info!("PUB Server stopped");
        Ok(())
    }
}
