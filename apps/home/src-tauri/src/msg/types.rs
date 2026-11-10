//! 值类型：消息类别、ACK 层级、方向、行结构、统计口径。
//!
//! 这些类型同时被 SQLite 存储层、迁移器与上层 channel 使用，因此保持
//! “纯数据 + 显式转换” 的风格：不做隐式序列化，数据库里的字符串/整数
//! 由这里集中映射，迁移与同步不会出现两套口径。

use std::fmt;

/// 优先级 P0（系统通知 / 申诉任务），数值最小 = 最先发送。
pub const PRIORITY_P0: i32 = 0;
/// 优先级 P1（普通聊天）。
pub const PRIORITY_P1: i32 = 1;
/// 优先级 P2（控制消息 / 回执）。
pub const PRIORITY_P2: i32 = 2;

/// 默认 TTL：6 小时，对齐旧 `offline_queue.rs:35`。
pub const DEFAULT_TTL_MS: i64 = 6 * 60 * 60 * 1000;
/// 设备群任务卡特例 TTL：7 天，对齐旧 `offline_queue.rs:306-317`。
pub const DEVICE_CARD_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// 去重窗口：7 天（R25 / T203）。
pub const DEFAULT_DEDUP_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
/// R23 的离线积压目标（单会话 1000 条），本 crate 的容量测试按此取值。
pub const BACKLOG_TARGET: usize = 1000;

/// 消息类别（对应 `eval/vnet/task-messaging.md` §4 的 `kind`）。
///
/// 旧 wire kind 到类别的映射见 [`MsgKind::from_wire_kind`]（审计 §5.3）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum MsgKind {
    /// 好友/群正文（`text/image/file/group-msg`）。
    Chat,
    /// 小灵官方通知（`official-notice`）。
    Notice,
    /// 申诉/任务卡（`task-share`）。
    Task,
    /// 控制消息（`msg-receipt`、`friend-*`、`group-*`、`task-accept/done/rename` 等）。
    Control,
}

impl MsgKind {
    /// 存库文本形态（`outbox.kind` / `conv_log.kind`）。
    pub const fn as_str(self) -> &'static str {
        match self {
            MsgKind::Chat => "Chat",
            MsgKind::Notice => "Notice",
            MsgKind::Task => "Task",
            MsgKind::Control => "Control",
        }
    }

    /// 从存库文本解析；大小写不敏感，未知值返回 `None`（调用方决定降级策略）。
    pub fn parse(raw: &str) -> Option<Self> {
        [MsgKind::Chat, MsgKind::Notice, MsgKind::Task, MsgKind::Control]
            .into_iter()
            .find(|kind| kind.as_str().eq_ignore_ascii_case(raw))
    }

    /// 旧 wire kind → 类别。
    ///
    /// 映射依据审计 §5.3：`text/image/file/group-msg→Chat`、`official-notice→Notice`、
    /// `task-share→Task`；`task-accept/task-done/task-rename` 与所有控制类
    /// （`friend-*/group-*/hole-punch-*/share-*/reshare-*/msg-receipt/delegation-notify`）
    /// → `Control`。**未知 kind 一律归 Control**：控制消息不进会话日志展示，
    /// 误归类只会“看不见”而不会污染聊天记录，是更保守的降级方向。
    pub fn from_wire_kind(wire: &str) -> Self {
        match wire {
            "text" | "image" | "file" | "group-msg" => MsgKind::Chat,
            "official-notice" => MsgKind::Notice,
            "task-share" => MsgKind::Task,
            _ => MsgKind::Control,
        }
    }

    /// 默认优先级：系统通知/申诉任务 P0，聊天 P1，控制 P2。
    ///
    /// 依据 task-messaging §4「P0（系统通知/申诉）走独立高优队列」与 §7。
    pub const fn priority_hint(self) -> i32 {
        match self {
            MsgKind::Notice | MsgKind::Task => PRIORITY_P0,
            MsgKind::Chat => PRIORITY_P1,
            MsgKind::Control => PRIORITY_P2,
        }
    }
}

impl fmt::Display for MsgKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// ACK 四级水位，只升不降（channel-proto 的同款语义）。
///
/// 存库为 `INTEGER`：`Accepted=0, Durable=1, Delivered=2, Read=3`。
/// 声明顺序即比较顺序，`Read > Delivered > Durable > Accepted`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum AckLevel {
    /// 本机已接受（落本地库）。
    Accepted,
    /// 对端已持久化。
    Durable,
    /// 对端已送达（per-target 语义）。
    Delivered,
    /// 对端已读。
    Read,
}

