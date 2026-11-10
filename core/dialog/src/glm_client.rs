//! GLM Client - 智谱 GLM API 客户端 (Anthropic 兼容)
//!
//! 调用 GLM API 进行对话

use reqwest::Client;
use serde::{Deserialize, Serialize};

/// GLM API 错误
#[derive(Debug, thiserror::Error)]
pub enum GlmError {
    #[error("HTTP error: {0}")]
    HttpError(String),

    #[error("API error: {0}")]
    ApiError(String),

    #[error("API key not configured")]
    ApiKeyNotConfigured,

    #[error("Parse error: {0}")]
    ParseError(String),
}

/// GLM 消息 (Anthropic 格式)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlmMessage {
    pub role: String,
    pub content: String,
}

/// Anthropic 请求格式
#[derive(Debug, Serialize)]
pub struct AnthropicRequest {
    pub model: String,
    pub messages: Vec<GlmMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
}

/// Anthropic 响应格式
#[derive(Debug, Deserialize)]
pub struct AnthropicResponse {
    pub content: Vec<ContentBlock>,
    pub model: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct ContentBlock {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

/// GLM Client (Anthropic 兼容)
#[derive(Clone)]
pub struct GlmClient {
    client: Client,
    api_key: String,
    api_base: String,
    model: String,
}

impl GlmClient {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: std::env::var("GLM_API_KEY")
                .unwrap_or_default(),  // 安全修复(2026-08-31):移除硬编码兜底key——必须经环境变量/配置注入
            api_base: std::env::var("GLM_API_BASE")
                .unwrap_or_else(|_| "https://open.bigmodel.cn/api/anthropic".to_string()),
            model: std::env::var("GLM_MODEL")
                .unwrap_or_else(|_| "glm-5".to_string()),
        }
    }

    /// 发送对话请求
    pub async fn chat(&self, messages: Vec<GlmMessage>) -> Result<String, GlmError> {
        let request = AnthropicRequest {
            model: self.model.clone(),
            messages,
            max_tokens: Some(4096),
            temperature: Some(0.7),
            system: None,
        };

        tracing::debug!("Sending request to GLM API: {:?}", request);

        let response = self.client
            .post(format!("{}/v1/messages", self.api_base))
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&request)
            .send()
            .await
            .map_err(|e| GlmError::HttpError(e.to_string()))?;

        let status = response.status();
        let body = response.text().await
            .map_err(|e| GlmError::HttpError(e.to_string()))?;

        if !status.is_success() {
            tracing::error!("GLM API error: {} - {}", status, body);
            return Err(GlmError::ApiError(format!("{}: {}", status, body)));
        }

        tracing::debug!("GLM API response: {}", body);

        let data: AnthropicResponse = serde_json::from_str(&body)
            .map_err(|e| GlmError::ParseError(format!("{}: {}", e, body)))?;

        let text = data.content
            .iter()
            .filter_map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n");

        if text.is_empty() {
            Err(GlmError::ApiError("Empty response".to_string()))
        } else {
            Ok(text)
        }
    }

    /// 带系统提示的对话
    pub async fn chat_with_system(
        &self,
        system: &str,
        messages: Vec<GlmMessage>,
    ) -> Result<String, GlmError> {
        let request = AnthropicRequest {
            model: self.model.clone(),
            messages,
            max_tokens: Some(4096),
            temperature: Some(0.7),
            system: Some(system.to_string()),
        };

        let response = self.client
            .post(format!("{}/v1/messages", self.api_base))
            .header("Content-Type", "application/json")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&request)
            .send()
            .await
            .map_err(|e| GlmError::HttpError(e.to_string()))?;

        let status = response.status();
        let body = response.text().await
            .map_err(|e| GlmError::HttpError(e.to_string()))?;

        if !status.is_success() {
            return Err(GlmError::ApiError(format!("{}: {}", status, body)));
        }

        let data: AnthropicResponse = serde_json::from_str(&body)
            .map_err(|e| GlmError::ParseError(format!("{}: {}", e, body)))?;

        let text = data.content
            .iter()
            .filter_map(|b| b.text.clone())
            .collect::<Vec<_>>()
            .join("\n");

        if text.is_empty() {
            Err(GlmError::ApiError("Empty response".to_string()))
        } else {
            Ok(text)
        }
    }
}

impl Default for GlmClient {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_glm_client() {
        let client = GlmClient::new();
        let messages = vec![
            GlmMessage {
                role: "user".to_string(),
                content: "Hello, how are you?".to_string(),
            },
        ];

        let result = client.chat(messages).await;
        println!("Result: {:?}", result);
    }
}
