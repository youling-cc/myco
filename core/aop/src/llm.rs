//! llm.rs — 经 llm-proxy(:8111)的 Anthropic Messages 流式调用。
//!
//! SSE 帧解析(message_start/content_block_*/message_delta/message_stop/error),
//! 支持 tool_use 块的 input_json_delta 增量拼接。与 Pi agent-loop 的流式
//! 消费对齐:截断(length)由调用方决定"全部 fail 工具调用"。

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Anthropic Messages 请求体里的消息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LlmMessage {
    pub role: String,
    pub content: Vec<LlmBlock>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum LlmBlock {
    Text { text: String },
    ToolUse { id: String, name: String, input: Value },
    ToolResult { tool_use_id: String, content: Vec<ToolResultContent> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolResultContent {
    #[serde(rename = "type")]
    pub kind: String,
    pub text: String,
}

impl LlmMessage {
    pub fn user_text(text: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: vec![LlmBlock::Text { text: text.into() }],
        }
    }
}

/// 工具定义(请求侧 tools 数组)。
#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

/// 一轮 LLM 回复:纯文本 + 工具调用(顺序无关,按 index 重组)。
#[derive(Debug, Clone, Default)]
pub struct LlmTurn {
    pub text: String,
    pub tool_uses: Vec<ToolUseBlock>,
    pub stop_reason: String,
}

#[derive(Debug, Clone)]
pub struct ToolUseBlock {
    pub id: String,
    pub name: String,
    pub input: Value,
    /// input_json_delta 原始拼接(解析失败时调试用)。
    pub raw_json: String,
}

pub struct LlmClient {
    base: String,
    token: String,
    model: Option<String>,
}

impl LlmClient {
    pub fn new(base: &str, token: &str, model: Option<&str>) -> Self {
        Self { base: base.trim_end_matches('/').to_string(), token: token.to_string(), model: model.map(|m| m.to_string()) }
    }

    /// 流式跑一轮;返回聚合文本与工具调用。max_tokens 默认 8192。
    /// 瞬时故障自愈:连接类失败/5xx 重试一次(800ms 退避);总时长 5min 上限
    /// (上游挂死不再无限等,实测工具循环下一轮 turn 永不返回卡死整任务)。
    pub async fn stream_turn(
        &self,
        system: &str,
        messages: Vec<LlmMessage>,
        tools: Option<&[ToolDef]>,
        max_tokens: u32,
    ) -> Result<LlmTurn, String> {
        let url = format!("{}/v1/messages", self.base);
        let mut body = serde_json::json!({
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "stream": true,
        });
        if let Some(model) = &self.model {
            body["model"] = Value::String(model.clone());
        }
        if let Some(tools) = tools {
            body["tools"] = serde_json::to_value(tools).map_err(|e| format!("tools 序列化失败: {e}"))?;
        }

        // 总时长上限:单轮 stream(含自愈重试)超过 5min 视为上游挂死——
        // 实测出现过工具循环下一轮 turn 永不返回(流无数据无超时),整任务卡死。
        let fut = self.stream_turn_inner(system, messages, tools, max_tokens);
        match tokio::time::timeout(std::time::Duration::from_secs(300), fut).await {
            Ok(r) => r,
            Err(_) => Err("LLM 调用超时(>5min,上游疑似挂死)".to_string()),
        }
    }

    async fn stream_turn_inner(
        &self,
        system: &str,
        messages: Vec<LlmMessage>,
        tools: Option<&[ToolDef]>,
        max_tokens: u32,
    ) -> Result<LlmTurn, String> {
        let url = format!("{}/v1/messages", self.base);
        // 发送端消毒(空 text 根修):任何空文本块都会被 Kimi K3 以 400
        // "text content is empty" 拒掉(GLM 容忍,换模型才暴露)。空 Text 块
        // 直接丢;tool_result 空文本补占位;消毒后 content 为空的消息丢弃。
        let messages: Vec<LlmMessage> = messages
            .into_iter()
            .filter_map(|mut m| {
                m.content.retain(|b| !matches!(b, LlmBlock::Text { text } if text.trim().is_empty()));
                for b in m.content.iter_mut() {
                    if let LlmBlock::ToolResult { content, .. } = b {
                        for c in content.iter_mut() {
                            if c.text.trim().is_empty() {
                                c.text = "(空)".to_string();
                            }
                        }
                    }
                }
                if m.content.is_empty() { None } else { Some(m) }
            })
            .collect();
        let mut body = serde_json::json!({
            "max_tokens": max_tokens,
            "system": system,
            "messages": messages,
            "stream": true,
        });
        if let Some(model) = &self.model {
            body["model"] = Value::String(model.clone());
        }
        if let Some(tools) = tools {
            body["tools"] = serde_json::to_value(tools).map_err(|e| format!("tools 序列化失败: {e}"))?;
        }
        // 全局复用 Client:每次 new 是短命连接池,工具循环一轮一个 → TIME_WAIT 堆积
        // → 临时端口间歇耗尽 → "error sending request"(R 评审大面积失败实测根因)
        static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
        let client = CLIENT.get_or_init(|| reqwest::Client::builder()
            .pool_max_idle_per_host(8)
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()));
        let send = |c: &reqwest::Client| {
            c.post(&url)
                .header("x-api-key", &self.token)
                .header("content-type", "application/json")
                .json(&body)
                .send()
        };
        let mut resp = match send(&client).await {
            Ok(r) => r,
            Err(e1) => {
                let transient = e1.is_connect() || e1.is_timeout() || e1.is_request();
                tracing::warn!("[aop/llm] 请求失败({e1}),{}重试", if transient { "瞬时故障,800ms 后" } else { "非瞬时," });
                if !transient {
                    return Err(format!("LLM 请求失败: {e1}"));
                }
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                send(&client).await.map_err(|e2| format!("LLM 请求失败(重试后): {e2}"))?
            }
        };
        // 5xx 也给一次重试(proxy 重启中/上游抖动)
        if resp.status().as_u16() >= 500 {
            tracing::warn!("[aop/llm] 上游 {} ,800ms 后重试", resp.status());
            tokio::time::sleep(std::time::Duration::from_millis(800)).await;
            resp = send(&client).await.map_err(|e| format!("LLM 请求失败(重试后): {e}"))?;
        }
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("LLM 请求返回 {status}: {}", truncate(&text, 500)));
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut text_blocks: std::collections::BTreeMap<usize, String> = Default::default();
        let mut tool_blocks: std::collections::BTreeMap<usize, (String, String, String)> = Default::default();
        let mut stop_reason = String::new();
        let mut first_error: Option<String> = None;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("流读取失败: {e}"))?;
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = buf.find('\n') {
                let line = buf.drain(..=pos).collect::<String>();
                let line = line.trim().trim_end_matches('\r');
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
                match v["type"].as_str() {
                    Some("content_block_start") => {
                        let block = &v["content_block"];
                        let idx = v["index"].as_u64().unwrap_or(0) as usize;
                        if block["type"] == "tool_use" {
                            tool_blocks.insert(
                                idx,
                                (
                                    block["id"].as_str().unwrap_or("").to_string(),
                                    block["name"].as_str().unwrap_or("").to_string(),
                                    String::new(),
                                ),
                            );
                        } else {
                            text_blocks.insert(idx, String::new());
                        }
                    }
                    Some("content_block_delta") => {
                        let delta = &v["delta"];
                        let idx = v["index"].as_u64().unwrap_or(0) as usize;
                        match delta["type"].as_str() {
                            Some("text_delta") => {
                                let entry = text_blocks.entry(idx).or_default();
                                entry.push_str(delta["text"].as_str().unwrap_or(""));
                            }
                            Some("input_json_delta") => {
                                if let Some(t) = tool_blocks.get_mut(&idx) {
                                    t.2.push_str(delta["partial_json"].as_str().unwrap_or(""));
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("message_delta") => {
                        if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                            stop_reason = sr.to_string();
                        }
                    }
                    Some("message_stop") => {}
                    Some("error") => {
                        first_error = Some(
                            v["error"]["message"]
                                .as_str()
                                .unwrap_or("unknown")
                                .to_string(),
                        );
                    }
                    _ => {}
                }
            }
        }

        if let Some(e) = first_error {
            return Err(format!("LLM 流错误: {e}"));
        }
        if stop_reason.is_empty() {
            stop_reason = "stop".to_string();
        }

        let text = text_blocks
            .into_values()
            .collect::<Vec<_>>()
            .join("\n");
        let mut tool_uses = Vec::new();
        for (_idx, (id, name, raw_json)) in tool_blocks {
            let input: Value = match serde_json::from_str(&raw_json) {
                Ok(v) => v,
                Err(_) => {
                    // 半截参数:标记为空对象,由调用方按 length 语义决定是否执行
                    Value::Object(Default::default())
                }
            };
            tool_uses.push(ToolUseBlock { id, name, input, raw_json });
        }

        Ok(LlmTurn { text, tool_uses, stop_reason })
    }
}

fn truncate(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().take(max).collect();
    let mut out: String = chars.into_iter().collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_message_user_text() {
        let m = LlmMessage::user_text("hi");
        match &m.content[0] {
            LlmBlock::Text { text } => assert_eq!(text, "hi"),
            _ => panic!("应为 Text"),
        }
    }

    #[test]
    fn tool_result_serde_shape() {
        let block = LlmBlock::ToolResult {
            tool_use_id: "tu_1".into(),
            content: vec![ToolResultContent { kind: "text".into(), text: "ok".into() }],
        };
        let v = serde_json::to_value(&block).unwrap();
        assert_eq!(v["type"], "tool_result");
        assert_eq!(v["tool_use_id"], "tu_1");
    }
}
