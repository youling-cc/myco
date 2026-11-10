//! Registry - Agent 注册表

use crate::protocol::*;
use async_trait::async_trait;
use dashmap::DashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::time::Instant;
use tracing::{debug, info, warn};

/// 注册表 trait
#[async_trait]
pub trait Registry: Send + Sync {
    /// 注册 Agent
    async fn register(&self, profile: AgentProfile) -> Result<Lease, RegistryError>;

    /// 注销 Agent
    async fn deregister(&self, did: &DID) -> Result<(), RegistryError>;

    /// 根据 DID 获取 Agent
    async fn get(&self, did: &DID) -> Option<AgentProfile>;

    /// 查询候选 Agents（基础过滤）
    async fn query_candidates(&self, requirements: &TaskRequirements) -> Vec<AgentProfile>;

    /// 列出所有 Agents
    async fn list_all(&self) -> Vec<AgentProfile>;

    /// 更新心跳
    async fn heartbeat(&self, did: &DID) -> Result<Lease, RegistryError>;

    /// 检查并清理过期 Agents
    async fn cleanup_expired(&self) -> Vec<DID>;
}

/// 注册表错误
#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("Agent already registered: {0}")]
    AlreadyExists(DID),

    #[error("Agent not found: {0}")]
    NotFound(DID),

    #[error("Lease expired: {0}")]
    LeaseExpired(LeaseId),

    #[error("Invalid signature")]
    InvalidSignature,

    #[error("Internal error: {0}")]
    Internal(String),
}

/// 内存注册表实现
pub struct MemoryRegistry {
    /// DID -> (Profile, Lease, LastHeartbeat)
    agents: DashMap<DID, AgentRecord>,
    /// 租约超时时间
    lease_duration: Duration,
}

struct AgentRecord {
    profile: AgentProfile,
    lease: Lease,
    last_heartbeat: Instant,
}

impl MemoryRegistry {
    pub fn new() -> Self {
        Self {
            agents: DashMap::new(),
            lease_duration: Duration::from_secs(60), // 默认 60 秒租约
        }
    }

    pub fn with_lease_duration(mut self, duration: Duration) -> Self {
        self.lease_duration = duration;
        self
    }
}

#[async_trait]
impl Registry for MemoryRegistry {
    async fn register(&self, profile: AgentProfile) -> Result<Lease, RegistryError> {
        let did = profile.did.clone();

        // 检查是否已存在
        if self.agents.contains_key(&did) {
            return Err(RegistryError::AlreadyExists(did));
        }

        // 创建租约
        let now = Utc::now();
        let lease = Lease {
            lease_id: format!("lease-{}", uuid::Uuid::new_v4()),
            did: did.clone(),
            created_at: now,
            expires_at: now + chrono::Duration::from_std(self.lease_duration).unwrap(),
        };

        // 存储
        let record = AgentRecord {
            profile,
            lease: lease.clone(),
            last_heartbeat: Instant::now(),
        };

        self.agents.insert(did.clone(), record);
        info!("Agent registered: {} (lease: {})", did, lease.lease_id);

        Ok(lease)
    }

    async fn deregister(&self, did: &DID) -> Result<(), RegistryError> {
        match self.agents.remove(did) {
            Some(_) => {
                info!("Agent deregistered: {}", did);
                Ok(())
            }
            None => Err(RegistryError::NotFound(did.clone())),
        }
    }

    async fn get(&self, did: &DID) -> Option<AgentProfile> {
        self.agents.get(did).map(|r| r.profile.clone())
    }

    async fn query_candidates(&self, requirements: &TaskRequirements) -> Vec<AgentProfile> {
        let mut candidates = Vec::new();

        for entry in self.agents.iter() {
            let record = entry.value();

            // 检查租约是否过期
            if Utc::now() > record.lease.expires_at {
                debug!("Agent {} lease expired, skipping", record.profile.did);
                continue;
            }

            // 检查技能匹配
            let agent_skills: Vec<_> = record
                .profile
                .capabilities
                .iter()
                .map(|c| &c.skill)
                .collect();

            let has_all_skills = requirements
                .skills
                .iter()
                .all(|req_skill| agent_skills.contains(&req_skill));

            if has_all_skills {
                candidates.push(record.profile.clone());
            }
        }

        candidates
    }

    async fn list_all(&self) -> Vec<AgentProfile> {
        self.agents
            .iter()
            .map(|entry| entry.value().profile.clone())
            .collect()
    }

    async fn heartbeat(&self, did: &DID) -> Result<Lease, RegistryError> {
        match self.agents.get_mut(did) {
            Some(mut record) => {
                // 更新心跳时间
                record.last_heartbeat = Instant::now();

                // 延长租约
                let new_expires_at = Utc::now() + chrono::Duration::from_std(self.lease_duration).unwrap();
                record.lease.expires_at = new_expires_at;

                debug!("Heartbeat received: {} (lease extended)", did);
                Ok(record.lease.clone())
            }
            None => Err(RegistryError::NotFound(did.clone())),
        }
    }

    async fn cleanup_expired(&self) -> Vec<DID> {
        let now = Utc::now();
        let mut expired = Vec::new();

        // 找出过期 Agent
        for entry in self.agents.iter() {
            let record = entry.value();
            if now > record.lease.expires_at {
                expired.push(entry.key().clone());
            }
        }

        // 删除过期 Agent
        for did in &expired {
            self.agents.remove(did);
            warn!("Agent expired and removed: {}", did);
        }

        expired
    }
}

impl Default for MemoryRegistry {
    fn default() -> Self {
        Self::new()
    }
}

use chrono::Utc;

/// 创建共享的 Registry Arc
pub type SharedRegistry = Arc<dyn Registry>;
