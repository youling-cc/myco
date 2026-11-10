//! # myco-terminal-proto
//!
//! Single source of truth for the **terminal wire contract** — the types that
//! cross the terminal-agent ↔ canvas boundary (HTTP API and Discovery invoke).
//!
//! Previously these were duplicated: terminal-agent `types.rs` used
//! `DateTime<Utc>` + proper enums, while canvas `terminal_agent_client.rs`
//! re-declared them with `String` timestamps and stringified enum fields.
//! This crate eliminates the double-write and guarantees both sides agree on
//! the wire format.
//!
//! Types are organized by PCDATR data-contract output (see AOP §2.1):
//!   - **P → o**  (observation):     `ScreenContent`, `OutputHistory`, `OutputDelta`
//!   - **C → b(s)** (belief):        `AppStatus` (+ `AppType`, `AppState`)
//!   - **D → a**  (action):          `ActionDecision` (+ `ActionType`)
//!   - **A**      (action exec):     `CreateSessionRequest`, `InputRequest`
//!   - **session** (P+A):            `SessionInfo`

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ═══ Session (P observe / A manage) ═══════════════════

/// Public session info (returned by create/list APIs).
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub task_id: String,
    pub pid: u32,
    pub command: String,
    pub status: String,
    pub started_at: DateTime<Utc>,
    /// 会话工作目录(项目根)——coworker 等外部编排方解析「项目名」的权威来源
    /// (title 不落 REST,cwd 尾段=项目目录名)。Option+skip:旧消费者零感知。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// 任务名(2026-09-03 多端同步):持久在 {cwd}/.aop/task-titles.json(跟项目
    /// 目录走=跨设备天然同步),list 回带——曾只写本设备 localStorage+窗口标题,
    /// 台式机改名笔记本看不见。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

// ═══ P → o: observation ═══════════════════════════════

/// Current visible screen content (faithful proxy for the console buffer).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenContent {
    pub cols: u16,
    pub rows: u16,
    pub cursor_x: u16,
    pub cursor_y: u16,
    /// All visible lines (empty lines preserved as "").
    pub lines: Vec<String>,
    /// 彩色单元格 [row][col]（?cells=1 时才带；老前端不传则无，省带宽）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<Vec<CharInfoLite>>>,
    pub timestamp: DateTime<Utc>,
}

/// Accumulated output history since session creation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputHistory {
    pub session_id: String,
    pub total_lines: usize,
    /// Index of the first line returned (for pagination).
    pub from: usize,
    /// Number of lines returned.
    pub count: usize,
    pub lines: Vec<String>,
    /// 与 lines 对应的彩色单元格（?cells=1 时才带）。history 主要存文本，多数情况 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<Vec<CharInfoLite>>>,
    /// 结构化对话消息（读 claude jsonl 得到，比终端滚屏干净：无 spinner/ANSI）。
    /// 远端优先用这个渲染成聊天记录；老的 lines 兜底。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<ChatMessage>>,
    pub last_updated_at: DateTime<Utc>,
}

/// 一条对话消息（从 claude 会话 jsonl 解析）。
/// role=user/assistant；text 已拼好（assistant 的多 text block 合并）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    /// ISO 8601 时间戳。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// 唯一 ID。harness 原生 id 或 myco 内容 hash（myco-{fnv1a_hex}）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    /// AI 消息的模型名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 工具调用链。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_use: Option<Vec<ToolCall>>,
    /// 思维链（proxy 拿到完整内容，不受 CLI 折叠影响）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<String>,
    /// 富媒体附件（图片/视频/文件）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
    /// 消息来源："proxy" | "terminal-input" | "claude-jsonl" | "kimi-wire" | "codex-rollout"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<String>,
    /// 产出 harness：claude-code | kimi-code | codex
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// user 消息的作者显示名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// 产出者身份（多 agent 协作用）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<MessageOwner>,
    /// token 用量（AI 消息）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// harness 原生 session ID。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// 在 harness 原生格式中的原始 ID（双向写盘匹配用）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness_uid: Option<String>,
}

/// 消息产出者身份（多 Soul 多设备协作）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MessageOwner {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub myco_did: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_did: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// token 用量。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
}

