//! REP Server - ZeroMQ 请求响应服务端
//!
//! 处理来自客户端的请求并返回响应

use zeromq::{RepSocket, Socket, SocketRecv, SocketSend, ZmqMessage};
use std::sync::Arc;
use std::future::Future;
use std::pin::Pin;
use tokio::sync::{Mutex, broadcast};
use thiserror::Error;

/// REP Server 错误
#[derive(Debug, Error)]
pub enum RepServerError {
    #[error("ZeroMQ error: {0}")]
    ZmqError(#[from] zeromq::ZmqError),
    #[error("Server not running")]
    NotRunning,
    #[error("Bind error: {0}")]
    BindError(String),
}

/// REP Server 配置
#[derive(Debug, Clone)]
pub struct RepServerConfig {
    /// IPC 端点 (如 "ipc://myco-pomdp.rep")
    pub endpoint: String,
}

impl Default for RepServerConfig {
    fn default() -> Self {
        Self {
            endpoint: "ipc://myco.rep".to_string(),
        }
    }
}

/// REP Server
pub struct RepServer {
    config: RepServerConfig,
    running: Arc<Mutex<bool>>,
    stop_signal: broadcast::Sender<()>,
}

impl RepServer {
    pub fn new(config: RepServerConfig) -> Self {
        let (stop_signal, _) = broadcast::channel(1);
        Self {
            config,
            running: Arc::new(Mutex::new(false)),
            stop_signal,
        }
    }

    /// 启动服务器并处理请求
    pub async fn start<F, Fut>(&self, handler: F) -> Result<(), RepServerError>
    where
        F: Fn(Vec<u8>) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Vec<u8>> + Send + 'static,
    {
        let mut running = self.running.lock().await;
        if *running {
            return Ok(());
        }

        let mut socket = RepSocket::new();
        socket.bind(&self.config.endpoint).await
            .map_err(|e| RepServerError::BindError(e.to_string()))?;

        *running = true;
        tracing::info!("REP Server started on {}", self.config.endpoint);

        let running_arc = self.running.clone();
        let mut stop_rx = self.stop_signal.subscribe();

        // 启动处理循环
        tokio::spawn(async move {
            loop {
                // 检查停止信号
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                if !*running_arc.lock().await {
                    break;
                }

                // 接收请求并发送响应
                match socket.recv().await {
                    Ok(msg) => {
                        let request: Vec<u8> = msg.into_vec().first()
                            .map(|f| f.to_vec())
                            .unwrap_or_default();

                        let response = handler(request).await;
                        let response_msg = ZmqMessage::from(response);

                        if let Err(e) = socket.send(response_msg).await {
                            tracing::error!("Failed to send response: {}", e);
                        }
                    }
                    Err(e) => {
                        tracing::debug!("Receive error: {}", e);
                    }
                }
            }

            tracing::info!("REP Server loop ended");
        });

        Ok(())
    }

    /// 停止服务器
    pub async fn stop(&self) -> Result<(), RepServerError> {
        let mut running = self.running.lock().await;
        if !*running {
            return Ok(());
        }

        let _ = self.stop_signal.send(());
        *running = false;

        tracing::info!("REP Server stopped");
        Ok(())
    }

    /// 检查是否运行中
    pub async fn is_running(&self) -> bool {
        *self.running.lock().await
    }
}
