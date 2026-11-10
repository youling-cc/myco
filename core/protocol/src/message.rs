//! ZMQ 消息类型
//!
//! 所有 Agent 间通信的消息格式

use serde::{Deserialize, Serialize};

/// 消息类型枚举
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum MessageType {
    // 任务操作
    #[serde(rename = "task:list")]
    TaskList,
    #[serde(rename = "task:get")]
    TaskGet,
    #[serde(rename = "task:create")]
    TaskCreate,
    #[serde(rename = "task:update")]
    TaskUpdate,
    #[serde(rename = "task:delete")]
    TaskDelete,
    #[serde(rename = "task:start")]
    TaskStart,

    // 图操作
    #[serde(rename = "graph:scan")]
    GraphScan,
    #[serde(rename = "graph:get")]
    GraphGet,

    // 事件广播
    #[serde(rename = "event:task-created")]
    EventTaskCreated,
    #[serde(rename = "event:task-updated")]
    EventTaskUpdated,
    #[serde(rename = "event:task-deleted")]
    EventTaskDeleted,
    #[serde(rename = "event:task-started")]
    EventTaskStarted,
    #[serde(rename = "event:task-completed")]
    EventTaskCompleted,

    // 对话
    #[serde(rename = "chat:message")]
    ChatMessage,
    #[serde(rename = "chat:response")]
    ChatResponse,
    #[serde(rename = "chat:stream")]
    ChatStream,

    // 系统
    #[serde(rename = "system:ping")]
    SystemPing,
    #[serde(rename = "system:pong")]
    SystemPong,
    #[serde(rename = "system:error")]
    SystemError,
    #[serde(rename = "system:ready")]
    SystemReady,
}

/// ZMQ 消息格式
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZmqMessage<T = serde_json::Value> {
    /// 消息唯一 ID
    pub id: String,
    /// 消息类型
    #[serde(rename = "type")]
    pub message_type: MessageType,
    /// 发送方 DID
    pub from: String,
    /// 接收方 DID (广播时为 '*')
    pub to: String,
    /// ISO 时间戳
    pub timestamp: String,
    /// 消息内容
    pub payload: T,
    /// 关联 ID (请求-响应模式)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<String>,
}

impl<T> ZmqMessage<T> {
    /// 创建新消息
    pub fn new(message_type: MessageType, from: impl Into<String>, to: impl Into<String>, payload: T) -> Self {
        Self {
            id: format!("msg-{}-{}", chrono::Utc::now().timestamp_millis(), uuid::Uuid::new_v4()),
            message_type,
            from: from.into(),
            to: to.into(),
            timestamp: chrono::Utc::now().to_rfc3339(),
            payload,
            correlation_id: None,
        }
    }

    /// 设置关联 ID
    pub fn with_correlation_id(mut self, id: impl Into<String>) -> Self {
        self.correlation_id = Some(id.into());
        self
    }
}

// ============================================
// 任务相关 Payload
// ============================================

/// 任务列表请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskListPayload {
    pub base_path: String,
    pub status: Option<String>,
    pub priority: Option<String>,
}

/// 任务列表响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskSummary>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSummary {
    pub id: String,
    pub title: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    pub directory: String,
}

/// 获取任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGetPayload {
    pub task_id: String,
    pub base_path: String,
}

/// 创建任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCreatePayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_dir: Option<String>,
    pub title: String,
    pub goal: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<String>>,
}

/// 更新任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUpdatePayload {
    pub task_id: String,
    pub base_path: String,
    pub updates: TaskUpdates,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskUpdates {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// 删除任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDeletePayload {
    pub task_id: String,
    pub base_path: String,
}

/// 启动任务请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskStartPayload {
    pub task_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
}

// ============================================
// 图相关 Payload
// ============================================

/// 扫描图请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphScanPayload {
    pub base_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_depth: Option<usize>,
}

/// 获取图请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraphGetPayload {
    pub base_path: String,
}

// ============================================
// 事件 Payload
// ============================================

/// 任务事件
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskEventPayload {
    pub task: serde_json::Value,
    pub timestamp: String,
}

// ============================================
// 对话相关 Payload
// ============================================

/// 对话消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessagePayload {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<ChatContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_path: Option<String>,
}

/// 对话响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatResponsePayload {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actions: Option<Vec<ChatAction>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatAction {
    #[serde(rename = "type")]
    pub action_type: String,
    pub data: serde_json::Value,
}

/// 对话流
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatStreamPayload {
    pub delta: String,
    pub done: bool,
}

// ============================================
// 系统 Payload
// ============================================

/// 系统错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemErrorPayload {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

// ============================================
// 通用响应
// ============================================

/// 成功响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SuccessResponse<T> {
    pub success: bool,
    pub data: T,
}

/// 错误响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub success: bool,
    pub error: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// API 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ApiResponse<T> {
    Success(SuccessResponse<T>),
    Error(ErrorResponse),
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        ApiResponse::Success(SuccessResponse {
            success: true,
            data,
        })
    }

    pub fn error(message: impl Into<String>) -> Self {
        ApiResponse::Error(ErrorResponse {
            success: false,
            error: message.into(),
            code: None,
        })
    }

    pub fn error_with_code(code: impl Into<String>, message: impl Into<String>) -> Self {
        ApiResponse::Error(ErrorResponse {
            success: false,
            error: message.into(),
            code: Some(code.into()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_serialization() {
        let msg = ZmqMessage::new(
            MessageType::TaskList,
            "did:myco:agent:test",
            "did:myco:agent:pomdp-001",
            TaskListPayload {
                base_path: "/tmp/tasks".to_string(),
                status: None,
                priority: None,
            },
        );

        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains(r#""type":"task:list""#));
        assert!(json.contains(r#""from":"did:myco:agent:test""#));
    }

    #[test]
    fn test_message_deserialization() {
        let json = r#"{
            "id": "msg-123",
            "type": "task:list",
            "from": "did:myco:agent:test",
            "to": "did:myco:agent:pomdp-001",
            "timestamp": "2026-03-16T10:00:00Z",
            "payload": {
                "base_path": "/tmp/tasks"
            }
        }"#;

        let msg: ZmqMessage<TaskListPayload> = serde_json::from_str(json).unwrap();
        assert_eq!(msg.message_type, MessageType::TaskList);
        assert_eq!(msg.payload.base_path, "/tmp/tasks");
    }
}