/// 一次工具调用（assistant 的 tool_use block）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    pub name: String,
    /// 参数摘要（前若干字），展示用。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    /// 完整参数（JSON 字符串），点击展开看全部（代码用代码块版式）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    /// 原始参数 JSON（结构化，2026-09-01 工具卡语义渲染）：Edit={file_path,
    /// old_string,new_string}——前端拆旧/新双块 diff 呈现;其余工具 None
    /// （input 主字段文本已够）。体积敏感:只带渲染必需键。
    /// Task/Agent（2026-09-05 后台 agent 可视化）:{subagentType, description}。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<String>,
    /// 工具调用原生 id（tool_use block 的 call_xxx）。Task/Agent 生命周期配对键：
    /// 启动(tool_use) ↔ 完成通知(task-notification 的 tool-use-id)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// 运行态（仅 Task/Agent）："running" | "completed"。其余工具 None。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// 后台 agent 报告摘要（完成时回填，服务端截 ~8k）。仅 Task/Agent。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

/// 富媒体附件（图片/视频/音频/文件）。xterm 纯字符显示不了，web 聊天格式可内嵌。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// image | video | audio | file
    pub kind: String,
    pub mime: String,
    /// 引用：落盘的绝对路径 / dataURL（web 取来渲染）。
    #[serde(rename = "ref")]
    pub ref_: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// SSE event carrying actual changed content (not just line indices).
///
/// 事件驱动的实时感知（AOP 的 P→o 观测流）：ta 每 50ms tick 检测 viewport
/// 变化，变了才推（没变化不同步，省带宽）。changed_lines 带彩色 cells，
/// 手机端定位重写变化行 → spinner/光标这类"靠重绘实现的动效"自然复现。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputDelta {
    pub session_id: String,
    pub task_id: String,
    pub timestamp: DateTime<Utc>,
    pub app_status: AppStatus,
    /// 帧序号（per-session 单调递增）：远端据此判顺序/丢帧/去重，
    /// 断线重连后可比对本地最后帧决定是否需要全量 snap 兜底。
    #[serde(default)]
    pub frame_seq: u64,
    /// Lines that changed with their new content.
    pub changed_lines: Vec<ChangedLine>,
}

/// 单元格彩色属性（wire 版，对应 terminal-agent 内部 CharInfo）。
/// fg/bg 是 Windows console 16 色 index（0-15），inverse=反色，underline=下划线。
/// **blink 取不到**（Windows console screen buffer 无闪烁属性位，conhost 渲染时合并掉了）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct CharInfoLite {
    pub ch: String,
    pub fg: u8,
    pub bg: u8,
    #[serde(default)]
    pub inverse: bool,
    #[serde(default)]
    pub underline: bool,
    /// truecolor 前景色 [r,g,b]（仅 model 模式的 24bit 色提供；16 色时 None，
    /// 前端退回 fg index 查调色板）。可选字段，向后兼容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fg_rgb: Option<[u8; 3]>,
    /// truecolor 背景色 [r,g,b]（语义同 fg_rgb）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bg_rgb: Option<[u8; 3]>,
}

/// A changed line in the output delta.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedLine {
    pub index: u16,
    pub content: String,
    /// 该行彩色单元格（?cells=1 时才带；老前端不消费）。长度 = cols。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cells: Option<Vec<CharInfoLite>>,
}

// ═══ C → b(s): parsed belief state (pure fact, no value judgment) ═══

/// Application state parsed from the screen (no output lines).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub app_type: AppType,
    pub app_state: AppState,
    pub prompt_text: Option<String>,
    pub mode: Option<String>,
    /// M-Harness H4: harness 特化细态(屏幕锚即查即得,见 state-union §3)。
    /// None = 未命中 harness 规则(未知/通用终端),此时 appState 走旧启发式。
    /// 可选字段,老消费方(无此字段的反序列化)向后兼容。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fine_state: Option<FineState>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AppType {
    ClaudeCode,
    KimiCode,
    Codex,
    OpenCode,
    /// myco 内置 AOP 会话(chat-native,不跑终端;canvas 内嵌运行时)。
    Aop,
    GenericShell,
    Unknown,
}

/// M-Harness H4: 11 细态(docs/harness-state-union.md §3,实测校准)。
/// 判态锚点按 harness 特化(terminal-agent `fine_state.rs` 规则表);
/// error_blocked 必须单设——它和 idle_ready 旧时都报 idle,会把"已卡死"当"可发消息"。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FineState {
    /// 进程起、首屏未就绪(banner 无输入框)。
    Starting,
    /// 可输入(提示符/输入盒在,无 spinner/对话框)。
    IdleReady,
    /// 思考/流式/重连中。
    Generating,
    /// 工具执行中(含审批前摇)。
    ToolRunning,
    /// 权限/信任/y-n/onboarding 确认等待(编号线性选择,等一个决定)。
    AwaitingApproval,
    /// 任何选择菜单/只读面板(/model、/help、历史翻页)。
    PickerOpen,
    /// 刚被 Esc/审批拒绝打断(持久行锚,kimi/codex 可直接识)。
    Interrupted,
    /// turn 失败,等人工(如 codex `■ unexpected status 404`)。
    ErrorBlocked,
    /// 退出确认(瞬时;更可靠的信号是进程退出事件)。
    Exiting,
    /// 上下文压缩(保留,三端未触发)。
    Compacting,
    /// 登录/凭证缺失(保留,三端未触发)。
    AuthRequired,
}