impl AckLevel {
    /// 存库整数。
    pub const fn as_i64(self) -> i64 {
        match self {
            AckLevel::Accepted => 0,
            AckLevel::Durable => 1,
            AckLevel::Delivered => 2,
            AckLevel::Read => 3,
        }
    }

    /// 从存库整数还原；越界值按 `Accepted` 保守降级（读旧库不 panic）。
    pub const fn from_i64(raw: i64) -> Self {
        match raw {
            i64::MIN..=0 => AckLevel::Accepted,
            1 => AckLevel::Durable,
            2 => AckLevel::Delivered,
            _ => AckLevel::Read,
        }
    }

    /// 文本形态（小写），用于 README/日志/事件。
    pub const fn as_str(self) -> &'static str {
        match self {
            AckLevel::Accepted => "accepted",
            AckLevel::Durable => "durable",
            AckLevel::Delivered => "delivered",
            AckLevel::Read => "read",
        }
    }

    /// 从文本形态解析（大小写不敏感）。
    pub fn parse(raw: &str) -> Option<Self> {
        [AckLevel::Accepted, AckLevel::Durable, AckLevel::Delivered, AckLevel::Read]
            .into_iter()
            .find(|level| level.as_str().eq_ignore_ascii_case(raw))
    }
}

impl fmt::Display for AckLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 会话日志里的方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
    /// 本机发出。
    Out,
    /// 本机收到。
    In,
}

impl Direction {
    /// 存库文本（`out` / `in`）。
    pub const fn as_str(self) -> &'static str {
        match self {
            Direction::Out => "out",
            Direction::In => "in",
        }
    }

    /// 解析；未知值按 `In` 保守处理（宁可当作收到的，也不把收到的当成自己发的）。
    pub fn parse(raw: &str) -> Self {
        if raw.eq_ignore_ascii_case("out") {
            Direction::Out
        } else {
            Direction::In
        }
    }
}

impl fmt::Display for Direction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 一条消息在存储层的统一视图。
///
/// - `enqueue` / `ingest` 用它写入；
/// - `sync_since` / `pending` 用它读出；
/// - 迁移器构造它之前先做旧字段映射。
///
/// 字段含义里最容易混淆的两个时间：
/// * `created_ms`：会话日志里的消息时间（旧 `ts`，发送端时钟）；
/// * `expires_ms`：**投递队列**的 TTL 边界（不用于会话日志淘汰）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MsgRow {
    /// 全局幂等键（新消息用 [`crate::msg::new_msg_id`] 生成）。
    pub msg_id: String,
    /// 会话 id（旧数据的 did_safe 形态原样保留）。
    pub conv_id: String,
    /// 消息类别。
    pub kind: MsgKind,
    /// 优先级，越小越先发（0=P0）。
    pub priority: i32,
    /// 不透明载荷字节：outbox = 上线字节（旧数据存 envelope JSON），conv_log = 业务 payload JSON。
    pub payload: Vec<u8>,
    /// 会话日志时间（epoch ms）。
    pub created_ms: i64,
    /// 消息级 ACK 水位（聚合值）。
    pub ack_level: AckLevel,
    /// 投递 TTL 边界；`None` 表示不过期。
    pub expires_ms: Option<i64>,
    /// 已尝试投递次数。
    pub attempts: i64,
    /// 会话内序号；0 表示尚未分配（写入前的占位值）。
    pub seq: i64,
    /// 发送设备 did（会话日志的 `fromDevice`）。
    pub sender_device: Option<String>,
    /// 方向；`enqueue` 默认 `Out`，`ingest` 默认 `In`。
    pub direction: Direction,
    /// 目标设备快照（outbox_targets 的行来源；群消息 = 成员设备）。
    pub targets: Vec<String>,
    /// 旧 wire kind（仅迁移数据有值，用于回放/排障）。
    pub wire_kind: Option<String>,
}

