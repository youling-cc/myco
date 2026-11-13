//! Transport - IPC/TCP 传输实现
//!
//! 实现基于 length-delimited framing 的消息传输

use crate::cache::ConnectionError;
use crate::codec::{AgentMessage, AgentMessageCodec};
use crate::connector::{AgentConnection, AgentConnector};
use crate::protocol::{Endpoint, Protocol, Task, TaskResult};
use async_trait::async_trait;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tracing::{debug, error, info};

// 条件编译：Unix 平台使用 UnixStream
// 2026-11-13 A1 后半修（开源 Issue #3）：cfg(unix) 块内用到的 IO trait 与 BytesMut
// 缺 use 导入——Windows 不编译该块所以没暴露，ubuntu CI 挂的根因。
#[cfg(unix)]
use tokio::net::UnixStream;
#[cfg(unix)]
use bytes::BytesMut;
#[cfg(unix)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// IPC (Unix Domain Socket) 连接器
pub struct IpcConnector;

impl IpcConnector {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentConnector for IpcConnector {
    async fn connect(&self, endpoint: &Endpoint) -> Result<Box<dyn AgentConnection>, ConnectionError> {
        if endpoint.protocol != Protocol::Ipc {
            return Err(ConnectionError::ConnectFailed(
                "Protocol mismatch: expected IPC".to_string(),
            ));
        }

        #[cfg(unix)]
        {
            let path = &endpoint.address;
            debug!("Connecting to IPC socket: {}", path);

            match UnixStream::connect(path).await {
                Ok(stream) => {
                    info!("Connected to IPC socket: {}", path);
                    Ok(Box::new(IpcConnection::new(stream, endpoint.clone())))
                }
                Err(e) => {
                    error!("Failed to connect to {}: {}", path, e);
                    Err(ConnectionError::ConnectFailed(e.to_string()))
                }
            }
        }

        #[cfg(not(unix))]
        {
            tracing::warn!("IPC not supported on Windows, using TCP fallback");
            Err(ConnectionError::ConnectFailed(
                "IPC not supported on Windows, use TCP".to_string()
            ))
        }
    }
}

impl Default for IpcConnector {
    fn default() -> Self {
        Self::new()
    }
}

/// IPC 连接实现
#[cfg(unix)]
pub struct IpcConnection {
    stream: Arc<Mutex<UnixStream>>,
    endpoint: Endpoint,
    codec: Mutex<AgentMessageCodec>,
}

#[cfg(unix)]
impl IpcConnection {
    fn new(stream: UnixStream, endpoint: Endpoint) -> Self {
        Self {
            stream: Arc::new(Mutex::new(stream)),
            endpoint,
            codec: Mutex::new(AgentMessageCodec::new()),
        }
    }

    async fn send_message(&self, msg: &AgentMessage) -> Result<(), ConnectionError> {
        let mut buf = BytesMut::new();
        self.codec.lock().await.encode(msg.clone(), &mut buf).map_err(|e| {
            ConnectionError::ConnectFailed(format!("Encode error: {}", e))
        })?;

        let mut stream = self.stream.lock().await;

        // 发送长度前缀
        let len = buf.len() as u32;
        stream.write_all(&len.to_be_bytes()).await.map_err(|e| {
            ConnectionError::ConnectFailed(format!("Write error: {}", e))
        })?;

        // 发送数据
        stream.write_all(&buf).await.map_err(|e| {
            ConnectionError::ConnectFailed(format!("Write error: {}", e))
        })?;

        Ok(())
    }

    async fn recv_message(&self) -> Result<AgentMessage, ConnectionError> {
        let mut stream = self.stream.lock().await;

        // 读取长度前缀
        let mut len_buf = [0u8; 4];
        stream.read_exact(&mut len_buf).await.map_err(|e| {
            ConnectionError::ConnectFailed(format!("Read error: {}", e))
        })?;
        let len = u32::from_be_bytes(len_buf) as usize;

        if len > 10 * 1024 * 1024 { // 10MB limit
            return Err(ConnectionError::ConnectFailed("Message too large".to_string()));
        }

        // 读取数据
        let mut buf = vec![0u8; len];
        stream.read_exact(&mut buf).await.map_err(|e| {
            ConnectionError::ConnectFailed(format!("Read error: {}", e))
        })?;

        drop(stream); // 释放锁

        let mut bytes_mut = BytesMut::from(&buf[..]);
        self.codec.lock().await.decode(&mut bytes_mut).map_err(|e| {
            ConnectionError::ConnectFailed(format!("Decode error: {}", e))
        })?.ok_or_else(|| ConnectionError::ConnectFailed("Incomplete message".to_string()))
    }
}

#[cfg(unix)]
#[async_trait]
impl AgentConnection for IpcConnection {
    async fn invoke(&self, task: Task) -> Result<TaskResult, ConnectionError> {
        let start = Instant::now();
        // 2026-11-13 A1 修（开源 Issue #3）：对齐 codec.rs 新形状——
        // Invoke { task: Task } 替代旧 InvokeRequest { task_id, skill, input, context }；
        // InvokeResponse 不再带 task_id。
        let request = AgentMessage::Invoke { task };

        // 发送请求
        self.send_message(&request).await?;

        // 等待响应
        match self.recv_message().await? {
            AgentMessage::InvokeResponse {
                success,
                output,
                error,
                ..
            } => {
                Ok(TaskResult {
                    output,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    success,
                    error,
                })
            }
            AgentMessage::Error { code, message } => {
                Err(ConnectionError::ConnectFailed(format!("{}: {}", code, message)))
            }
            _ => {
                Err(ConnectionError::ConnectFailed("Unexpected response type".to_string()))
            }
        }
    }

