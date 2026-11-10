//! Context Manager - 会话上下文管理
//!
//! 管理对话历史和会话状态

use std::collections::HashMap;
use crate::glm_client::GlmMessage;

/// 会话上下文
pub struct SessionContext {
    pub session_id: String,
    pub messages: Vec<GlmMessage>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub metadata: HashMap<String, serde_json::Value>,
}

impl SessionContext {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            messages: Vec::new(),
            created_at: chrono::Utc::now(),
            metadata: HashMap::new(),
        }
    }

    pub fn add_message(&mut self, role: impl Into<String>, content: impl Into<String>) {
        self.messages.push(GlmMessage {
            role: role.into(),
            content: content.into(),
        });
    }
}

/// Context Manager
pub struct ContextManager {
    sessions: HashMap<String, SessionContext>,
    max_context_size: usize,
}

impl ContextManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            max_context_size: 20,
        }
    }

    /// 获取或创建会话
    pub fn get_or_create(&mut self, session_id: &str) -> &mut SessionContext {
        self.sessions.entry(session_id.to_string())
            .or_insert_with(|| SessionContext::new(session_id))
    }

    /// 添加消息到会话
    pub fn add_message(&mut self, session_id: &str, role: impl Into<String>, content: impl Into<String>) {
        let max_size = self.max_context_size;
        let session = self.get_or_create(session_id);
        session.add_message(role, content);

        // 限制上下文大小
        if session.messages.len() > max_size {
            session.messages.remove(0);
        }
    }

    /// 获取会话消息
    pub fn get_messages(&self, session_id: &str) -> Vec<GlmMessage> {
        self.sessions.get(session_id)
            .map(|s| s.messages.clone())
            .unwrap_or_default()
    }

    /// 清除会话
    pub fn clear_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }
}

impl Default for ContextManager {
    fn default() -> Self {
        Self::new()
    }
}