impl FineState {
    /// 细态 → 粗态映射(state-union §3,向后兼容现有 appState 消费方):
    /// working 家族 = starting/generating/tool_running/compacting;其余归 waiting_input。
    pub fn coarse(&self) -> AppState {
        match self {
            FineState::Starting
            | FineState::Generating
            | FineState::ToolRunning
            | FineState::Compacting => AppState::Working,
            _ => AppState::WaitingInput,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum AppState {
    Idle,
    Working,
    WaitingInput,
}

// ═══ D → a: action decision (value function is the rule set) ═══

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActionDecision {
    pub action: ActionType,
    pub input_text: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ActionType {
    None,
    InjectInput,
    Wait,
}

// ═══ A: action execution requests ═════════════════════

/// Request to spawn a console session.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub task_id: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    #[serde(default)]
    pub title: Option<String>,
    /// Max output history lines. Default 50000, set 0 to disable.
    #[serde(default = "default_history_limit")]
    pub history_limit: usize,
    /// true=后台隐藏 conhost 窗口（不弹黑窗，claude 仍在 console 里跑、ta 照常
    /// 抓屏/注入）；false=可见窗口（现状）。用于 PC 版内嵌聊天视图时后台代理。
    #[serde(default)]
    pub hidden: bool,
    /// claude 专属会话 id(2026-09-03 任务 session 分离,env 编排):有值则注入
    /// --session-id 并绑定(新任务/分叉任务的 id 由 env 生成并写 task-meta)——
    /// 每任务独立会话由编排层定,ta 只执行绑定。
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// 当前使用的模型名（canvas 从 provider 配置传入，用于消息归属显示）。
    /// 中途 /switch 时 LlmProxy 时间线做精确回填。
    #[serde(default)]
    pub model: Option<String>,
    /// 拉起的 harness 标识（claude-code / kimi-code / codex；M-Harness H5 由
    /// canvas 按项目/任务选择传入）。随会话元数据存储，供 H3/H4 感知/执行
    /// 分派用；None = 旧调用方未指定（按 claude-code 处理）。
    #[serde(default)]
    pub harness: Option<String>,
}

// Manual Default so the Rust-level default matches the serde wire defaults
// (cols=120, rows=30, history_limit=50000). `#[derive(Default)]` would give
// 0 for these numerics. Lets callers build with `..Default::default()`.
impl Default for CreateSessionRequest {
    fn default() -> Self {
        Self {
            task_id: String::new(),
            command: String::new(),
            args: Vec::new(),
            cwd: String::new(),
            env: HashMap::new(),
            cols: default_cols(),
            rows: default_rows(),
            title: None,
            history_limit: default_history_limit(),
            hidden: false,
            claude_session_id: None,
            model: None,
            harness: None,
        }
    }
}

fn default_cols() -> u16 {
    120
}
fn default_rows() -> u16 {
    30
}
fn default_history_limit() -> usize {
    80000 // ≈1M token（终端行均 ~12 token 估算），环形缓冲
}

/// Input request supporting text, special keys, and control combinations.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct InputRequest {
    /// Plain text input (mutually exclusive with `key`).
    #[serde(default)]
    pub text: Option<String>,
    /// Special key name (mutually exclusive with `text`).
    /// Supported: enter, escape, tab, backspace, delete,
    ///   up, down, left, right, home, end, pageup, pagedown,
    ///   ctrl+c, ctrl+d, ctrl+z, ctrl+a, ctrl+l
    #[serde(default)]
    pub key: Option<String>,
    /// 输入作者显示名（哪个 Soul/设备的人发的）——多端共用一台 claude 时区分
    /// "非 AI 说话"的身份。由接入层按连接身份附上（phone=设备/账号名，canvas 本机=账号名），
    /// 写入 sidecar(myco.jsonl) 持久，历史加载仍显示。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    /// true = 写入终端但不生成 echo/gen_start 事件（终端逐字符输入用）。
    #[serde(default)]
    pub silent: bool,
    /// true = 只生成 echo 事件，不写入终端（终端提交整行回显用）。
    #[serde(default)]
    pub echo_only: bool,
    /// 附件（图片等），用于 echo 即时显示图片而非路径文本。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Attachment>>,
}

// ═══ Generic API response envelope ════════════════════

/// Standard `{ success, data, error }` envelope used by terminal-agent HTTP API.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiResponse<T> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T> ApiResponse<T> {
    pub fn success(data: T) -> Self {
        Self {
            success: true,
            data: Some(data),
            error: None,
        }
    }
    pub fn error(msg: impl Into<String>) -> Self {
        Self {
            success: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

// ═══ BeliefStore collection names (shared constant) ═══

pub const COLLECTION_SESSIONS: &str = "terminal_sessions";
pub const COLLECTION_STATE: &str = "terminal_state";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_status_roundtrips_snake_case() {
        let s = AppStatus {
            app_type: AppType::ClaudeCode,
            app_state: AppState::WaitingInput,
            prompt_text: Some(">".into()),
            mode: None,
            fine_state: Some(FineState::IdleReady),
        };
        let json = serde_json::to_string(&s).unwrap();
        // snake_case enums
        assert!(json.contains("\"appType\":\"claude_code\""));
        assert!(json.contains("\"appState\":\"waiting_input\""));
        assert!(json.contains("\"fineState\":\"idle_ready\""));
        let back: AppStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn app_status_without_fine_state_backcompat() {
        // 老 wire(无 fineState)反序列化为 None;None 不出现在 wire 上。
        let old = r#"{"appType":"kimi_code","appState":"working","promptText":null,"mode":null}"#;
        let s: AppStatus = serde_json::from_str(old).unwrap();
        assert!(s.fine_state.is_none());
        assert_eq!(s.app_type, AppType::KimiCode);
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("fineState"));
    }

    #[test]
    fn fine_state_coarse_mapping() {
        // state-union §3:working 家族 vs waiting_input 家族
        assert_eq!(FineState::Generating.coarse(), AppState::Working);
        assert_eq!(FineState::ToolRunning.coarse(), AppState::Working);
        assert_eq!(FineState::Starting.coarse(), AppState::Working);
        assert_eq!(FineState::Compacting.coarse(), AppState::Working);
        assert_eq!(FineState::IdleReady.coarse(), AppState::WaitingInput);
        assert_eq!(FineState::AwaitingApproval.coarse(), AppState::WaitingInput);
        assert_eq!(FineState::PickerOpen.coarse(), AppState::WaitingInput);
        assert_eq!(FineState::Interrupted.coarse(), AppState::WaitingInput);
        assert_eq!(FineState::ErrorBlocked.coarse(), AppState::WaitingInput);
        assert_eq!(FineState::Exiting.coarse(), AppState::WaitingInput);
        assert_eq!(FineState::AuthRequired.coarse(), AppState::WaitingInput);
    }

    #[test]
    fn create_session_request_defaults_history_limit() {
        // Missing history_limit in JSON must deserialize via #[serde(default)].
        let json = r#"{"taskId":"t","command":"cmd","cwd":"."}"#;
        let req: CreateSessionRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.history_limit, 80000);
        assert_eq!(req.cols, 120);
        assert_eq!(req.rows, 30);
    }

    #[test]
    fn create_session_request_derives_default_for_construction() {
        // Canvas constructs with ..Default::default() to omit history_limit.
        let req = CreateSessionRequest {
            task_id: "t".into(),
            command: "cmd".into(),
            cwd: ".".into(),
            ..Default::default()
        };
        assert_eq!(req.history_limit, 80000);
        assert!(req.args.is_empty());
    }

    #[test]
    fn input_request_default_is_empty() {
        let r = InputRequest::default();
        assert!(r.text.is_none() && r.key.is_none());
    }

    #[test]
    fn char_info_lite_rgb_optional_backcompat() {
        // 老 wire（无 fgRgb/bgRgb）反序列化为 None；有值时 camelCase 往返。
        let old = r#"{"ch":"a","fg":7,"bg":0}"#;
        let c: CharInfoLite = serde_json::from_str(old).unwrap();
        assert!(c.fg_rgb.is_none() && c.bg_rgb.is_none());
        let c2 = CharInfoLite {
            ch: "a".into(),
            fg: 7,
            bg: 0,
            inverse: false,
            underline: false,
            fg_rgb: Some([255, 128, 0]),
            bg_rgb: None,
        };
        let json = serde_json::to_string(&c2).unwrap();
        assert!(json.contains("\"fgRgb\":[255,128,0]"));
        assert!(!json.contains("bgRgb")); // None 不出现在 wire 上
        let back: CharInfoLite = serde_json::from_str(&json).unwrap();
        assert_eq!(back, c2);
    }
}
