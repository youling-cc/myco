//! AOP harness — env 内嵌的 AOP(面向智能体编程)会话运行时。
//!
//! chat-native:不依赖 terminal-agent、不启动任何终端进程。会话权威在本模块,
//! 事件经 env HTTP SSE(:3002/api/aop/events)以兼容 ta ObservationEvent 的
//! 形状广播,前端 belief-store 直接融合 → 聊天气泡渲染零改。
//!
//! 阶段流(参考 aop-task-designer 的 /aop 方法论):
//!   define(起草 ROSA 任务定义) → plan(PCDATR 拆解,落盘 agents/<layer>-<slug>/task.md,
//!   触发 pomdp 重扫 → 任务图现子任务) → execute(按 P→C→D→A→T→R 逐子任务执行 +
//!   R 评价) → report(R 汇总表)。

pub mod llm;
pub mod client;
pub mod config;
pub mod frames;
pub mod http;
pub mod plan;
mod prompts;
mod r_agent;
pub mod dataset;
pub mod session;
mod taskfile;
pub mod tools;

pub use frames::{AopFrame, ExecutorKind, FrameKind, TraceRecorder};
pub use plan::{AopPlan, SubTask};
pub use session::{AopSession, AopSessionConfig, HumanSubmission};

use std::collections::HashMap;
use std::sync::Arc;

use chrono::Utc;
use myco_terminal_proto::{ChatMessage, SessionInfo};
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use myco_transport::{ReqClient, ReqClientConfig};

/// 本 harness 的 appType 标识(前端按它分流输入/隐藏终端面板)。
pub const APP_TYPE: &str = "aop";
const PROXY_BASE: &str = "http://127.0.0.1:8111";
const ZMQ_ENDPOINT: &str = "tcp://127.0.0.1:5555";

/// 会话级事件。to_json 产出的形状与 ta belief-events 的 ObservationEvent 兼容
/// (camelCase + kind 分派),前端 belief-store 的 applyObservationEvent 直接消费。
#[derive(Debug, Clone)]
pub enum AopEvent {
    /// SSE 首帧:该会话的完整 belief 快照(消息历史 + live 状态)。
    Snapshot {
        session_id: String,
        task_id: String,
        messages: Vec<ChatMessage>,
        app_state: String,
    },
    /// 用户消息即时回显(author 空=本机)。
    InputEcho { session_id: String, text: String, at_ms: i64 },
    /// LLM 轮次开始(前端显示"生成中" spinner)。
    GenStart { session_id: String, working_since_ms: i64 },
    /// 一条聊天消息(role=user/assistant)。
    Message { session_id: String, message: ChatMessage },
    /// LLM 轮次结束。
    GenEnd { session_id: String },
    /// 会话粗态变化(appState=idle/working)。fineState 对齐三 harness 细态口径:
    /// Planning→generating / Executing→tool_running / Idle→idle_ready,
    /// 管线失败收尾→error_blocked(与 ta proxy_error 同语义),用户中断→interrupted。
    State { session_id: String, app_state: String, fine_state: Option<String> },
    /// 任务图已变化(plan 写盘/状态更新后)——前端重拉 get_task_graph。
    GraphChanged,
    /// 过程数据帧(纲领二:o/s/a/r 直播,P 视图插件消费)。
    Frame { session_id: String, frame: Box<AopFrame> },
    /// 子任务开始执行。
    SubtaskStart { session_id: String, slug: String, layer: String, title: String, executor: String },
    /// 子任务完成(含 R 评审结论;interrupted=用户中断,非未达标)。
    SubtaskDone { session_id: String, slug: String, layer: String, title: String, score: Option<f64>, pass: bool, attempts: u32, interrupted: bool },
    /// 拆解完成(plan 卡片数据)。marks = 子任务运行态覆盖(slug→(status,score,attempts)),
    /// 仅快照回放时携带(断线重连还原数字孪生);live 首次拆解为 None(全 pending)。
    PlanReady {
        session_id: String,
        plan: Box<AopPlan>,
        marks: Option<std::collections::HashMap<String, (String, Option<f64>, u32)>>,
    },
    /// 自强不息一轮:R 评审未达标,feedback 回灌执行者重跑。
    EvalRound { session_id: String, slug: String, attempt: u32, score: Option<f64>, feedback: String },
    /// 人工节点待交付(纲领五:人类执行者的 P 呈现——GUI 任务卡数据)。
    HumanTaskPending { session_id: String, slug: String, layer: String, title: String, goal: String, inputs: Vec<String>, out: Vec<String>, r_criteria: Vec<String>, upstream: String },
    /// 会话已暂停(用户「等等」),deadline_at=自动续跑时刻(unix ms;纲领一:期限暂停)。
    Paused { session_id: String, deadline_ms: i64 },
    /// 暂停解除(用户消息提前续跑 / deadline 到期自动续跑;auto 区分)。
    Resumed { session_id: String, auto: bool },
}

