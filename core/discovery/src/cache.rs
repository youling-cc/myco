//! Connection Cache - 连接缓存

use crate::protocol::{DID, Endpoint};
use dashmap::DashMap;
use std::time::{Duration, Instant};
use tracing::{debug, warn};

/// 缓存策略
#[derive(Debug, Clone)]
pub struct CachePolicy {
    /// 最大缓存连接数
    pub max_connections: usize,
    /// 连接 TTL（秒）
    pub ttl_secs: u64,
    /// 最大空闲时间（秒）
    pub max_idle_secs: u64,
}

impl Default for CachePolicy {
    fn default() -> Self {
        Self {
            max_connections: 100,
            ttl_secs: 300,      // 5 分钟 TTL
            max_idle_secs: 60,  // 1 分钟空闲即回收
        }
    }
}

/// 缓存的连接
pub struct CachedConnection {
    /// 实际连接（需要实现 Connection trait）
    pub endpoint: Endpoint,
    /// 创建时间
    pub created_at: Instant,
    /// 最后使用时间
    pub last_used: Instant,
    /// 使用次数
    pub use_count: u64,
    /// 健康状态
    pub healthy: bool,
}

impl CachedConnection {
    pub fn new(endpoint: Endpoint) -> Self {
        let now = Instant::now();
        Self {
            endpoint,
            created_at: now,
            last_used: now,
            use_count: 0,
            healthy: true,
        }
    }

    /// 是否过期
    pub fn is_expired(&self, policy: &CachePolicy) -> bool {
        let now = Instant::now();
        let age = now.duration_since(self.created_at);
        let idle = now.duration_since(self.last_used);

        age > Duration::from_secs(policy.ttl_secs)
            || idle > Duration::from_secs(policy.max_idle_secs)
    }

    /// 标记为已使用
    pub fn mark_used(&mut self) {
        self.last_used = Instant::now();
        self.use_count += 1;
    }
}

/// 连接缓存
pub struct ConnectionCache {
    /// DID -> CachedConnection
    connections: DashMap<DID, CachedConnection>,
    /// 缓存策略
    policy: CachePolicy,
    /// 按 skill 缓存的 DID 列表（用于快速查找）
    skill_cache: DashMap<String, Vec<DID>>,
}

impl ConnectionCache {
    pub fn new(policy: CachePolicy) -> Self {
        Self {
            connections: DashMap::new(),
            policy,
            skill_cache: DashMap::new(),
        }
    }

    /// 获取连接
    pub fn get(&self, did: &DID) -> Option<CachedConnection> {
        if let Some(mut entry) = self.connections.get_mut(did) {
            if entry.is_expired(&self.policy) {
                drop(entry);
                self.connections.remove(did);
                debug!("Connection expired for {}", did);
                return None;
            }
            entry.mark_used();
            return Some(CachedConnection {
                endpoint: entry.endpoint.clone(),
                created_at: entry.created_at,
                last_used: entry.last_used,
                use_count: entry.use_count,
                healthy: entry.healthy,
            });
        }
        None
    }

    /// 存储连接
    pub fn put(&self, did: DID, endpoint: Endpoint) {
        // 清理过期连接
        self.cleanup_expired();

        let conn = CachedConnection::new(endpoint);
        let did_clone = did.clone();
        self.connections.insert(did, conn);
        debug!("Connection cached for {}", did_clone);
    }

    /// 移除连接
    pub fn remove(&self, did: &DID) {
        self.connections.remove(did);
        debug!("Connection removed for {}", did);
    }

    /// 标记不健康
    pub fn mark_unhealthy(&self, did: &DID) {
        if let Some(mut entry) = self.connections.get_mut(did) {
            entry.healthy = false;
            warn!("Connection marked unhealthy for {}", did);
        }
    }

    /// 获取 skill 对应的 DID 列表
    pub fn get_by_skill(&self, skill: &str) -> Vec<DID> {
        self.skill_cache
            .get(skill)
            .map(|v| v.clone())
            .unwrap_or_default()
    }

    /// 缓存 skill -> DID 映射
    pub fn cache_skill(&self, skill: String, did: DID) {
        self.skill_cache
            .entry(skill)
            .or_insert_with(Vec::new)
            .push(did);
    }

    /// 清理过期连接
    pub fn cleanup_expired(&self) {
        let to_remove: Vec<_> = self
            .connections
            .iter()
            .filter(|entry| entry.value().is_expired(&self.policy))
            .map(|entry| entry.key().clone())
            .collect();

        for did in to_remove {
            self.connections.remove(&did);
            debug!("Expired connection cleaned up for {}", did);
        }
    }

    /// 获取统计信息
    pub fn stats(&self) -> CacheStats {
        CacheStats {
            total_connections: self.connections.len(),
            healthy_connections: self
                .connections
                .iter()
                .filter(|e| e.value().healthy)
                .count(),
            skill_mappings: self.skill_cache.len(),
        }
    }
}

/// 缓存统计
#[derive(Debug)]
pub struct CacheStats {
    pub total_connections: usize,
    pub healthy_connections: usize,
    pub skill_mappings: usize,
}

/// 连接错误
#[derive(Debug, thiserror::Error)]
pub enum ConnectionError {
    #[error("Connection failed: {0}")]
    ConnectFailed(String),
    #[error("Invoke failed: {0}")]
    InvokeFailed(String),
    #[error("Timeout")]
    Timeout,
    #[error("Not healthy")]
    NotHealthy,
}
