//! # msg_store — T201 生产适配层（Step 2/3，2026-10-23）
//!
//! 设计依据：`eval/msg/DESIGN-t201-production.md`（Step 2 适配层 / Step 3 迁移驱动）、
//! `eval/vnet/task-messaging.md` §4.2 迁移四步、`eval/msg/AUDIT-chat-stack.md` §5 数据映射。
//!
//! 本文件**只做适配**，不含业务逻辑：
//!
//! | 职责 | 说明 |
//! |---|---|
//! | 模式 | `MYCO_MSG_STORE=off\|dual\|shadow\|primary`（默认 `off`，**未接线时零副作用**） |
//! | 路径 | 一账号一库：`<config_dir>/msg_store/<bucket>/msg.sqlite3`（**不进**旧 `chat/<account>/`，审计风险 3） |
//! | 句柄 | 进程内按库缓存 `Arc<Store>`（SQLite 单写者：一账号一写进程，跨进程靠 busy_timeout） |
//! | 迁移 | 逐桶一次性 import：flag 文件 `migrated-v1.json` + 幂等 + 事务（`msg::migrate_legacy_dir` 自带整批回滚） |
//! | 状态 | `status()` 给诊断/验收用（模式、库路径、flag、行数） |
//!
//! **边界**：不碰 `chat_service` / `p2p_*` / `dsh_share`；真正的双写挂点是 Step 4（`conv_append` 末尾）。
//! 本层被接入之前，即使库文件存在也不会被读写（`mode()` 默认 `off`）。

use crate::msg::{self, MigrationOptions, MigrationReport, Store};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// 模式环境变量名。
pub const MODE_ENV: &str = "MYCO_MSG_STORE";
/// 迁移完成标志文件名（放在账号库目录下）。
pub const FLAG_FILE: &str = "migrated-v1.json";
/// 库目录名（相对 config_dir）。
pub const STORE_DIRNAME: &str = "msg_store";
/// 库文件名。
pub const DB_FILENAME: &str = "msg.sqlite3";

/// 消息存储模式（灰度四档，见设计文档 §双写开关）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StoreMode {
    /// 不启用（默认）：行为与旧版完全一致。
    #[default]
    Off,
    /// 双写：新库跟随写入，读仍走旧路径。
    Dual,
    /// 影子读：双写 + 双读对比，**只记录差异、不改变行为**（S3 门禁阶段）。
    Shadow,
    /// 切读：读以新库为主（S4 之后）。
    Primary,
}

impl StoreMode {
    /// 从字符串解析（大小写不敏感）；非法值返回 `None`。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "off" | "0" | "false" | "" => Some(Self::Off),
            "dual" | "1" | "true" => Some(Self::Dual),
            "shadow" => Some(Self::Shadow),
            "primary" => Some(Self::Primary),
            _ => None,
        }
    }

    /// 读环境变量（非法值回落 `Off`，并记一条日志——绝不因配置笔误上写入）。
    pub fn from_env() -> Self {
        match std::env::var(MODE_ENV) {
            Ok(raw) => match Self::parse(&raw) {
                Some(m) => m,
                None => {
                    eprintln!("[msg-store] 非法 {MODE_ENV}={raw:?}，回落 off（不上写入）");
                    Self::Off
                }
            },
            Err(_) => Self::Off,
        }
    }

    /// 稳定字符串（日志/状态面用）。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Dual => "dual",
            Self::Shadow => "shadow",
            Self::Primary => "primary",
        }
    }

    /// 是否写新库（dual/shadow/primary 都写）。
    pub fn writes(&self) -> bool {
        !matches!(self, Self::Off)
    }

    /// 读是否以新库为准（primary）。
    pub fn primary_reads(&self) -> bool {
        matches!(self, Self::Primary)
    }

    /// 是否处于影子读对比阶段（shadow）。
    pub fn shadow_reads(&self) -> bool {
        matches!(self, Self::Shadow)
    }
}

/// 当前模式（默认 `off`）。
pub fn mode() -> StoreMode {
    StoreMode::from_env()
}

/// 库根目录：`<config_dir>/msg_store`。
pub fn store_root() -> PathBuf {
    myco_core::config::config_dir().join(STORE_DIRNAME)
}

/// 桶名清洗：只保留 `[A-Za-z0-9._-]`，其它字节换成 `_`（防路径穿越/非法文件名）。
pub fn sanitize_bucket(bucket: &str) -> String {
    let mut out = String::with_capacity(bucket.len());
    for ch in bucket.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        out.push_str("_empty");
    }
    out
}

/// 账号桶目录：`<root>/<bucket>`。
pub fn bucket_dir(root: &Path, bucket: &str) -> PathBuf {
    root.join(sanitize_bucket(bucket))
}

/// 账号库路径：`<root>/<bucket>/msg.sqlite3`。
pub fn db_path(root: &Path, bucket: &str) -> PathBuf {
    bucket_dir(root, bucket).join(DB_FILENAME)
}

/// 进程内句柄缓存（key = 库绝对路径）。
fn handles() -> &'static Mutex<HashMap<String, Arc<Store>>> {
    static HANDLES: std::sync::LazyLock<Mutex<HashMap<String, Arc<Store>>>> =
        std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
    &HANDLES
}