impl AopEvent {
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            AopEvent::Snapshot { session_id, task_id, messages, app_state } => serde_json::json!({
                "kind": "snapshot",
                "sessionId": session_id,
                "belief": {
                    "sessionMeta": { "sessionId": session_id, "taskId": task_id },
                    "live": {
                        "appState": app_state,
                        "fineState": null,
                        "appType": APP_TYPE,
                        "interactive": false,
                        "picker": null,
                        "todos": null,
                    },
                    "messages": messages,
                    "conn": "online",
                },
            }),
            AopEvent::InputEcho { session_id, text, at_ms } => serde_json::json!({
                "kind": "input_echo",
                "sessionId": session_id,
                "text": text,
                "atMs": at_ms,
            }),
            AopEvent::GenStart { session_id, working_since_ms } => serde_json::json!({
                "kind": "gen_start",
                "sessionId": session_id,
                "workingSinceMs": working_since_ms,
            }),
            AopEvent::Message { session_id, message } => serde_json::json!({
                "kind": "message",
                "sessionId": session_id,
                "message": message,
            }),
            AopEvent::GenEnd { session_id } => serde_json::json!({
                "kind": "gen_end",
                "sessionId": session_id,
            }),
            AopEvent::State { session_id, app_state, fine_state } => serde_json::json!({
                "kind": "state",
                "sessionId": session_id,
                "appState": app_state,
                "fineState": fine_state,
                "appType": APP_TYPE,
                "approval": null,
            }),
            AopEvent::GraphChanged => serde_json::json!({ "kind": "graph_changed" }),
            AopEvent::Frame { session_id, frame } => serde_json::json!({
                "kind": "aop_frame",
                "sessionId": session_id,
                "frame": frame,
            }),
            AopEvent::SubtaskStart { session_id, slug, layer, title, executor } => serde_json::json!({
                "kind": "aop_subtask_start",
                "sessionId": session_id,
                "slug": slug, "layer": layer, "title": title, "executor": executor,
            }),
            AopEvent::SubtaskDone { session_id, slug, layer, title, score, pass, attempts, interrupted } => serde_json::json!({
                "kind": "aop_subtask_done",
                "sessionId": session_id,
                "slug": slug, "layer": layer, "title": title,
                "score": score, "pass": pass, "attempts": attempts,
                "interrupted": interrupted,
            }),
            AopEvent::PlanReady { session_id, plan, marks } => {
                let mut plan_json = serde_json::to_value(plan).unwrap_or_default();
                // 快照回放:把运行态覆盖进每个子任务(status/score/attempts)
                if let Some(marks) = marks {
                    if let Some(subs) = plan_json.get_mut("subtasks").and_then(|s| s.as_array_mut()) {
                        for st in subs {
                            if let Some(slug) = st.get("slug").and_then(|s| s.as_str()) {
                                if let Some((status, score, attempts)) = marks.get(slug) {
                                    st["status"] = serde_json::json!(status);
                                    st["score"] = serde_json::json!(score);
                                    st["attempts"] = serde_json::json!(attempts);
                                }
                            }
                        }
                    }
                }
                serde_json::json!({
                    "kind": "aop_plan_ready",
                    "sessionId": session_id,
                    "plan": plan_json,
                })
            }
            AopEvent::EvalRound { session_id, slug, attempt, score, feedback } => serde_json::json!({
                "kind": "aop_eval_round",
                "sessionId": session_id,
                "slug": slug, "attempt": attempt, "score": score, "feedback": feedback,
            }),
            AopEvent::HumanTaskPending { session_id, slug, layer, title, goal, inputs, out, r_criteria, upstream } => serde_json::json!({
                "kind": "aop_human_pending",
                "sessionId": session_id,
                "slug": slug, "layer": layer, "title": title, "goal": goal,
                "inputs": inputs, "out": out, "rCriteria": r_criteria, "upstream": upstream,
            }),
            AopEvent::Paused { session_id, deadline_ms } => serde_json::json!({
                "kind": "aop_paused",
                "sessionId": session_id,
                "deadlineMs": deadline_ms,
            }),
            AopEvent::Resumed { session_id, auto } => serde_json::json!({
                "kind": "aop_resumed",
                "sessionId": session_id,
                "auto": auto,
            }),
        }
    }
}