impl MsgRow {
    /// 构造一条待发消息（outbox + conv_log 双写）。
    pub fn outbound(
        msg_id: impl Into<String>,
        conv_id: impl Into<String>,
        kind: MsgKind,
        payload: impl Into<Vec<u8>>,
        created_ms: i64,
    ) -> Self {
        Self {
            msg_id: msg_id.into(),
            conv_id: conv_id.into(),
            kind,
            priority: kind.priority_hint(),
            payload: payload.into(),
            created_ms,
            ack_level: AckLevel::Accepted,
            expires_ms: None,
            attempts: 0,
            seq: 0,
            sender_device: None,
            direction: Direction::Out,
            targets: Vec::new(),
            wire_kind: None,
        }
    }

    /// 构造一条已收到的消息（conv_log + inbox 双写）。
    pub fn inbound(
        msg_id: impl Into<String>,
        conv_id: impl Into<String>,
        kind: MsgKind,
        payload: impl Into<Vec<u8>>,
        created_ms: i64,
    ) -> Self {
        Self {
            direction: Direction::In,
            ..Self::outbound(msg_id, conv_id, kind, payload, created_ms)
        }
    }

    /// 覆盖优先级。
    pub fn with_priority(mut self, priority: i32) -> Self {
        self.priority = priority;
        self
    }

    /// 覆盖 TTL 边界。
    pub fn with_expires(mut self, expires_ms: Option<i64>) -> Self {
        self.expires_ms = expires_ms;
        self
    }

    /// 设置目标设备列表。
    pub fn with_targets<I, S>(mut self, targets: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.targets = targets.into_iter().map(Into::into).collect();
        self
    }

    /// 设置发送设备。
    pub fn with_sender_device(mut self, device: impl Into<String>) -> Self {
        self.sender_device = Some(device.into());
        self
    }

    /// 设置 ACK 水位（迁移时用于保留旧 `sendState`）。
    pub fn with_ack(mut self, ack_level: AckLevel) -> Self {
        self.ack_level = ack_level;
        self
    }

    /// 设置方向（迁移时用于保留旧 `dir`）。
    pub fn with_direction(mut self, direction: Direction) -> Self {
        self.direction = direction;
        self
    }

    /// 设置旧 wire kind。
    pub fn with_wire_kind(mut self, wire_kind: impl Into<String>) -> Self {
        self.wire_kind = Some(wire_kind.into());
        self
    }
}

/// 单个投递目标的独立状态（修审计发现 3）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetState {
    /// 消息 id。
    pub msg_id: String,
    /// 目标设备 did。
    pub target_device: String,
    /// 该目标的 ACK 水位（独立于其它目标）。
    pub ack_level: AckLevel,
    /// 首次送达时刻（`Read` 不会清空它）。
    pub delivered_ms: Option<i64>,
}

/// 小灵/申诉通知的本地送达/已读状态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoticeState {
    /// 通知 id（服务端 `ntc-*`，客户端 `msgId = noticeId`）。
    pub notice_id: String,
    /// 本地送达时刻（首次）。
    pub delivered_ms: Option<i64>,
    /// 本地已读时刻（首次）。
    pub read_ms: Option<i64>,
}

/// 去重窗口里的一条记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DedupEntry {
    /// 消息 id。
    pub msg_id: String,
    /// 首次出现的会话。
    pub conv_id: String,
    /// 首次入库时刻。
    pub seen_ms: i64,
}

/// `enqueue` / `ingest` 的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnqueueOutcome {
    /// 新写入，分配了会话序号。
    Inserted {
        /// 分配的会话内序号（从 1 开始）。
        seq: i64,
    },
    /// 命中幂等闸，没有写入；`seq` 是已存在消息的序号（查不到时为 `None`）。
    Duplicate {
        /// 已存在消息的会话序号。
        seq: Option<i64>,
    },
}

/// `sync_batch` 的查询参数。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncQuery {
    /// 会话 id。
    pub conv_id: String,
    /// 设备 id（只影响调用方语义，不自动推进 cursor）。
    pub device_id: String,
    /// 已消费到的 seq，返回 `seq > cursor` 的行。
    pub cursor: i64,
    /// 单次上限；`None` = 全量增量。
    pub limit: Option<usize>,
}

impl SyncQuery {
    /// 构造查询。
    pub fn new(conv_id: impl Into<String>, device_id: impl Into<String>, cursor: i64) -> Self {
        Self {
            conv_id: conv_id.into(),
            device_id: device_id.into(),
            cursor,
            limit: None,
        }
    }

    /// 设置单次上限。
    pub fn with_limit(mut self, limit: usize) -> Self {
        self.limit = Some(limit);
        self
    }
}

