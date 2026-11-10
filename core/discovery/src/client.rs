//! Discovery Client - 统一的 Discovery 客户端封装
//!
//! 提供简洁的 API 用于：
//! - 发现并调用 Agent 技能
//! - 自动连接管理
//! - 故障转移和重试

use crate::{
    AgentMatch, AgentProfile, Discovery, DiscoveryError, Endpoint,
    QueryRequest, Task, TaskRequirements,
    cache::{CachePolicy, ConnectionCache, ConnectionError},
    connector::{AgentConnection, AgentConnector, DefaultAgentConnector},
    transport::{TcpConnector},
};
use serde_json::Value;
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::RwLock;
use tracing::{debug, info, warn};

/// 调用错误
#[derive(Error, Debug)]
pub enum InvokeError {
    #[error("Discovery error: {0}")]
    Discovery(#[from] DiscoveryError),

    #[error("Connection error: {0}")]
    Connection(#[from] ConnectionError),

    #[error("No agent found for skill: {0}")]
    NoAgentFound(String),

    #[error("No healthy agent available for skill: {0}")]
    NoHealthyAgent(String),

    #[error("Invoke failed: {0}")]
    InvokeFailed(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Timeout")]
    Timeout,
}

/// 负载均衡策略
#[derive(Debug, Clone, Copy)]
pub enum LoadBalanceStrategy {
    /// 轮询
    RoundRobin,
    /// 最低延迟
    LeastLatency,
    /// 随机
    Random,
    /// 优先级优先
    Priority,
}

impl Default for LoadBalanceStrategy {
    fn default() -> Self {
        LoadBalanceStrategy::Priority
    }
}

/// 调用选项
#[derive(Debug, Clone)]
pub struct InvokeOptions {
    /// 负载均衡策略
    pub strategy: LoadBalanceStrategy,
    /// 最大重试次数
    pub max_retries: u32,
    /// 超时时间（毫秒）
    pub timeout_ms: u64,
    /// 要求的最小可用性
    pub min_availability: Option<f32>,
    /// 要求的最大延迟
    pub max_latency_ms: Option<u32>,
}

impl Default for InvokeOptions {
    fn default() -> Self {
        Self {
            strategy: LoadBalanceStrategy::default(),
            max_retries: 3,
            timeout_ms: 30000,
            min_availability: None,
            max_latency_ms: None,
        }
    }
}

/// Discovery 客户端 - 统一的 Agent 发现和调用接口
pub struct DiscoveryClient {
    /// Discovery 服务
    discovery: Arc<dyn Discovery>,
    /// Agent 连接器
    connector: Arc<dyn AgentConnector>,
    /// 连接缓存
    cache: ConnectionCache,
    /// 轮询计数器（用于 RoundRobin 策略）
    round_robin_counter: RwLock<std::collections::HashMap<String, usize>>,
}

impl DiscoveryClient {
    /// 创建新的 DiscoveryClient
    pub fn new(
        discovery: Arc<dyn Discovery>,
        connector: Arc<dyn AgentConnector>,
        cache_policy: CachePolicy,
    ) -> Self {
        Self {
            discovery,
            connector,
            cache: ConnectionCache::new(cache_policy),
            round_robin_counter: RwLock::new(std::collections::HashMap::new()),
        }
    }

    /// 使用默认配置创建
    pub fn with_defaults(discovery: Arc<dyn Discovery>) -> Self {
        // 创建默认连接器（支持 TCP）
        let connector = Arc::new(
            DefaultAgentConnector::new()
                .with_tcp(Arc::new(TcpConnector::new()))
        );

        Self::new(discovery, connector, CachePolicy::default())
    }

    /// 发现并调用技能（最简接口）
    ///
    /// 自动流程：
    /// 1. Query Discovery 查找提供该技能的 Agents
    /// 2. 选择最佳匹配
    /// 3. 获取或创建连接
    /// 4. 调用技能并返回结果
    pub async fn invoke(
        &self,
        skill: &str,
        input: Value,
    ) -> Result<Value, InvokeError> {
        self.invoke_with_options(skill, input, InvokeOptions::default()).await
    }

    /// 使用自定义选项调用技能
    pub async fn invoke_with_options(
        &self,
        skill: &str,
        input: Value,
        options: InvokeOptions,
    ) -> Result<Value, InvokeError> {
        // 1. 构建查询请求
        let query = QueryRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            requirements: TaskRequirements {
                skills: vec![skill.to_string()],
                qos_requirements: None,
                max_price: None,
                min_reputation: None,
                context: Default::default(),
            },
            max_results: 10,
        };

        // 2. 查询 Discovery
        let matches = self.discovery.query(query).await?;

        if matches.is_empty() {
            return Err(InvokeError::NoAgentFound(skill.to_string()));
        }

        // 3. 根据策略选择 Agent
        let candidates = self.filter_healthy(matches).await;
        if candidates.is_empty() {
            return Err(InvokeError::NoHealthyAgent(skill.to_string()));
        }

        let selected = self.select_agent(&candidates, options.strategy, skill).await;

        // 4. 带重试的调用
        self.invoke_with_retry(skill, selected, input, &candidates[1..], options).await
    }

    /// 带重试的调用
    async fn invoke_with_retry(
        &self,
        skill: &str,
        primary: AgentMatch,
        input: Value,
        fallbacks: &[AgentMatch],
        options: InvokeOptions,
    ) -> Result<Value, InvokeError> {
        #[allow(unused_assignments)]
        let mut last_error: Option<InvokeError> = None;

        // 尝试主节点
        match self.do_invoke(skill, &primary, input.clone()).await {
            Ok(result) => return Ok(result),
            Err(e) => {
                warn!("Invoke failed for {}: {}", primary.profile.did, e);
                last_error = Some(e);
            }
        }

        // 尝试故障转移
        for (idx, fallback) in fallbacks.iter().take(options.max_retries as usize).enumerate() {
            info!("Trying fallback {}: {}", idx + 1, fallback.profile.did);

            match self.do_invoke(skill, fallback, input.clone()).await {
                Ok(result) => return Ok(result),
                Err(e) => {
                    warn!("Fallback {} failed: {}", idx + 1, e);
                    last_error = Some(e);
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            InvokeError::InvokeFailed("All attempts failed".to_string())
        }))
    }

    /// 实际执行调用
    async fn do_invoke(
        &self,
        skill: &str,
        agent_match: &AgentMatch,
        input: Value,
    ) -> Result<Value, InvokeError> {
        let endpoint = &agent_match.endpoint;
        let did = &agent_match.profile.did;

        // 1. 获取或创建连接
        let conn = self.get_connection(did, endpoint).await?;

        // 2. 构建 Task using the requested skill name
        let task = Task {
            skill: skill.to_string(),
            input,
        };

        // 3. 调用
        let result = conn.invoke(task).await?;

        // 4. 解析结果
        if result.success {
            Ok(result.output)
        } else {
            Err(InvokeError::InvokeFailed(
                result.error.unwrap_or_else(|| "Unknown error".to_string()),
            ))
        }
    }

    /// 获取连接（带缓存）
    async fn get_connection(
        &self,
        did: &str,
        endpoint: &Endpoint,
    ) -> Result<Box<dyn AgentConnection>, InvokeError> {
        let did_string = did.to_string();

        // 检查缓存中是否存在且健康
        if let Some(cached) = self.cache.get(&did_string) {
            if cached.healthy {
                debug!("Found cached connection to {}", did);
            }
        }

        // 创建新连接
        debug!("Creating new connection to {} at {:?}", did, endpoint);
        let conn = self.connector.connect(endpoint).await?;

        // 存入缓存
        self.cache.put(did_string, endpoint.clone());

        Ok(conn)
    }

    /// 过滤健康的 Agents
    async fn filter_healthy(&self, matches: Vec<AgentMatch>) -> Vec<AgentMatch> {
        let mut healthy = Vec::new();

        for m in matches {
            // 简单检查：检查连接是否可用
            if self.is_agent_healthy(&m).await {
                healthy.push(m);
            }
        }

        healthy
    }

    /// 检查 Agent 健康状态
    async fn is_agent_healthy(&self, agent_match: &AgentMatch) -> bool {
        // 检查缓存中是否存在且标记为健康
        if let Some(cached) = self.cache.get(&agent_match.profile.did) {
            return cached.healthy;
        }

        // 没有缓存连接时，假设健康（实际连接时会验证）
        true
    }

    /// 根据策略选择 Agent
    async fn select_agent(
        &self,
        candidates: &[AgentMatch],
        strategy: LoadBalanceStrategy,
        skill: &str,
    ) -> AgentMatch {
        match strategy {
            LoadBalanceStrategy::RoundRobin => {
                let mut counter = self.round_robin_counter.write().await;
                let idx = *counter.entry(skill.to_string()).or_insert(0);
                *counter.get_mut(skill).unwrap() = (idx + 1) % candidates.len();
                candidates[idx].clone()
            }
            LoadBalanceStrategy::LeastLatency => {
                // 选择延迟最低的
                candidates
                    .iter()
                    .min_by_key(|m| m.profile.capabilities.iter()
                        .find(|c| c.skill == skill)
                        .map(|c| c.qos.latency_ms as u32)
                        .unwrap_or(u32::MAX))
                    .cloned()
                    .unwrap_or_else(|| candidates[0].clone())
            }
            LoadBalanceStrategy::Random => {
                use rand::seq::SliceRandom;
                let mut rng = rand::thread_rng();
                candidates.choose(&mut rng).cloned().unwrap_or_else(|| candidates[0].clone())
            }
            LoadBalanceStrategy::Priority => {
                // 默认选择第一个（已经按优先级排序）
                candidates[0].clone()
            }
        }
    }

    /// 列出所有可用的 Agents
    pub async fn list_agents(&self) -> Vec<AgentProfile> {
        self.discovery.list_agents().await
    }

    /// 获取特定 Agent 信息
    pub async fn get_agent(&self, did: &str) -> Option<AgentProfile> {
        self.discovery.get_agent(&did.to_string()).await
    }

    /// 查询特定技能的所有 Agents
    pub async fn query_skill(&self, skill: &str) -> Result<Vec<AgentMatch>, InvokeError> {
        let query = QueryRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            requirements: TaskRequirements {
                skills: vec![skill.to_string()],
                qos_requirements: None,
                max_price: None,
                min_reputation: None,
                context: Default::default(),
            },
            max_results: 10,
        };

        Ok(self.discovery.query(query).await?)
    }

    /// 批量调用（Scatter-Gather 模式）
    pub async fn invoke_all(
        &self,
        skill: &str,
        input: Value,
    ) -> Vec<Result<Value, InvokeError>> {
        match self.query_skill(skill).await {
            Ok(matches) => {
                let mut results = Vec::new();

                for m in matches {
                    let result = self.do_invoke(skill, &m, input.clone()).await;
                    results.push(result);
                }

                results
            }
            Err(e) => vec![Err(e)],
        }
    }
}

/// Builder 模式创建 DiscoveryClient
pub struct DiscoveryClientBuilder {
    discovery: Option<Arc<dyn Discovery>>,
    connector: Option<Arc<dyn AgentConnector>>,
    cache_policy: Option<CachePolicy>,
}

impl DiscoveryClientBuilder {
    pub fn new() -> Self {
        Self {
            discovery: None,
            connector: None,
            cache_policy: None,
        }
    }

    pub fn with_discovery(mut self, discovery: Arc<dyn Discovery>) -> Self {
        self.discovery = Some(discovery);
        self
    }

    pub fn with_connector(mut self, connector: Arc<dyn AgentConnector>) -> Self {
        self.connector = Some(connector);
        self
    }

    pub fn with_cache_policy(mut self, policy: CachePolicy) -> Self {
        self.cache_policy = Some(policy);
        self
    }

    pub fn build(self) -> DiscoveryClient {
        let discovery = self.discovery.expect("Discovery is required");

        let connector = self.connector.unwrap_or_else(|| {
            Arc::new(
                DefaultAgentConnector::new()
                    .with_tcp(Arc::new(TcpConnector::new()))
            )
        });

        let cache_policy = self.cache_policy.unwrap_or_default();

        DiscoveryClient::new(discovery, connector, cache_policy)
    }
}

impl Default for DiscoveryClientBuilder {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 测试用例将在后续添加
}