/// AOP 会话管理器(env 内嵌,Arc 共享于 Tauri state 与 HTTP server state)。
#[derive(Clone)]
pub struct AopSessionManager {
    inner: Arc<Mutex<HashMap<String, Arc<AopSession>>>>,
    events: broadcast::Sender<AopEvent>,
}

impl AopSessionManager {
    pub fn new() -> Self {
        let (events, _) = broadcast::channel(256);
        Self { inner: Arc::new(Mutex::new(HashMap::new())), events }
    }

    /// 创建(或复用)任务级 AOP 会话,并启动其 run loop。
    pub async fn create(&self, cfg: AopSessionConfig) -> Result<SessionInfo, String> {
        let mut guard = self.inner.lock().await;
        if let Some(existing) = guard.values().find(|s| s.task_id == cfg.task_id) {
            return Ok(existing.info());
        }
        let session_id = format!("aop-{}", Uuid::new_v4());
        let (input_tx, input_rx) = tokio::sync::mpsc::channel(128);
        let session = Arc::new(AopSession::new(session_id, cfg, self.events.clone(), input_tx));
        guard.insert(session.session_id.clone(), session.clone());
        drop(guard);

        let s = session.clone();
        tokio::spawn(async move { s.run(input_rx).await });
        Ok(session.info())
    }

    /// 用户消息入队:落盘历史 + 广播 user message/echo 事件,再投递 run loop。
    pub async fn send_message(&self, session_id: &str, text: &str) -> Result<(), String> {
        let session = {
            let guard = self.inner.lock().await;
            guard.get(session_id).cloned()
        }
        .ok_or_else(|| format!("AOP 会话不存在: {session_id}"))?;
        session.accept_input(text).await;
        Ok(())
    }

    /// 中断当前执行(下个子任务边界生效)。
    pub async fn stop(&self, session_id: &str) -> Result<(), String> {
        let session = {
            let guard = self.inner.lock().await;
            guard.get(session_id).cloned()
        }
        .ok_or_else(|| format!("AOP 会话不存在: {session_id}"))?;
        session.request_stop();
        Ok(())
    }

    /// 销毁任务级 AOP 会话(切 harness 用):从表移除——input_tx 随之 drop,
    /// run loop 的 rx.recv() 返回 None 自然退出。历史已逐条落盘
    /// (.aop/history.jsonl),重建时 AopSession::new 自动回载,对话不丢。
    /// 返回是否销毁过(无该任务的 AOP 会话时为 false,幂等)。
    pub async fn destroy_task(&self, task_id: &str) -> bool {
        let mut guard = self.inner.lock().await;
        let sid = guard.values().find(|s| s.task_id == task_id).map(|s| s.session_id.clone());
        match sid {
            Some(sid) => {
                guard.remove(&sid);
                true
            }
            None => false,
        }
    }

