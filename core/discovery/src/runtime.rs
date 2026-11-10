//! Service Runtime - Agent 服务运行时框架
//!
//! 为服务端 Agent 提供：
//! - 自动注册到 Discovery
//! - 心跳维护
//! - 请求监听和处理
//! - 可选的 skill execution trace 自动采集

use crate::{
    AgentProfile, Discovery, DiscoveryError, Lease, Protocol,
    codec::{AgentMessage, AgentMessageCodec},
};
use async_trait::async_trait;
use myco_storage::{BeliefStore, TraceRecord};
use serde_json::Value;
use std::sync::Arc;
use std::time::Instant;
use thiserror::Error;
use tokio::net::TcpListener;
use tokio::sync::RwLock;
use tokio_util::codec::Framed;
use tracing::{debug, error, info, warn};

/// 服务错误
#[derive(Error, Debug)]
pub enum ServiceError {
    #[error("Discovery error: {0}")]
    Discovery(#[from] DiscoveryError),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Unknown skill: {0}")]
    UnknownSkill(String),

    #[error("Handler error: {0}")]
    Handler(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
}

/// Agent 服务 trait - 服务端需要实现此 trait
#[async_trait]
pub trait AgentService: Send + Sync {
    /// 返回 Agent 配置信息
    fn profile(&self) -> AgentProfile;

    /// 处理技能调用
    async fn handle_invoke(&self, skill: &str, input: Value) -> Result<Value, ServiceError>;

    /// 健康检查
    async fn health_check(&self) -> Result<bool, ServiceError> {
        Ok(true)
    }
}

/// 服务运行时配置
#[derive(Debug, Clone)]
pub struct ServiceRuntimeConfig {
    /// 心跳间隔（毫秒）
    pub heartbeat_interval_ms: u64,
    /// 租约续期提前时间（毫秒）
    pub lease_renewal_before_ms: i64,
    /// 服务监听地址
    pub bind_address: String,
    /// 服务端口
    pub port: u16,
}

impl Default for ServiceRuntimeConfig {
    fn default() -> Self {
        Self {
            heartbeat_interval_ms: 30000,
            lease_renewal_before_ms: 5000,
            bind_address: "127.0.0.1".to_string(),
            port: 0, // 0 表示自动分配
        }
    }
}

/// 服务运行时 - 管理 Agent 服务的生命周期
pub struct ServiceRuntime {
    discovery: Arc<dyn Discovery>,
    service: Arc<dyn AgentService>,
    /// Optional BeliefStore for auto-recording skill execution traces
    store: Option<Arc<dyn BeliefStore>>,
    config: ServiceRuntimeConfig,
    lease: Arc<RwLock<Option<Lease>>>,
    shutdown_tx: Option<tokio::sync::mpsc::Sender<()>>,
}

impl ServiceRuntime {
    /// 创建新的服务运行时
    pub fn new(
        discovery: Arc<dyn Discovery>,
        service: Arc<dyn AgentService>,
        config: ServiceRuntimeConfig,
    ) -> Self {
        Self {
            discovery,
            service,
            store: None,
            config,
            lease: Arc::new(RwLock::new(None)),
            shutdown_tx: None,
        }
    }

    /// 使用默认配置创建
    pub fn with_defaults(
        discovery: Arc<dyn Discovery>,
        service: Arc<dyn AgentService>,
    ) -> Self {
        Self::new(discovery, service, ServiceRuntimeConfig::default())
    }

    /// Attach a BeliefStore for auto-recording skill execution traces.
    /// When set, every invoke is automatically recorded as a TraceRecord.
    pub fn with_store(mut self, store: Arc<dyn BeliefStore>) -> Self {
        self.store = Some(store);
        self
    }

    /// 启动服务
    pub async fn start(&mut self) -> Result<(), ServiceError> {
        let profile = self.service.profile();
        info!("Starting Agent service: {}", profile.did);

        // 1. 注册到 Discovery
        self.register().await?;

        // 2. 启动心跳任务
        self.start_heartbeat().await;

        // 3. 启动服务监听
        self.start_listener().await?;

        info!("Agent service {} started successfully", profile.did);
        Ok(())
    }

    /// 注册到 Discovery
    async fn register(&self) -> Result<(), ServiceError> {
        let profile = self.service.profile();
        info!("Registering agent {} to Discovery", profile.did);

        match self.discovery.register(profile).await {
            Ok(lease) => {
                info!("Registered with lease: {} (expires at {})",
                    lease.lease_id, lease.expires_at);

                let mut guard = self.lease.write().await;
                *guard = Some(lease);

                Ok(())
            }
            Err(e) => {
                error!("Failed to register: {}", e);
                Err(ServiceError::Discovery(e))
            }
        }
    }

    /// 启动心跳任务
    async fn start_heartbeat(&self) {
        let discovery = self.discovery.clone();
        let lease = self.lease.clone();
        let interval_ms = self.config.heartbeat_interval_ms;
        let renewal_before_ms = self.config.lease_renewal_before_ms;

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(
                tokio::time::Duration::from_millis(interval_ms)
            );

            loop {
                interval.tick().await;

                let lease_guard: tokio::sync::RwLockReadGuard<'_, Option<crate::protocol::Lease>> = lease.read().await;
                if let Some(current_lease) = lease_guard.as_ref() {
                    // 检查是否需要续期
                    let now = chrono::Utc::now();
                    let expires_at = current_lease.expires_at;
                    let should_renew = (expires_at - now).num_milliseconds() < renewal_before_ms;

                    if should_renew {
                        let did = current_lease.did.clone();
                        let lease_id = current_lease.lease_id.clone();
                        drop(lease_guard);

                        match discovery.heartbeat(&did, &lease_id).await {
                            Ok(new_lease) => {
                                info!("Heartbeat successful, new lease expires at {}",
                                    new_lease.expires_at);

                                let mut lease_guard = lease.write().await;
                                *lease_guard = Some(new_lease);
                            }
                            Err(e) => {
                                warn!("Heartbeat failed: {}", e);
                                // TODO: 连续失败时尝试重新注册
                            }
                        }
                    }
                } else {
                    drop(lease_guard);
                    warn!("No lease available, skipping heartbeat");
                }
            }
        });
    }

