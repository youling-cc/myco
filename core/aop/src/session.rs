//! session.rs — 单个 AOP 会话:自主管线 + 子 Agent 分发 + 独立 R + 过程帧流。
//!
//! 设计依据 design/04-agent/AOP_EXECUTOR-子代理执行与人类委托与独立R纲领.md:
//!   纲领一 自主优先:define→plan→execute→report 全链自动,零确认门;「等等」
//!           挂起但带期限(默认 3 分钟,超时自动续跑)。
//!   纲领二 过程透明:每次工具调用/评审产 o/s/a/r 帧,双流(UI 直播 + 落盘轨迹)。
//!   纲领三 每层独立子 Agent:子任务独立上下文执行,归约 task.md 挂 parent 指针。
//!   纲领四 独立 R:r_agent.rs 第三方评审,fail → feedback 回灌重跑(自强不息,
//!           上限 MAX_R_ATTEMPTS 轮)。
//!   纲领五 人类可委托:executor=human 的节点挂起等 GUI 任务卡交付,人工交付
//!           同样过独立 R 评审;人工等待不适用自动续跑期限。
//!
//! 并发结构:run loop 只收消息;阶段任务(define/plan/execute 链)spawn 成独立
//! tokio task(busy 标志互斥)——用户消息在执行中即时处理:命令(/stop/等等)
//! 立即生效,自由文字进 steering 队列,在执行轮次边界注入子 Agent 上下文。

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use chrono::Utc;
use myco_terminal_proto::{ChatMessage, SessionInfo};
use tokio::sync::{broadcast, mpsc, Mutex, Notify};

use super::frames::{AopFrame, ExecutorKind, FrameKind, TraceRecorder, ENV_PROCESS_DID};
use super::llm::{LlmBlock, LlmMessage, ToolDef};
use super::plan::{parse_plan, repair_json, retry_hint, AopPlan, SubTask};
use super::prompts;
use super::r_agent::RAgent;
use super::taskfile::{RosaDef, TaskWriter};
use super::tools::{exec_tool_defs, ToolRunner};
use super::{build_message, proxy_base, proxy_token, AopEvent, APP_TYPE};

/// 纲领一:期限暂停默认 3 分钟(无回应自动续跑)。
pub const PAUSE_SECS: i64 = 180;
/// 纲领四:自强不息轮次上限。
const MAX_R_ATTEMPTS: u32 = 3;

const PAUSE_WORDS: &[&str] = &["等等", "等下", "等一下", "暂停", "停一下", "先停", "wait", "hold on", "/pause"];
const RESUME_WORDS: &[&str] = &["继续", "继续跑", "接着跑", "resume", "/resume"];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AopSessionConfig {
    pub task_id: String,
    pub task_dir: PathBuf,
    pub title: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Idle,
    Planning,
    Executing,
}

/// 人类执行者的交付物(纲领五:人工节点的 A 界面数据)。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct HumanSubmission {
    pub slug: String,
    /// 交付说明(人写的"我做了什么")。
    pub note: String,
    /// 产物登记(文件路径列表,R 评审会亲自核验这些路径)。
    pub artifacts: Vec<String>,
}

pub struct SessionState {
    pub phase: Phase,
    pub messages: Vec<ChatMessage>,
    pub plan: Option<AopPlan>,
    pub executed: bool,
    /// 子任务运行态(slug → (status, score, attempts)):快照回放用——
    /// 计划/节点状态不能只靠 live 事件,页面刷新后 SSE 快照要能还原数字孪生。
    pub subtask_marks: std::collections::HashMap<String, (String, Option<f64>, u32)>,
    /// 等待人工交付中的节点(快照回放 HumanTaskPending)。
    pub human_pending: Option<HumanPendingInfo>,
}

/// 人工任务卡载荷(快照回放用,字段对齐 AopEvent::HumanTaskPending)。
#[derive(Debug, Clone)]
pub struct HumanPendingInfo {
    pub slug: String,
    pub layer: String,
    pub title: String,
    pub goal: String,
    pub inputs: Vec<String>,
    pub out: Vec<String>,
    pub r_criteria: Vec<String>,
    pub upstream: String,
}

pub struct AopSession {
    pub session_id: String,
    pub task_id: String,
    pub task_dir: PathBuf,
    pub title: String,
    pub started_at: chrono::DateTime<Utc>,
    model: Option<String>,
    state: Mutex<SessionState>,
    input_tx: mpsc::Sender<String>,
    stop: AtomicBool,
    /// 阶段任务互斥(true=define/plan/execute 链正在跑)。
    busy: AtomicBool,
    /// 阶段任务句柄(会话销毁时 abort,防泄漏)。
    active: Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// 执行中的用户纠偏队列(轮次边界注入子 Agent 上下文)。
    steering: Mutex<Vec<String>>,
    /// 暂停期限(unix ms;Some=挂起中,到期自动续跑)。
    pause_deadline: Mutex<Option<i64>>,
    resume_notify: Notify,
    /// 人工节点交付通道。
    human_tx: mpsc::Sender<HumanSubmission>,
    human_rx: Mutex<mpsc::Receiver<HumanSubmission>>,
    /// gen_start/gen_end 嵌套引用计数:LLM 调用可嵌套(执行器工具循环内套
    /// R 评审),内层 gen_end 不能误清外层生成指示(belief pending 是单值)。
    gen_depth: AtomicUsize,
    /// 数据集记录器(用 myco 开发 myco):开关打开后,关键状态事件(消息/live/
    /// 帧/plan)落盘 .aop/datasets/*.jsonl——回放端把事件 apply 进影子会话,
    /// 任意视图(聊天/时间线/任务图)即可渲染历史状态轨迹。
    dataset: Mutex<Option<crate::dataset::DatasetWriter>>,
    events: broadcast::Sender<AopEvent>,
}

