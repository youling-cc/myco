//! # msg — myco 消息层 T201 的 SQLite 持久化（vendored from `eval/msg/store-proto`）
//!
//! 来源：`eval/msg/store-proto/src/{lib,error,ids,schema,types,migrate,export}.rs`
//! （2026-10-23 原型，47 项测试全绿）。Step 1 只做**加法**：按模块拆分、把
//! `crate::…` 改成 `crate::msg::…`；DDL、公开 API、测试与语义一行未改。
//! 主 crate 尚未接线（`chat_service` / `p2p_*` / `dsh_share` 均未动）。
//!
//! 对应任务：`eval/vnet/task-messaging.md` **T201**（outbox/inbox/cursors/dedup/conv_log
//! 表 + 迁移脚本）；语义对齐 `eval/msg/channel-proto`（内存版信道原语）与
//! `eval/msg/AUDIT-chat-stack.md` 的五条硬发现。
//!
//! 这个模块只做**持久化**：没有网络、没有加密、没有 UI、不碰 `apps/`。
//! 它把审计指出的四个结构性缺口补掉：
//!
//! | 审计发现 | 本模块的修补 |
//! |---|---|
//! | 发现 2：没有 `seq`、没有 per-device cursor、msgId 不含设备/随机 | `conv_log` 每会话单调 `seq`；`cursors(device_id, conv_id)`；[`new_msg_id`] |
//! | 发现 3：群/多端“任一目标成功即整体成功” | `outbox_targets` 每目标独立 ACK，消息级 ACK = 目标最小值 |
//! | 发现 2：msgId 不唯一 | 全局 `dedup(msg_id)` 去重窗口 + `conv_log UNIQUE(conv_id,msg_id)` 长尾兜底 + 新 id 生成器 |
//! | 审计 §2.5：小灵/申诉本地没有送达/已读 | `notice_state(notice_id, delivered_ms, read_ms)` 幂等 |
//!
//! ## 最小用法
//!
//! ```
//! use myco_home_lib::msg::{AckLevel, MsgKind, MsgRow, Store};
//!
//! let store = Store::open_in_memory().unwrap();
//! let msg = MsgRow::outbound("m-1", "conv-1", MsgKind::Chat, b"hello".to_vec(), 1_000)
//!     .with_targets(["phone"]);
//! store.enqueue(msg).unwrap();
//!
//! store.mark_ack("m-1", AckLevel::Delivered, Some("phone")).unwrap();
//! let rows = store.sync_since("conv-1", "pc", 0).unwrap();
//! assert_eq!(rows.len(), 1);
//! assert_eq!(rows[0].seq, 1);
//! assert_eq!(store.stats().unwrap().delivered, 1);
//! ```
//!
//! ## 约定
//!
//! * **时间一律注入**：需要时间的操作都有显式 `now_ms` 参数（`mark_ack_at`、
//!   `sweep_expired`、`advance_cursor_at`、`stats_at`），不带 `_at` 的便捷版读系统时钟。
//!   这样 TTL/去重窗口在单测里完全确定，也天然抵抗设备时钟偏移（MSG-19）。
//! * **`seq` 只增**：`conv_log` 每会话从 1 开始；吞吐/丢弃造成的空洞是允许的
//!   （与 channel-proto §7.4 同口径）。
//! * **读不推进 cursor**：`sync_since` 是纯快照，消费成功后调用方显式
//!   [`Store::advance_cursor`]，避免“返回即丢失”。
//! * **线程安全**：内部 `Mutex<Connection>`，`Store` 是 `Send + Sync`；文件库用
//!   WAL + `busy_timeout=5s`，多进程读可以并发，写串行。

mod error;
mod export;
mod ids;
mod migrate;
mod schema;
mod store;
mod types;

pub use error::{Error, Result};
pub use export::{
    export_conversation, export_conversation_with_outbox, payload_value, ExportDoc, ExportMessage,
    ExportOutboxItem, EXPORT_FORMAT,
};
pub use ids::{new_msg_id, new_msg_id_now, now_ms, sanitize_device_tail};
pub use migrate::{
    inventory_legacy_dir, migrate_legacy_dir, LegacyInventory, MigrationOptions, MigrationReport,
};
pub use schema::{SCHEMA_SQL, SCHEMA_VERSION};
pub use store::{sqlite_version, Store, StoreConfig};
pub use types::{
    AckLevel, DedupEntry, Direction, EnqueueOutcome, MsgKind, MsgRow, NoticeState, Stats, SyncQuery,
    TargetState, BACKLOG_TARGET, DEFAULT_DEDUP_WINDOW_MS, DEFAULT_TTL_MS, DEVICE_CARD_TTL_MS,
    PRIORITY_P0, PRIORITY_P1, PRIORITY_P2,
};

// 内部原语：迁移器在事务内复用（不对外承诺）。
pub(crate) use store::alloc_seq;