    /// 启动服务监听器
    async fn start_listener(&self) -> Result<(), ServiceError> {
        let profile = self.service.profile();

        // 获取监听的端点
        let endpoint = profile.endpoints.first()
            .ok_or_else(|| ServiceError::Io(
                std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    "No endpoint configured"
                )
            ))?;

        // 解析地址 — strip "tcp://" prefix if present for TcpListener::bind
        let bind_addr = match &endpoint.protocol {
            Protocol::Tcp => endpoint.address
                .strip_prefix("tcp://")
                .unwrap_or(&endpoint.address),
            _ => {
                return Err(ServiceError::Io(
                    std::io::Error::new(
                        std::io::ErrorKind::InvalidInput,
                        format!("Unsupported protocol: {:?}", endpoint.protocol)
                    )
                ));
            }
        };

        // 启动 TCP 监听
        let listener = TcpListener::bind(bind_addr).await?;
        let local_addr = listener.local_addr()?;
        info!("Agent {} listening on {}", profile.did, local_addr);

        let service = self.service.clone();
        let store = self.store.clone();

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, addr)) => {
                        debug!("New connection from: {}", addr);
                        let service = service.clone();
                        let store = store.clone();

                        tokio::spawn(async move {
                            if let Err(e) = handle_connection(stream, service, store).await {
                                warn!("Connection handler error: {}", e);
                            }
                        });
                    }
                    Err(e) => {
                        error!("Accept error: {}", e);
                    }
                }
            }
        });

        Ok(())
    }

    /// 停止服务
    pub async fn stop(&self) -> Result<(), ServiceError> {
        info!("Stopping Agent service");

        // 注销 Discovery 注册
        let lease_guard = self.lease.read().await;
        if let Some(lease) = lease_guard.as_ref() {
            if let Err(e) = self.discovery.deregister(&lease.did).await {
                warn!("Failed to deregister: {}", e);
            } else {
                info!("Deregistered from Discovery");
            }
        }

        // 发送关闭信号
        if let Some(tx) = &self.shutdown_tx {
            let _ = tx.send(()).await;
        }

        Ok(())
    }

    /// 获取当前租约
    pub async fn lease(&self) -> Option<Lease> {
        self.lease.read().await.clone()
    }
}