impl AopSession {
    pub fn new(
        session_id: String,
        cfg: AopSessionConfig,
        events: broadcast::Sender<AopEvent>,
        input_tx: mpsc::Sender<String>,
    ) -> Self {
        let writer = TaskWriter::new(cfg.task_dir.clone());
        let mut messages = Vec::new();
        for line in writer.load_history_lines() {
            if let Ok(m) = serde_json::from_str::<ChatMessage>(&line) {
                messages.push(m);
            }
        }
        let (human_tx, human_rx) = mpsc::channel(8);
        Self {
            session_id,
            task_id: cfg.task_id,
            task_dir: cfg.task_dir,
            title: cfg.title,
            started_at: Utc::now(),
            model: cfg.model,
            state: Mutex::new(SessionState {
                phase: Phase::Idle,
                messages,
                plan: None,
                executed: false,
                subtask_marks: std::collections::HashMap::new(),
                human_pending: None,
            }),
            input_tx,
            stop: AtomicBool::new(false),
            busy: AtomicBool::new(false),
            active: Mutex::new(None),
            steering: Mutex::new(Vec::new()),
            pause_deadline: Mutex::new(None),
            resume_notify: Notify::new(),
            human_tx,
            human_rx: Mutex::new(human_rx),
            gen_depth: AtomicUsize::new(0),
            dataset: Mutex::new(None),
            events,
        }
    }

    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            session_id: self.session_id.clone(),
            task_id: self.task_id.clone(),
            pid: 0,
            command: APP_TYPE.to_string(),
            status: "running".to_string(),
            title: None,
            started_at: self.started_at,
            cwd: None,
        }
    }

    pub async fn messages(&self) -> Vec<ChatMessage> {
        self.state.lock().await.messages.clone()
    }

    pub async fn app_state_str(&self) -> String {
        if self.state.lock().await.phase == Phase::Idle { "idle".to_string() } else { "working".to_string() }
    }

    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // 停止也解除暂停(防挂起任务等不到 deadline)
        self.resume_notify.notify_one();
    }

    /// 「等等」:挂起到子任务/轮次边界,期限到自动续跑(纲领一)。
    pub async fn request_pause(&self) {
        if !self.busy.load(Ordering::SeqCst) {
            self.bubble("现在没有在跑的任务——暂停只对执行中的会话生效。").await;
            return;
        }
        let deadline = Utc::now().timestamp_millis() + PAUSE_SECS * 1000;
        *self.pause_deadline.lock().await = Some(deadline);
        let _ = self.events.send(AopEvent::Paused { session_id: self.session_id.clone(), deadline_ms: deadline });
        self.bubble(&format!(
            "⏸ 已请求暂停(在安全点生效)。{} 分钟内无操作自动续跑;说「继续」立即续跑。",
            PAUSE_SECS / 60
        ))
        .await;
    }

    /// 续跑(auto=true 为期限到期自动续跑)。
    pub async fn request_resume(&self, auto: bool) {
        let mut guard = self.pause_deadline.lock().await;
        if guard.take().is_some() {
            self.resume_notify.notify_one();
            let _ = self.events.send(AopEvent::Resumed { session_id: self.session_id.clone(), auto });
            if !auto {
                self.bubble("▶ 继续跑。").await;
            }
        }
    }

    /// 数据集记录开关(HTTP 面,与 /dataset 命令同效)。
    pub async fn dataset_toggle(&self, on: bool) -> Result<serde_json::Value, String> {
        let mut d = self.dataset.lock().await;
        if on {
            if d.is_none() {
                let cwd = self.task_dir.to_string_lossy().to_string();
                let w = super::dataset::DatasetWriter::create(&self.task_dir, &self.session_id, &cwd, "aop")?;
                let info = serde_json::json!({"recording": true, "path": w.path.display().to_string(), "events": 0});
                *d = Some(w);
                Ok(info)
            } else {
                Ok(serde_json::json!({"recording": true, "already": true}))
            }
        } else {
            match d.take() {
                Some(w) => Ok(serde_json::json!({"recording": false, "events": w.events, "path": w.path.display().to_string()})),
                None => Ok(serde_json::json!({"recording": false, "already": false})),
            }
        }
    }

    /// 人工节点交付(/api/aop/human_submit)。
    pub async fn submit_human(&self, sub: HumanSubmission) -> Result<(), String> {
        self.human_tx
            .send(sub)
            .await
            .map_err(|e| format!("人工交付通道已关闭: {e}"))
    }

    pub fn recorder(&self) -> TraceRecorder {
        TraceRecorder::new(&self.task_dir, &self.session_id)
    }

    /// 用户消息:落盘 + 广播 + 投递 run loop(命令/暂停/纠偏全由 run loop 分派)。
    pub async fn accept_input(&self, text: &str) {
        let msg = build_message("user", text, None, None);
        self.persist(&msg).await;
        self.state.lock().await.messages.push(msg.clone());
        if let Some(w) = self.dataset.lock().await.as_mut() {
            w.write(&serde_json::json!({"kind":"message","message":msg,"at":chrono::Utc::now().to_rfc3339()}));
        }
        let _ = self.events.send(AopEvent::Message { session_id: self.session_id.clone(), message: msg });
        let _ = self.input_tx.send(text.to_string()).await;
    }

    // ── 基础设施 ──────────────────────────────────────────────

    fn writer(&self) -> TaskWriter {
        TaskWriter::new(self.task_dir.clone())
    }

    fn llm(&self) -> super::llm::LlmClient {
        super::llm::LlmClient::new(proxy_base(), &proxy_token(&self.task_id), self.model.as_deref())
    }

    /// Esc(/stop)立即生效:轮询 stop 标志与 stream_turn 竞速,先到即中断。
    async fn interruptible_turn(
        &self,
        system: &str,
        messages: Vec<LlmMessage>,
        tools: Option<&[ToolDef]>,
        max_tokens: u32,
    ) -> Result<super::llm::LlmTurn, String> {
        let llm = self.llm();
        tokio::select! {
            biased;
            _ = self.wait_stop() => Err("已被用户中断".to_string()),
            r = llm.stream_turn(system, messages, tools, max_tokens) => r,
        }
    }

    async fn wait_stop(&self) {
        while !self.stop.load(Ordering::SeqCst) {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
    }

    async fn persist(&self, msg: &ChatMessage) {
        if let Ok(line) = serde_json::to_string(msg) {
            let _ = self.writer().append_history_line(&line).await;
        }
    }

    async fn bubble(&self, text: &str) {
        let msg = build_message("assistant", text, self.model.as_deref(), None);
        self.push_message(msg).await;
    }

    async fn push_message(&self, msg: ChatMessage) {
        self.persist(&msg).await;
        self.state.lock().await.messages.push(msg.clone());
        // 数据集挂钩:assistant 气泡(定义/拆解/子任务/R 结论/报告)全走这里——
        // 漏挂=回放有帧无聊天(实测 v2 旅程 70 事件只 1 条 user 消息)。
        if let Some(w) = self.dataset.lock().await.as_mut() {
            w.write(&serde_json::json!({"kind":"message","message":msg,"at":chrono::Utc::now().to_rfc3339()}));
        }
        let _ = self.events.send(AopEvent::Message { session_id: self.session_id.clone(), message: msg });
    }

    async fn set_phase(&self, phase: Phase) {
        self.set_phase_with_fine(phase, None).await;
    }

    /// set_phase 带细态覆盖:None=按相位映射默认细态(与三 harness 11 细态同口径:
    /// Planning→generating / Executing→tool_running / Idle→idle_ready),
    /// Some(x)=管线收尾特殊态(error_blocked=LLM 失败,interrupted=用户中断)。
    async fn set_phase_with_fine(&self, phase: Phase, fine_override: Option<&str>) {
        self.state.lock().await.phase = phase;
        let app_state = if phase == Phase::Idle { "idle" } else { "working" };
        let fine_state = fine_override.map(|s| s.to_string()).unwrap_or_else(|| {
            match phase {
                Phase::Planning => "generating",
                Phase::Executing => "tool_running",
                Phase::Idle => "idle_ready",
            }
            .to_string()
        });
        let _ = self.events.send(AopEvent::State {
            session_id: self.session_id.clone(),
            app_state: app_state.to_string(),
            fine_state: Some(fine_state.clone()),
        });
        // 状态事件进数据集(回放端 gen 徽章数据源;state 翻转低频,无需节流)
        if let Some(w) = self.dataset.lock().await.as_mut() {
            w.write(&serde_json::json!({
                "kind":"state","appState":app_state,"fineState":fine_state,
                "at":chrono::Utc::now().to_rfc3339(),
            }));
        }
    }

    fn gen_begin(&self) {
        if self.gen_depth.fetch_add(1, Ordering::SeqCst) == 0 {
            // 轮边界进数据集(崩溃回放平衡的配对锚)
            if let Ok(mut d) = self.dataset.try_lock() {
                if let Some(w) = d.as_mut() {
                    w.write(&serde_json::json!({"kind":"turn/start","at":chrono::Utc::now().to_rfc3339()}));
                }
            }
            let _ = self.events.send(AopEvent::GenStart {
                session_id: self.session_id.clone(),
                working_since_ms: Utc::now().timestamp_millis(),
            });
        }
    }

    fn gen_end(&self) {
        let prev = self.gen_depth.load(Ordering::SeqCst);
        if prev == 0 {
            return;
        }
        if self.gen_depth.fetch_sub(1, Ordering::SeqCst) == 1 {
            if let Ok(mut d) = self.dataset.try_lock() {
                if let Some(w) = d.as_mut() {
                    w.write(&serde_json::json!({"kind":"turn/end","reason":"done","at":chrono::Utc::now().to_rfc3339()}));
                }
            }
            let _ = self.events.send(AopEvent::GenEnd { session_id: self.session_id.clone() });
        }
    }

    /// 过程视图快照(断线重连/页面刷新回放):计划+运行态、人工待交付卡、暂停期限。
    pub async fn process_snapshot_events(&self) -> Vec<super::AopEvent> {
        let st = self.state.lock().await;
        let mut out: Vec<super::AopEvent> = Vec::new();
        if let Some(plan) = &st.plan {
            out.push(super::AopEvent::PlanReady {
                session_id: self.session_id.clone(),
                plan: Box::new(plan.clone()),
                marks: Some(st.subtask_marks.clone()),
            });
        }
        if let Some(hp) = &st.human_pending {
            out.push(super::AopEvent::HumanTaskPending {
                session_id: self.session_id.clone(),
                slug: hp.slug.clone(),
                layer: hp.layer.clone(),
                title: hp.title.clone(),
                goal: hp.goal.clone(),
                inputs: hp.inputs.clone(),
                out: hp.out.clone(),
                r_criteria: hp.r_criteria.clone(),
                upstream: hp.upstream.clone(),
            });
        }
        drop(st);
        if let Some(dl) = *self.pause_deadline.lock().await {
            out.push(super::AopEvent::Paused { session_id: self.session_id.clone(), deadline_ms: dl });
        }
        out
    }

    async fn rescan(&self) {
        super::rescan_tasks(&self.events, &self.task_dir.to_string_lossy()).await;
    }

    /// 过程帧双流:UI 直播 + 落盘轨迹(纲领二)。
    /// 帧统一盖发帧者 DID(S1 粒度:整个 env 进程一个;S3 细化到 skill)。
    /// o/s 自动接:生产者不填(留空)时,从会话当前真实状态自动填充——
    /// o=POMDP 观测摘要(当前 phase/fine 态 + 输入),s=子任务运行态(轮次/执行者)。
    /// 修复历史问题:手填常空(AR 实测 205 帧 o 空 78%/s 空 94%),POMDP 的 O/S 有名无实。
    async fn emit_frame(&self, mut frame: AopFrame) {
        frame.from = Some(ENV_PROCESS_DID.into());
        if frame.o.trim().is_empty() || frame.s.trim().is_empty() {
            let (phase, mark, plan_ready) = {
                let st = self.state.lock().await;
                (st.phase.clone(), st.subtask_marks.get(&frame.slug).cloned(), st.plan.is_some())
            };
            if frame.o.trim().is_empty() {
                let fine = match phase {
                    Phase::Planning => "generating",
                    Phase::Executing => "tool_running",
                    Phase::Idle => "idle_ready",
                };
                frame.o = format!("phase={:?} fineState={fine} mark={:?} planReady={plan_ready}", phase, mark);
            }
            if frame.s.trim().is_empty() {
                frame.s = format!("子任务 {} attempt={} executor={}", frame.slug, frame.attempt, frame.executor_kind.as_str());
            }
        }
        if let Some(w) = self.dataset.lock().await.as_mut() {
            w.write(&serde_json::json!({"kind":"frame","frame":frame,"at":chrono::Utc::now().to_rfc3339()}));
        }
        self.recorder().record(&frame).await;
        let _ = self.events.send(AopEvent::Frame {
            session_id: self.session_id.clone(),
            frame: Box::new(frame),
        });
    }

    /// 安全点检查(子任务边界/执行轮次边界调用):
    /// 1. 暂停中 → 等 resume 或期限到(自动续跑);
    /// 2. 返回 false = 用户已 /stop。
    async fn checkpoint(&self) -> bool {
        loop {
            let deadline = *self.pause_deadline.lock().await;
            let Some(dl) = deadline else { break };
            let remain = dl - Utc::now().timestamp_millis();
            if remain <= 0 {
                *self.pause_deadline.lock().await = None;
                let _ = self.events.send(AopEvent::Resumed { session_id: self.session_id.clone(), auto: true });
                self.bubble(&format!("⏱ 暂停超过 {} 分钟无操作,按约自动续跑。", PAUSE_SECS / 60)).await;
                break;
            }
            tokio::select! {
                _ = self.resume_notify.notified() => {
                    let mut g = self.pause_deadline.lock().await;
                    if g.take().is_some() {
                        let _ = self.events.send(AopEvent::Resumed { session_id: self.session_id.clone(), auto: false });
                    }
                    break;
                }
                _ = tokio::time::sleep(std::time::Duration::from_millis(remain as u64)) => {
                    *self.pause_deadline.lock().await = None;
                    let _ = self.events.send(AopEvent::Resumed { session_id: self.session_id.clone(), auto: true });
                    self.bubble(&format!("⏱ 暂停超过 {} 分钟无操作,按约自动续跑。", PAUSE_SECS / 60)).await;
                    break;
                }
            }
        }
        !self.stop.load(Ordering::SeqCst)
    }

    /// 抽干 steering 队列(执行中的用户纠偏)。
    async fn drain_steering(&self) -> Vec<String> {
        std::mem::take(&mut *self.steering.lock().await)
    }

    // ── run loop(只收消息;阶段任务 spawn 出去,执行中消息即时分派) ──

    pub async fn run(self: Arc<Self>, mut rx: mpsc::Receiver<String>) {
        let writer = self.writer();
        // 重启恢复:.aop/plan.json 已落盘 → 恢复计划 + 从 agents/*/task.md 重建 marks,
        // 直接续跑剩余子任务(不再重新拆解烧 LLM)。没有 plan 才走自动拆解。
        if writer.has_root_task_md() {
            if let Some(plan) = writer.read_plan_json().await {
                let mut marks = std::collections::HashMap::new();
                let mut done = 0usize;
                for st in &plan.subtasks {
                    let status = writer.read_subtask_status(&st.slug).await.unwrap_or_else(|| "pending".to_string());
                    // completed 与 failed 都是终态:failed(上次耗尽轮次)重跑=又烧 N 轮,
                    // 恢复语义是"续跑未完成的",不是"重试已判死的"。
                    let finished = status == "completed" || status == "failed";
                    if finished { done += 1; }
                    marks.insert(st.slug.clone(), (status, None, 0));
                }
                let total = plan.subtasks.len();
                {
                    let mut s = self.state.lock().await;
                    s.plan = Some(plan);
                    s.subtask_marks = marks;
                    s.executed = false;
                }
                if done == total {
                    self.bubble(&format!(
                        "AOP 会话恢复:任务《{}》的 {done}/{total} 个子任务均已达标(上次会话完成)。描述新任务即可开始,或 /execute 重跑。",
                        self.title
                    ))
                    .await;
                    self.state.lock().await.executed = true;
                } else {
                    // 恢复但不自动续跑:重启后用户意图未知(可能要开新任务)——
                    // 自动续跑会把用户随后发的新任务消息吞成 steering(实测踩过)。
                    // 状态已恢复,说「继续」即续跑剩余;描述新任务则重定义。
                    self.bubble(&format!(
                        "AOP 会话恢复:任务《{}》已拆解,{done}/{total} 达标(进度已从任务图恢复,不重新拆解)。说「继续」从剩余子任务续跑,或直接描述新任务。",
                        self.title
                    ))
                    .await;
                }
            } else {
                self.bubble(&format!(
                    "AOP 会话就绪:已读到任务定义《{}》,自动开始 PCDATR 拆解与执行(随时可纠偏/「等等」暂停)。",
                    self.title
                ))
                .await;
                self.spawn_pipeline(Pipeline::Plan(None)).await;
            }
        } else {
            self.bubble(
                "AOP 会话就绪。目录里还没有 task.md——用一句话描述任务目标,我会自动完成:起草 ROSA 定义 → PCDATR 拆解 → 逐层执行 → 独立 R 评审。过程中你随时可以看到每一步,并可随时纠偏。",
            )
            .await;
        }

        while let Some(raw) = rx.recv().await {
            // 残留 /stop 标志:空闲时清掉(不吞消息——否则 /stop 后的第一条
            // 用户输入会被丢弃);执行中绝不动它——否则 /stop 后紧跟的一条
            // 消息会把停止请求静默取消,管线就停不下来了。
            if !self.busy.load(Ordering::SeqCst) {
                self.stop.store(false, Ordering::SeqCst);
            }
            let text = raw.trim().to_string();
            if text.is_empty() {
                continue;
            }
            let lower = text.to_lowercase();

            if lower == "/status" {
                self.status_bubble(&writer).await;
                continue;
            }
            // 数据集记录开关(用 myco 开发 myco:状态流落盘,回放端任意视图渲染历史)
            if let Some(arg) = lower.strip_prefix("/dataset ") {
                let on = arg.trim() == "on";
                {
                    let mut d = self.dataset.lock().await;
                    if on {
                        if d.is_none() {
                            let cwd = self.task_dir.to_string_lossy().to_string();
                            match super::dataset::DatasetWriter::create(&self.task_dir, &self.session_id, &cwd, "aop") {
                                Ok(w) => {
                                    let p = w.path.display().to_string();
                                    *d = Some(w);
                                    drop(d);
                                    self.bubble(&format!("⏺ 数据集记录已开启:`{p}`。回放:过程视图 → 数据集。")).await;
                                }
                                Err(e) => { drop(d); self.bubble(&format!("⚠️ 数据集开启失败:{e}")).await; }
                            }
                        } else {
                            drop(d);
                            self.bubble("数据集记录已在进行中。").await;
                        }
                    } else {
                        let stopped = d.take().map(|w| (w.events, w.path.display().to_string()));
                        drop(d);
                        match stopped {
                            Some((n, p)) => self.bubble(&format!("⏹ 数据集记录已停止:{n} 条事件 → `{p}`")).await,
                            None => self.bubble("数据集记录未开启。").await,
                        }
                    }
                }
                continue;
            }
            if lower == "/stop" {
                self.request_stop();
                self.bubble("⏹ 已请求中断(LLM 调用立即中止,执行在安全点停)。").await;
                continue;
            }
            // 「等等」:期限暂停(纲领一)
            if PAUSE_WORDS.iter().any(|w| lower == *w) {
                self.request_pause().await;
                continue;
            }
            // 「继续」:暂停中=续跑;空闲且有未执行计划=补执行;否则按自由文字
            if RESUME_WORDS.iter().any(|w| lower == *w) {
                if self.pause_deadline.lock().await.is_some() {
                    self.request_resume(false).await;
                    continue;
                }
                let (has_plan, executed) = {
                    let st = self.state.lock().await;
                    (st.plan.is_some(), st.executed)
                };
                if has_plan && !executed && !self.busy.load(Ordering::SeqCst) {
                    self.spawn_pipeline(Pipeline::Execute).await;
                    continue;
                }
                if self.busy.load(Ordering::SeqCst) {
                    self.bubble("正在跑,不用催——进度见过程视图。").await;
                    continue;
                }
                // 空闲且无待执行计划:落入自由文字分派(视为新一轮指导)
            }
            if lower == "/plan" {
                if self.busy.load(Ordering::SeqCst) {
                    self.bubble("正在执行中——你的意见已记下,将在下一轮边界注入。").await;
                    self.steering.lock().await.push(text);
                } else {
                    self.spawn_pipeline(Pipeline::Plan(None)).await;
                }
                continue;
            }
            if matches!(lower.as_str(), "/execute" | "/start") {
                if self.busy.load(Ordering::SeqCst) {
                    self.bubble("正在执行中。").await;
                } else if self.state.lock().await.plan.is_none() {
                    self.bubble("还没有计划——先描述任务目标,或 /plan。").await;
                } else {
                    self.spawn_pipeline(Pipeline::Execute).await;
                }
                continue;
            }

            // 元问题(身份/harness/模型):系统直回事实,不丢给 LLM 编。
            if is_meta_query(&lower) {
                self.bubble(&self.meta_answer()).await;
                continue;
            }

            // 自由文字:
            //  - 规划期(Planning)收到新任务描述 → 用户在给真实意图,中止当前规划,
            //    以这条文字为准重新定义任务(纲领一:随时可改变任务定义);
            //  - 执行期(Executing) → steering 队列,轮次边界注入;
            //  - 空闲 → 上轮已执行完视为新任务(重定义),否则当修订指导重拆解。
            if self.busy.load(Ordering::SeqCst) {
                let phase = self.state.lock().await.phase;
                if phase == Phase::Planning {
                    self.abort_active_pipeline().await;
                    self.bubble("收到,以你这条为准——重新起草任务定义并拆解。").await;
                    self.spawn_pipeline(Pipeline::Define(text)).await;
                } else {
                    self.steering.lock().await.push(text);
                    self.bubble("收到,你的意见已注入执行上下文(下一轮次边界生效)。").await;
                }
                continue;
            }
            let prev_executed = self.state.lock().await.executed;
            if !writer.has_root_task_md() || prev_executed {
                self.spawn_pipeline(Pipeline::Define(text)).await;
            } else {
                self.spawn_pipeline(Pipeline::Plan(Some(text))).await;
            }
        }

        // 会话销毁(input_tx 全 drop):中止在跑的阶段任务,防泄漏。
        if let Some(h) = self.active.lock().await.take() {
            h.abort();
        }
    }

    /// 中止在跑的阶段任务(Planning 期重定义用):abort 管线、清互斥、回 Idle。
    /// 必须同步清 gen_depth——abort 发生在 gen_begin/gen_end 之间时,引用计数
    /// 泄漏在 1,此后该会话的 GenEnd 永远不再发,前端 spinner 永久卡"生成中"
    /// (AOP 的 state 事件 fineState=null,belief-store 不会代为清 pending)。
    async fn abort_active_pipeline(&self) {
        self.request_stop();
        if let Some(h) = self.active.lock().await.take() {
            h.abort();
        }
        self.busy.store(false, Ordering::SeqCst);
        if self.gen_depth.swap(0, Ordering::SeqCst) > 0 {
            let _ = self.events.send(AopEvent::GenEnd { session_id: self.session_id.clone() });
        }
        self.set_phase(Phase::Idle).await;
    }

    /// 阶段任务 spawn:busy 互斥 + 结束清态;销毁可 abort。
    async fn spawn_pipeline(self: &Arc<Self>, pipeline: Pipeline) {
        if self.busy.swap(true, Ordering::SeqCst) {
            return; // 已有管线在跑(调用方已判 phase,此处双保险)
        }
        self.stop.store(false, Ordering::SeqCst);
        let this = Arc::clone(self);
        let writer = self.writer();
        let handle = tokio::spawn(async move {
            // define/plan 失败(false)=LLM 调用/解析失败;execute_turn 内部子任务级
            // 失败走自强不息重跑,管线正常收尾不算 error_blocked。
            let mut ok = true;
            match pipeline {
                Pipeline::Define(text) => {
                    if this.define_turn(&writer, text).await {
                        if this.plan_turn(&writer, None).await {
                            this.execute_turn(&writer).await;
                        } else {
                            ok = false;
                        }
                    } else {
                        ok = false;
                    }
                }
                Pipeline::Plan(guidance) => {
                    if this.plan_turn(&writer, guidance.as_deref()).await {
                        this.execute_turn(&writer).await;
                    } else {
                        ok = false;
                    }
                }
                Pipeline::Execute => this.execute_turn(&writer).await,
            }
            // 管线收尾细态(与 ta proxy_error 同语义):
            // 用户中断(stop 置位)→interrupted;失败收尾→error_blocked;
            // 正常完成→idle_ready。失败的具体原因已由各 turn 的 ⚠️ bubble 告知。
            let outcome = if this.stop.load(Ordering::SeqCst) {
                Some("interrupted")
            } else if !ok {
                Some("error_blocked")
            } else {
                None
            };
            this.set_phase_with_fine(Phase::Idle, outcome).await;
            this.busy.store(false, Ordering::SeqCst);
        });
        *self.active.lock().await = Some(handle);
    }

    // ── define:起草 ROSA 任务定义 ─────────────────────────────

    async fn define_turn(self: &Arc<Self>, writer: &TaskWriter, description: String) -> bool {
        self.set_phase(Phase::Planning).await;
        // 与 decompose 同待遇:解析失败带反馈自动重试一次(而不是把锅甩给用户
        // "换个说法再描述"——define 的 JSON 输出同样会被思考型模型写飞)
        let mut user = prompts::define_user_prompt(&self.task_id, &description);
        let mut last_err = String::new();
        for _attempt in 0..2 {
            self.gen_begin();
            let result = self
                .interruptible_turn(prompts::DEFINE_SYSTEM, vec![LlmMessage::user_text(user.clone())], None, 8192)
                .await;
            self.gen_end();
            match result {
                Ok(turn) => {
                    match parse_rosa(&turn.text) {
                        Ok(rosa) => {
                            if let Err(e) = writer.write_root_task(&rosa, "running").await {
                                self.bubble(&format!("⚠️ 写 task.md 失败:{e}")).await;
                                return false;
                            }
                            let r_lines: Vec<String> = rosa
                                .r
                                .iter()
                                .map(|m| format!("| {} | {} | {} |", m.key, m.formula, m.threshold))
                                .collect();
                            let table = if r_lines.is_empty() {
                                String::new()
                            } else {
                                format!(
                                    "**任务定义(ROSA)已写入 task.md**\n\n| R 指标 | 判定 | 阈值 |\n|---|---|---|\n{}\n",
                                    r_lines.join("\n")
                                )
                            };
                            self.bubble(&format!("{table}\n继续,自动进入 PCDATR 拆解…")).await;
                            return true;
                        }
                        Err(e) => {
                            tracing::warn!("[aop] define JSON 解析失败,重试: {}", e.chars().take(200).collect::<String>());
                            last_err = e;
                            user = format!("{user}\n\n{}", super::plan::retry_hint(&last_err));
                            continue;
                        }
                    }
                }
                Err(e) => {
                    self.bubble(&format!("⚠️ define 调用失败:{e}")).await;
                    return false;
                }
            }
        }
        self.bubble(&format!("⚠️ define 输出两次解析失败,请换个说法再描述任务:{last_err}")).await;
        false
    }

    // ── plan:PCDATR 拆解(归约落盘 + plan 制品留存) ────────────

    async fn plan_turn(self: &Arc<Self>, writer: &TaskWriter, guidance: Option<&str>) -> bool {
        self.set_phase(Phase::Planning).await;
        // steering 队列里的纠偏意见并入本轮拆解指导
        let steering = self.drain_steering().await;
        let merged_guidance = match (guidance, steering.is_empty()) {
            (g, true) => g.map(|s| s.to_string()),
            (None, false) => Some(steering.join("\n")),
            (Some(g), false) => Some(format!("{g}\n{}", steering.join("\n"))),
        };
        self.bubble("🔧 开始 PCDATR 拆解…").await;
        let mut plan = match self.decompose_with_retry(writer, merged_guidance.as_deref()).await {
            Ok(p) => p,
            Err(e) => {
                self.bubble(&format!("⚠️ 拆解失败:{e}")).await;
                return false;
            }
        };

        // 纲领三:plan 制品留存 → plan_file 回填 → 契约段挂链接
        match writer.write_plan_artifact(&plan, merged_guidance.as_deref()).await {
            Ok(rel) => plan.plan_file = Some(rel),
            Err(e) => tracing::warn!("[aop] plan 制品写盘失败: {e}"),
        }
        for st in &plan.subtasks {
            if let Err(e) = writer.write_subtask(st, "pending").await {
                self.bubble(&format!("⚠️ 写子任务 {} 失败:{e}", st.slug)).await;
            }
        }
        if let Err(e) = writer.upsert_subtasks_section(&plan).await {
            tracing::warn!("[aop] 写 ## 子任务 契约段失败: {e}");
        }
        let _ = writer.write_plan_json(&plan).await;

        self.state.lock().await.plan = Some(plan.clone());
        {
            // 新计划 → 重置运行态(旧计划的 marks/人工卡不串台)
            let mut st = self.state.lock().await;
            st.executed = false;
            st.subtask_marks.clear();
            st.human_pending = None;
        }
        self.rescan().await;

        if let Some(w) = self.dataset.lock().await.as_mut() {
            let marks_snapshot = self.state.lock().await.subtask_marks.clone();
            w.write(&serde_json::json!({"kind":"plan","plan":plan,"marks":marks_snapshot,"at":chrono::Utc::now().to_rfc3339()}));
        }
        let _ = self.events.send(AopEvent::PlanReady {
            session_id: self.session_id.clone(),
            plan: Box::new(plan.clone()),
            marks: None,
        });
        let n_human = plan
            .subtasks
            .iter()
            .filter(|s| ExecutorKind::parse(s.executor.as_deref()) == ExecutorKind::Human)
            .count();
        let human_note = if n_human > 0 {
            format!(";其中 {n_human} 个子任务指派给「人工」,到点会在聊天里给你任务卡")
        } else {
            String::new()
        };
        self.bubble(&format!(
            "🧩 拆解完成:{} 个子任务已落任务图{human_note}。**自动开始执行**——过程见「过程」视图(帧级直播),随时可纠偏/「等等」暂停。",
            plan.subtasks.len()
        ))
        .await;
        true
    }

    async fn decompose_with_retry(&self, writer: &TaskWriter, guidance: Option<&str>) -> Result<AopPlan, String> {
        let existing = writer.read_root_task_md();
        let mut user = prompts::decompose_user_prompt(existing.as_deref(), guidance);
        let mut last_err = String::new();
        for _ in 0..2 {
            self.gen_begin();
            let result = self
                .interruptible_turn(prompts::DECOMPOSE_SYSTEM, vec![LlmMessage::user_text(user.clone())], None, 8192)
                .await;
            self.gen_end();
            match result {
                Ok(turn) => match parse_plan(&turn.text) {
                    Ok(plan) => return Ok(plan),
                    Err(e) => {
                        tracing::warn!("[aop] 拆解 JSON 解析失败,重试: {}", e.chars().take(200).collect::<String>());
                        last_err = e;
                        user = format!("{user}\n\n{}", retry_hint(&last_err));
                    }
                },
                Err(e) => return Err(e),
            }
        }
        Err(last_err)
    }

    // ── execute:子 Agent 逐层执行 + 独立 R 自强不息 loop ───────

    async fn execute_turn(self: &Arc<Self>, writer: &TaskWriter) {
        let plan = {
            let st = self.state.lock().await;
            st.plan.clone()
        };
        let Some(plan) = plan else {
            self.bubble("还没有计划——先描述任务目标。").await;
            return;
        };
        self.set_phase(Phase::Executing).await;
        self.bubble(&format!("🚀 开始执行 {} 个子任务(P→C→D→A→T→R 顺序)…", plan.subtasks.len())).await;

        let runner = ToolRunner::new(self.task_dir.clone());
        let root_goal = extract_goal(writer.read_root_task_md().as_deref());
        // (layer, slug, title, score_str, verdict, attempts, executor)
        let mut rows: Vec<(String, String, String, String, String, u32, String)> = Vec::new();
        // 上游产出物摘要:按层序累计,下游子任务直接读取复用(in→out 契约的数据流)
        let mut upstream = String::new();
        let mut all_pass = true;
        let mut interrupted = false;
        let mut resumed = 0usize;
        // 根目录产物只在内容变化时追加(每个子任务后都重收会把同一份清单
        // 重复灌进下游上下文,N 个子任务就是 N 份)。
        let mut last_root = collect_root_artifacts(writer);

        for st in plan.in_layer_order() {
            if !self.checkpoint().await {
                self.bubble("⏹ 执行已中断——已达标子任务的产物已留存,说「继续」可从剩余子任务恢复。").await;
                interrupted = true;
                break;
            }
            // 断点续跑:已达标(completed)的子任务不重跑,产物仍在盘上,
            // 只并入 upstream 供下游复用、进报告保持全景。
            let mark = self.state.lock().await.subtask_marks.get(&st.slug).cloned();
            if let Some((status, score, attempts)) = mark {
                if status == "completed" {
                    let executor_str = match ExecutorKind::parse(st.executor.as_deref()) {
                        ExecutorKind::Agent => "AI",
                        ExecutorKind::Human => "人工",
                        ExecutorKind::Remote => "远程(回退AI)",
                    };
                    let score_str = score.map(|s| format!("{s:.2}")).unwrap_or_else(|| "—".into());
                    upstream.push_str(&format!("=== [{}] {}(`{}/`) ===\n", st.layer, st.title, st.slug));
                    upstream.push_str(&collect_artifacts(writer, &st.slug));
                    rows.push((st.layer.clone(), st.slug.clone(), st.title.clone(), score_str, "达标".to_string(), attempts, executor_str.to_string()));
                    resumed += 1;
                    continue;
                }
            }
            let row = self.execute_subtask(writer, st, &runner, root_goal.as_deref(), &upstream).await;
            if row.4 != "达标" {
                all_pass = false;
            }
            upstream.push_str(&format!("=== [{}] {}(`{}/`) ===\n", st.layer, st.title, st.slug));
            upstream.push_str(&collect_artifacts(writer, &st.slug));
            let root_now = collect_root_artifacts(writer);
            if root_now != last_root {
                last_root = root_now;
                upstream.push_str(&collect_root_artifacts(writer));
            }
            rows.push(row);
        }
        if resumed > 0 {
            self.bubble(&format!("↩️ 断点续跑:已达标子任务 {resumed} 个不重跑(产物直接复用)。")).await;
        }

        if !rows.is_empty() {
            let mut table = String::from("**执行报告**(R 评分由独立评审代理第三方核验)\n\n| 层 | 子任务 | 执行者 | R 评分 | 轮次 | 结论 |\n|---|---|---|---|---|---|\n");
            for (layer, slug, title, score, verdict, attempts, executor) in &rows {
                table.push_str(&format!(
                    "| **{layer}** | {title}(`{slug}/`) | {executor} | {score} | {attempts} | {verdict} |\n"
                ));
            }
            self.bubble(&table).await;
        }
        // 纲领二:全部达标 → 轨迹登记回归语料
        if all_pass && rows.len() == plan.subtasks.len() && !rows.is_empty() {
            match self.recorder().export_success(&self.task_id).await {
                Ok(p) => self.bubble(&format!("🏁 全部子任务达标。执行轨迹已登记回归语料:`{}`", p.display())).await,
                Err(e) => tracing::warn!("[aop] 轨迹登记失败: {e}"),
            }
            // R3:相关传感器语料(内容含本 task_id)同柜归档 → ~/.myco/traces/sensors/
            match crate::frames::archive_related_sensors(writer.root_dir(), &self.task_id).await {
                Ok(n) if n > 0 => self.bubble(&format!("📼 相关传感器语料 {n} 份已一并归档,可在监视器「语料」页精确回放")).await,
                Err(e) => tracing::warn!("[aop] sensor 语料归档失败: {e}"),
                _ => {}
            }
        }
        // 只有完整跑完才算"已执行"——中断时保持 false,「继续」才能续跑剩余子任务
        //(否则「继续」会被当新任务描述,把 task.md 重定义成"继续"两个字)。
        if !interrupted {
            self.state.lock().await.executed = true;
        }
    }

    /// 单个子任务:executor 三态分发 + 独立 R 评审 + 自强不息重跑。
    /// 返回 (layer, slug, title, score_str, verdict, attempts, executor_str)
    #[allow(clippy::too_many_arguments)]
    async fn execute_subtask(
        self: &Arc<Self>,
        writer: &TaskWriter,
        st: &SubTask,
        runner: &ToolRunner,
        root_goal: Option<&str>,
        upstream: &str,
    ) -> (String, String, String, String, String, u32, String) {
        let (layer, slug, title) = (st.layer.clone(), st.slug.clone(), st.title.clone());
        let kind = ExecutorKind::parse(st.executor.as_deref());
        let executor_str = match kind {
            ExecutorKind::Agent => "AI",
            ExecutorKind::Human => "人工",
            ExecutorKind::Remote => "远程(回退AI)",
        };
        let _ = self.events.send(AopEvent::SubtaskStart {
            session_id: self.session_id.clone(),
            slug: slug.clone(),
            layer: layer.clone(),
            title: title.clone(),
            executor: executor_str.to_string(),
        });
        self.state.lock().await.subtask_marks.insert(slug.clone(), ("running".to_string(), None, 0));
        self.bubble(&format!("▶ 开始 [{layer}] {title}(`{slug}/`,执行者:{executor_str})…")).await;
        let _ = writer.update_subtask_status(&slug, "running").await;
        self.rescan().await;

        let mut feedback: Option<String> = None;
        let mut attempt: u32 = 0;
        let (score, pass, evidence_text) = loop {
            attempt += 1;
            if !self.checkpoint().await {
                break (None, false, "(用户中断)".to_string());
            }

            // ── 执行(纲领五:三态分发) ──
            let deliverable_note = match kind {
                ExecutorKind::Human => match self.run_human_wait(st, upstream, attempt).await {
                    Some(note) => note,
                    None => break (None, false, "(用户中断)".to_string()),
                },
                // Remote:did 委托 seam——S0 无远端可测,回退本地子 Agent 并记帧。
                ExecutorKind::Remote | ExecutorKind::Agent => {
                    if kind == ExecutorKind::Remote {
                        let mut f = AopFrame::new(&self.session_id, &slug, &layer, attempt, kind, FrameKind::Note);
                        f.r = "did 委托未实装(seam),回退本地子 Agent 执行".to_string();
                        self.emit_frame(f).await;
                    }
                    match self
                        .run_executor_loop(st, runner, root_goal, upstream, feedback.as_deref(), attempt)
                        .await
                    {
                        Ok((_summary, evidence)) => evidence,
                        Err(e) => format!("执行失败:{e}"),
                    }
                }
            };

            // /stop 立即止步:不进 R 评审——评审的 LLM 调用不可中断,在被中断的
            // 交付上白烧一整轮核验,还可能把"用户中断"误判成"未达标"。
            if self.stop.load(Ordering::SeqCst) {
                break (None, false, "(用户中断)".to_string());
            }

            // ── 独立 R 评审(纲领四:第三方客观中立,亲自核验) ──
            let verdict = self.run_r_eval(st, &deliverable_note, attempt, kind).await;
            let score_str = verdict.score.map(|s| format!("{:.2}", s)).unwrap_or_else(|| "—".into());

            // 评审帧
            let mut f = AopFrame::new(&self.session_id, &slug, &layer, attempt, kind, FrameKind::Eval);
            f.s = format!("R 评审第 {attempt} 轮");
            f.r = format!(
                "score={} pass={} | {}",
                score_str,
                verdict.pass,
                truncate_chars(&verdict.evidence, 600)
            );
            // r 结构化:score/pass/evidence 独立字段(供按分过滤回放;字符串保留人读叙事)
            f.r_score = verdict.score.map(|s| (s * 100.0).round() / 100.0);
            f.r_pass = Some(verdict.pass);
            f.r_evidence = Some(truncate_chars(&verdict.evidence, 2000));
            self.emit_frame(f).await;

            // traces.json + 状态落盘(每轮一帧,带 attempt)
            let trace = serde_json::json!({
                "o": { "subtask": slug, "inputs": st.inputs },
                "s": { "attempt": attempt, "executor": kind.as_str() },
                "a": { "deliverable": truncate_chars(&deliverable_note, 4000) },
                "r": { "score": verdict.score, "pass": verdict.pass, "evidence": verdict.evidence, "feedback": verdict.feedback },
                "at": Utc::now().to_rfc3339(),
            });
            let _ = writer.append_trace(&slug, trace).await;

            if verdict.pass {
                break (verdict.score, true, verdict.evidence);
            }
            if attempt >= MAX_R_ATTEMPTS {
                break (verdict.score, false, verdict.evidence);
            }
            // 自强不息:feedback 回灌执行者,重跑
            let _ = self.events.send(AopEvent::EvalRound {
                session_id: self.session_id.clone(),
                slug: slug.clone(),
                attempt,
                score: verdict.score,
                feedback: verdict.feedback.clone(),
            });
            self.bubble(&format!(
                "🔁 [{layer}] {title} 第 {attempt} 轮未达标(R={score_str})——独立评审反馈:\n\n> {}\n\n自动重跑第 {} 轮…",
                verdict.feedback,
                attempt + 1
            ))
            .await;
            feedback = Some(verdict.feedback);
            // 人工节点:重跑=再发任务卡(带退回原因)
        };

        // 用户中断 ≠ 未达标:marks/taskfile 回到 pending(续跑会重跑它),
        // 事件带 interrupted 让前端显示"待命"而不是误导性的红叉。
        let interrupted = !pass && evidence_text == "(用户中断)";
        let status = if pass { "completed" } else if interrupted { "pending" } else { "failed" };
        let _ = writer.update_subtask_status(&slug, status).await;
        self.state.lock().await.subtask_marks.insert(slug.clone(), (status.to_string(), score, attempt));
        self.rescan().await;

        let icon = if interrupted { "⏹" } else if pass { "✅" } else { "❌" };
        let score_str = score.map(|s| format!("{s:.2}")).unwrap_or_else(|| "—".into());
        let verdict_str = if interrupted { "已中断".to_string() } else if pass { "达标".to_string() } else { "未达标".to_string() };
        let _ = self.events.send(AopEvent::SubtaskDone {
            session_id: self.session_id.clone(),
            slug: slug.clone(),
            layer: layer.clone(),
            title: title.clone(),
            score,
            pass,
            attempts: attempt,
            interrupted,
        });
        if interrupted {
            self.bubble(&format!("{icon} [{layer}] {title} — 已中断(说「继续」从该子任务恢复)。")).await;
        } else {
            self.bubble(&format!(
                "{icon} [{layer}] {title} — R 评分 {score_str} · {verdict_str}(第 {attempt} 轮)\n\n{evidence_text}"
            ))
            .await;
        }

        (layer, slug, title, score_str, verdict_str, attempt, executor_str.to_string())
    }

    /// 纲领四:独立 R 代理评审。评审过程的工具调用也产帧(UI 直播评审核验)。
    async fn run_r_eval(
        &self,
        st: &SubTask,
        deliverable_note: &str,
        attempt: u32,
        kind: ExecutorKind,
    ) -> super::r_agent::RVerdict {
        let subtask_md = self.writer().read_subtask_md(&st.slug).await.unwrap_or_default();
        let r = RAgent::new(proxy_base(), &proxy_token(&self.task_id), self.model.as_deref(), self.task_dir.clone());

        // 评审工具回调:帧先广播(同步),收集后统一落盘(async)
        let pending = std::sync::Arc::new(std::sync::Mutex::new(Vec::<AopFrame>::new()));
        let pending2 = pending.clone();
        let events = self.events.clone();
        let sid = self.session_id.clone();
        let slug = st.slug.clone();
        let layer = st.layer.clone();
        let on_tool = move |name: &str, out: &str| {
            let mut f = AopFrame::new(&sid, &slug, &layer, attempt, ExecutorKind::Agent, FrameKind::Eval);
            // 同步回调走不了 emit_frame,这里同样盖进程 DID(与 emit_frame 一致)。
            f.from = Some(ENV_PROCESS_DID.into());
            f.a = format!("R 核验: {name}");
            f.r = truncate_chars(out, 400);
            let _ = events.send(AopEvent::Frame { session_id: sid.clone(), frame: Box::new(f.clone()) });
            if let Ok(mut g) = pending2.lock() {
                g.push(f);
            }
        };

        self.gen_begin();
        let verdict = r.evaluate(&subtask_md, deliverable_note, attempt, kind, &on_tool).await;
        self.gen_end();

        // std MutexGuard 非 Send,先 drain 出 Vec 再跨 await 落盘
        let drained: Vec<AopFrame> = pending
            .lock()
            .map(|mut g| g.drain(..).collect())
            .unwrap_or_default();
        for f in &drained {
            self.recorder().record(f).await;
        }
        verdict
    }

    /// 纲领五:人工节点——发 GUI 任务卡,挂起等交付(不适用自动续跑期限;
    /// /stop 仍可中断)。返回交付说明(note + artifacts 登记)。
    async fn run_human_wait(&self, st: &SubTask, upstream: &str, attempt: u32) -> Option<String> {
        let upstream_clip = truncate_chars(upstream, 3000);
        let hp = HumanPendingInfo {
            slug: st.slug.clone(),
            layer: st.layer.clone(),
            title: st.title.clone(),
            goal: st.goal.clone(),
            inputs: st.inputs.clone(),
            out: st.out.clone(),
            r_criteria: st.r_criteria.clone(),
            upstream: upstream_clip.clone(),
        };
        self.state.lock().await.human_pending = Some(hp);
        let _ = self.events.send(AopEvent::HumanTaskPending {
            session_id: self.session_id.clone(),
            slug: st.slug.clone(),
            layer: st.layer.clone(),
            title: st.title.clone(),
            goal: st.goal.clone(),
            inputs: st.inputs.clone(),
            out: st.out.clone(),
            r_criteria: st.r_criteria.clone(),
            upstream: upstream_clip.clone(),
        });
        let mut f = AopFrame::new(&self.session_id, &st.slug, &st.layer, attempt, ExecutorKind::Human, FrameKind::Note);
        f.s = "等待人工交付".to_string();
        f.o = truncate_chars(&st.goal, 300);
        self.emit_frame(f).await;
        self.bubble(&format!(
            "🧑 该子任务指派给「人工」执行(第 {attempt} 轮):\n\n**{}**(`{}/`)\n\n- 目标:{}\n- 交付物:{}\n- R 标准:{}\n\n请在下方任务卡交付(说明 + 产物路径),或 /stop 中断。",
            st.title,
            st.slug,
            st.goal.trim(),
            st.out.join("、"),
            st.r_criteria.join("、"),
        ))
        .await;

        let mut guard = self.human_rx.lock().await;
        let result = loop {
            tokio::select! {
                biased;
                _ = self.wait_stop() => break None,
                sub = guard.recv() => {
                    let Some(sub) = sub else { break None };
                    // 陈旧提交(任务卡过期/重规划后的旧 slug)直接丢弃——
                    // 不能当本节点的交付,否则 R 评审核验的是错误的产物。
                    if sub.slug != st.slug {
                        tracing::warn!("[aop] 人工交付 slug 不匹配:期望 {} 收到 {},已丢弃", st.slug, sub.slug);
                        drop(guard);
                        self.bubble("⚠️ 已忽略一条过期任务卡的交付(任务卡已不在等待状态)。").await;
                        guard = self.human_rx.lock().await;
                        continue;
                    }
                    let artifacts = if sub.artifacts.is_empty() { "(未登记产物)".into() } else { sub.artifacts.join("\n") };
                    let note = format!("人工交付说明:\n{}\n\n登记产物:\n{}", sub.note, artifacts);
                    let mut f = AopFrame::new(&self.session_id, &st.slug, &st.layer, attempt, ExecutorKind::Human, FrameKind::Human);
                    f.a = "人工交付".to_string();
                    f.r = truncate_chars(&note, 800);
                    self.emit_frame(f).await;
                    self.bubble("📬 收到人工交付,转独立 R 评审核验…").await;
                    break Some(note);
                }
            }
        };
        // 交付/中断都清卡(快照不再回放此节点)
        self.state.lock().await.human_pending = None;
        result
    }

    /// Pi 式工具循环(子 Agent 本体)。返回 (最终文本, 工具证据摘要)。
    /// 每轮次边界:checkpoint(暂停/停止) + steering 纠偏注入(纲领一/二)。
    async fn run_executor_loop(
        &self,
        st: &SubTask,
        runner: &ToolRunner,
        root_goal: Option<&str>,
        upstream: &str,
        feedback: Option<&str>,
        attempt: u32,
    ) -> Result<(String, String), String> {
        let subtask_md = self.writer().read_subtask_md(&st.slug).await.unwrap_or_default();
        let mut messages = vec![LlmMessage::user_text(prompts::execute_user_prompt(
            root_goal,
            &subtask_md,
            upstream,
            feedback,
        ))];
        let tools = exec_tool_defs();
        let mut evidence: Vec<String> = Vec::new();
        let mut final_text = String::new();

        self.gen_begin();
        let result = async {
            for _turn in 0..12 {
                if !self.checkpoint().await {
                    final_text = "(用户中断)".to_string();
                    return Ok::<_, String>((final_text.clone(), evidence.join("\n")));
                }
                // steering:用户中途纠偏注入子 Agent 上下文(纲领一:随时改变任务执行)
                let steerings = self.drain_steering().await;
                if !steerings.is_empty() {
                    let note = steerings.join("\n");
                    messages.push(LlmMessage::user_text(format!("【用户中途纠偏,优先遵从】:\n{note}")));
                    let mut f = AopFrame::new(&self.session_id, &st.slug, &st.layer, attempt, ExecutorKind::Agent, FrameKind::Note);
                    f.s = "用户纠偏注入".to_string();
                    f.r = truncate_chars(&note, 400);
                    self.emit_frame(f).await;
                }

                let turn = self
                    .interruptible_turn(prompts::EXECUTE_SYSTEM, messages.clone(), Some(&tools), 8192)
                    .await?;
                final_text = turn.text.clone();
                if turn.tool_uses.is_empty() {
                    break;
                }
                // length 截断:全部 fail,不执行半截参数(Pi agent-loop 安全语义)
                let truncated = turn.stop_reason == "length" || turn.stop_reason == "max_tokens";
                let mut assistant_content: Vec<LlmBlock> = Vec::new();
                if !turn.text.is_empty() {
                    assistant_content.push(LlmBlock::Text { text: turn.text.clone() });
                }
                let mut results: Vec<LlmBlock> = Vec::new();
                for tu in &turn.tool_uses {
                    assistant_content.push(LlmBlock::ToolUse {
                        id: tu.id.clone(),
                        name: tu.name.clone(),
                        input: tu.input.clone(),
                    });
                    let out = if truncated {
                        "Error: 响应被 token 上限截断,工具调用参数不完整,已拒绝执行(请重试)".to_string()
                    } else {
                        runner.run(&tu.name, &tu.input).await
                    };
                    // 工具帧(纲领二:过程透明)
                    let mut f = AopFrame::new(&self.session_id, &st.slug, &st.layer, attempt, ExecutorKind::Agent, FrameKind::Tool);
                    f.o = truncate_chars(&turn.text, 300);
                    f.a = format!("{} {}", tu.name, truncate_chars(&serde_json::to_string(&tu.input).unwrap_or_default(), 200));
                    f.r = truncate_chars(&out, 500);
                    self.emit_frame(f).await;

                    evidence.push(format!(
                        "{} {} => {}",
                        tu.name,
                        serde_json::to_string(&tu.input).unwrap_or_default(),
                        truncate_chars(&out, 800)
                    ));
                    results.push(LlmBlock::ToolResult {
                        tool_use_id: tu.id.clone(),
                        content: vec![super::llm::ToolResultContent { kind: "text".into(), text: out }],
                    });
                }
                messages.push(LlmMessage { role: "assistant".into(), content: assistant_content });
                messages.push(LlmMessage { role: "user".into(), content: results });
            }
            Ok((final_text.clone(), evidence.join("\n")))
        }
        .await;
        self.gen_end();
        result
    }

    async fn status_bubble(&self, writer: &TaskWriter) {
        let st = self.state.lock().await;
        let phase = st.phase;
        let plan = st.plan.clone();
        let paused = self.pause_deadline.lock().await.is_some();
        drop(st);
        let phase_str = match phase {
            Phase::Idle => "空闲(等待输入)",
            Phase::Planning => "拆解中",
            Phase::Executing if paused => "已暂停(期限暂停,超时自动续跑)",
            Phase::Executing => "执行中",
        };
        let mut out = format!("**状态**:{phase_str}\n");
        if let Some(plan) = plan {
            out.push_str("\n| 层 | 子任务 | 执行者 | 状态 |\n|---|---|---|---|\n");
            for subtask in plan.in_layer_order() {
                let status = writer
                    .read_subtask_status(&subtask.slug)
                    .await
                    .unwrap_or_else(|| "pending".to_string());
                let executor = subtask.executor.as_deref().unwrap_or("agent");
                out.push_str(&format!(
                    "| {} | {}(`{}/`) | {} | {} |\n",
                    subtask.layer, subtask.title, subtask.slug, executor, status
                ));
            }
        } else {
            out.push_str("\n还没有计划——描述任务目标即可自动开始。");
        }
        self.bubble(&out).await;
    }

    /// 元问题的权威回答:系统直回事实,不经 LLM。口径:只说 AOP 面向智能体编程。
    fn meta_answer(&self) -> String {
        let model = self.model.as_deref().unwrap_or("(默认)");
        format!(
            "**AOP 面向智能体编程**(Agent-Oriented Programming,POMDP→PCDATR)。\n\n\
            | 维度 | 说明 |\n|---|---|\n\
            | 范式 | AOP 面向智能体编程,把任何任务按 PCDATR 六层拆解 |\n\
            | 六层 | P 感知 / C 认知 / D 决策 / A 行动 / T 转变 / R 回报 |\n\
            | 执行 | 每层由独立子 Agent 执行(可指派人工),独立 R 代理第三方评审,不达标自动重跑 |\n\
            | 后端模型 | `{model}` |\n\
            | 交互 | 描述目标即自动跑全程;过程视图看帧级直播;随时纠偏/「等等」暂停(3 分钟自动续跑) |\n\
            | 工作目录 | `{}` |",
            self.task_dir.display()
        )
    }
}