/// 打开（并缓存）某账号桶的库；目录不存在会创建。
///
/// 同一个库在进程内只会有一个 `Store`（SQLite 单写者约束）；测试/多实例场景
/// 请用 `db_path` + `Store::open` 自行隔离。
pub fn open_bucket(root: &Path, bucket: &str) -> msg::Result<Arc<Store>> {
    let path = db_path(root, bucket);
    let key = path.to_string_lossy().to_string();
    {
        let cache = handles().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = cache.get(&key) {
            return Ok(hit.clone());
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(msg::Error::Io)?;
    }
    let store = Arc::new(Store::open(&path)?);
    let mut cache = handles().lock().unwrap_or_else(|e| e.into_inner());
    Ok(cache.entry(key).or_insert(store).clone())
}

/// 从进程内缓存摘掉某账号库（重建/删除前必须先调用，否则旧句柄占着文件）。
pub(crate) fn close_bucket(root: &Path, bucket: &str) {
    let path = db_path(root, bucket);
    let key = path.to_string_lossy().to_string();
    let mut cache = handles().lock().unwrap_or_else(|e| e.into_inner());
    cache.remove(&key);
}

/// 迁移结果。
#[derive(Debug, Clone)]
pub struct MigrateOutcome {
    /// 本次是否真的执行了迁移（false = flag 已存在，幂等重跑）。
    pub migrated: bool,
    /// 迁移报告（仅 `migrated = true` 时有值）。
    pub report: Option<MigrationReport>,
    /// flag 文件路径。
    pub flag_path: PathBuf,
}

/// 一次性迁移：`legacy_bucket_dir`（旧 `chat/<account>/` 目录）→ 新库。
///
/// * **逐桶**：调用方必须传单个账号桶目录（表无 `account_id`，传 `config_dir()` 会串库——
///   设计文档一页速览第 2 条）。
/// * **幂等**：成功后写 `migrated-v1.json`，重跑直接返回 `migrated=false`。
/// * **原子**：`migrate_legacy_dir` 内部一个事务，失败一条不落；失败不写 flag。
pub fn migrate_bucket_once(
    root: &Path,
    bucket: &str,
    legacy_bucket_dir: &Path,
    device_id: &str,
    now_ms: i64,
) -> msg::Result<MigrateOutcome> {
    let dir = bucket_dir(root, bucket);
    std::fs::create_dir_all(&dir).map_err(msg::Error::Io)?;
    let flag_path = dir.join(FLAG_FILE);
    if flag_path.is_file() {
        return Ok(MigrateOutcome {
            migrated: false,
            report: None,
            flag_path,
        });
    }
    let store = open_bucket(root, bucket)?;
    let opts = MigrationOptions::new(device_id, now_ms);
    let report = msg::migrate_legacy_dir(&*store, legacy_bucket_dir, &opts)?;
    // 先写临时文件再 rename：避免半截 flag 让下次误判“已迁移”。
    let payload = serde_json::json!({
        "version": 1,
        "migratedAt": now_ms,
        "deviceId": device_id,
        "legacyDir": legacy_bucket_dir.to_string_lossy(),
        "db": db_path(root, bucket).to_string_lossy(),
        "report": {
            "buckets": report.inventory.buckets,
            "files": report.inventory.files,
            "outboxItems": report.inventory.outbox_items,
            "outboxTargets": report.inventory.outbox_targets,
            "jsonlRows": report.inventory.jsonl_rows,
            "outboxInserted": report.outbox_inserted,
            "outboxTargetsInserted": report.outbox_targets_inserted,
            "convLogInserted": report.conv_log_inserted,
            "inboxInserted": report.inbox_inserted,
            "dedupInserted": report.dedup_inserted,
            "cursorsWritten": report.cursors_written,
            "skippedDuplicates": report.skipped_duplicates,
        },
    });
    let tmp = flag_path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&payload).map_err(|e| {
        msg::Error::Invalid(format!("flag 序列化失败: {e}"))
    })?)
    .map_err(msg::Error::Io)?;
    std::fs::rename(&tmp, &flag_path).map_err(msg::Error::Io)?;
    Ok(MigrateOutcome {
        migrated: true,
        report: Some(report),
        flag_path,
    })
}

/// 诊断快照（状态面/验收用）：模式、路径、flag、行数。
pub fn status(root: &Path, bucket: &str) -> msg::Result<serde_json::Value> {
    let m = mode();
    let db = db_path(root, bucket);
    let flag = bucket_dir(root, bucket).join(FLAG_FILE);
    let mut out = serde_json::json!({
        "mode": m.as_str(),
        "root": root.to_string_lossy(),
        "bucket": sanitize_bucket(bucket),
        "db": db.to_string_lossy(),
        "dbExists": db.is_file(),
        "migrated": flag.is_file(),
    });
    if db.is_file() {
        let store = open_bucket(root, bucket)?;
        let stats = store.stats()?;
        out["stats"] = serde_json::json!({
            "pending": stats.pending,
            "durable": stats.durable,
            "delivered": stats.delivered,
            "read": stats.read,
            "deduped": stats.deduped,
            "expired": stats.expired,
        });
    }
    if flag.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&flag) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                out["migratedAt"] = v.get("migratedAt").cloned().unwrap_or_default();
                out["report"] = v.get("report").cloned().unwrap_or_default();
            }
        }
    }
    Ok(out)
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 4a：旧 conv_append → 新库镜像（纯映射 + best-effort 写入）
// ─────────────────────────────────────────────────────────────────────────────

/// 旧会话 jsonl 里的一条消息 JSON → `MsgRow`（**纯函数**，无 IO，便于单测）。
///
/// 映射依据审计 §5.3：
/// * `msgId` 必填（空 → `None`，调用方跳过，不制造假 id）；
/// * `kind` 走 [`msg::MsgKind::from_wire_kind`]（未知 kind → Control，保守）；
/// * `payload` 原样序列化为业务 payload 字节（与迁移器同口径）；
/// * `dir == "in"` → 入向（`inbound`，落 conv_log + inbox），否则出向（outbox）；
/// * `sendState` 只做**保守**映射（审计发现 3：不把"任一目标送达"冒充整体 delivered）。
pub fn row_from_legacy_value(conv_id: &str, msg: &serde_json::Value) -> Option<msg::MsgRow> {
    use msg::{AckLevel, Direction, MsgKind, MsgRow};
    let msg_id = msg.get("msgId").and_then(|v| v.as_str())?.trim().to_string();
    if msg_id.is_empty() {
        return None;
    }
    let created_ms = msg
        .get("ts")
        .and_then(|v| v.as_i64())
        .unwrap_or_else(msg::now_ms);
    let wire = msg.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let kind = MsgKind::from_wire_kind(wire);
    let payload = msg.get("payload").cloned().unwrap_or(serde_json::Value::Null);
    let payload_bytes = serde_json::to_vec(&payload).ok()?;
    let is_in = msg.get("dir").and_then(|v| v.as_str()) == Some("in");
    let mut row = if is_in {
        MsgRow::inbound(&msg_id, conv_id, kind, payload_bytes, created_ms)
    } else {
        MsgRow::outbound(&msg_id, conv_id, kind, payload_bytes, created_ms)
    };
    row.sender_device = msg
        .get("fromDevice")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    row.wire_kind = if wire.is_empty() { None } else { Some(wire.to_string()) };
    // 保守水位：只有明确 deliveredCount>0 且 sendState=delivered 才抬到 Delivered，
    // 其余一律 Accepted（真实 per-target 由 T202 写入，见设计文档 §2.3 D8）。
    let delivered_count = msg
        .get("deliveredCount")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    row.ack_level = match msg.get("sendState").and_then(|v| v.as_str()) {
        Some("delivered") if delivered_count > 0 => AckLevel::Delivered,
        _ => AckLevel::Accepted,
    };
    debug_assert!(
        row.direction == Direction::In || row.direction == Direction::Out,
        "direction 只有两种"
    );
    Some(row)
}

