//! Connector - Agent 连接器

use crate::cache::ConnectionError;
use crate::protocol::{Endpoint, Protocol, Task, TaskResult, DID};
use async_trait::async_trait;
use std::sync::Arc;
use tracing::debug;

/// Agent 连接 trait
#[async_trait]
pub trait AgentConnection: Send + Sync {
    /// 调用 Agent 执行任务
    async fn invoke(&self, task: Task) -> Result<TaskResult, ConnectionError>;

    /// 关闭连接
    async fn close(&self) -> Result<(), ConnectionError>;

    /// 获取端点信息
    fn endpoint(&self) -> &Endpoint;

    /// 检查健康状态
    async fn health_check(&self) -> Result<bool, ConnectionError>;

    /// 是否健康（简化版）
    fn is_healthy(&self) -> bool {
        true
    }
}

/// Agent 连接器 trait
#[async_trait]
pub trait AgentConnector: Send + Sync {
    /// 连接到指定端点
    async fn connect(&self, endpoint: &Endpoint) -> Result<Box<dyn AgentConnection>, ConnectionError>;

    /// 连接到指定 DID（自动选择最优端点）
    async fn connect_did(
        &self,
        _did: &DID,
        endpoints: Vec<Endpoint>,
    ) -> Result<Box<dyn AgentConnection>, ConnectionError> {
        // 按优先级排序
        let mut endpoints = endpoints;
        endpoints.sort_by_key(|e| e.priority);

        // 尝试连接，直到成功
        for endpoint in endpoints {
            match self.connect(&endpoint).await {
                Ok(conn) => return Ok(conn),
                Err(e) => {
                    debug!("Failed to connect to {:?}: {}", endpoint, e);
                    continue;
                }
            }
        }

        Err(ConnectionError::ConnectFailed(
            "All endpoints failed".to_string(),
        ))
    }
}

/// 通用 Agent 连接器
pub struct DefaultAgentConnector {
    /// IPC 连接器
    ipc_connector: Option<Arc<dyn AgentConnector>>,
    /// TCP 连接器
    tcp_connector: Option<Arc<dyn AgentConnector>>,
}

impl DefaultAgentConnector {
    pub fn new() -> Self {
        Self {
            ipc_connector: None,
            tcp_connector: None,
        }
    }

    pub fn with_ipc(mut self, connector: Arc<dyn AgentConnector>) -> Self {
        self.ipc_connector = Some(connector);
        self
    }

    pub fn with_tcp(mut self, connector: Arc<dyn AgentConnector>) -> Self {
        self.tcp_connector = Some(connector);
        self
    }
}

#[async_trait]
impl AgentConnector for DefaultAgentConnector {
    async fn connect(&self, endpoint: &Endpoint) -> Result<Box<dyn AgentConnection>, ConnectionError> {
        match endpoint.protocol {
            Protocol::Ipc => {
                if let Some(connector) = &self.ipc_connector {
                    connector.connect(endpoint).await
                } else {
                    Err(ConnectionError::ConnectFailed(
                        "IPC connector not configured".to_string(),
                    ))
                }
            }
            Protocol::Tcp => {
                if let Some(connector) = &self.tcp_connector {
                    connector.connect(endpoint).await
                } else {
                    Err(ConnectionError::ConnectFailed(
                        "TCP connector not configured".to_string(),
                    ))
                }
            }
            _ => Err(ConnectionError::ConnectFailed(format!(
                "Protocol {:?} not supported",
                endpoint.protocol
            ))),
        }
    }
}

impl Default for DefaultAgentConnector {
    fn default() -> Self {
        Self::new()
    }
}

/// 连接包装器（带缓存）
pub struct CachedAgentConnection {
    inner: Box<dyn AgentConnection>,
    did: DID,
}

impl CachedAgentConnection {
    pub fn new(inner: Box<dyn AgentConnection>, did: DID) -> Self {
        Self { inner, did }
    }

    pub fn did(&self) -> &DID {
        &self.did
    }
}

#[async_trait]
impl AgentConnection for CachedAgentConnection {
    async fn invoke(&self, task: Task) -> Result<TaskResult, ConnectionError> {
        self.inner.invoke(task).await
    }

    async fn close(&self) -> Result<(), ConnectionError> {
        self.inner.close().await
    }

    fn endpoint(&self) -> &Endpoint {
        self.inner.endpoint()
    }

    async fn health_check(&self) -> Result<bool, ConnectionError> {
        self.inner.health_check().await
    }
}
