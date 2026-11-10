//! REQ Client - ZeroMQ 请求响应客户端
//!
//! 向 REP Server 发送请求并接收响应

use zeromq::{ReqSocket, Socket, SocketRecv, SocketSend, ZmqMessage};
use thiserror::Error;

/// REQ Client 错误
#[derive(Debug, Error)]
pub enum ReqClientError {
    #[error("ZeroMQ error: {0}")]
    ZmqError(#[from] zeromq::ZmqError),
    #[error("Connection error: {0}")]
    ConnectionError(String),
    #[error("Timeout")]
    Timeout,
    #[error("Not connected")]
    NotConnected,
}

/// REQ Client 配置
#[derive(Debug, Clone)]
pub struct ReqClientConfig {
    /// REP Server 端点
    pub endpoint: String,
    /// 请求超时 (毫秒)
    pub timeout_ms: u64,
}

impl Default for ReqClientConfig {
    fn default() -> Self {
        Self {
            endpoint: "ipc://myco.rep".to_string(),
            timeout_ms: 10000,
        }
    }
}

/// REQ Client
pub struct ReqClient {
    config: ReqClientConfig,
    socket: Option<ReqSocket>,
}

impl ReqClient {
    pub fn new(config: ReqClientConfig) -> Self {
        Self {
            config,
            socket: None,
        }
    }

    /// 连接到 REP Server
    pub async fn connect(&mut self) -> Result<(), ReqClientError> {
        let mut socket = ReqSocket::new();
        socket.connect(&self.config.endpoint).await
            .map_err(|e| ReqClientError::ConnectionError(e.to_string()))?;

        self.socket = Some(socket);
        tracing::info!("REQ Client connected to {}", self.config.endpoint);
        Ok(())
    }

    /// 发送请求并等待响应
    pub async fn request(&mut self, data: &[u8]) -> Result<Vec<u8>, ReqClientError> {
        let socket = self.socket.as_mut().ok_or(ReqClientError::NotConnected)?;

        let msg = ZmqMessage::from(data.to_vec());
        socket.send(msg).await?;

        let response = socket.recv().await?;
        let result: Vec<u8> = response.into_vec().first()
            .map(|f| f.to_vec())
            .unwrap_or_default();

        Ok(result)
    }

    /// 断开连接
    pub async fn disconnect(&mut self) {
        self.socket = None;
        tracing::info!("REQ Client disconnected");
    }

    /// 检查是否已连接
    pub fn is_connected(&self) -> bool {
        self.socket.is_some()
    }
}
