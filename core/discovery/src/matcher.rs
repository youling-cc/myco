//! Matcher - Agent 匹配算法

use crate::protocol::*;
use async_trait::async_trait;
use std::sync::Arc;
use tracing::debug;

/// Matcher trait（可插拔匹配算法）
#[async_trait]
pub trait Matcher: Send + Sync {
    /// 匹配 Agents
    async fn match_agents(&self, ctx: MatchContext) -> Result<Vec<AgentMatch>, MatcherError>;

    /// 更新匹配策略
    async fn update_policy(&self, policy: MatchPolicy) -> Result<(), MatcherError>;
}

/// Matcher 错误
#[derive(Debug, thiserror::Error)]
pub enum MatcherError {
    #[error("Invalid context: {0}")]
    InvalidContext(String),

    #[error("No candidates available")]
    NoCandidates,

    #[error("Policy error: {0}")]
    PolicyError(String),

    #[error("Internal error: {0}")]
    Internal(String),
}

/// 简单 Matcher（本地实现）
pub struct SimpleMatcher {
    policy: std::sync::RwLock<MatchPolicy>,
}

impl SimpleMatcher {
    pub fn new() -> Self {
        Self {
            policy: std::sync::RwLock::new(MatchPolicy::default()),
        }
    }

    pub fn with_policy(policy: MatchPolicy) -> Self {
        Self {
            policy: std::sync::RwLock::new(policy),
        }
    }

    /// 计算单个 Agent 的匹配分数
    fn calculate_score(&self, agent: &AgentProfile, requirements: &TaskRequirements) -> f64 {
        let policy = self.policy.read().unwrap();

        // 1. 能力匹配度 (0-1)
        let capability_score = self.match_capability(agent, requirements);

        // 2. QoS 满足度 (0-1)
        let qos_score = self.match_qos(agent, requirements);

        // 3. 延迟分数（选择最优端点）
        let (_best_endpoint, latency_score) = self.calculate_latency_score(agent);

        // 4. 信誉分数（Web3）
        let reputation_score = agent
            .economy
            .as_ref()
            .map(|e| e.reputation / 5.0)
            .unwrap_or(0.5);

        // 5. 价格分数（Web3，越低越好）
        let price_score = agent
            .economy
            .as_ref()
            .map(|e| {
                let max_price = requirements.max_price.unwrap_or(1.0);
                if e.price_per_call <= max_price {
                    1.0 - (e.price_per_call / max_price) * 0.5
                } else {
                    0.0
                }
            })
            .unwrap_or(1.0);

        // 加权总分
        let score = capability_score * policy.capability_weight
            + qos_score * policy.qos_weight
            + latency_score * policy.latency_weight
            + reputation_score * policy.reputation_weight
            + price_score * policy.price_weight;

        debug!(
            "Agent {} scores: capability={:.2}, qos={:.2}, latency={:.2}, reputation={:.2}, price={:.2}, total={:.2}",
            agent.did, capability_score, qos_score, latency_score, reputation_score, price_score, score
        );

        score
    }

    /// 能力匹配度
    fn match_capability(&self, agent: &AgentProfile, requirements: &TaskRequirements) -> f64 {
        if requirements.skills.is_empty() {
            return 1.0;
        }

        let agent_skills: Vec<_> = agent
            .capabilities
            .iter()
            .map(|c| c.skill.clone())
            .collect();

        let matched = requirements
            .skills
            .iter()
            .filter(|req| agent_skills.contains(req))
            .count();

        matched as f64 / requirements.skills.len() as f64
    }

    /// QoS 匹配度
    fn match_qos(&self, agent: &AgentProfile, requirements: &TaskRequirements) -> f64 {
        let Some(req_qos) = &requirements.qos_requirements else {
            return 1.0;
        };

        let mut scores = vec![];

        for capability in &agent.capabilities {
            // 延迟分数（承诺延迟越低越好）
            let latency_score = if capability.qos.latency_ms <= req_qos.latency_ms {
                1.0
            } else {
                let ratio = req_qos.latency_ms as f64 / capability.qos.latency_ms as f64;
                ratio * 0.5 // 超出承诺，降权
            };

            // 吞吐量分数
            let throughput_score = if capability.qos.throughput_rps >= req_qos.throughput_rps {
                1.0
            } else {
                let ratio = capability.qos.throughput_rps as f64 / req_qos.throughput_rps as f64;
                ratio * 0.5
            };

            // 可用性分数
            let availability_score = if capability.qos.availability >= req_qos.availability {
                1.0
            } else {
                let diff = capability.qos.availability - req_qos.availability;
                (1.0 + diff).max(0.0)
            };

            scores.push((latency_score + throughput_score + availability_score) / 3.0);
        }

        if scores.is_empty() {
            0.0
        } else {
            scores.iter().sum::<f64>() / scores.len() as f64
        }
    }