    /// 数据集记录开关(session 级)。返回开启的文件路径或停止统计。
    pub async fn dataset_toggle(&self, session_id: &str, on: bool) -> Result<serde_json::Value, String> {
        let session = self.get(session_id).await?;
        session.dataset_toggle(on).await
    }

    /// 暂停会话执行(「等等」):子任务边界挂起,3 分钟无回应自动续跑(纲领一)。
    pub async fn pause(&self, session_id: &str) -> Result<(), String> {
        let session = self.get(session_id).await?;
        session.request_pause().await;
        Ok(())
    }

    /// 立即续跑(用户提前说「继续」)。
    pub async fn resume(&self, session_id: &str) -> Result<(), String> {
        let session = self.get(session_id).await?;
        session.request_resume(false).await;
        Ok(())
    }

    /// 人类执行者交付(纲领五):note=交付说明,artifacts=产物路径登记。
    pub async fn human_submit(&self, session_id: &str, sub: HumanSubmission) -> Result<(), String> {
        let session = self.get(session_id).await?;
        session.submit_human(sub).await
    }

    /// 会话全部过程帧(SSE 重连补帧用)。
    /// 重启恢复场景:新会话 id 无帧文件 → 兜底读任务 traces 目录 mtime 最新文件
    /// (历史帧不因 exe 重启丢失——时间线"断线回放"跨重启)。
    pub async fn frames_of(&self, session_id: &str) -> Vec<AopFrame> {
        let (recorder, task_dir) = {
            let guard = self.inner.lock().await;
            match guard.get(session_id) {
                Some(s) => (Some(s.recorder()), Some(s.task_dir.clone())),
                None => (None, None),
            }
        };
        if let Some(r) = recorder {
            let frames = r.read_all().await;
            if !frames.is_empty() {
                return frames;
            }
        }
        // 兜底:traces 目录最新文件(恢复会话 0 帧/未知会话)
        let Some(dir) = task_dir else { return Vec::new() };
        let traces = dir.join(".aop").join("traces");
        let Ok(entries) = tokio::fs::read_dir(&traces).await else { return Vec::new() };
        let mut latest: Option<(std::time::SystemTime, std::path::PathBuf)> = None;
        let mut rd = entries;
        while let Ok(Some(e)) = rd.next_entry().await {
            if let Ok(m) = e.metadata().await {
                if let Ok(t) = m.modified() {
                    if latest.as_ref().map(|(lt, _)| t > *lt).unwrap_or(true) {
                        latest = Some((t, e.path()));
                    }
                }
            }
        }
        match latest {
            Some((_, p)) => TraceRecorder::read_all_path(&p).await,
            None => Vec::new(),
        }
    }

    async fn get(&self, session_id: &str) -> Result<Arc<AopSession>, String> {
        let guard = self.inner.lock().await;
        guard
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("AOP 会话不存在: {session_id}"))
    }

    /// 会话列表(形状对齐 ta 的 SessionInfo,command="aop" 供前端识别)。
    pub async fn list(&self) -> Vec<SessionInfo> {
        let guard = self.inner.lock().await;
        guard.values().map(|s| s.info()).collect()
    }

    /// 会话历史(SSE 重连快照 / 聊天视图 lazy 分页共用)。
    pub async fn messages_of(&self, session_id: &str) -> Vec<ChatMessage> {
        let guard = self.inner.lock().await;
        match guard.get(session_id) {
            Some(s) => s.messages().await,
            None => Vec::new(),
        }
    }

    /// SSE 首帧快照(所有会话,JSON 数组——前端逐条 apply)。
    /// 除 belief 快照外,回放过程视图状态(纲领二:断线重连/页面刷新不丢
    /// 数字孪生):PlanReady(带运行态 marks) + HumanTaskPending + Paused。
    pub async fn snapshot_events_json(&self) -> String {
        let guard = self.inner.lock().await;
        let mut events: Vec<serde_json::Value> = Vec::new();
        for s in guard.values() {
            events.push(
                AopEvent::Snapshot {
                    session_id: s.session_id.clone(),
                    task_id: s.task_id.clone(),
                    messages: s.messages().await,
                    app_state: s.app_state_str().await,
                }
                .to_json(),
            );
            for ev in s.process_snapshot_events().await {
                events.push(ev.to_json());
            }
        }
        serde_json::to_string(&events).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<AopEvent> {
        self.events.subscribe()
    }

    pub fn emit(&self, event: AopEvent) {
        let _ = self.events.send(event);
    }

    /// 触发 pomdp 重扫(path 为任务根目录),并广播 graph_changed 供前端重拉任务图。
    /// pomdp 侧的 PUB 事件也会让 Tauri 端经 pomdp:event 重拉——两路互不冲突。
    pub async fn rescan(&self, path: &str) {
        rescan_tasks(&self.events, path).await;
    }
}

