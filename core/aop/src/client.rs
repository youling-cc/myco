//! client.rs — AopClient:远程附着 myco-aop-core.exe(:8102)的 HTTP 客户端。
//!
//! 方法面与 AopSessionManager 一一对应(env AopHandle 双模的 Remote 臂)。
//! 事件流:subscribe_json 返回**原始事件 JSON 串**的广播(不做 AopEvent 往返
//! 序列化——to_json→from_json→to_json 双重转换对 PlanReady marks 有漂移风险,
//! 原样透传零损)。SSE 首帧(快照数组)跳过——env 侧快照走
//! snapshot_events_json 单发,不重复推。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use myco_terminal_proto::{ChatMessage, SessionInfo};
use tokio::sync::broadcast;

use crate::session::{AopSessionConfig, HumanSubmission};
use crate::AopFrame;

pub const DEFAULT_BASE: &str = "http://127.0.0.1:8102";

#[derive(Clone)]
pub struct AopClient {
    base: String,
    http: reqwest::Client,
    inner: Arc<Inner>,
}

struct Inner {
    events_tx: broadcast::Sender<String>,
    sse_started: AtomicBool,
}

impl AopClient {
    pub fn new(base: impl Into<String>) -> Self {
        let (events_tx, _) = broadcast::channel(256);
        Self {
            base: base.into(),
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            inner: Arc::new(Inner { events_tx, sse_started: AtomicBool::new(false) }),
        }
    }

    /// 探测远端在不在(800ms;env 启动附着判定用)。
    pub async fn probe(base: &str) -> bool {
        let Ok(http) = reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(800))
            .build()
        else {
            return false;
        };
        http.get(format!("{base}/health"))
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    async fn data<T: serde::de::DeserializeOwned>(
        &self,
        req: reqwest::RequestBuilder,
    ) -> Result<T, String> {
        let resp = req.send().await.map_err(|e| format!("aop 远端不可达: {e}"))?;
        let v: serde_json::Value = resp.json().await.map_err(|e| format!("aop 响应坏包: {e}"))?;
        if v.get("success").and_then(|s| s.as_bool()).unwrap_or(false) {
            serde_json::from_value(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
                .map_err(|e| format!("aop data 形状不符: {e}"))
        } else {
            Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("aop 远端错误").to_string())
        }
    }

    fn post(&self, path: &str, body: &serde_json::Value) -> reqwest::RequestBuilder {
        self.http.post(format!("{}{path}", self.base)).json(body)
    }

    pub async fn create(&self, cfg: AopSessionConfig) -> Result<SessionInfo, String> {
        let body = serde_json::to_value(&cfg).map_err(|e| e.to_string())?;
        self.data(self.post("/api/labs/create", &body)).await
    }

    pub async fn destroy_task(&self, task_id: &str) -> bool {
        let body = serde_json::json!({ "taskId": task_id });
        self.data::<bool>(self.post("/api/labs/destroy_task", &body))
            .await
            .unwrap_or(false)
    }

    pub async fn list(&self) -> Vec<SessionInfo> {
        let req = self.http.get(format!("{}/api/labs/list", self.base));
        self.data(req).await.unwrap_or_default()
    }

    pub async fn send_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        let body = serde_json::json!({ "sessionId": session_id, "text": text });
        self.data(self.post("/api/labs/message", &body)).await
    }

    pub async fn stop(&self, session_id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "sessionId": session_id });
        self.data(self.post("/api/labs/stop", &body)).await
    }

    pub async fn pause(&self, session_id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "sessionId": session_id });
        self.data(self.post("/api/labs/pause", &body)).await
    }

    pub async fn resume(&self, session_id: &str) -> Result<(), String> {
        let body = serde_json::json!({ "sessionId": session_id });
        self.data(self.post("/api/labs/resume", &body)).await
    }

    pub async fn human_submit(&self, session_id: &str, sub: HumanSubmission) -> Result<(), String> {
        let body = serde_json::json!({
            "sessionId": session_id,
            "slug": sub.slug,
            "note": sub.note,
            "artifacts": sub.artifacts,
        });
        self.data(self.post("/api/labs/human_submit", &body)).await
    }

    pub async fn frames_of(&self, session_id: &str) -> Vec<AopFrame> {
        let req = self.http.get(format!("{}/api/labs/frames/{session_id}", self.base));
        self.data(req).await.unwrap_or_default()
    }

    pub async fn messages_of(&self, session_id: &str) -> Vec<ChatMessage> {
        let req = self.http.get(format!("{}/api/labs/history/{session_id}", self.base));
        let v: serde_json::Value = self.data(req).await.unwrap_or_default();
        serde_json::from_value(v.get("messages").cloned().unwrap_or_default()).unwrap_or_default()
    }

    pub async fn dataset_toggle(&self, session_id: &str, on: bool) -> Result<serde_json::Value, String> {
        let body = serde_json::json!({ "sessionId": session_id, "on": on });
        self.data(self.post("/api/labs/dataset_toggle", &body)).await
    }

    pub async fn snapshot_events_json(&self) -> String {
        let req = self.http.get(format!("{}/api/labs/events_snapshot", self.base));
        match self.data::<serde_json::Value>(req).await {
            Ok(v) => v
                .get("snapshotJson")
                .and_then(|s| s.as_str())
                .unwrap_or("[]")
                .to_string(),
            Err(_) => "[]".to_string(),
        }
    }

    /// 订阅远端事件流(原始 JSON 串;首帧快照已跳过)。
    /// 幂等:首次调用拉起 SSE 重连循环,之后纯广播分发。
    pub fn subscribe_json(&self) -> broadcast::Receiver<String> {
        let rx = self.inner.events_tx.subscribe();
        if !self.inner.sse_started.swap(true, Ordering::SeqCst) {
            let base = self.base.clone();
            let tx = self.inner.events_tx.clone();
            tokio::spawn(async move {
                sse_loop(base, tx).await;
            });
        }
        rx
    }
}

/// SSE 长连读 /api/labs/events:跳过首帧快照,事件原样转发进广播;断线 3s 重连。
async fn sse_loop(base: String, tx: broadcast::Sender<String>) {
    use futures_util::StreamExt;
    loop {
        let resp = match reqwest::Client::new()
            .get(format!("{base}/api/labs/events"))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => {
                tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                continue;
            }
        };
        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut first = true;
        // 45s 读超时:防半开 TCP 吊死(answerer 失聪事故同款根因)
        loop {
            let chunk = match tokio::time::timeout(std::time::Duration::from_secs(45), stream.next()).await {
                Ok(Some(Ok(c))) => c,
                _ => break, // 流结束/超时/错 → 外层重连
            };
            buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(idx) = buf.find("\n\n") {
                let block = buf[..idx].to_string();
                buf = buf[idx + 2..].to_string();
                for line in block.lines() {
                    let Some(data) = line.strip_prefix("data: ") else { continue };
                    if first {
                        first = false; // 首帧=快照数组,跳过(env 单发)
                        continue;
                    }
                    let _ = tx.send(data.to_string());
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    }
}