    async fn close(&self) -> Result<(), ConnectionError> {
        let mut stream = self.stream.lock().await;
        stream.shutdown().await.ok();
        Ok(())
    }

    fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    async fn health_check(&self) -> Result<bool, ConnectionError> {
        Ok(true)
    }
}

// Windows 占位实现
#[cfg(not(unix))]
pub struct IpcConnection {
    endpoint: Endpoint,
}

#[cfg(not(unix))]
#[async_trait]
impl AgentConnection for IpcConnection {
    async fn invoke(&self, _task: Task) -> Result<TaskResult, ConnectionError> {
        Err(ConnectionError::ConnectFailed("IPC not supported".to_string()))
    }

    async fn close(&self) -> Result<(), ConnectionError> {
        Ok(())
    }

    fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    async fn health_check(&self) -> Result<bool, ConnectionError> {
        Ok(false)
    }
}

/// TCP 连接器
pub struct TcpConnector;

impl TcpConnector {
    pub fn new() -> Self {
        Self
    }
}

#[async_trait]
impl AgentConnector for TcpConnector {
    async fn connect(&self, endpoint: &Endpoint) -> Result<Box<dyn AgentConnection>, ConnectionError> {
        use tokio::net::TcpStream;

        if endpoint.protocol != Protocol::Tcp {
            return Err(ConnectionError::ConnectFailed(
                "Protocol mismatch: expected TCP".to_string(),
            ));
        }

        // Strip "tcp://" prefix for TcpStream::bind
        let addr = endpoint.address
            .strip_prefix("tcp://")
            .unwrap_or(&endpoint.address);

        debug!("Connecting to TCP: {}", addr);

        match TcpStream::connect(addr).await {
            Ok(stream) => {
                info!("Connected to TCP: {}", endpoint.address);
                Ok(Box::new(TcpConnection::new(stream, endpoint.clone())))
            }
            Err(e) => {
                error!("Failed to connect to {}: {}", endpoint.address, e);
                Err(ConnectionError::ConnectFailed(e.to_string()))
            }
        }
    }
}

impl Default for TcpConnector {
    fn default() -> Self {
        Self::new()
    }
}

/// TCP 连接实现 — 使用 Framed 进行读写（与 server 端一致）
pub struct TcpConnection {
    framed: Arc<Mutex<tokio_util::codec::Framed<tokio::net::TcpStream, AgentMessageCodec>>>,
    endpoint: Endpoint,
}

impl TcpConnection {
    fn new(stream: tokio::net::TcpStream, endpoint: Endpoint) -> Self {
        Self {
            framed: Arc::new(Mutex::new(tokio_util::codec::Framed::new(stream, AgentMessageCodec::new()))),
            endpoint,
        }
    }
}

#[async_trait]
impl AgentConnection for TcpConnection {
    async fn invoke(&self, task: Task) -> Result<TaskResult, ConnectionError> {
        use futures::SinkExt;
        use futures::StreamExt;

        let start = Instant::now();

        let request = AgentMessage::Invoke {
            task,
        };

        // 发送请求
        {
            let mut framed = self.framed.lock().await;
            framed.send(request).await.map_err(|e| {
                ConnectionError::ConnectFailed(format!("Send error: {}", e))
            })?;
        }

        // 等待响应
        let response = {
            let mut framed = self.framed.lock().await;
            match framed.next().await {
                Some(Ok(msg)) => msg,
                Some(Err(e)) => {
                    return Err(ConnectionError::ConnectFailed(format!("Recv error: {}", e)));
                }
                None => {
                    return Err(ConnectionError::ConnectFailed("Connection closed".to_string()));
                }
            }
        };

        match response {
            AgentMessage::InvokeResponse {
                success,
                output,
                error,
                ..
            } => {
                Ok(TaskResult {
                    output,
                    execution_time_ms: start.elapsed().as_millis() as u64,
                    success,
                    error,
                })
            }
            AgentMessage::Error { code, message } => {
                Err(ConnectionError::ConnectFailed(format!("{}: {}", code, message)))
            }
            _ => {
                Err(ConnectionError::ConnectFailed("Unexpected response type".to_string()))
            }
        }
    }

    async fn close(&self) -> Result<(), ConnectionError> {
        use futures::SinkExt;
        let mut framed = self.framed.lock().await;
        framed.close().await.ok();
        Ok(())
    }

    fn endpoint(&self) -> &Endpoint {
        &self.endpoint
    }

    async fn health_check(&self) -> Result<bool, ConnectionError> {
        Ok(true)
    }
}