/// 当前活动账号的 chat 桶名（与 `chat_service::chat_dir()` 最后一段一致，
/// 从而旧桶与库桶一一对应；`msg_store` 自身不解析账号 DID）。
/// chat_service::chat_dir 的变体桥（2026-10-25 CLI 构建修复）：CLI 变体不编译
/// chat_service——按同一落盘口径（config_dir()/chat/did_<safe 账号>）兜底，
/// 保证 msg_store 迁移/重建在 headless 也能找到同一个桶。
#[cfg(feature = "gui")]
pub(crate) fn legacy_chat_dir() -> std::path::PathBuf {
    crate::chat_service::chat_dir()
}

#[cfg(not(feature = "gui"))]
pub(crate) fn legacy_chat_dir() -> std::path::PathBuf {
    let acc = myco_core::identity::account_did_storage().unwrap_or_else(|| "_guest".to_string());
    let bucket = myco_core::config::config_dir()
        .join("chat")
        .join(acc.replace([':', '/'], "_"));
    let _ = std::fs::create_dir_all(&bucket);
    bucket
}

fn current_bucket() -> String {
    legacy_chat_dir()
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string())
}

/// Step 4a：把**已落旧 jsonl** 的一条消息镜像进新库。
///
/// * 只有 [`mode().writes()`] 才动作（默认 `off` → 完全不碰磁盘）；
/// * best-effort：任何失败只打日志，**绝不改变旧路径结果**（审计风险 3：双写失败只告警）；
/// * 幂等：同一 `msgId` 重复镜像由 `dedup`/`conv_log UNIQUE` 兜住（`Duplicate` 视为成功）。
pub fn mirror_append(conv_id: &str, msg: &serde_json::Value) {
    if !mode().writes() {
        return;
    }
    let Some(row) = row_from_legacy_value(conv_id, msg) else {
        return;
    };
    let root = store_root();
    let bucket = current_bucket();
    let is_notice = row.kind == msg::MsgKind::Notice && row.direction == msg::Direction::In;
    let msg_id = row.msg_id.clone();
    if let Err(e) = mirror_row_to(&root, &bucket, row) {
        eprintln!("[msg-store] 双写失败（旧路径不受影响）conv={conv_id}: {e}");
        return;
    }
    // S4：小灵/申诉通知本地状态（审计 §2.5：本地此前没有送达/已读字段）。
    // 入向 Notice 落库即登记 + delivered（客户端"已收到"独立于服务端三态，
    // 服务端 delivered 只在 /official/pending 拉取时置位——见 DESIGN-s4 §5）。
    if is_notice {
        if let Err(e) = mark_notice_delivered_in(&root, &bucket, &msg_id, conv_id) {
            eprintln!("[msg-store] 通知 delivered 落库失败（不影响旧路径）{msg_id}: {e}");
        }
    }
}

/// S4：登记通知 + 标记 delivered（可测内核）。
pub(crate) fn mark_notice_delivered_in(
    root: &Path,
    bucket: &str,
    notice_id: &str,
    conv_id: &str,
) -> msg::Result<()> {
    let store = open_bucket(root, bucket)?;
    let now = msg::now_ms();
    store.enqueue_notice_at(notice_id, conv_id, now)?;
    store.mark_notice_delivered(notice_id, now)
}

/// S4：打开「小灵」会话即批量标记本地已读（服务端 `/official/read` 仍是权威，本地是副本）。
pub(crate) fn mark_notice_read_in(
    root: &Path,
    bucket: &str,
    conv_hint: &str,
    notice_ids: &[String],
) -> msg::Result<usize> {
    let store = open_bucket(root, bucket)?;
    let now = msg::now_ms();
    let conv = if conv_hint.is_empty() { "official" } else { conv_hint };
    let mut n = 0usize;
    for id in notice_ids {
        if id.is_empty() {
            continue;
        }
        // 不存在则先登记（历史通知可能早于本库迁移），再标已读；
        // 未登记过的历史通知也要能标（notice_state 只需 notice_id）。
        let _ = store.enqueue_notice_at(id, conv, now);
        if store.mark_notice_read(id, now).is_ok() {
            n += 1;
        }
    }
    Ok(n)
}

/// 生产入口：本地标记通知已读（mode=off 时零动作；best-effort）。
pub fn mark_notice_read_local(conv_id: &str, notice_ids: &[String]) {
    if !mode().writes() || notice_ids.is_empty() {
        return;
    }
    let root = store_root();
    let bucket = current_bucket();
    match mark_notice_read_in(&root, &bucket, conv_id, notice_ids) {
        Ok(n) => eprintln!("[msg-store] 本地已读标记 {n}/{}", notice_ids.len()),
        Err(e) => eprintln!("[msg-store] 本地已读标记失败（不影响服务端回执）: {e}"),
    }
}

