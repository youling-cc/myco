//! Myco Discovery - Agent 发现与匹配服务
//!
//! 提供 Agent 注册、发现、能力匹配和连接管理

pub mod protocol;
pub mod registry;
pub mod matcher;
pub mod discovery;
pub mod cache;
pub mod connector;
pub mod transport;
pub mod codec;
pub mod client;
pub mod runtime;
pub mod remote;

pub use protocol::*;
pub use registry::{Registry, MemoryRegistry, RegistryError};
pub use matcher::{Matcher, SimpleMatcher, MatcherError, MatcherKind};
pub use discovery::{Discovery, DiscoveryService, DiscoveryServer, DiscoveryError};
pub use cache::{ConnectionCache, CachePolicy, CachedConnection, CacheStats, ConnectionError};
pub use connector::{AgentConnector, AgentConnection, DefaultAgentConnector, CachedAgentConnection};
pub use transport::{IpcConnector, TcpConnector};
pub use codec::{AgentMessage, AgentMessageCodec};
pub use client::{DiscoveryClient, DiscoveryClientBuilder, InvokeError, InvokeOptions, LoadBalanceStrategy};
pub use runtime::{ServiceRuntime, ServiceRuntimeBuilder, ServiceRuntimeConfig, AgentService, ServiceError};
pub use remote::RemoteDiscovery;

use std::sync::Arc;

/// Discovery 服务构建器
pub struct DiscoveryBuilder {
    registry: Option<Arc<dyn Registry>>,
    matcher: Option<Arc<dyn Matcher>>,
    cache_policy: CachePolicy,
}

impl DiscoveryBuilder {
    pub fn new() -> Self {
        Self {
            registry: None,
            matcher: None,
            cache_policy: CachePolicy::default(),
        }
    }

    pub fn with_registry(mut self, registry: Arc<dyn Registry>) -> Self {
        self.registry = Some(registry);
        self
    }

    pub fn with_matcher(mut self, matcher: Arc<dyn Matcher>) -> Self {
        self.matcher = Some(matcher);
        self
    }

    pub fn with_cache_policy(mut self, policy: CachePolicy) -> Self {
        self.cache_policy = policy;
        self
    }

    pub fn build(self) -> DiscoveryService {
        let registry = self.registry.unwrap_or_else(|| {
            Arc::new(MemoryRegistry::new())
        });

        let matcher = self.matcher.unwrap_or_else(|| {
            Arc::new(SimpleMatcher::new())
        });

        DiscoveryService::new(registry, matcher, self.cache_policy)
    }
}

impl Default for DiscoveryBuilder {
    fn default() -> Self {
        Self::new()
    }
}

/// 便捷的创建函数
pub fn new_discovery() -> DiscoveryService {
    DiscoveryBuilder::new().build()
}

/// 使用自定义配置创建
pub fn new_discovery_with_config<F>(f: F) -> DiscoveryService
where
    F: FnOnce(DiscoveryBuilder) -> DiscoveryBuilder,
{
    f(DiscoveryBuilder::new()).build()
}