/// 存储层统计（对应 channel §4 `channel.state` 的持久化版本）。
///
/// 口径：
/// * `pending/durable/delivered/read` 都是**消息级**（outbox 聚合 ACK）；
/// * `delivered` 统计 `ack_level >= Delivered`，因此已读消息**仍计入已送达**
///   （`Read` 不会抹掉 `Delivered` 这个事实）；
/// * `targets_delivered/targets_total` 是**per-target** 视角，用于暴露群/多端
///   的真实进度（修审计发现 3 的“任一成功即整体成功”）；
/// * `deduped` 是累计被幂等闸挡下的入队次数（持久计数器），`dedup_rows` 是当前
///   去重窗口表大小；`expired` 是累计被 TTL 清掉的条数。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Stats {
    /// 未过期且聚合 ACK < Delivered 的待投递条数。
    pub pending: i64,
    /// 聚合 ACK >= Durable 的条数。
    pub durable: i64,
    /// 聚合 ACK >= Delivered 的条数（含已读）。
    pub delivered: i64,
    /// 聚合 ACK >= Read 的条数。
    pub read: i64,
    /// 累计被幂等闸挡下的入队次数。
    pub deduped: i64,
    /// 当前去重表中的行数。
    pub dedup_rows: i64,
    /// 累计被 TTL 清理的条数。
    pub expired: i64,
    /// 待投递条数按优先级分组（优先级升序 = P0 在最前）。
    pub by_priority: Vec<(i32, i64)>,
    /// outbox 总行数。
    pub total_outbox: i64,
    /// outbox_targets 总行数。
    pub targets_total: i64,
    /// outbox_targets 中 `ack_level >= Delivered` 的行数。
    pub targets_delivered: i64,
}

impl Stats {
    /// 便捷断言/日志用：待投递里最高优先级（数值最小），没有待投递则为 `None`。
    pub fn top_priority(&self) -> Option<i32> {
        self.by_priority.first().map(|(priority, _)| *priority)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_levels_are_ordered_and_roundtrip_through_integers() {
        assert!(AckLevel::Accepted < AckLevel::Durable);
        assert!(AckLevel::Durable < AckLevel::Delivered);
        assert!(AckLevel::Delivered < AckLevel::Read);
        for level in [AckLevel::Accepted, AckLevel::Durable, AckLevel::Delivered, AckLevel::Read] {
            assert_eq!(AckLevel::from_i64(level.as_i64()), level);
            assert_eq!(AckLevel::parse(level.as_str()), Some(level));
        }
        // 越界值保守降级，不 panic
        assert_eq!(AckLevel::from_i64(-7), AckLevel::Accepted);
        assert_eq!(AckLevel::from_i64(99), AckLevel::Read);
    }

    #[test]
    fn wire_kind_mapping_matches_audit_section_5_3() {
        assert_eq!(MsgKind::from_wire_kind("text"), MsgKind::Chat);
        assert_eq!(MsgKind::from_wire_kind("group-msg"), MsgKind::Chat);
        assert_eq!(MsgKind::from_wire_kind("official-notice"), MsgKind::Notice);
        assert_eq!(MsgKind::from_wire_kind("task-share"), MsgKind::Task);
        // 控制类：task-accept/done/rename 不能和 Task 混为一类
        assert_eq!(MsgKind::from_wire_kind("task-accept"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("task-done"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("task-rename"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("msg-receipt"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("friend-request"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("group-kick"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("hole-punch-offer"), MsgKind::Control);
        assert_eq!(MsgKind::from_wire_kind("share-entry-enter"), MsgKind::Control);
        // 未知 kind 保守归 Control
        assert_eq!(MsgKind::from_wire_kind("brand-new-kind"), MsgKind::Control);

        assert_eq!(MsgKind::Notice.priority_hint(), PRIORITY_P0);
        assert_eq!(MsgKind::Task.priority_hint(), PRIORITY_P0);
        assert_eq!(MsgKind::Chat.priority_hint(), PRIORITY_P1);
        assert_eq!(MsgKind::Control.priority_hint(), PRIORITY_P2);
    }

    #[test]
    fn direction_parse_is_conservative() {
        assert_eq!(Direction::parse("out"), Direction::Out);
        assert_eq!(Direction::parse("OUT"), Direction::Out);
        assert_eq!(Direction::parse("in"), Direction::In);
        assert_eq!(Direction::parse("garbage"), Direction::In);
    }
}