/// 按方向把一行镜像进指定库：**出向 → conv_log（不建 outbox）**；入向 → conv_log+inbox。
///
/// 出向为什么不建 outbox：旧栈投递成功不进 outbox，镜像若造出"待发"行会与旧侧对不上
/// （2026-10-23 真实运行发现），且 store.outbox 在 S2 不是重发源（设计 §2.3 D8）。
/// 抽成独立函数是为了**可测**：单测用临时目录验证分派，不必改进程级环境变量。
pub(crate) fn mirror_row_to(
    store_root: &Path,
    bucket: &str,
    row: msg::MsgRow,
) -> msg::Result<()> {
    let store = open_bucket(store_root, bucket)?;
    if row.direction == msg::Direction::In {
        store.ingest(row).map(|_| ())
    } else {
        store.conv_mirror(row).map(|_| ())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5：启动引导（活动账号一次性迁移；mode=off 时零动作）
// ─────────────────────────────────────────────────────────────────────────────

/// 启动引导的**可测内核**：给定 root/bucket/旧桶目录/设备，做一次幂等迁移。
///
/// 返回一句话结果（写日志/状态面用）。任何失败都**不 panic、不阻塞**——
/// 消息库是加速层，旧 jsonl 才是权威（设计文档回滚方案：切回 off 即可）。
pub(crate) fn bootstrap_for(
    root: &Path,
    bucket: &str,
    legacy_bucket_dir: &Path,
    device_id: &str,
    now_ms: i64,
) -> String {
    if !legacy_bucket_dir.is_dir() {
        return format!("msg-store 跳过迁移（无旧数据）bucket={bucket}");
    }
    match migrate_bucket_once(root, bucket, legacy_bucket_dir, device_id, now_ms) {
        Ok(outcome) if outcome.migrated => {
            let r = outcome.report.as_ref();
            let (conv, outbox, inbox, skipped) = r
                .map(|r| {
                    (
                        r.conv_log_inserted,
                        r.outbox_inserted,
                        r.inbox_inserted,
                        r.skipped_duplicates,
                    )
                })
                .unwrap_or((0, 0, 0, 0));
            format!(
                "msg-store 迁移完成 bucket={bucket} conv_log={conv} outbox={outbox} inbox={inbox} skipped={skipped}"
            )
        }
        Ok(_) => format!("msg-store 已迁移过（flag 存在，幂等跳过）bucket={bucket}"),
        Err(e) => {
            eprintln!("[msg-store] 启动迁移失败（不阻塞启动，旧路径不受影响）: {e}");
            format!("msg-store 迁移失败 bucket={bucket}: {e}")
        }
    }
}

/// 强制重建活动账号库（运维入口：清理旧 jsonl 后让库与旧侧重新对齐）。
///
/// 为什么需要显式入口：自动对账只补"缺失"、不会删"多余"——2026-10-23 用户清理测试会话
/// （旧 jsonl 删行）后，库比旧侧多 257 行，需要"删库→按当前 jsonl 重迁"才能收敛。
pub fn force_rebuild_active() -> String {
    if !mode().writes() {
        return format!("msg-store mode={}（不重建）", mode().as_str());
    }
    let legacy = legacy_chat_dir();
    let bucket = legacy
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let device = myco_core::identity::device_identity()
        .map(|(did, _)| did)
        .unwrap_or_else(|_| "unknown-device".to_string());
    if !legacy.is_dir() {
        return format!("msg-store 重建跳过（无旧数据）bucket={bucket}");
    }
    let log = rebuild_for(&store_root(), &bucket, &legacy, &device, msg::now_ms());
    eprintln!("[msg-store] {log}");
    log
}

/// 启动对账：把旧 jsonl 里"新库还没有"的消息补镜像（dual 关闭窗口/漏写/切读前回填）。
///
/// 为什么需要：2026-10-23 实测——一次非 dual 重启期间旧 jsonl 多写了 1 条，
/// 新库没有；重启回 dual 后剩余差异不会自愈。启动对账把差异补齐（幂等，只补缺失）。
/// 返回一句话统计（日志/状态面用）。
pub(crate) fn backfill_for(root: &Path, bucket: &str, legacy_bucket_dir: &Path) -> (String, usize) {
    if !legacy_bucket_dir.is_dir() {
        return (format!("msg-store 对账跳过（无旧数据）bucket={bucket}"), 0);
    }
    let store = match open_bucket(root, bucket) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[msg-store] 对账打开库失败（跳过）: {e}");
            return (format!("msg-store 对账失败 bucket={bucket}: {e}"), 0);
        }
    };
    let mut scanned = 0usize;
    let mut added = 0usize;
    let mut bad = 0usize;
    let entries = match std::fs::read_dir(legacy_bucket_dir) {
        Ok(it) => it,
        Err(e) => return (format!("msg-store 对账读目录失败 bucket={bucket}: {e}"), 0),
    };
    let mut convs: Vec<std::path::PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
        .collect();
    convs.sort();
    for path in convs {
        let conv_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if conv_id.is_empty() {
            continue;
        }
        let body = match std::fs::read_to_string(&path) {
            Ok(b) => b,
            Err(_) => {
                bad += 1;
                continue;
            }
        };
        for line in body.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                bad += 1;
                continue;
            };
            scanned += 1;
            let Some(row) = row_from_legacy_value(&conv_id, &value) else {
                bad += 1;
                continue;
            };
            match store.contains_msg(&row.msg_id) {
                Ok(true) => {}
                Ok(false) => match mirror_row_to(root, bucket, row) {
                    Ok(()) => added += 1,
                    Err(e) => {
                        bad += 1;
                        eprintln!("[msg-store] 对账补写失败 {conv_id}: {e}");
                    }
                },
                Err(e) => {
                    bad += 1;
                    eprintln!("[msg-store] 对账查询失败 {conv_id}: {e}");
                }
            }
        }
    }
    // outbox 对账：以旧侧 outbox.json 现存待发集合为准清陈旧 pending
    // （迁移快照后旧栈送达并清账，DB 不跟随会积累假 pending——真机实测 0/30）
    let mut ob_removed = 0usize;
    if let Ok(store) = open_bucket(root, bucket) {
        let mut keep: Vec<String> = Vec::new();
        if let Ok(raw) = std::fs::read_to_string(legacy_bucket_dir.join("outbox.json")) {
            if let Ok(arr) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(list) = arr.as_array() {
                    for it in list {
                        if let Some(id) = it.get("msgId").and_then(|v| v.as_str()) {
                            keep.push(id.to_string());
                        }
                    }
                }
            }
        }
        match store.reconcile_outbox(&keep) {
            Ok(n) => ob_removed = n,
            Err(e) => eprintln!("[msg-store] outbox 对账失败: {e}"),
        }
    }
    (
        format!("msg-store 对账完成 bucket={bucket} scanned={scanned} added={added} bad={bad} outbox_removed={ob_removed}"),
        added,
    )
}

