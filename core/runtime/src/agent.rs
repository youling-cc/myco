//! Agent 基类
//!
//! 实现 Agent 的生命周期管理

use std::sync::Arc;
use tokio::sync::Mutex;
use myco_protocol::AgentConfig;

use crate::skill::{SkillRegistry, SkillContext, SkillResult};

/// Agent 状态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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

/// Agent 错误
#[derive(Debug, thiserror::Error)]
pub enum AgentError {
    #[error("Agent not running")]
    NotRunning,
    #[error("Skill not found: {0}")]
    SkillNotFound(String),
    #[error("Execution error: {0}")]
    ExecutionError(String),
}

/// Agent 基类
pub struct BaseAgent {
    /// 配置
    pub config: AgentConfig,
    /// 状态
    status: Arc<Mutex<AgentStatus>>,
    /// 技能注册表
    skills: SkillRegistry,
}

impl BaseAgent {
    pub fn new(config: AgentConfig) -> Self {
        Self {
            config,
            status: Arc::new(Mutex::new(AgentStatus::Stopped)),
            skills: SkillRegistry::new(),
        }
    }

    /// 获取 DID
    pub fn did(&self) -> &str {
        &self.config.did
    }

    /// 获取名称
    pub fn name(&self) -> &str {
        &self.config.name
    }

    /// 获取当前状态
    pub async fn status(&self) -> AgentStatus {
        *self.status.lock().await
    }

    /// 启动 Agent
    pub async fn start(&self) -> Result<(), AgentError> {
        let mut status = self.status.lock().await;
        if *status == AgentStatus::Running {
            return Ok(());
        }

        *status = AgentStatus::Starting;
        tracing::info!("Agent {} starting", self.config.name);

        // TODO: 初始化传输层

        *status = AgentStatus::Running;
        tracing::info!("Agent {} started", self.config.name);
        Ok(())
    }

    /// 停止 Agent
    pub async fn stop(&self) -> Result<(), AgentError> {
        let mut status = self.status.lock().await;
        if *status != AgentStatus::Running {
            return Ok(());
        }

        *status = AgentStatus::Stopping;
        tracing::info!("Agent {} stopping", self.config.name);

        // TODO: 清理传输层

        *status = AgentStatus::Stopped;
        tracing::info!("Agent {} stopped", self.config.name);
        Ok(())
    }

    /// 注册技能
    pub fn register_skill(&mut self, skill: Box<dyn crate::skill::Skill>) {
        self.skills.register(skill);
    }

    /// 调用技能
    pub async fn invoke_skill(&self, name: &str, context: SkillContext) -> Result<SkillResult, AgentError> {
        let status = self.status.lock().await;
        if *status != AgentStatus::Running {
            return Err(AgentError::NotRunning);
        }
        drop(status);

        let skill = self.skills.get(name)
            .ok_or_else(|| AgentError::SkillNotFound(name.to_string()))?;

        Ok(skill.execute(context).await)
    }
}