impl Default for AopSessionManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 构造消息的公共辅助(历史落盘用 JSON 行,字段与 ta ChatMessage 对齐)。
pub(crate) fn build_message(role: &str, text: &str, model: Option<&str>, author: Option<&str>) -> ChatMessage {
    ChatMessage {
        role: role.to_string(),
        text: text.to_string(),
        timestamp: Some(Utc::now().to_rfc3339()),
        uuid: Some(format!("aop-{}", Uuid::new_v4())),
        model: model.map(|m| m.to_string()),
        origin: Some(APP_TYPE.to_string()),
        harness: Some(APP_TYPE.to_string()),
        author: author.map(|a| a.to_string()),
        ..Default::default()
    }
}

/// llm-proxy 的 task token(与 ta 会话同路径:myco-proxy-<taskId> 按所选 provider 路由)。
pub(crate) fn proxy_token(task_id: &str) -> String {
    format!("myco-proxy-{task_id}")
}

pub fn proxy_base() -> &'static str {
    PROXY_BASE
}

/// 层序(执行顺序 = 图上 LAYER_ORDER 同序)。
pub const LAYER_ORDER: [&str; 6] = ["P", "C", "D", "A", "T", "R"];

/// pomdp 重扫(共享助手:manager 与 session 共用)。连接失败/请求失败都不
/// 硬失败——只广播 graph_changed,前端重拉图时兜底。
pub(crate) async fn rescan_tasks(events: &broadcast::Sender<AopEvent>, path: &str) {
    let config = ReqClientConfig { endpoint: ZMQ_ENDPOINT.to_string(), timeout_ms: 30000 };
    let mut client = ReqClient::new(config);
    if let Err(e) = client.connect().await {
        tracing::warn!("[aop] rescan: POMDP 连接失败({e}),仅广播 graph_changed");
        let _ = events.send(AopEvent::GraphChanged);
        return;
    }
    let command = format!("task:scan:{}", serde_json::json!({ "path": path }));
    if let Err(e) = client.request(command.as_bytes()).await {
        tracing::warn!("[aop] rescan: task:scan 失败: {e}");
    }
    let _ = events.send(AopEvent::GraphChanged);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_json_shapes_are_camel_case() {
        let ev = AopEvent::State { session_id: "aop-x".into(), app_state: "working".into(), fine_state: Some("generating".into()) };
        let v = ev.to_json();
        assert_eq!(v["kind"], "state");
        assert_eq!(v["sessionId"], "aop-x");
        assert_eq!(v["appState"], "working");
        assert_eq!(v["fineState"], "generating");
        assert_eq!(v["appType"], "aop");
        // belief-store 依赖 snapshot 里 live.appType 分流显示
        let snap = AopEvent::Snapshot {
            session_id: "s".into(),
            task_id: "t".into(),
            messages: vec![],
            app_state: "idle".into(),
        }
        .to_json();
        assert_eq!(snap["belief"]["live"]["appType"], "aop");
        assert_eq!(snap["belief"]["sessionMeta"]["sessionId"], "s");
    }
}