/// 管线种类(spawn_pipeline 用)。
enum Pipeline {
    Define(String),
    Plan(Option<String>),
    Execute,
}

/// 解析 define 阶段的 ROSA JSON(带提取/修复)。
fn parse_rosa(raw: &str) -> Result<RosaDef, String> {
    let text = super::plan::extract_json_text(raw);
    let repaired = repair_json(&text);
    let rosa: RosaDef = serde_json::from_str(&repaired).map_err(|e| format!("JSON 解析失败: {e}"))?;
    if rosa.title.trim().is_empty() {
        return Err("缺少 title".to_string());
    }
    if rosa.r.is_empty() {
        return Err("缺少 R 指标(先定 R)".to_string());
    }
    Ok(rosa)
}

/// 收集某子任务目录的产出物摘要(排除 task.md/traces.json),供下游 in→out 数据流。
fn collect_artifacts(writer: &TaskWriter, slug: &str) -> String {
    let dir = writer.subtask_dir(slug);
    let mut out = String::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "task.md" || name == "traces.json" {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        out.push_str(&format!("[{slug}/{}]\n", name));
        if let Ok(content) = std::fs::read_to_string(&path) {
            let clipped: String = content.chars().take(600).collect();
            out.push_str(&clipped);
            out.push('\n');
        }
    }
    truncate_chars(&out, 6000)
}

