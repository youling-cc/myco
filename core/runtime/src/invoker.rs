//! Skill 调用器
//!
//! 统一处理 Local/IPC/Network 调用

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::skill::{SkillContext, SkillResult};

/// Skill 位置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum SkillLocation {
    /// 本地调用
    Local,
    /// IPC 调用 (ZeroMQ)
    Ipc(String),
    /// 网络调用 (HTTP/DID)
    Network(String),
}

/// Skill 调用错误
#[derive(Debug, Error)]
pub enum InvokerError {
    #[error("Skill not found: {0}")]
    SkillNotFound(String),
    #[error("IPC error: {0}")]
    IpcError(String),
    #[error("Network error: {0}")]
    NetworkError(String),
    #[error("Timeout")]
    Timeout,
}

/// Skill 调用器
pub struct SkillInvoker {
    // TODO: 添加传输层客户端
}

impl SkillInvoker {
    pub fn new() -> Self {
        Self {}
    }

    /// 调用技能
    pub async fn invoke(
        &self,
        location: &SkillLocation,
        skill_name: &str,
        context: SkillContext,
    ) -> Result<SkillResult, InvokerError> {
        match location {
            SkillLocation::Local => {
                // 本地调用由 Agent 直接处理
                Err(InvokerError::SkillNotFound(skill_name.to_string()))
            }
            SkillLocation::Ipc(endpoint) => {
                self.invoke_ipc(endpoint, skill_name, context).await
            }
            SkillLocation::Network(url) => {
                self.invoke_http(url, skill_name, context).await
            }
        }
    }

    async fn invoke_ipc(
        &self,
        _endpoint: &str,
        skill_name: &str,
        _context: SkillContext,
    ) -> Result<SkillResult, InvokerError> {
        // TODO: 实现 ZeroMQ IPC 调用
        tracing::debug!("IPC invoke: {}", skill_name);
        Ok(SkillResult::success(serde_json::json!({})))
    }

    async fn invoke_http(
        &self,
        _url: &str,
        skill_name: &str,
        _context: SkillContext,
    ) -> Result<SkillResult, InvokerError> {
        // TODO: 实现 HTTP 调用
        tracing::debug!("HTTP invoke: {}", skill_name);
        Ok(SkillResult::success(serde_json::json!({})))
    }
}

impl Default for SkillInvoker {
    fn default() -> Self {
        Self::new()
    }
}
