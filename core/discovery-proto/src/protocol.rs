//! Discovery 协议定义

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Agent DID
pub type DID = String;

/// 租约 ID
pub type LeaseId = String;

/// 技能标识
pub type Skill = String;

/// Agent Profile（画像）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentProfile {
    pub did: DID,
    pub name: String,
    pub version: String,
    pub capabilities: Vec<Capability>,
    pub endpoints: Vec<Endpoint>,
    #[serde(default)]
    pub economy: Option<EconomyProfile>,
    #[serde(default)]
    pub meta: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capability {
    pub skill: Skill,
    #[serde(rename = "type")]
    pub skill_type: SkillType,
    pub input_schema: String,
    pub output_schema: String,
    pub qos: QosProfile,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum SkillType {
    P, C, D, A, T, R,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QosProfile {
    pub latency_ms: u64,
    pub throughput_rps: u32,
    pub availability: f64,
}

/// QoS 查询要求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QosRequirements {
    pub max_latency_ms: Option<u32>,
    pub min_throughput_rps: Option<u32>,
    pub min_availability: Option<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Endpoint {
    pub protocol: Protocol,
    pub address: String,
    pub priority: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Ipc, Tcp, Tls, Quic, Ws, Wss,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EconomyProfile {
    pub staking: u64,
    pub reputation: f64,
    pub price_per_call: f64,
    pub payment_address: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Lease {
    pub lease_id: LeaseId,
    pub did: DID,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryRequest {
    pub request_id: String,
    pub requirements: TaskRequirements,
    #[serde(default = "default_max_results")]
    pub max_results: usize,
}

fn default_max_results() -> usize { 10 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskRequirements {
    pub skills: Vec<Skill>,
    pub qos_requirements: Option<QosProfile>,
    pub max_price: Option<f64>,
    pub min_reputation: Option<f64>,
    #[serde(default)]
    pub context: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMatch {
    pub profile: AgentProfile,
    pub score: f64,
    pub rank: usize,
    pub endpoint: Endpoint,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchContext {
    pub candidates: Vec<AgentProfile>,
    pub requirements: TaskRequirements,
    #[serde(default)]
    pub context: HashMap<String, serde_json::Value>,
    pub caller: DID,
    pub timestamp: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DiscoveryMessage {
    Register { profile: AgentProfile, signature: Option<String> },
    RegisterResponse { success: bool, lease: Option<Lease>, error: Option<String> },
    Deregister { did: DID, lease_id: LeaseId, signature: Option<String> },
    DeregisterResponse { success: bool, error: Option<String> },
    Query(QueryRequest),
    QueryResponse { request_id: String, matches: Vec<AgentMatch> },
    Heartbeat { did: DID, lease_id: LeaseId, metrics: Option<AgentMetrics> },
    HeartbeatResponse { lease_id: LeaseId, expires_at: DateTime<Utc> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentMetrics {
    pub requests_processed: u64,
    pub avg_latency_ms: f64,
    pub error_rate: f64,
    pub current_load: f64,
    pub uptime_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RegistryEvent {
    AgentRegistered { did: DID, profile: AgentProfile },
    AgentDeregistered { did: DID },
    AgentExpired { did: DID },
    HeartbeatReceived { did: DID, metrics: Option<AgentMetrics> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchPolicy {
    pub capability_weight: f64,
    pub qos_weight: f64,
    pub latency_weight: f64,
    pub reputation_weight: f64,
    pub price_weight: f64,
    pub custom_scorer: Option<String>,
}

impl Default for MatchPolicy {
    fn default() -> Self {
        Self {
            capability_weight: 0.4,
            qos_weight: 0.3,
            latency_weight: 0.2,
            reputation_weight: 0.05,
            price_weight: 0.05,
            custom_scorer: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub skill: Skill,
    pub input: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskResult {
    pub output: serde_json::Value,
    pub execution_time_ms: u64,
    pub success: bool,
    pub error: Option<String>,
}
