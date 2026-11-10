//! Myco Dialog Agent - 对话服务
//!
//! LLM 驱动的对话 Agent，支持任务拆分

mod glm_client;
mod context;
mod parser;
mod service;

use myco_protocol::AgentConfig;
use tracing_subscriber::fmt;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fmt::init();

    tracing::info!("Starting Dialog Agent...");

    let config = AgentConfig {
        did: "did:myco:agent:dialog-001".to_string(),
        name: "Dialog Agent".to_string(),
        description: "对话 Agent，支持任务拆分".to_string(),
        version: "0.1.0".to_string(),
    };

    let agent = service::DialogAgent::new(config);
    agent.start().await?;

    Ok(())
}
