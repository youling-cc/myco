//! Agent 类型定义
//!
//! Agent 声明、PCDATR 框架和运行时类型

use serde::{Deserialize, Serialize};

/// PCDATR 阶段
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum PcdatrPhase {
    Perception,
    Cognition,
    Decision,
    Action,
    Transition,
    Retribution,
}

impl std::fmt::Display for PcdatrPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PcdatrPhase::Perception => write!(f, "perception"),
            PcdatrPhase::Cognition => write!(f, "cognition"),
            PcdatrPhase::Decision => write!(f, "decision"),
            PcdatrPhase::Action => write!(f, "action"),
            PcdatrPhase::Transition => write!(f, "transition"),
            PcdatrPhase::Retribution => write!(f, "retribution"),
        }
    }
}

/// Agent 配置 (简化版)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    /// DID
    pub did: String,
    /// 名称
    pub name: String,
    /// 描述
    pub description: String,
    /// 版本
    pub version: String,
}

/// Agent 运行时状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentStatus {
    Starting,
    Running,
    Stopping,
    Stopped,
    Error,
}

impl Default for AgentStatus {
    fn default() -> Self {
        AgentStatus::Stopped
    }
}

/// Agent 运行时信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntime {
    pub config: AgentConfig,
    pub status: AgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default)]
    pub messages_processed: u64,
}

/// Skill 定义
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDef {
    /// 技能名称
    pub name: String,
    /// 技能描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 所属阶段
    pub phase: PcdatrPhase,
}

/// 完整的 Agent 配置 (从 agent.yaml 加载)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentYaml {
    pub version: u32,
    pub agent: AgentYamlInner,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skills: Vec<SkillDef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<AgentEndpoints>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentYamlInner {
    pub did: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEndpoints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rep: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pub_endpoint: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sub: Vec<String>,
}

/// Agent 注册表条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRegistryEntry {
    pub did: String,
    pub name: String,
    pub endpoints: AgentEndpoints,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seen: Option<String>,
    pub status: AgentStatus,
}