    /// 计算延迟分数，返回最优端点
    fn calculate_latency_score(&self, agent: &AgentProfile) -> (Option<Endpoint>, f64) {
        if agent.endpoints.is_empty() {
            return (None, 0.0);
        }

        // 按优先级排序，选择最优端点
        let mut endpoints: Vec<_> = agent.endpoints.clone();
        endpoints.sort_by_key(|e| e.priority);

        // 假设 IPC 延迟最低，TCP 次之
        let best = endpoints.first().cloned().unwrap();
        let score = match best.protocol {
            Protocol::Ipc => 1.0,
            Protocol::Tcp => 0.9,
            Protocol::Quic => 0.85,
            Protocol::Tls => 0.8,
            _ => 0.7,
        };

        (Some(best), score)
    }
}

#[async_trait]
impl Matcher for SimpleMatcher {
    async fn match_agents(&self, ctx: MatchContext) -> Result<Vec<AgentMatch>, MatcherError> {
        if ctx.candidates.is_empty() {
            return Err(MatcherError::NoCandidates);
        }

        // 计算每个候选者的分数
        let mut matches: Vec<AgentMatch> = ctx
            .candidates
            .iter()
            .map(|agent| {
                let score = self.calculate_score(agent, &ctx.requirements);
                let (endpoint, _) = self.calculate_latency_score(agent);

                AgentMatch {
                    profile: agent.clone(),
                    score,
                    rank: 0, // 稍后计算
                    endpoint: endpoint.unwrap_or_else(|| agent.endpoints.first().cloned().unwrap()),
                    reason: format!(
                        "Capability match with score {:.2}",
                        self.match_capability(agent, &ctx.requirements)
                    ),
                }
            })
            .collect();

        // 按分数降序排序
        matches.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());

        // 分配排名
        for (i, m) in matches.iter_mut().enumerate() {
            m.rank = i + 1;
        }

        // 过滤掉分数过低的（< 0.3）
        matches.retain(|m| m.score >= 0.3);

        debug!(
            "Matched {} agents from {} candidates",
            matches.len(),
            ctx.candidates.len()
        );

        Ok(matches)
    }

    async fn update_policy(&self, policy: MatchPolicy) -> Result<(), MatcherError> {
        let mut p = self.policy.write().unwrap();
        *p = policy;
        debug!("Matcher policy updated: {:?}", p);
        Ok(())
    }
}

impl Default for SimpleMatcher {
    fn default() -> Self {
        Self::new()
    }
}

/// Matcher Agent 客户端（调用远程 Matcher Agent）
pub struct MatcherAgentClient {
    /// Matcher Agent 的 DID
    _matcher_did: DID,
    /// 连接缓存
    _connector: Arc<dyn crate::connector::AgentConnector>,
}

impl MatcherAgentClient {
    pub fn new(matcher_did: DID, connector: Arc<dyn crate::connector::AgentConnector>) -> Self {
        Self {
            _matcher_did: matcher_did,
            _connector: connector,
        }
    }
}

#[async_trait]
impl Matcher for MatcherAgentClient {
    async fn match_agents(&self, ctx: MatchContext) -> Result<Vec<AgentMatch>, MatcherError> {
        // 构建 Task
        let _task = crate::protocol::Task {
            skill: "discovery.match".to_string(),
            input: serde_json::to_value(&ctx).map_err(|e| {
                MatcherError::InvalidContext(format!("Failed to serialize context: {}", e))
            })?,
        };

        // 调用 Matcher Agent
        // TODO: 需要实现 invoke_agent 逻辑
        todo!("Implement invoke_agent for MatcherAgentClient")
    }

    async fn update_policy(&self, _policy: MatchPolicy) -> Result<(), MatcherError> {
        // 远程 Matcher Agent 可能不支持动态更新策略
        Err(MatcherError::PolicyError(
            "Remote matcher policy update not supported".to_string(),
        ))
    }
}

/// 创建 Matcher 的辅助函数
pub fn create_matcher(kind: MatcherKind) -> Arc<dyn Matcher> {
    match kind {
        MatcherKind::Simple => Arc::new(SimpleMatcher::new()),
        MatcherKind::Remote { did: _ } => {
            // 需要 connector 才能创建
            panic!("Remote matcher requires connector, use MatcherAgentClient::new")
        }
    }
}

/// Matcher 类型
#[derive(Debug, Clone)]
pub enum MatcherKind {
    /// 本地简单 Matcher
    Simple,
    /// 远程 Matcher Agent
    Remote { did: DID },
}