/// 收集任务根目录的交付物摘要(DECOMPOSE 约定:最终 out 写根目录)。
fn collect_root_artifacts(writer: &TaskWriter) -> String {
    const SKIP: &[&str] = &["task.md", "agents", ".aop", ".git", "target", "node_modules"];
    let mut out = String::new();
    let Ok(entries) = std::fs::read_dir(writer.root_dir()) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKIP.contains(&name.as_str()) || name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        out.push_str(&format!("[根目录/{name}]\n"));
        if let Ok(content) = std::fs::read_to_string(&path) {
            let clipped: String = content.chars().take(600).collect();
            out.push_str(&clipped);
            out.push('\n');
        }
    }
    truncate_chars(&out, 6000)
}

/// 元问题判定。
fn is_meta_query(lower: &str) -> bool {
    const PATTERNS: &[&str] = &[
        "你是什么 harness",
        "你是什么harness",
        "什么 harness 工具",
        "什么harness工具",
        "你是什么模型",
        "你是谁",
        "你是什么",
        "what harness",
        "which harness",
        "what model are you",
        "who are you",
        "what are you",
    ];
    PATTERNS.iter().any(|p| lower.contains(p))
}

/// 提取根 task.md 的 ## 目标 段(供子任务执行上下文)。
fn extract_goal(md: Option<&str>) -> Option<String> {
    let md = md?;
    let idx = md.find("## 目标")?;
    let rest = &md[idx + "## 目标".len()..];
    let end = rest.find("\n## ").unwrap_or(rest.len());
    let goal = rest[..end].trim().to_string();
    if goal.is_empty() { None } else { Some(truncate_chars(&goal, 2000)) }
}

