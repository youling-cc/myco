//! Myco Agent - Agent 基类和 Skill trait
//!
//! 实现 PCDATR 6 阶段技能系统和统一调用接口

pub mod skill;
pub mod agent;
pub mod registry;
pub mod invoker;
pub mod discovery;

pub use skill::{Skill, SkillResult, SkillContext, SkillRegistry, SkillPhase};
pub use agent::BaseAgent;
pub use registry::AgentRegistry;
pub use invoker::{SkillInvoker, SkillLocation};
pub use discovery::{AgentDiscoveryClient, DiscoveryClientError};
