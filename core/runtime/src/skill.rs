//! Skill trait 和 PCDATR 实现
//!
//! 定义技能的统一接口

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// PCDATR 阶段
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub enum SkillPhase {
    Perception,
    Cognition,
    Decision,
    Action,
    Transition,
    Reward,
}

/// Skill 上下文
#[derive(Debug, Clone)]
pub struct SkillContext {
    /// Agent 状态
    pub state: serde_json::Value,
    /// 输入数据
    pub input: Option<serde_json::Value>,
    /// 环境信息
    pub environment: HashMap<String, serde_json::Value>,
}

impl Default for SkillContext {
    fn default() -> Self {
        Self {
            state: serde_json::json!({}),
            input: None,
            environment: HashMap::new(),
        }
    }
}

/// Skill 结果
#[derive(Debug, Clone)]
pub struct SkillResult {
    /// 输出数据
    pub output: serde_json::Value,
    /// 是否需要终止
    pub should_terminate: bool,
    /// 错误信息
    pub error: Option<String>,
}

impl SkillResult {
    pub fn success(output: serde_json::Value) -> Self {
        Self {
            output,
            should_terminate: false,
            error: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        Self {
            output: serde_json::json!(null),
            should_terminate: true,
            error: Some(message.into()),
        }
    }
}

/// Skill trait
#[async_trait]
pub trait Skill: Send + Sync {
    /// 技能名称
    fn name(&self) -> &str;

    /// 技能描述
    fn description(&self) -> Option<&str> {
        None
    }

    /// 所属阶段
    fn phase(&self) -> SkillPhase;

    /// 执行技能
    async fn execute(&self, context: SkillContext) -> SkillResult;
}

/// Skill 注册表
pub struct SkillRegistry {
    skills: HashMap<String, Box<dyn Skill>>,
}

impl SkillRegistry {
    pub fn new() -> Self {
        Self {
            skills: HashMap::new(),
        }
    }

    pub fn register(&mut self, skill: Box<dyn Skill>) {
        self.skills.insert(skill.name().to_string(), skill);
    }

    pub fn get(&self, name: &str) -> Option<&Box<dyn Skill>> {
        self.skills.get(name)
    }

    pub fn list(&self) -> Vec<&str> {
        self.skills.keys().map(|s| s.as_str()).collect()
    }
}

impl Default for SkillRegistry {
    fn default() -> Self {
        Self::new()
    }
}