fn truncate_chars(s: &str, max: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max {
        return s.to_string();
    }
    let kept: String = chars[..max].iter().collect();
    format!("{kept}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_goal_finds_section() {
        let md = "---\nid: x\n---\n\n## 目标\n\n做一件事\n\n## MDP 定义\n\n### R — 回报函数";
        assert_eq!(extract_goal(Some(md)).as_deref(), Some("做一件事"));
    }

    #[test]
    fn parse_rosa_rejects_missing_r() {
        assert!(parse_rosa(r#"{"title":"t","goal":"g"}"#).is_err());
    }

    /// gen_depth 引用计数:嵌套的 begin/end 只在最外层进出时发事件。
    #[test]
    fn gen_depth_refcount_emits_once_for_nested() {
        let session = test_session();
        let mut rx = session.events.subscribe();
        session.gen_begin();
        session.gen_begin();
        session.gen_end();
        session.gen_end();
        session.gen_end(); // 配对失衡兜底
        drop(session);

        let mut kinds = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            kinds.push(match ev {
                AopEvent::GenStart { .. } => "start",
                AopEvent::GenEnd { .. } => "end",
                _ => "other",
            });
        }
        assert_eq!(kinds, vec!["start", "end"]);
    }

    /// 期限暂停(纲领一):request_pause 设 deadline 并发 Paused 事件;
    /// request_resume 清除并发 Resumed(auto=false)。
    #[tokio::test]
    async fn pause_sets_deadline_and_resume_clears() {
        let session = test_session();
        session.busy.store(true, Ordering::SeqCst); // 假装执行中
        let mut rx = session.events.subscribe();
        session.request_pause().await;
        assert!(session.pause_deadline.lock().await.is_some());
        session.request_resume(false).await;
        assert!(session.pause_deadline.lock().await.is_none());

        let mut kinds = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            kinds.push(match ev {
                AopEvent::Paused { deadline_ms, .. } => {
                    assert!(deadline_ms > Utc::now().timestamp_millis() + 1000);
                    "paused"
                }
                AopEvent::Resumed { auto, .. } => {
                    assert!(!auto);
                    "resumed"
                }
                _ => "other",
            });
        }
        assert!(kinds.contains(&"paused"));
        assert!(kinds.contains(&"resumed"));
    }

    /// 空闲时「等等」不该设暂停(没东西可停)。
    #[tokio::test]
    async fn pause_ignored_when_idle() {
        let session = test_session();
        session.request_pause().await;
        assert!(session.pause_deadline.lock().await.is_none());
    }

    /// 相位→细态映射 + 管线收尾覆盖(§9.4:与三 harness 11 细态同口径)。
    /// Planning→generating / Executing→tool_running / Idle→idle_ready,
    /// 收尾覆盖 error_blocked(LLM 失败)/interrupted(用户中断)。
    #[tokio::test]
    async fn set_phase_maps_fine_states_with_outcome_override() {
        let session = test_session();
        let mut rx = session.events.subscribe();
        session.set_phase(Phase::Planning).await;
        session.set_phase(Phase::Executing).await;
        session.set_phase(Phase::Idle).await;
        session.set_phase_with_fine(Phase::Idle, Some("error_blocked")).await;
        session.set_phase_with_fine(Phase::Idle, Some("interrupted")).await;
        drop(session);

        let mut fines = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            if let AopEvent::State { fine_state, .. } = ev {
                fines.push(fine_state.unwrap_or_default());
            }
        }
        assert_eq!(
            fines,
            vec!["generating", "tool_running", "idle_ready", "error_blocked", "interrupted"]
        );
    }

    /// 根目录收集:跳过 task.md/agents/.aop 与点文件,抓普通交付物。
    #[test]
    fn collect_root_artifacts_skips_known_and_captures_deliverables() {
        let tmp = std::env::temp_dir().join(format!("myco-aop-root-art-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("agents/p-scan")).unwrap();
        std::fs::create_dir_all(tmp.join(".aop")).unwrap();
        std::fs::write(tmp.join("task.md"), "# root").unwrap();
        std::fs::write(tmp.join("stats.md"), "1 2 3 行统计").unwrap();
        std::fs::write(tmp.join("report.csv"), "a,b\n1,2").unwrap();
        std::fs::write(tmp.join(".hidden"), "no").unwrap();
        std::fs::write(tmp.join("agents/p-scan/task.md"), "# sub").unwrap();
        std::fs::write(tmp.join(".aop/history.jsonl"), "{}").unwrap();

        let writer = TaskWriter::new(tmp.clone());
        let out = collect_root_artifacts(&writer);
        assert!(out.contains("stats.md"), "应包含根目录交付物 stats.md: {out}");
        assert!(out.contains("report.csv"), "应包含 report.csv: {out}");
        assert!(out.contains("1 2 3 行统计"), "应抓内容: {out}");
        assert!(!out.contains("task.md]"), "应跳过 task.md: {out}");
        assert!(!out.contains(".hidden"), "应跳过点文件: {out}");
        assert!(!out.contains("agents"), "应跳过 agents 目录: {out}");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// 元问题判定:命中身份问句,不误伤任务描述/命令。
    #[test]
    fn is_meta_query_matches_identity_not_task() {
        assert!(is_meta_query("你是什么harness工具？"));
        assert!(is_meta_query("你是谁"));
        assert!(is_meta_query("what harness are you"));
        assert!(!is_meta_query("帮我统计这个目录的行数"));
        assert!(!is_meta_query("你说先定 r 是什么意思,继续拆"));
        assert!(!is_meta_query("/plan"));
        assert!(!is_meta_query("继续"));
    }

    /// 暂停/继续词表:「等等」进 PAUSE_WORDS;「继续」在 RESUME_WORDS 且不属元问题。
    #[test]
    fn pause_resume_word_sets() {
        assert!(PAUSE_WORDS.contains(&"等等"));
        assert!(PAUSE_WORDS.contains(&"暂停"));
        assert!(RESUME_WORDS.contains(&"继续"));
    }

    /// Planning 期 abort 必须清 gen_depth 并补发 GenEnd——否则引用计数泄漏,
    /// 前端 spinner 永久卡"生成中"(state 事件 fineState=null 不会代为清)。
    #[tokio::test]
    async fn abort_resets_gen_depth_and_emits_gen_end() {
        let session = test_session();
        let mut rx = session.events.subscribe();
        session.busy.store(true, Ordering::SeqCst);
        session.state.lock().await.phase = Phase::Planning;
        session.gen_begin(); // 模拟 abort 落在 gen_begin/gen_end 之间
        assert_eq!(session.gen_depth.load(Ordering::SeqCst), 1);

        session.abort_active_pipeline().await;
        assert_eq!(session.gen_depth.load(Ordering::SeqCst), 0, "gen_depth 应清零");

        let mut saw_gen_end = false;
        while let Ok(ev) = rx.try_recv() {
            if matches!(ev, AopEvent::GenEnd { .. }) {
                saw_gen_end = true;
            }
        }
        assert!(saw_gen_end, "abort 后应补发 GenEnd");
    }

    /// /stop 的停止请求不被执行中的后续消息吞掉(P2 修复回归):
    /// busy=true 时 run loop 绝不清 stop 标志。
    #[tokio::test]
    async fn stop_flag_survives_message_while_busy() {
        // 用自己的通道建 session——test_session 的 rx 被丢弃,accept_input 送不进 run loop
        let tmp = std::env::temp_dir().join(format!("myco-aop-stopflag-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let (events, _) = broadcast::channel(16);
        let (tx, mut rx) = mpsc::channel(8);
        let s = std::sync::Arc::new(AopSession::new(
            "test-sess".to_string(),
            AopSessionConfig {
                task_id: "t".to_string(),
                task_dir: tmp,
                title: "t".to_string(),
                provider_id: None,
                model: None,
            },
            events,
            tx,
        ));
        let runner = s.clone();
        tokio::spawn(async move { runner.run(rx).await });

        s.busy.store(true, Ordering::SeqCst);
        s.request_stop();
        s.accept_input("一条会取消停止的消息").await;
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        assert!(s.stop.load(Ordering::SeqCst), "执行中消息不得清除停止请求");
        let steering = s.steering.lock().await.clone();
        assert!(steering.iter().any(|m| m.contains("取消停止")), "消息应进 steering: {steering:?}");
    }

    /// 中断的执行不置 executed——「继续」才能续跑剩余子任务,而不是把
    /// task.md 重定义成"继续"两个字。
    #[tokio::test]
    async fn execute_turn_interrupted_keeps_executed_false() {
        let session = std::sync::Arc::new(test_session());
        {
            let mut st = session.state.lock().await;
            st.plan = Some(test_plan());
        }
        session.request_stop();
        session.execute_turn(&session.writer()).await;
        assert!(!session.state.lock().await.executed, "中断后 executed 必须保持 false");
        let msgs = session.messages().await;
        assert!(msgs.iter().any(|m| m.text.contains("执行已中断")), "应有中断说明 bubble");
    }

    /// 断点续跑:已达标(completed)子任务不重跑、进报告、upstream 复用产物;
    /// 全部达标时 executed=true(无需 LLM——两个子任务都标 completed)。
    #[tokio::test]
    async fn execute_turn_skips_completed_and_resumes() {
        let session = std::sync::Arc::new(test_session());
        let plan = test_plan();
        {
            let mut st = session.state.lock().await;
            st.plan = Some(plan.clone());
            for sub in &plan.subtasks {
                session.writer().write_subtask(sub, "completed").await.unwrap();
                st.subtask_marks.insert(sub.slug.clone(), ("completed".to_string(), Some(0.95), 1));
            }
        }
        session.execute_turn(&session.writer()).await;
        assert!(session.state.lock().await.executed, "全 completed 跳过后应视为已执行");
        let msgs = session.messages().await;
        assert!(msgs.iter().any(|m| m.text.contains("断点续跑")), "应提示跳过数量");
        assert!(msgs.iter().any(|m| m.text.contains("执行报告")), "报告应含被跳过子任务");
    }

    /// 测试用最小 AopSession(不跑 run loop)。
    fn test_session() -> AopSession {
        let tmp = std::env::temp_dir().join(format!("myco-aop-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let (events, _) = broadcast::channel(16);
        let (input_tx, _rx) = mpsc::channel(1);
        AopSession::new(
            "test-sess".to_string(),
            AopSessionConfig {
                task_id: "t".to_string(),
                task_dir: tmp,
                title: "t".to_string(),
                provider_id: None,
                model: None,
            },
            events,
            input_tx,
        )
    }

    /// 测试用最小拆解计划(2 子任务,无 executor 指派)。
    fn test_plan() -> AopPlan {
        AopPlan {
            title: "测试任务".into(),
            r_summary: "s".into(),
            plan_file: None,
            subtasks: vec![
                SubTask {
                    layer: "P".into(),
                    slug: "p-scan".into(),
                    title: "扫描".into(),
                    goal: "g".into(),
                    inputs: vec![],
                    out: vec!["list.txt".into()],
                    r_criteria: vec!["r1".into()],
                    executor: None,
                    deadline: None,
                },
                SubTask {
                    layer: "A".into(),
                    slug: "a-write".into(),
                    title: "写文件".into(),
                    goal: "g2".into(),
                    inputs: vec![],
                    out: vec![],
                    r_criteria: vec!["r2".into()],
                    executor: None,
                    deadline: None,
                },
            ],
        }
    }
}

#[cfg(test)]
mod resume_tests {
    use super::*;

    /// 重启恢复:plan.json + agents/*/task.md 状态 → 恢复 marks 与 executed 语义。
    /// (逻辑在 run() 里,这里测支撑件:write_subtask 落 status 后 read_subtask_status 回读。)
    #[tokio::test]
    async fn resume_supports_plan_and_marks_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("aop-resume-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).unwrap();
        let w = crate::taskfile::TaskWriter::new(tmp.clone());
        let plan = crate::plan::AopPlan {
            title: "t".into(), r_summary: "s".into(), plan_file: None,
            subtasks: vec![crate::plan::SubTask {
                layer: "P".into(), slug: "p-a".into(), title: "a".into(), goal: "g".into(),
                inputs: vec![], out: vec![], r_criteria: vec!["r".into()], executor: None,
                    deadline: None,
            }],
        };
        w.write_subtask(&plan.subtasks[0], "completed").await.unwrap();
        w.write_plan_json(&plan).await.unwrap();
        // 回读
        let restored = w.read_plan_json().await.expect("plan 应可回读");
        assert_eq!(restored.subtasks.len(), 1);
        assert_eq!(w.read_subtask_status("p-a").await.as_deref(), Some("completed"));
        std::fs::remove_dir_all(&tmp).ok();
    }
}
