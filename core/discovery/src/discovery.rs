//! Discovery 服务实现

use crate::cache::{CachePolicy, ConnectionCache};
use crate::matcher::{Matcher, SimpleMatcher};
use crate::protocol::*;
use crate::registry::{MemoryRegistry, Registry, RegistryError};
use async_trait::async_trait;
use std::sync::Arc;
use tracing::{debug, info};

/// Discovery trait
#[async_trait]
pub trait Discovery: Send + Sync {
    async fn register(&self, profile: AgentProfile) -> Result<Lease, DiscoveryError>;
    async fn deregister(&self, did: &DID) -> Result<(), DiscoveryError>;
    async fn query(&self, req: QueryRequest) -> Result<Vec<AgentMatch>, DiscoveryError>;
    async fn heartbeat(&self, did: &DID, lease_id: &LeaseId) -> Result<Lease, DiscoveryError>;
    async fn get_agent(&self, did: &DID) -> Option<AgentProfile>;
    async fn list_agents(&self) -> Vec<AgentProfile>;
}

/// Discovery 错误
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("Registry error: {0}")]
    Registry(#[from] RegistryError),
    #[error("Matcher error: {0}")]
    Matcher(String),
    #[error("No matching agents found")]
    NoMatch,
    #[error("Internal error: {0}")]
    Internal(String),
}

/// Discovery 服务实现
pub struct DiscoveryService {
    registry: Arc<dyn Registry>,
    matcher: Arc<dyn Matcher>,
    _cache: ConnectionCache,
}

impl DiscoveryService {
    pub fn new(
        registry: Arc<dyn Registry>,
        matcher: Arc<dyn Matcher>,
        cache_policy: CachePolicy,
    ) -> Self {
        Self {
            registry,
            matcher,
            _cache: ConnectionCache::new(cache_policy),
        }
    }

    pub fn with_defaults() -> Self {
        Self::new(
            Arc::new(MemoryRegistry::new()),
            Arc::new(SimpleMatcher::new()),
            CachePolicy::default(),
        )
    }

    /// 启动后台任务（心跳清理）
    pub async fn start_background_tasks(&self) {
        let registry = self.registry.clone();

        tokio::spawn(async move {
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(30));

            loop {
                interval.tick().await;
                let expired = registry.cleanup_expired().await;
                if !expired.is_empty() {
                    info!("Cleaned up {} expired agents", expired.len());
                }
            }
        });
    }
}

#[async_trait]
impl Discovery for DiscoveryService {
    async fn register(&self, profile: AgentProfile) -> Result<Lease, DiscoveryError> {
        info!("Registering agent: {}", profile.did);
        let lease = self.registry.register(profile).await?;
        Ok(lease)
    }

    async fn deregister(&self, did: &DID) -> Result<(), DiscoveryError> {
        info!("Deregistering agent: {}", did);
        self.registry.deregister(did).await?;
        Ok(())
    }

    async fn query(&self, req: QueryRequest) -> Result<Vec<AgentMatch>, DiscoveryError> {
        debug!("Query request: {:?}", req);

        // 1. 获取候选 Agents
        let candidates = self.registry.query_candidates(&req.requirements).await;

        if candidates.is_empty() {
            return Err(DiscoveryError::NoMatch);
        }

        // 2. 构建匹配上下文
        let ctx = MatchContext {
            candidates,
            requirements: req.requirements,
            context: HashMap::new(),
            caller: "anonymous".to_string(), // TODO: 从认证信息获取
            timestamp: Utc::now(),
        };

        // 3. 调用 Matcher
        let matches = self
            .matcher
            .match_agents(ctx)
            .await
            .map_err(|e| DiscoveryError::Matcher(e.to_string()))?;

        // 4. 限制返回数量
        let result: Vec<_> = matches.into_iter().take(req.max_results).collect();

        info!("Query returned {} matches", result.len());
        Ok(result)
    }

    async fn heartbeat(&self, did: &DID, _lease_id: &LeaseId) -> Result<Lease, DiscoveryError> {
        let lease = self.registry.heartbeat(did).await?;
        Ok(lease)
    }

    async fn get_agent(&self, did: &DID) -> Option<AgentProfile> {
        self.registry.get(did).await
    }

    async fn list_agents(&self) -> Vec<AgentProfile> {
        self.registry.list_all().await
    }
}use chrono::Utc;
use std::collections::HashMap;

/// Discovery 服务器（RPC 端点）
pub struct DiscoveryServer {
    service: Arc<DiscoveryService>,
}

impl DiscoveryServer {
    pub fn new(service: Arc<DiscoveryService>) -> Self {
        Self { service }
    }

    /// 处理消息
    pub async fn handle_message(&self, msg: DiscoveryMessage) -> DiscoveryMessage {
        match msg {
            DiscoveryMessage::Register { profile, .. } => {
                match self.service.register(profile).await {
                    Ok(lease) => DiscoveryMessage::RegisterResponse {
                        success: true,
                        lease: Some(lease),
                        error: None,
                    },
                    Err(e) => DiscoveryMessage::RegisterResponse {
                        success: false,
                        lease: None,
                        error: Some(e.to_string()),
                    },
                }
            }
            DiscoveryMessage::Deregister { did, lease_id: _, .. } => {
                match self.service.deregister(&did).await {
                    Ok(_) => DiscoveryMessage::DeregisterResponse {
                        success: true,
                        error: None,
                    },
                    Err(e) => DiscoveryMessage::DeregisterResponse {
                        success: false,
                        error: Some(e.to_string()),
                    },
                }
            }
            DiscoveryMessage::Query(req) => {
                let request_id = req.request_id.clone();
                match self.service.query(req).await {
                    Ok(matches) => DiscoveryMessage::QueryResponse {
                        request_id,
                        matches,
                    },
                    Err(_e) => DiscoveryMessage::QueryResponse {
                        request_id,
                        matches: vec![],
                    },
                }
            }
            DiscoveryMessage::Heartbeat { did, lease_id, .. } => {
                match self.service.heartbeat(&did, &lease_id).await {
                    Ok(lease) => DiscoveryMessage::HeartbeatResponse {
                        lease_id: lease.lease_id,
                        expires_at: lease.expires_at,
                    },
                    Err(_) => {
                        // 返回过期响应
                        DiscoveryMessage::HeartbeatResponse {
                            lease_id,
                            expires_at: Utc::now(),
                        }
                    }
                }
            }
            _ => DiscoveryMessage::RegisterResponse {
                success: false,
                lease: None,
                error: Some("Unsupported message type".to_string()),
            },
        }
    }
}