/// 全量重建：删库 + 重新迁移（**顺序正确**——迁移按旧 `(ts,msgId)` 排序赋 seq）。
///
/// 为什么需要：对账"追加补写"只能补内容，补不了位置——2026-10-23 实测两条消息在旧侧
/// 按 ts 排在中间，追加到 seq 尾部后影子读报"乱序 2"。DB 是派生数据且迁移 1253 条仅 0.09s，
/// 发现漏镜像时直接重建最稳。
pub(crate) fn rebuild_for(
    root: &Path,
    bucket: &str,
    legacy_bucket_dir: &Path,
    device_id: &str,
    now_ms: i64,
) -> String {
    close_bucket(root, bucket);
    let dir = bucket_dir(root, bucket);
    for name in ["msg.sqlite3", "msg.sqlite3-wal", "msg.sqlite3-shm", FLAG_FILE] {
        let p = dir.join(name);
        if !p.exists() {
            continue;
        }
        // 重试：其他线程/句柄释放需要一点时间（Windows 文件锁）
        let mut last_err = None;
        let mut ok = false;
        for _ in 0..30 {
            match std::fs::remove_file(&p) {
                Ok(()) => {
                    ok = true;
                    break;
                }
                Err(e) => {
                    last_err = Some(e);
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
            }
        }
        if !ok {
            return format!(
                "msg-store 重建失败（删 {name}: {}）bucket={bucket}",
                last_err.map(|e| e.to_string()).unwrap_or_default()
            );
        }
    }
    let boot = bootstrap_for(root, bucket, legacy_bucket_dir, device_id, now_ms);
    let (bf, _added) = backfill_for(root, bucket, legacy_bucket_dir);
    format!("msg-store 重建完成 bucket={bucket} | {boot} | {bf}")
}

/// 启动引导（生产入口）：mode≠off 时对**活动账号**做一次性迁移。
///
/// 由 `lib.rs` 在后台线程调用（大账号迁移可能耗时，不能卡启动）。
pub fn bootstrap_active_account() -> String {
    let m = mode();
    if !m.writes() {
        return format!("msg-store mode={}（跳过）", m.as_str());
    }
    let legacy = legacy_chat_dir();
    let bucket = legacy
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let device = myco_core::identity::device_identity()
        .map(|(did, _)| did)
        .unwrap_or_else(|_| "unknown-device".to_string());
    // 运维兜底：MYCO_MSG_FORCE_REBUILD=1 → 本次启动强制重建（删库重迁，顺序正确）
    if std::env::var("MYCO_MSG_FORCE_REBUILD").map(|v| v == "1").unwrap_or(false) {
        let log = rebuild_for(&store_root(), &bucket, &legacy, &device, msg::now_ms());
        eprintln!("[msg-store] 启动强制重建: {log}");
        return format!("msg-store 启动强制重建 → {log}");
    }
    let boot = bootstrap_for(&store_root(), &bucket, &legacy, &device, msg::now_ms());
    // 迁移之后必须对账：非 dual 窗口漏写的消息不会自愈（2026-10-23 实测 diff=1）
    let (backfill, added) = backfill_for(&store_root(), &bucket, &legacy);
    if added > 0 {
        // 追加补写会破坏"旧侧 ts 顺序 ↔ 新库 seq"的对应（实测乱序 2 条）→ 全量重建
        let rebuilt = rebuild_for(&store_root(), &bucket, &legacy, &device, msg::now_ms());
        return format!("{boot} | {backfill} | 发现 {added} 条漏镜像→{rebuilt}");
    }
    format!("{boot} | {backfill}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 独立临时目录（并行测试安全）。
    fn temp_root(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "myco-msg-store-{tag}-{}-{}",
            std::process::id(),
            nanos
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 造一个最小旧账号桶（outbox.json + 1 个会话 jsonl）。
    fn make_legacy_bucket(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        let outbox = r#"[
  {
    "msgId": "m-legacy-0001-0",
    "convId": "did_youling_zfriend1",
    "targets": ["did:youling:zfriend1"],
    "envelope": {
      "msgId": "m-legacy-0001-0",
      "from": "did:youling:zaabbcc",
      "fromName": "阿宝",
      "fromDevice": "did:youling:zdevpc",
      "to": "did:youling:zfriend1",
      "kind": "text",
      "payload": { "text": "hello one" },
      "ts": 1790000000100
    },
    "ts": 1790000000123,
    "attempts": 2,
    "status": "pending",
    "lastError": "",
    "sendState": "sent"
  }
]"#;
        std::fs::write(dir.join("outbox.json"), outbox).unwrap();
        let jsonl = concat!(
            r#"{"msgId":"m-f1-1001","from":"did:youling:zaabbcc","to":"did:youling:zfriend1","kind":"text","payload":{"text":"hello one"},"ts":1790000000100,"dir":"out","fromDevice":"did:youling:zdevpc","sendState":"sent"}"#,
            "\n",
            r#"{"msgId":"m-f1-1002","from":"did:youling:zfriend1","to":"did:youling:zaabbcc","kind":"text","payload":{"text":"reply two"},"ts":1790000000200,"dir":"in","fromDevice":"did:youling:zfriend1-phone","fromName":"小一"}"#,
            "\n"
        );
        std::fs::write(dir.join("did_youling_zfriend1.jsonl"), jsonl).unwrap();
    }

    #[test]
    fn mode_parse_is_strict_and_default_off() {
        assert_eq!(StoreMode::parse("off"), Some(StoreMode::Off));
        assert_eq!(StoreMode::parse("DUAL"), Some(StoreMode::Dual));
        assert_eq!(StoreMode::parse("shadow"), Some(StoreMode::Shadow));
        assert_eq!(StoreMode::parse("primary"), Some(StoreMode::Primary));
        assert_eq!(StoreMode::parse("bogus"), None);
        assert_eq!(StoreMode::default(), StoreMode::Off);
        assert!(!StoreMode::Off.writes());
        assert!(StoreMode::Dual.writes() && StoreMode::Shadow.writes() && StoreMode::Primary.writes());
        assert!(StoreMode::Primary.primary_reads());
        assert!(StoreMode::Shadow.shadow_reads());
    }

    #[test]
    fn bucket_paths_are_sanitised_and_outside_legacy_chat_dir() {
        let root = Path::new("C:/cfg/msg_store");
        assert_eq!(sanitize_bucket("did:youling:abc"), "did_youling_abc");
        assert_eq!(sanitize_bucket("../etc/passwd"), ".._etc_passwd");
        assert_eq!(sanitize_bucket(""), "_empty");
        let db = db_path(root, "did:youling:abc");
        assert!(db.ends_with("msg.sqlite3"), "db={}", db.display());
        assert!(db.to_string_lossy().contains("did_youling_abc"));
    }

    #[test]
    fn open_bucket_is_cached_and_creates_dirs() {
        let root = temp_root("open");
        let a = open_bucket(&root, "acct-a").unwrap();
        let b = open_bucket(&root, "acct-a").unwrap();
        assert!(Arc::ptr_eq(&a, &b), "同一库必须复用同一个 Store");
        assert!(db_path(&root, "acct-a").is_file());
        let c = open_bucket(&root, "acct-b").unwrap();
        assert!(!Arc::ptr_eq(&a, &c));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_once_imports_legacy_bucket_then_is_idempotent() {
        let root = temp_root("migrate");
        let legacy = root.join("legacy-chat").join("did_youling_zaabbcc");
        make_legacy_bucket(&legacy);

        let r1 = migrate_bucket_once(&root, "did_youling_zaabbcc", &legacy, "dev-test", 1790000009999)
            .unwrap();
        assert!(r1.migrated, "首次必须真的迁移");
        let rep = r1.report.expect("首次迁移要有报告");
        assert_eq!(rep.outbox_inserted, 1, "outbox 应插入 1 条: {rep:?}");
        assert_eq!(rep.outbox_targets_inserted, 1, "targets 应插入 1 条: {rep:?}");
        assert_eq!(rep.conv_log_inserted, 2, "jsonl 应插入 2 条: {rep:?}");
        assert!(r1.flag_path.is_file(), "成功后必须写 flag");

        // 幂等：重跑不写、不报错
        let r2 = migrate_bucket_once(&root, "did_youling_zaabbcc", &legacy, "dev-test", 1790000010000)
            .unwrap();
        assert!(!r2.migrated);
        assert!(r2.report.is_none());

        // 库内容可读：outbox/targets 行已写入，conv_log 可读取
        // 注意：夹具 ts 是 2026-10 附近的固定值，若已早于当前时钟会被 TTL 排除出 pending，
        // 所以这里断言"总行数/历史行数"而不是 pending（TTL 行为本身由 msg::tests 覆盖）。
        let store = open_bucket(&root, "did_youling_zaabbcc").unwrap();
        let stats = store.stats().unwrap();
        assert_eq!(stats.total_outbox, 1, "outbox 应有 1 行: {stats:?}");
        assert_eq!(stats.targets_total, 1, "outbox_targets 应有 1 行: {stats:?}");
        let rows = store.conv_log_rows("did_youling_zfriend1").unwrap();
        assert_eq!(rows.len(), 2, "conv_log 应有 2 行: {rows:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_failure_leaves_no_flag_and_no_partial_rows() {
        let root = temp_root("migrate-bad");
        let legacy = root.join("legacy-chat").join("bad-bucket");
        std::fs::create_dir_all(&legacy).unwrap();
        // outbox.json 语法错误 → 整个迁移事务回滚
        std::fs::write(legacy.join("outbox.json"), "{ not json ]").unwrap();

        let err = migrate_bucket_once(&root, "bad-bucket", &legacy, "dev-test", 1).unwrap_err();
        let _ = err;
        let flag = bucket_dir(&root, "bad-bucket").join(FLAG_FILE);
        assert!(!flag.is_file(), "失败绝不能写 flag");
        let db = db_path(&root, "bad-bucket");
        if db.is_file() {
            let store = Store::open(&db).unwrap();
            let stats = store.stats().unwrap();
            assert_eq!(stats.total_outbox, 0, "失败必须零残留（outbox）: {stats:?}");
            assert_eq!(stats.targets_total, 0, "失败必须零残留（targets）: {stats:?}");
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_value_maps_outbound_chat_row() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"m-1","from":"a","to":"b","kind":"text","payload":{"text":"hi"},"ts":1790000000100,"dir":"out","fromDevice":"dev-pc","sendState":"sent"}"#,
        )
        .unwrap();
        let row = row_from_legacy_value("conv-1", &v).expect("应能映射");
        assert_eq!(row.msg_id, "m-1");
        assert_eq!(row.conv_id, "conv-1");
        assert_eq!(row.kind, msg::MsgKind::Chat);
        assert_eq!(row.direction, msg::Direction::Out);
        assert_eq!(row.sender_device.as_deref(), Some("dev-pc"));
        assert_eq!(row.wire_kind.as_deref(), Some("text"));
        assert_eq!(row.ack_level, msg::AckLevel::Accepted);
        assert_eq!(row.created_ms, 1790000000100);
        let payload: serde_json::Value = serde_json::from_slice(&row.payload).unwrap();
        assert_eq!(payload["text"], "hi");
    }

    #[test]
    fn legacy_value_maps_inbound_and_notice_priority() {
        let v: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"n-1","from":"xiaoling","to":"a","kind":"official-notice","payload":{"card":{"title":"通知"}},"ts":1790000000200,"dir":"in"}"#,
        )
        .unwrap();
        let row = row_from_legacy_value("official", &v).expect("应能映射");
        assert_eq!(row.kind, msg::MsgKind::Notice);
        assert_eq!(row.direction, msg::Direction::In);
        assert_eq!(row.priority, 0, "Notice 必须 P0");
    }

    #[test]
    fn legacy_value_rejects_empty_msg_id_and_maps_delivered_conservatively() {
        let empty: serde_json::Value =
            serde_json::from_str(r#"{"msgId":"","kind":"text","ts":1}"#).unwrap();
        assert!(row_from_legacy_value("c", &empty).is_none());

        // delivered 但 deliveredCount=0 → 不抬水位（审计发现 3）
        let v: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"m-2","kind":"text","ts":2,"dir":"out","sendState":"delivered","deliveredCount":0}"#,
        )
        .unwrap();
        assert_eq!(
            row_from_legacy_value("c", &v).unwrap().ack_level,
            msg::AckLevel::Accepted
        );
        let v2: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"m-3","kind":"text","ts":3,"dir":"out","sendState":"delivered","deliveredCount":2}"#,
        )
        .unwrap();
        assert_eq!(
            row_from_legacy_value("c", &v2).unwrap().ack_level,
            msg::AckLevel::Delivered
        );
    }

    #[test]
    fn mirror_row_to_persists_outbound_and_inbound() {
        let root = temp_root("mirror");
        let out: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"m-out","kind":"text","payload":{"text":"hi"},"ts":1790000000100,"dir":"out","fromDevice":"dev-pc"}"#,
        )
        .unwrap();
        let inb: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"m-in","kind":"text","payload":{"text":"yo"},"ts":1790000000200,"dir":"in","fromDevice":"dev-phone"}"#,
        )
        .unwrap();
        let row_out = row_from_legacy_value("conv-m", &out).unwrap();
        let row_in = row_from_legacy_value("conv-m", &inb).unwrap();
        mirror_row_to(&root, "acct-m", row_out).unwrap();
        mirror_row_to(&root, "acct-m", row_in).unwrap();

        let store = open_bucket(&root, "acct-m").unwrap();
        let stats = store.stats().unwrap();
        // 出向只写 conv_log，不建 outbox（旧栈投递成功不进 outbox，镜像不得造假 pending）
        assert_eq!(stats.total_outbox, 0, "出向不应进 outbox: {stats:?}");
        let rows = store.conv_log_rows("conv-m").unwrap();
        assert_eq!(rows.len(), 2, "出向+入向都应进 conv_log: {rows:?}");
        // 幂等：同一行再镜像一次不新增
        let dup: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"m-out","kind":"text","payload":{"text":"hi"},"ts":1790000000100,"dir":"out","fromDevice":"dev-pc"}"#,
        )
        .unwrap();
        mirror_row_to(&root, "acct-m", row_from_legacy_value("conv-m", &dup).unwrap()).unwrap();
        assert_eq!(store.stats().unwrap().total_outbox, 0, "重复镜像不得新增 outbox 行");
        assert_eq!(
            store.conv_log_rows("conv-m").unwrap().len(),
            2,
            "重复镜像不得新增 conv_log 行"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn bootstrap_for_migrates_once_then_is_noop_and_tolerates_missing_legacy() {
        let root = temp_root("bootstrap");
        let legacy = root.join("legacy-chat").join("acct-b");
        make_legacy_bucket(&legacy);

        let first = bootstrap_for(&root, "acct-b", &legacy, "dev-b", 1790000005000);
        assert!(first.contains("迁移完成"), "首次应迁移: {first}");
        assert!(db_path(&root, "acct-b").is_file());

        let second = bootstrap_for(&root, "acct-b", &legacy, "dev-b", 1790000006000);
        assert!(second.contains("已迁移过"), "第二次应幂等跳过: {second}");

        // 旧目录不存在 → 跳过而不是报错（新账号首次启动的常态）
        let missing = bootstrap_for(&root, "acct-x", &root.join("nope"), "dev-b", 1);
        assert!(missing.contains("跳过迁移"), "无旧数据应跳过: {missing}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 端到端（隔离配置目录）：走生产入口 `bootstrap_active_account` + `mirror_append`，
    /// 验证「MYCO_MSG_STORE=dual → 启动迁移 → 双写落库」整条链路。
    ///
    /// `#[ignore]`：改进程级环境变量，必须串行跑（`-- --ignored --test-threads=1`）。
    #[test]
    #[ignore = "修改进程环境变量，需 --test-threads=1 串行执行"]
    fn e2e_isolated_config_migrates_and_mirrors() {
        let root = temp_root("e2e");
        // 旧数据放在隔离配置目录的 chat/<bucket>/ 下；bucket 由 chat_dir() 求值，
        // 无身份时回落 `_guest`（did_safe 形态）。先探测一次拿真实桶名。
        let prev_cfg = std::env::var("MYCO_CONFIG_DIR").ok();
        let prev_mode = std::env::var("MYCO_MSG_STORE").ok();
        std::env::set_var("MYCO_CONFIG_DIR", &root);
        std::env::set_var("MYCO_MSG_STORE", "dual");

        let legacy_dir = crate::chat_service::chat_dir();
        let bucket = legacy_dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "default".to_string());
        make_legacy_bucket(&legacy_dir);

        let log = bootstrap_active_account();
        assert!(log.contains("迁移完成"), "启动引导应完成迁移: {log}");
        let db = db_path(&store_root(), &bucket);
        assert!(db.is_file(), "库文件应存在: {}", db.display());

        // 双写入口（生产同款）：一条出向消息
        let msg: serde_json::Value = serde_json::from_str(
            r#"{"msgId":"e2e-out-1","kind":"text","payload":{"text":"e2e hello"},"ts":1790000099999,"dir":"out","fromDevice":"dev-e2e"}"#,
        )
        .unwrap();
        mirror_append("did_youling_zfriend1", &msg);
        let store = open_bucket(&store_root(), &bucket).unwrap();
        let stats = store.stats().unwrap();
        assert!(stats.total_outbox >= 2, "迁移 1 条 + 双写 1 条，outbox 应 >=2: {stats:?}");
        let rows = store.conv_log_rows("did_youling_zfriend1").unwrap();
        assert!(
            rows.iter().any(|r| r.msg_id == "e2e-out-1"),
            "双写消息应进 conv_log: {rows:?}"
        );

        eprintln!("E2E_DIR={}", root.display());
        eprintln!("E2E_BUCKET={bucket}");
        eprintln!("E2E_DB={}", db.display());
        eprintln!("E2E_BOOTSTRAP={log}");
        // 故意不清理：外部脚本要用这个库跑 store-proto-export + shadow-compare。
        match prev_cfg {
            Some(v) => std::env::set_var("MYCO_CONFIG_DIR", v),
            None => std::env::remove_var("MYCO_CONFIG_DIR"),
        }
        match prev_mode {
            Some(v) => std::env::set_var("MYCO_MSG_STORE", v),
            None => std::env::remove_var("MYCO_MSG_STORE"),
        }
    }

    #[test]
    fn notice_state_local_delivered_then_read_is_idempotent() {
        let root = temp_root("notice");
        // delivered 登记（镜像入向 Notice 时走 mark_notice_delivered_in）
        mark_notice_delivered_in(&root, "acct-n", "n-1", "official").unwrap();
        let store = open_bucket(&root, "acct-n").unwrap();
        let st = store.notice_state("n-1").unwrap().expect("应已登记");
        assert!(st.delivered_ms.is_some(), "应写 delivered: {st:?}");
        assert!(st.read_ms.is_none());
        // 已读：幂等 + 隐含 delivered
        assert_eq!(
            mark_notice_read_in(&root, "acct-n", "official", &["n-1".into(), "n-2".into()])
                .unwrap(),
            2
        );
        let st = store.notice_state("n-1").unwrap().unwrap();
        assert!(st.read_ms.is_some(), "应写 read: {st:?}");
        // 重复标记不覆盖首次时间
        let first_read = st.read_ms;
        mark_notice_read_in(&root, "acct-n", "official", &["n-1".into()]).unwrap();
        assert_eq!(
            store.notice_state("n-1").unwrap().unwrap().read_ms,
            first_read,
            "重复已读必须保留首次时间"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 真实数据迁移自检（只读真实 `chat/<acct>/`，产物写临时目录）：
    /// 给 S3 影子读提供"真实账号桶 → 生产迁移代码 → 独立库"，不重启/不写真实配置。
    ///
    /// 跑法：`cargo test -p myco-home --offline msg_store::tests::real_data_migration_shadow_ready -- --ignored --nocapture`
    #[test]
    #[ignore = "读真实配置目录（只读），需串行执行"]
    fn real_data_migration_shadow_ready() {
        let legacy = legacy_chat_dir();
        if !legacy.is_dir() {
            eprintln!("REAL_SKIP=真实 chat 桶不存在: {}", legacy.display());
            return;
        }
        let bucket = legacy
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "default".to_string());
        let device = myco_core::identity::device_identity()
            .map(|(did, _)| did)
            .unwrap_or_else(|_| "unknown-device".to_string());
        let root = temp_root("real");
        let log = bootstrap_for(&root, &bucket, &legacy, &device, msg::now_ms());
        let convs = std::fs::read_dir(&legacy)
            .map(|it| {
                it.filter_map(|e| e.ok())
                    .map(|e| e.path())
                    .filter(|p| p.extension().map(|x| x == "jsonl").unwrap_or(false))
                    .count()
            })
            .unwrap_or(0);
        eprintln!("REAL_ROOT={}", root.display());
        eprintln!("REAL_BUCKET={bucket}");
        eprintln!("REAL_LEGACY={}", legacy.display());
        eprintln!("REAL_CONVS={convs}");
        eprintln!("REAL_LOG={log}");
    }

    #[test]
    fn backfill_adds_missing_messages_and_is_idempotent() {
        let root = temp_root("backfill");
        let legacy = root.join("legacy-chat").join("acct-bf");
        make_legacy_bucket(&legacy);

        // 空库直接对账 → 全量补写（模拟"dual 关闭窗口后重启回 dual"）
        let (first, added1) = backfill_for(&root, "acct-bf", &legacy);
        assert!(first.contains("added=2") && added1 == 2, "首次对账应补 2 条: {first}");
        let store = open_bucket(&root, "acct-bf").unwrap();
        assert_eq!(store.conv_log_rows("did_youling_zfriend1").unwrap().len(), 2);
        assert!(store.contains_msg("m-f1-1001").unwrap());
        assert!(store.contains_msg("m-f1-1002").unwrap());

        // 再跑一次 → 幂等，不新增
        let (second, added2) = backfill_for(&root, "acct-bf", &legacy);
        assert!(second.contains("added=0") && added2 == 0, "重跑应 added=0: {second}");
        assert_eq!(store.conv_log_rows("did_youling_zfriend1").unwrap().len(), 2);

        // 追加一条新消息再对账 → 只补 1 条
        let extra = concat!(
            r#"{"msgId":"m-f1-9999","from":"did:youling:zaabbcc","to":"did:youling:zfriend1","kind":"text","payload":{"text":"late"},"ts":1790000009000,"dir":"out","fromDevice":"did:youling:zdevpc"}"#,
            "\n"
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(legacy.join("did_youling_zfriend1.jsonl"))
            .unwrap()
            .write_all(extra.as_bytes())
            .unwrap();
        let (third, added3) = backfill_for(&root, "acct-bf", &legacy);
        assert!(third.contains("added=1") && added3 == 1, "增量对账应只补 1 条: {third}");
        assert_eq!(store.conv_log_rows("did_youling_zfriend1").unwrap().len(), 3);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rebuild_preserves_file_order_after_backfill() {
        let root = temp_root("rebuild");
        let legacy = root.join("legacy-chat").join("acct-rb");
        make_legacy_bucket(&legacy);
        // 先全量迁移
        bootstrap_for(&root, "acct-rb", &legacy, "dev-rb", 1790000005000);
        // 人为追加一条"中间 ts"的消息（模拟漏镜像后被补写；追加补写会排到尾部）
        let mid = concat!(
            r#"{"msgId":"m-f1-1500","from":"did:youling:zaabbcc","to":"did:youling:zfriend1","kind":"text","payload":{"text":"mid"},"ts":1790000000150,"dir":"out","fromDevice":"did:youling:zdevpc"}"#,
            "\n"
        );
        std::fs::OpenOptions::new()
            .append(true)
            .open(legacy.join("did_youling_zfriend1.jsonl"))
            .unwrap()
            .write_all(mid.as_bytes())
            .unwrap();
        let (_log, added) = backfill_for(&root, "acct-rb", &legacy);
        assert_eq!(added, 1, "应检测到 1 条缺失");
        // 追加补写 → 排到尾部（乱序）
        {
            let store = open_bucket(&root, "acct-rb").unwrap();
            let rows = store.conv_log_rows("did_youling_zfriend1").unwrap();
            let last = rows.last().unwrap();
            assert_eq!(last.msg_id, "m-f1-1500", "追加补写应在尾部（这就是要重建的原因）");
        }
        close_bucket(&root, "acct-rb"); // 重建前释放句柄（生产由 backfill/bootstrap 作用域保证）

        // 重建 → **文件行序**（2026-10-23 顺序语义修正：与双写镜像同语义=到达序；
        // mid 的 ts 虽在中间，但它在文件里是最后一行 → seq 也必须在最后，
        // 否则和逐条镜像的 seq 语义冲突，影子读必炸）
        let rebuilt = rebuild_for(&root, "acct-rb", &legacy, "dev-rb", 1790000006000);
        assert!(rebuilt.contains("重建完成"), "应重建成功: {rebuilt}");
        let store2 = open_bucket(&root, "acct-rb").unwrap();
        let mut rows2 = store2.conv_log_rows("did_youling_zfriend1").unwrap();
        rows2.sort_by_key(|r| r.seq);
        let ids: Vec<&str> = rows2.iter().map(|r| r.msg_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["m-f1-1001", "m-f1-1002", "m-f1-1500"],
            "重建后应保持文件行序（mid 在文件末尾 → seq 也在末尾）: {ids:?}"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn mark_notice_read_registers_missing_historical_row() {
        // 历史通知（迁移只写 conv_log，无 notice_state 行）直接标已读：
        // 旧实现 UnknownNotice 静默失败；新实现应先登记再标记（2026-10-23 真机回填 0 条的根因）
        let root = temp_root("notice-hist");
        make_legacy_bucket(&root.join("legacy").join("acct-h"));
        bootstrap_for(&root, "acct-h", &root.join("legacy").join("acct-h"), "dev-h", 1790000005000);
        let store = open_bucket(&root, "acct-h").unwrap();
        assert!(
            store.notice_state("no-such-row").unwrap().is_none(),
            "前提：该通知确实没有行"
        );
        store.mark_notice_read("no-such-row", 42).unwrap();
        let st = store.notice_state("no-such-row").unwrap().expect("应自动登记");
        assert_eq!(st.read_ms, Some(42));
        assert_eq!(st.delivered_ms, Some(42), "已读隐含已送达");
        // 幂等：重复标记保留首次时间
        store.mark_notice_read("no-such-row", 99).unwrap();
        assert_eq!(store.notice_state("no-such-row").unwrap().unwrap().read_ms, Some(42));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn status_reports_mode_paths_and_flag() {
        let root = temp_root("status");
        let legacy = root.join("legacy-chat").join("acct-s");
        make_legacy_bucket(&legacy);
        let before = status(&root, "acct-s").unwrap();
        assert_eq!(before["migrated"], false);
        migrate_bucket_once(&root, "acct-s", &legacy, "dev-test", 42).unwrap();
        let after = status(&root, "acct-s").unwrap();
        assert_eq!(after["migrated"], true);
        assert_eq!(after["dbExists"], true);
        assert!(after["stats"].is_object());
        let _ = std::fs::remove_dir_all(&root);
    }
}
