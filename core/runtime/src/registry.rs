//! Agent 注册表
//!
//! 管理 Agent 的发现和查找

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

/// Agent 注册条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEntry {
    /// Agent DID
    pub did: String,
    /// Agent 名称
    pub name: String,
    /// REP 端点
    pub rep_endpoint: Option<String>,
    /// PUB 端点
    pub pub_endpoint: Option<String>,
    /// 最后见到时间
    pub last_seen: Option<String>,
    /// 状态
    pub status: AgentEntryStatus,
}

/// Agent 注册条目状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentEntryStatus {
    Online,
    Offline,
    Unknown,
}

/// Agent 注册表
pub struct AgentRegistry {
    agents: HashMap<String, AgentEntry>,
}

impl AgentRegistry {
    pub fn new() -> Self {
        Self {
            agents: HashMap::new(),
        }
    }

    /// 注册 Agent
    pub fn register(&mut self, entry: AgentEntry) {
        self.agents.insert(entry.did.clone(), entry);
    }

    /// 注销 Agent
    pub fn unregister(&mut self, did: &str) {
        self.agents.remove(did);
    }

    /// 查找 Agent
    pub fn find(&self, did: &str) -> Option<&AgentEntry> {
        self.agents.get(did)
    }

    /// 列出所有 Agent
    pub fn list(&self) -> Vec<&AgentEntry> {
        self.agents.values().collect()
    }

    /// 列出在线 Agent
    pub fn list_online(&self) -> Vec<&AgentEntry> {
        self.agents.values()
            .filter(|a| a.status == AgentEntryStatus::Online)
            .collect()
    }
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self::new()
    }
}