/// 处理单个连接
async fn handle_connection(
    stream: tokio::net::TcpStream,
    service: Arc<dyn AgentService>,
    store: Option<Arc<dyn BeliefStore>>,
) -> Result<(), ServiceError> {
    let mut framed = Framed::new(stream, AgentMessageCodec);

    while let Some(result) = framed.next().await {
        match result {
            Ok(msg) => {
                let response = match msg {
                    AgentMessage::Invoke { task, .. } => {
                        debug!("Received invoke request for skill: {}", task.skill);
                        let start = Instant::now();

                        let result = service.handle_invoke(&task.skill, task.input.clone()).await;
                        let duration = start.elapsed().as_millis() as u64;

                        // Auto-record trace if store is configured
                        if let Some(ref store) = store {
                            let agent_did = service.profile().did.to_string();
                            // Extract tick_id from input if present
                            let tick_id = task.input.get("tickId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string());

                            let trace = TraceRecord {
                                trace_id: uuid::Uuid::new_v4().to_string(),
                                tick_id,
                                agent_did,
                                skill_name: task.skill.clone(),
                                o_input: task.input,
                                s_context: None,
                                a_output: result.as_ref().ok().cloned(),
                                r_score: None,
                                r_evaluation: None,
                                duration_ms: duration,
                                success: result.is_ok(),
                                error: result.as_ref().err().map(|e| e.to_string()),
                                timestamp: now_ms(),
                            };

                            if let Err(e) = store.record_trace(&trace).await {
                                warn!("Failed to record trace: {}", e);
                            }
                        }

                        match result {
                            Ok(output) => AgentMessage::InvokeResponse {
                                success: true,
                                output,
                                error: None,
                                execution_time_ms: duration,
                            },
                            Err(e) => AgentMessage::InvokeResponse {
                                success: false,
                                output: Value::Null,
                                error: Some(e.to_string()),
                                execution_time_ms: duration,
                            },
                        }
                    }
                    AgentMessage::HealthCheck => {
                        match service.health_check().await {
                            Ok(healthy) => AgentMessage::HealthCheckResponse { healthy },
                            Err(e) => {
                                warn!("Health check failed: {}", e);
                                AgentMessage::HealthCheckResponse { healthy: false }
                            }
                        }
                    }
                    _ => {
                        AgentMessage::Error {
                            code: 400,
                            message: "Unsupported message type".to_string(),
                        }
                    }
                };

                if let Err(e) = framed.send(response).await {
                    warn!("Failed to send response: {}", e);
                    break;
                }
            }
            Err(e) => {
                warn!("Message decode error: {}", e);
                break;
            }
        }
    }

    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

use futures::SinkExt;
use futures::StreamExt;

/// Service Runtime Builder
pub struct ServiceRuntimeBuilder {
    discovery: Option<Arc<dyn Discovery>>,
    service: Option<Arc<dyn AgentService>>,
    store: Option<Arc<dyn BeliefStore>>,
    config: Option<ServiceRuntimeConfig>,
}

impl ServiceRuntimeBuilder {
    pub fn new() -> Self {
        Self {
            discovery: None,
            service: None,
            store: None,
            config: None,
        }
    }

    pub fn with_discovery(mut self, discovery: Arc<dyn Discovery>) -> Self {
        self.discovery = Some(discovery);
        self
    }

    pub fn with_service(mut self, service: Arc<dyn AgentService>) -> Self {
        self.service = Some(service);
        self
    }

    pub fn with_store(mut self, store: Arc<dyn BeliefStore>) -> Self {
        self.store = Some(store);
        self
    }

    pub fn with_config(mut self, config: ServiceRuntimeConfig) -> Self {
        self.config = Some(config);
        self
    }

    pub fn build(self) -> ServiceRuntime {
        let discovery = self.discovery.expect("Discovery is required");
        let service = self.service.expect("Service is required");
        let config = self.config.unwrap_or_default();

        ServiceRuntime {
            discovery,
            service,
            store: self.store,
            config,
            lease: Arc::new(RwLock::new(None)),
            shutdown_tx: None,
        }
    }
}

impl Default for ServiceRuntimeBuilder {
    fn default() -> Self {
        Self::new()
    }
}
