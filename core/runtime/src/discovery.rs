//! Agent Discovery Client
//!
//! 用于 Agent 自动注册到 Discovery 服务

use myco_discovery::{
    AgentProfile, Capability, Discovery, Endpoint, Lease, Protocol,
    TaskRequirements, QueryRequest, AgentMatch, DiscoveryService,
};
use std::sync::Arc;
use std::time::Duration;
use tokio::time::interval;
use tracing::{error, info, warn};

/// Agent Discovery 客户端
pub struct AgentDiscoveryClient {
    discovery: Arc<dyn Discovery>,
    profile: AgentProfile,
    lease: Option<Lease>,
    heartbeat_interval: Duration,
}

impl AgentDiscoveryClient {
    /// 创建新的 Discovery 客户端
    pub fn new(
        discovery: Arc<dyn Discovery>,
        profile: AgentProfile,
    ) -> Self {
        Self {
            discovery,
            profile,
            lease: None,
            heartbeat_interval: Duration::from_secs(30),
        }
    }

    /// 设置心跳间隔
    pub fn with_heartbeat_interval(mut self, interval: Duration) -> Self {
        self.heartbeat_interval = interval;
        self
    }

    /// 注册到 Discovery 服务
    pub async fn register(&mut self) -> Result<Lease, DiscoveryClientError> {
        info!("Registering agent {} to Discovery", self.profile.did);

        match self.discovery.register(self.profile.clone()).await {
            Ok(lease) => {
                info!("Agent {} registered successfully, lease: {}",
                    self.profile.did, lease.lease_id);
                self.lease = Some(lease.clone());
                Ok(lease)
            }
            Err(e) => {
                error!("Failed to register agent {}: {}", self.profile.did, e);
                Err(DiscoveryClientError::RegisterFailed(e.to_string()))
            }
        }
    }

    /// 注销
    pub async fn deregister(&mut self) -> Result<(), DiscoveryClientError> {
        if let Some(lease) = &self.lease {
            info!("Deregistering agent {}", self.profile.did);
            match self.discovery.deregister(&self.profile.did).await {
                Ok(_) => {
                    info!("Agent {} deregistered", self.profile.did);
                    self.lease = None;
                    Ok(())
                }
                Err(e) => {
                    error!("Failed to deregister agent {}: {}", self.profile.did, e);
                    Err(DiscoveryClientError::DeregisterFailed(e.to_string()))
                }
            }
        } else {
            warn!("Agent {} was not registered", self.profile.did);
            Ok(())
        }
    }

    /// 启动心跳任务
    pub async fn start_heartbeat(&self) {
        let discovery = self.discovery.clone();
        let lease = match &self.lease {
            Some(l) => l.clone(),
            None => {
                warn!("Cannot start heartbeat: not registered");
                return;
            }
        };
        let did = self.profile.did.clone();
        let interval_duration = self.heartbeat_interval;

        tokio::spawn(async move {
            let mut ticker = interval(interval_duration);

            loop {
                ticker.tick().await;

                match discovery.heartbeat(&did, &lease.lease_id).await {
                    Ok(new_lease) => {
                        info!("Heartbeat successful for {}, expires at {}",
                            did, new_lease.expires_at);
                    }
                    Err(e) => {
                        error!("Heartbeat failed for {}: {}", did, e);
                        // 心跳失败，可能需要重新注册
                    }
                }
            }
        });
    }

    /// 查询其他 Agent
    pub async fn query_agents(
        &self,
        skills: Vec<String>,
        max_results: usize,
    ) -> Result<Vec<AgentMatch>, DiscoveryClientError> {
        let req = QueryRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            requirements: TaskRequirements {
                skills,
                qos_requirements: None,
                max_price: None,
                min_reputation: None,
                context: Default::default(),
            },
            max_results,
        };

        match self.discovery.query(req).await {
            Ok(matches) => {
                info!("Query returned {} matches", matches.len());
                Ok(matches)
            }
            Err(e) => {
                error!("Query failed: {}", e);
                Err(DiscoveryClientError::QueryFailed(e.to_string()))
            }
        }
    }

    /// 获取当前 lease
    pub fn lease(&self) -> Option<&Lease> {
        self.lease.as_ref()
    }

    /// 检查是否已注册
    pub fn is_registered(&self) -> bool {
        self.lease.is_some()
    }
}

/// Discovery 客户端错误
#[derive(Debug, thiserror::Error)]
pub enum DiscoveryClientError {
    #[error("Register failed: {0}")]
    RegisterFailed(String),

    #[error("Deregister failed: {0}")]
    DeregisterFailed(String),

    #[error("Query failed: {0}")]
    QueryFailed(String),

    #[error("Not registered")]
    NotRegistered,
}

/// 从 agent.yaml 构建 AgentProfile
pub fn build_profile_from_config(
    did: String,
    name: String,
    version: String,
    skills: Vec<SkillConfig>,
    endpoints: Vec<EndpointConfig>,
) -> AgentProfile {
    let capabilities = skills.into_iter()
        .map(|s| Capability {
            skill: s.id,
            skill_type: s.skill_type.into(),
            input_schema: s.input_schema,
            output_schema: s.output_schema,
            qos: myco_discovery::QosProfile {
                latency_ms: s.qos.latency_ms,
                throughput_rps: s.qos.throughput_rps,
                availability: s.qos.availability,
            },
        })
        .collect();

    let endpoints = endpoints.into_iter()
        .map(|e| Endpoint {
            protocol: e.protocol.into(),
            address: e.address,
            priority: e.priority,
        })
        .collect();

    AgentProfile {
        did,
        name,
        version,
        capabilities,
        endpoints,
        economy: None,
        meta: Default::default(),
    }
}

/// Skill 配置
pub struct SkillConfig {
    pub id: String,
    pub skill_type: SkillType,
    pub input_schema: String,
    pub output_schema: String,
    pub qos: QosConfig,
}

/// QoS 配置
pub struct QosConfig {
    pub latency_ms: u64,
    pub throughput_rps: u32,
    pub availability: f64,
}

/// Endpoint 配置
pub struct EndpointConfig {
    pub protocol: ProtocolType,
    pub address: String,
    pub priority: u32,
}

/// Skill 类型
#[derive(Debug, Clone, Copy)]
pub enum SkillType {
    P, C, D, A, T, R,
}

impl From<SkillType> for myco_discovery::SkillType {
    fn from(t: SkillType) -> Self {
        match t {
            SkillType::P => myco_discovery::SkillType::P,
            SkillType::C => myco_discovery::SkillType::C,
            SkillType::D => myco_discovery::SkillType::D,
            SkillType::A => myco_discovery::SkillType::A,
            SkillType::T => myco_discovery::SkillType::T,
            SkillType::R => myco_discovery::SkillType::R,
        }
    }
}

/// 协议类型
#[derive(Debug, Clone, Copy)]
pub enum ProtocolType {
    Ipc,
    Tcp,
    Tls,
    Quic,
    Ws,
    Wss,
}

impl From<ProtocolType> for myco_discovery::Protocol {
    fn from(p: ProtocolType) -> Self {
        match p {
            ProtocolType::Ipc => myco_discovery::Protocol::Ipc,
            ProtocolType::Tcp => myco_discovery::Protocol::Tcp,
            ProtocolType::Tls => myco_discovery::Protocol::Tls,
            ProtocolType::Quic => myco_discovery::Protocol::Quic,
            ProtocolType::Ws => myco_discovery::Protocol::Ws,
            ProtocolType::Wss => myco_discovery::Protocol::Wss,
        }
    }
}
