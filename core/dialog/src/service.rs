//! Dialog Agent Service
//!
//! LLM 驱动的对话 Agent，支持任务拆分和 PCDATR 解析

use anyhow::Result;
use myco_protocol::AgentConfig;
use myco_transport::{RepServer, RepServerConfig};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::glm_client::{GlmClient, GlmMessage};
use crate::context::ContextManager;

/// Dialog Agent
pub struct DialogAgent {
    config: AgentConfig,
    glm_client: GlmClient,
    context_manager: Arc<RwLock<ContextManager>>,
}

impl DialogAgent {
    pub fn new(config: AgentConfig) -> Self {
        Self {
            config,
            glm_client: GlmClient::new(),
            context_manager: Arc::new(RwLock::new(ContextManager::new())),
        }
    }

    pub async fn start(&self) -> Result<()> {
        tracing::info!("Dialog Agent {} starting", self.config.did);

        // 启动 REP 服务器
        let rep_config = RepServerConfig {
            endpoint: "tcp://127.0.0.1:5557".to_string(),
        };
        let rep_server = RepServer::new(rep_config);

        let glm_client = Arc::new(self.glm_client.clone());
        let context_manager = self.context_manager.clone();

        rep_server.start(move |request| {
            let glm_client = glm_client.clone();
            let context_manager = context_manager.clone();

            let request_str = String::from_utf8_lossy(&request).to_string();

            async move {
                handle_request(&request_str, &glm_client, &context_manager).await
            }
        }).await?;

        tracing::info!("Dialog Agent {} started on tcp://127.0.0.1:5557", self.config.did);

        // 保持运行
        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
        }
    }
}

/// API 响应
#[derive(Debug, Serialize)]
struct ApiResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ApiResponse {
    fn success(data: Value) -> Self {
        Self { success: true, data: Some(data), error: None }
    }

    fn error(msg: impl Into<String>) -> Self {
        Self { success: false, data: None, error: Some(msg.into()) }
    }
}

/// 处理 ZeroMQ 请求
async fn handle_request(
    request: &str,
    glm_client: &Arc<GlmClient>,
    context_manager: &Arc<RwLock<ContextManager>>,
) -> Vec<u8> {
    tracing::debug!("Dialog Agent received request: {}", request);

    // 尝试找到 JSON payload 的开始位置
    let json_start = request.find('{');
    let (command, payload): (&str, &str) = if let Some(pos) = json_start {
        (&request[..pos].trim_end_matches(':'), &request[pos..])
    } else {
        (request.trim_end_matches(':'), "")
    };

    let response = match command {
        "chat" => handle_chat(glm_client, context_manager, payload).await,
        "chat:session" => handle_chat_session(glm_client, context_manager, payload).await,
        "task:parse" => handle_task_parse(glm_client, payload).await,
        "session:create" => handle_session_create(context_manager).await,
        "session:clear" => handle_session_clear(context_manager, payload).await,
        "ping" => ApiResponse::success(json!("pong")),
        _ => ApiResponse::error(format!("Unknown command: {}", command)),
    };

    serde_json::to_vec(&response).unwrap_or_default()
}

/// 简单对话（无会话）
async fn handle_chat(
    glm_client: &Arc<GlmClient>,
    _context_manager: &Arc<RwLock<ContextManager>>,
    payload: &str,
) -> ApiResponse {
    let chat_req: Result<ChatRequest, _> = serde_json::from_str(payload);

    match chat_req {
        Ok(req) => {
            let messages = vec![
                GlmMessage {
                    role: "user".to_string(),
                    content: req.message,
                },
            ];

            match glm_client.chat(messages).await {
                Ok(response) => ApiResponse::success(json!({ "response": response })),
                Err(e) => ApiResponse::error(format!("GLM API error: {}", e)),
            }
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e)),
    }
}

