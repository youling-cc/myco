//! Message framing and codec for Agent communication
//!
//! Uses length-delimited framing with JSON serialization

use bytes::{Buf, BytesMut};
use serde::{Deserialize, Serialize};
use std::io;
use tokio_util::codec::{Decoder, Encoder};

/// Message types for Agent-to-Agent communication
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AgentMessage {
    /// Invoke request
    Invoke {
        task: crate::Task,
    },
    /// Invoke response
    InvokeResponse {
        success: bool,
        output: serde_json::Value,
        error: Option<String>,
        execution_time_ms: u64,
    },
    /// Health check request
    HealthCheck,
    /// Health check response
    HealthCheckResponse { healthy: bool },
    /// Error response
    Error { code: u32, message: String },
}

/// Codec for Agent messages
#[derive(Debug, Clone)]
pub struct AgentMessageCodec;

impl AgentMessageCodec {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AgentMessageCodec {
    fn default() -> Self {
        Self::new()
    }
}

impl Encoder<AgentMessage> for AgentMessageCodec {
    type Error = io::Error;

    fn encode(&mut self, item: AgentMessage, dst: &mut BytesMut) -> Result<(), Self::Error> {
        let json = serde_json::to_vec(&item).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("JSON serialize error: {}", e))
        })?;
        // 使用长度前缀 framing
        dst.extend_from_slice(&(json.len() as u32).to_be_bytes());
        dst.extend_from_slice(&json);
        Ok(())
    }
}

impl Decoder for AgentMessageCodec {
    type Item = AgentMessage;
    type Error = io::Error;

    fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Self::Item>, Self::Error> {
        // 需要至少 4 字节的长度前缀
        if src.len() < 4 {
            return Ok(None);
        }

        // 读取长度前缀
        let length = u32::from_be_bytes([src[0], src[1], src[2], src[3]]) as usize;

        // 检查是否有足够的数据
        if src.len() < 4 + length {
            return Ok(None);
        }

        // 解析 JSON
        let message = serde_json::from_slice(&src[4..4 + length]).map_err(|e| {
            io::Error::new(io::ErrorKind::InvalidData, format!("JSON deserialize error: {}", e))
        })?;

        // 消耗已解析的数据
        src.advance(4 + length);

        Ok(Some(message))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_message_roundtrip() {
        let msg = AgentMessage::Invoke {
            task: crate::Task {
                skill: "data.collect".to_string(),
                input: serde_json::json!({"key": "value"}),
            },
        };

        let mut codec = AgentMessageCodec::new();
        let mut buf = BytesMut::new();

        codec.encode(msg.clone(), &mut buf).unwrap();
        let decoded = codec.decode(&mut buf).unwrap().unwrap();

        match (msg, decoded) {
            (AgentMessage::Invoke { task: t1 }, AgentMessage::Invoke { task: t2 }) => {
                assert_eq!(t1.skill, t2.skill);
            }
            _ => panic!("Message type mismatch"),
        }
    }
}
