//! SUB Client - ZeroMQ 发布订阅客户端
//!
//! 订阅 PUB Server 的消息

use zeromq::{SubSocket, Socket, SocketRecv, ZmqMessage};
use thiserror::Error;

/// SUB Client 错误
#[derive(Debug, Error)]
pub enum SubClientError {
    #[error("ZeroMQ error: {0}")]
    ZmqError(#[from] zeromq::ZmqError),
    #[error("Connection error: {0}")]
    ConnectionError(String),
    #[error("Not connected")]
    NotConnected,
}

/// SUB Client 配置
#[derive(Debug, Clone)]
pub struct SubClientConfig {
    /// PUB Server 端点
    pub endpoint: String,
}

impl Default for SubClientConfig {
    fn default() -> Self {
        Self {
            endpoint: "ipc://myco.pub".to_string(),
        }
    }
}

/// SUB Client
pub struct SubClient {
    config: SubClientConfig,
    socket: Option<SubSocket>,
}

impl SubClient {
    pub fn new(config: SubClientConfig) -> Self {
        Self {
            config,
            socket: None,
        }
    }

    /// 连接并订阅
    pub async fn connect(&mut self, topics: &[&str]) -> Result<(), SubClientError> {
        let mut socket = SubSocket::new();

        socket.connect(&self.config.endpoint).await
            .map_err(|e| SubClientError::ConnectionError(e.to_string()))?;

        // 订阅指定 topic
        for topic in topics {
            socket.subscribe(topic).await
                .map_err(|e| SubClientError::ConnectionError(e.to_string()))?;
            tracing::debug!("Subscribed to topic: {}", topic);
        }

        self.socket = Some(socket);
        tracing::info!("SUB Client connected to {}", self.config.endpoint);
        Ok(())
    }

    /// 接收消息
    pub async fn receive(&mut self) -> Result<(String, Vec<u8>), SubClientError> {
        let socket = self.socket.as_mut().ok_or(SubClientError::NotConnected)?;

        let msg = socket.recv().await?;
        let data: Vec<u8> = msg.into_vec().first()
            .map(|f| f.to_vec())
            .unwrap_or_default();

        // 解析 topic + data
        if let Some(pos) = data.iter().position(|&b| b == 0) {
            let topic = String::from_utf8_lossy(&data[..pos]).to_string();
            let payload = data[pos + 1..].to_vec();
            Ok((topic, payload))
        } else {
            Ok((String::new(), data))
        }
    }

    /// 断开连接
    pub async fn disconnect(&mut self) {
        self.socket = None;
        tracing::info!("SUB Client disconnected");
    }
}