/// 带会话的对话
async fn handle_chat_session(
    glm_client: &Arc<GlmClient>,
    context_manager: &Arc<RwLock<ContextManager>>,
    payload: &str,
) -> ApiResponse {
    let chat_req: Result<ChatSessionRequest, _> = serde_json::from_str(payload);

    match chat_req {
        Ok(req) => {
            // 获取或创建会话
            let mut cm = context_manager.write().await;
            let session = cm.get_or_create(&req.session_id);

            // 添加用户消息
            session.add_message("user", &req.message);

            // 获取所有消息
            let messages = session.messages.clone();
            drop(cm);

            // 调用 GLM
            match glm_client.chat(messages).await {
                Ok(response) => {
                    // 保存回复
                    let mut cm = context_manager.write().await;
                    if let Some(session) = cm.get_or_create(&req.session_id).messages.last_mut() {
                        // 添加助手回复
                        cm.add_message(&req.session_id, "assistant", &response);
                    }

                    ApiResponse::success(json!({ "response": response }))
                }
                Err(e) => ApiResponse::error(format!("GLM API error: {}", e)),
            }
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e)),
    }
}

/// 解析任务描述并拆分为 PCDATR 子任务
async fn handle_task_parse(
    glm_client: &Arc<GlmClient>,
    payload: &str,
) -> ApiResponse {
    let parse_req: Result<TaskParseRequest, _> = serde_json::from_str(payload);

    match parse_req {
        Ok(req) => {
            let system_prompt = r#"你是一个任务分析专家。请分析用户的任务描述，将其拆分为 PCDATR 格式的子任务。

PCDATR 代表:
- Perception (感知): 收集信息、理解需求
- Cognition (认知): 分析问题、设计方案
- Decision (决策): 选择方案、确定优先级
- Action (行动): 执行任务、实现功能
- Transition (转换): 状态变化、流程转换
- Reward (奖励): 验证结果、评估成果

请返回 JSON 格式的任务列表，每个任务包含:
- title: 任务标题
- type: 任务类型 (perception/cognition/decision/action/transition/reward)
- description: 任务描述
- priority: 优先级 (low/medium/high/critical)

返回格式示例:
{
  "tasks": [
    {"title": "...", "type": "perception", "description": "...", "priority": "high"},
    {"title": "...", "type": "action", "description": "...", "priority": "medium"}
  ]
}"#;

            let messages = vec![
                GlmMessage {
                    role: "user".to_string(),
                    content: format!("请分析以下任务并拆分为子任务:\n\n{}", req.description),
                },
            ];

            match glm_client.chat_with_system(system_prompt, messages).await {
                Ok(response) => {
                    // 尝试解析 JSON
                    // 提取 JSON 部分
                    let json_start = response.find('{');
                    let json_end = response.rfind('}');

                    if let (Some(start), Some(end)) = (json_start, json_end) {
                        let json_str = &response[start..=end];
                        match serde_json::from_str::<Value>(json_str) {
                            Ok(tasks) => ApiResponse::success(tasks),
                            Err(_) => ApiResponse::success(json!({
                                "raw": response,
                                "tasks": []
                            })),
                        }
                    } else {
                        ApiResponse::success(json!({
                            "raw": response,
                            "tasks": []
                        }))
                    }
                }
                Err(e) => ApiResponse::error(format!("GLM API error: {}", e)),
            }
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e)),
    }
}

/// 创建新会话
async fn handle_session_create(
    context_manager: &Arc<RwLock<ContextManager>>,
) -> ApiResponse {
    let session_id = uuid::Uuid::new_v4().to_string();
    let mut cm = context_manager.write().await;
    cm.get_or_create(&session_id);
    ApiResponse::success(json!({ "session_id": session_id }))
}

/// 清除会话
async fn handle_session_clear(
    context_manager: &Arc<RwLock<ContextManager>>,
    payload: &str,
) -> ApiResponse {
    let clear_req: Result<SessionClearRequest, _> = serde_json::from_str(payload);

    match clear_req {
        Ok(req) => {
            let mut cm = context_manager.write().await;
            cm.clear_session(&req.session_id);
            ApiResponse::success(json!({ "cleared": req.session_id }))
        }
        Err(e) => ApiResponse::error(format!("Invalid request: {}", e)),
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatRequest {
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct ChatSessionRequest {
    session_id: String,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TaskParseRequest {
    description: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionClearRequest {
    session_id: String,
}
