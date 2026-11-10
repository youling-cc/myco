//! 老数据迁移：审计 §5 的四类旧文件 → 新表。
//!
//! 输入布局（与 `chat_service.rs:202-239` / `offline_queue.rs:397-411` 一致）：
//!
//! ```text
//! <root>/chat/<account_did_safe>/
//!     outbox.json          # 待发队列（JSON 数组，整文件读/整文件写）
//!     seen.json            # {convId: lastSeenTs}，用户级已读水位
//!     <conv>.jsonl         # 会话消息，一行一条 JSON，append-only
//!     <conv>.meta.json     # {n,lastTs,F,ids:[[msgId,ts]],aliasSrc} 去重索引
//! ```
//!
//! 也接受 `<root>` 自身就是一个账号桶（便于夹具/单测），两种布局可同时存在。
//!
//! ## 映射规则（审计 §5.2-§5.5）
//!
//! | 旧数据 | 新表 | 关键转换 |
//! |---|---|---|
//! | `outbox.json[]` | `outbox` + `outbox_targets` | `sendState`→ACK（`sent→Accepted`、`delivered→Delivered`、`read→Read`）；`ts`→`created_ms`；`ts+6h`（设备群任务卡 `ts+7d`）→`expires_ms`；envelope 原样存 `payload` 以便重发 |
//! | `<conv>.meta.json.ids` | `dedup` | `[msgId, ts]` → `(msg_id, conv_id, seen_ms)` |
//! | `seen.json` | `cursors` | `lastSeenTs` → 查 `conv_log` 里 `created_ms <= lastSeenTs` 的最大 `seq` |
//! | `<conv>.jsonl` | `conv_log` + `inbox` | 按 `(ts, msgId)` 排序后赋 `seq=1..n`；`dir`→`direction`；`fromDevice`→`sender_device`；保留 `wire_kind` |
//!
//! ## 三个硬要求
//!
//! 1. **幂等**：全部 `INSERT OR IGNORE` + `conv_log UNIQUE(conv_id,msg_id)` +
//!    `cursors` 单调 upsert。重跑不产生新行（`*_inserted == 0`）。
//! 2. **计数可核对**：报告里同时给“旧文件侧条数”（[`LegacyInventory`]）与
//!    “实际插入数”，迁移后 `conv_log/inbox/outbox/targets/dedup/cursors` 的行数
//!    必须与旧侧一致（`tests/migrate_tests.rs` 逐项断言）。
//! 3. **失败可回滚**：整个迁移是**一个事务**；任一文件 JSON 语法错误 → `Err` →
//!    全部写入回滚（不会留下半套数据）。
//!
//! ## 有意的保守取舍
//!
//! * 群消息旧 `sendState=delivered` 但只有 `deliveredTargets=[1 个]` 时，**消息级 ACK
//!   仍按目标最小值降为 Accepted**：审计发现 3 指出旧语义“任一目标成功即整体成功”
//!   是错的，迁移不能把这句假话抄进新表；宁可在新栈上重投一次。
//! * 迁移不为 jsonl 行写 `dedup`（审计 §5.4：旧去重索引的唯一来源是 `meta.json`），
//!   长尾幂等由 `conv_log UNIQUE(conv_id,msg_id)` 保证。
//! * malformed 单行只跳过并计数（审计 §5.7 的容错口径），但**文件级 JSON 语法错误
//!   直接失败并回滚**（半解析出的数据不可信）。

use crate::msg::error::{Error, Result};
use crate::msg::ids::{now_ms, sanitize_device_tail};
use crate::msg::types::{AckLevel, Direction, MsgKind, DEFAULT_TTL_MS, DEVICE_CARD_TTL_MS};
use crate::msg::{alloc_seq, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// 迁移选项。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationOptions {
    /// 迁移发起设备（旧 `seen.json` 没有设备维度，只能整机记到一个设备上）。
    pub device_id: String,
    /// 迁移时刻（写入 `cursors.updated_ms` / 兜底时间）。
    pub now_ms: i64,
    /// outbox 默认 TTL（对应旧 `offline_queue.rs:35` 的 6 小时）。
    pub default_ttl_ms: i64,
    /// 设备群任务卡特例 TTL（对应旧 `offline_queue.rs:306-317` 的 7 天）。
    pub device_card_ttl_ms: i64,
}

impl Default for MigrationOptions {
    fn default() -> Self {
        Self {
            device_id: "legacy-device".to_string(),
            now_ms: now_ms(),
            default_ttl_ms: DEFAULT_TTL_MS,
            device_card_ttl_ms: DEVICE_CARD_TTL_MS,
        }
    }
}

impl MigrationOptions {
    /// 指定设备与时刻（测试/生产迁移入口都用它固定可复现参数）。
    pub fn new(device_id: impl Into<String>, now_ms: i64) -> Self {
        Self {
            device_id: device_id.into(),
            now_ms,
            ..Self::default()
        }
    }
}

/// 旧文件侧的条数（“迁移前”的对照口径）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LegacyInventory {
    /// 账号桶数量。
    pub buckets: usize,
    /// 读到的旧文件数（outbox.json + seen.json + *.jsonl + *.meta.json）。
    pub files: usize,
    /// `outbox.json` 里解析成功的条目数。
    pub outbox_items: usize,
    /// `outbox.json` 里 targets 的总数。
    pub outbox_targets: usize,
    /// `*.jsonl` 里解析成功的行数。
    pub jsonl_rows: usize,
    /// `*.meta.json` 里的 id 数。
    pub meta_ids: usize,
    /// `seen.json` 里的会话数。
    pub seen_convs: usize,
    /// 坏行/坏条目数（缺 msgId、非对象等），跳过但不致命。
    pub malformed_rows: usize,
    /// 缺 `msgId`/`convId` 而被跳过的 outbox 条目数。
    pub malformed_outbox_items: usize,
}

/// 迁移报告（“迁移后实际写入”的对照口径）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    /// 旧文件侧条数。
    pub inventory: LegacyInventory,
    /// 新插入的 outbox 行数。
    pub outbox_inserted: usize,
    /// 新插入的 outbox_targets 行数。
    pub outbox_targets_inserted: usize,
    /// 新插入的 conv_log 行数。
    pub conv_log_inserted: usize,
    /// 新插入的 inbox 行数。
    pub inbox_inserted: usize,
    /// 新插入的 dedup 行数（来自 meta.json）。
    pub dedup_inserted: usize,
    /// 写入/更新的 cursor 行数（来自 seen.json）。
    pub cursors_written: usize,
    /// 因已存在而跳过的行数（幂等重跑的观测值）。
    pub skipped_duplicates: usize,
}

impl MigrationReport {
    /// 是否“什么都没写”（幂等重跑应满足）。
    pub fn is_noop(&self) -> bool {
        self.outbox_inserted == 0
            && self.outbox_targets_inserted == 0
            && self.conv_log_inserted == 0
            && self.inbox_inserted == 0
            && self.dedup_inserted == 0
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 只读扫描（不写库）：给“迁移前后条数一致”提供独立口径
// ─────────────────────────────────────────────────────────────────────────────

/// 只扫描不写库，返回旧文件侧条数（可用于迁移前对账）。
pub fn inventory_legacy_dir(root: impl AsRef<Path>) -> Result<LegacyInventory> {
    let buckets = discover_buckets(root.as_ref())?;
    let mut inventory = LegacyInventory::default();
    for bucket in &buckets {
        let _data = load_bucket(bucket, &mut inventory)?;
    }
    Ok(inventory)
}

/// 迁移入口：把 `<root>` 下的所有账号桶迁进 `store`。
///
/// 整个迁移在**一个事务**里：任一文件语法错误 → `Err` → 一条不落。
pub fn migrate_legacy_dir(
    store: &Store,
    root: impl AsRef<Path>,
    opts: &MigrationOptions,
) -> Result<MigrationReport> {
    if opts.device_id.is_empty() {
        return Err(Error::Invalid(
            "migration requires a non-empty device_id".to_string(),
        ));
    }
    let buckets = discover_buckets(root.as_ref())?;
    let mut report = MigrationReport::default();
    store.transaction(|tx| {
        for bucket in &buckets {
            // 解析放在事务内：后面的桶坏了，前面已写入的行一起回滚
            let data = load_bucket(bucket, &mut report.inventory)?;
            write_bucket(tx, &data, opts, &mut report)?;
        }
        Ok(())
    })?;
    Ok(report)
}

// ─────────────────────────────────────────────────────────────────────────────
// 桶发现与解析
// ─────────────────────────────────────────────────────────────────────────────

fn discover_buckets(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.exists() {
        return Err(Error::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("legacy root does not exist: {}", root.display()),
        )));
    }
    let mut buckets = Vec::new();
    let chat_dir = root.join("chat");
    if chat_dir.is_dir() {
        let mut subdirs: Vec<PathBuf> = std::fs::read_dir(&chat_dir)?
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
            .collect();
        subdirs.sort();
        buckets.extend(subdirs);
    }
    if looks_like_bucket(root) {
        buckets.push(root.to_path_buf());
    }
    buckets.sort();
    buckets.dedup();
    Ok(buckets)
}

fn looks_like_bucket(path: &Path) -> bool {
    if path.join("outbox.json").is_file() || path.join("seen.json").is_file() {
        return true;
    }
    std::fs::read_dir(path)
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .any(|entry| entry.file_name().to_string_lossy().ends_with(".jsonl"))
        })
        .unwrap_or(false)
}

/// 一个账号桶解析后的全部旧数据。
struct BucketData {
    /// 账号桶名（`account_did_storage()` 的 safe 形态）。
    #[allow(dead_code)]
    account: String,
    outbox: Vec<LegacyOutboxItem>,
    convs: Vec<LegacyConv>,
    metas: Vec<LegacyMeta>,
    seen: Vec<(String, i64)>,
}

struct LegacyConv {
    conv_id: String,
    rows: Vec<LegacyRow>,
}

struct LegacyMeta {
    conv_id: String,
    ids: Vec<(String, i64)>,
}

struct LegacyRow {
    msg_id: String,
    ts: i64,
    kind: MsgKind,
    wire_kind: String,
    direction: Direction,
    payload: Vec<u8>,
    sender_device: Option<String>,
}

struct LegacyOutboxItem {
    msg_id: String,
    conv_id: String,
    kind: MsgKind,
    priority: i32,
    payload: Vec<u8>,
    created_ms: i64,
    attempts: i64,
    ack_level: AckLevel,
    expires_ms: i64,
    next_retry_ms: i64,
    targets: Vec<(String, AckLevel)>,
}

fn load_bucket(bucket: &Path, inventory: &mut LegacyInventory) -> Result<BucketData> {
    inventory.buckets += 1;
    let account = bucket
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();

    let outbox_path = bucket.join("outbox.json");
    let outbox = if outbox_path.is_file() {
        inventory.files += 1;
        let raw = std::fs::read(&outbox_path)?;
        parse_outbox_json(&raw, &outbox_path, inventory)?
    } else {
        Vec::new()
    };

    let mut file_names: Vec<String> = std::fs::read_dir(bucket)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    file_names.sort();

    let mut convs = Vec::new();
    for name in &file_names {
        if let Some(conv_id) = name.strip_suffix(".jsonl") {
            inventory.files += 1;
            let path = bucket.join(name);
            let raw = std::fs::read_to_string(&path)?;
            let rows = parse_jsonl(&raw, &account, inventory)?;
            convs.push(LegacyConv {
                conv_id: conv_id.to_string(),
                rows,
            });
        }
    }

    let mut metas = Vec::new();
    for name in &file_names {
        if let Some(conv_id) = name.strip_suffix(".meta.json") {
            inventory.files += 1;
            let path = bucket.join(name);
            let raw = std::fs::read(&path)?;
            let ids = parse_meta_json(&raw, &path, inventory)?;
            metas.push(LegacyMeta {
                conv_id: conv_id.to_string(),
                ids,
            });
        }
    }

    let seen_path = bucket.join("seen.json");
    let seen = if seen_path.is_file() {
        inventory.files += 1;
        let raw = std::fs::read(&seen_path)?;
        parse_seen_json(&raw, &seen_path, inventory)?
    } else {
        Vec::new()
    };

    Ok(BucketData {
        account,
        outbox,
        convs,
        metas,
        seen,
    })
}

fn read_json(raw: &[u8], path: &Path) -> Result<Value> {
    serde_json::from_slice::<Value>(raw)
        .map_err(|err| Error::Json(format!("{}: {err}", path.display())))
}

fn parse_outbox_json(
    raw: &[u8],
    path: &Path,
    inventory: &mut LegacyInventory,
) -> Result<Vec<LegacyOutboxItem>> {
    let value = read_json(raw, path)?;
    let items: Vec<Value> = match value {
        Value::Null => Vec::new(),
        Value::Array(items) => items,
        Value::Object(mut map) => match map.remove("items") {
            Some(Value::Array(items)) => items,
            _ => {
                return Err(Error::Json(format!(
                    "{}: outbox.json must be an array",
                    path.display()
                )))
            }
        },
        _ => {
            return Err(Error::Json(format!(
                "{}: outbox.json must be an array",
                path.display()
            )))
        }
    };

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let Some(msg_id) = get_str(&item, "msgId").filter(|id| !id.is_empty()) else {
            inventory.malformed_outbox_items += 1;
            inventory.malformed_rows += 1;
            continue;
        };
        let Some(conv_id) = get_str(&item, "convId").filter(|id| !id.is_empty()) else {
            inventory.malformed_outbox_items += 1;
            inventory.malformed_rows += 1;
            continue;
        };
        let envelope = item.get("envelope").cloned().unwrap_or(Value::Null);
        let wire_kind = get_str(&envelope, "kind").unwrap_or("").to_string();
        let kind = MsgKind::from_wire_kind(&wire_kind);
        let to = get_str(&envelope, "to").unwrap_or(conv_id);

        let created_ms = get_i64(&item, "ts")
            .or_else(|| get_i64(&envelope, "ts"))
            .unwrap_or(0);
        let attempts = get_i64(&item, "attempts").unwrap_or(0);
        let send_state = get_str(&item, "sendState")
            .or_else(|| get_str(&item, "status"))
            .unwrap_or("");
        let ack_level = map_send_state(send_state);
        let delivered_targets: Vec<String> = item
            .get("deliveredTargets")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let targets: Vec<String> = item
            .get("targets")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(|value| value.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        // 设备群任务卡特例：7 天 TTL（审计 §1.3 `offline_queue.rs:306-317`）
        let is_device_card = wire_kind == "task-share" && to.starts_with("grp-dev-");
        let ttl = if is_device_card {
            DEVICE_CARD_TTL_MS
        } else {
            DEFAULT_TTL_MS
        };

        let target_levels: Vec<(String, AckLevel)> = targets
            .iter()
            .map(|target| {
                (
                    target.clone(),
                    target_ack_level(&targets, &delivered_targets, ack_level, target),
                )
            })
            .collect();

        inventory.outbox_items += 1;
        inventory.outbox_targets += target_levels.len();

        out.push(LegacyOutboxItem {
            msg_id: msg_id.to_string(),
            conv_id: conv_id.to_string(),
            kind,
            priority: kind.priority_hint(),
            payload: payload_of(&envelope, path)?,
            created_ms,
            attempts,
            ack_level,
            expires_ms: created_ms.saturating_add(ttl),
            next_retry_ms: created_ms.saturating_add(backoff_ms(attempts)),
            targets: target_levels,
        });
    }
    Ok(out)
}

/// 旧 `sendState` → ACK 层级（任务书口径：`sent→Accepted`、`delivered→Delivered`）。
///
/// `failed/queued/pending` 一律 `Accepted`：旧栈的 `failed` 同时表示“入队待补发”
/// 和“彻底失败”（审计 §1.5），迁移无法区分，取最保守的 `Accepted`。
fn map_send_state(raw: &str) -> AckLevel {
    match raw {
        "delivered" => AckLevel::Delivered,
        "read" => AckLevel::Read,
        // sent / sending / failed / queued / pending / 未知
        _ => AckLevel::Accepted,
    }
}

/// 单个目标的 ACK：只有拿到 per-target 证据才升级。
///
/// * 单目标：直接继承 `sendState`（旧栈的单聊语义可信）；
/// * 多目标 + `deliveredTargets` 命中：至少 `Delivered`；
/// * 多目标但没有该目标证据：`Accepted`（不把整条消息的旧 `delivered` 平摊给所有目标）。
fn target_ack_level(
    targets: &[String],
    delivered_targets: &[String],
    base: AckLevel,
    target: &str,
) -> AckLevel {
    if targets.len() == 1 {
        return base;
    }
    if delivered_targets.iter().any(|delivered| delivered == target) {
        return base.max(AckLevel::Delivered);
    }
    AckLevel::Accepted
}

fn parse_jsonl(raw: &str, account: &str, inventory: &mut LegacyInventory) -> Result<Vec<LegacyRow>> {
    let mut rows = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(_) => {
                // 单行语法错误：跳过并计数（审计 §5.7 的容错口径）
                inventory.malformed_rows += 1;
                continue;
            }
        };
        let Some(msg_id) = get_str(&value, "msgId").filter(|id| !id.is_empty()) else {
            inventory.malformed_rows += 1;
            continue;
        };
        let wire_kind = get_str(&value, "kind").unwrap_or("").to_string();
        let kind = MsgKind::from_wire_kind(&wire_kind);
        let ts = get_i64(&value, "ts").unwrap_or(0);
        let direction = match get_str(&value, "dir") {
            Some(raw_dir) => Direction::parse(raw_dir),
            None => infer_direction(&value, account),
        };
        let payload = match value.get("payload") {
            Some(payload) => serde_json::to_vec(payload)?,
            None => b"null".to_vec(),
        };
        inventory.jsonl_rows += 1;
        rows.push(LegacyRow {
            msg_id: msg_id.to_string(),
            ts,
            kind,
            wire_kind,
            direction,
            payload,
            sender_device: get_str(&value, "fromDevice").map(str::to_string),
        });
    }
    // 2026-10-23 顺序语义修正：**保留文件行序（到达序）**，不再按 (ts, msgId) 排序。
    // 根因（真机实测乱序 8 条）：peer-task 卡带"创建时 ts"但经同步晚到——旧 jsonl 行序是到达序，
    // 而双写镜像按 conv_append 到达序赋 seq；若迁移/重建按 ts 排序，两种写入路径的 seq 语义不一致，
    // 影子读必炸。**双写期旧侧是真相**：seq = 文件行序（与镜像/对账/重建完全同语义）。
    // （ts 排序的展示诉求归 UI/读取层，不归存储序。）
    Ok(rows)
}

/// 没有 `dir` 字段时按 `from` 推断：`from` 是本站账号 → out，否则 in。
fn infer_direction(value: &Value, account: &str) -> Direction {
    match get_str(value, "from") {
        Some(from) if sanitize_device_tail(from) == account => Direction::Out,
        _ => Direction::In,
    }
}

fn parse_meta_json(
    raw: &[u8],
    path: &Path,
    inventory: &mut LegacyInventory,
) -> Result<Vec<(String, i64)>> {
    let value = read_json(raw, path)?;
    let ids = value
        .get("ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(ids.len());
    for entry in ids {
        let (msg_id, ts) = match &entry {
            Value::Array(pair) => (
                pair.first().and_then(Value::as_str).map(str::to_string),
                pair.get(1).and_then(as_i64).unwrap_or(0),
            ),
            Value::Object(_) => (
                get_str(&entry, "msgId").map(str::to_string),
                get_i64(&entry, "ts").unwrap_or(0),
            ),
            _ => (None, 0),
        };
        match msg_id {
            Some(msg_id) if !msg_id.is_empty() => {
                inventory.meta_ids += 1;
                out.push((msg_id, ts));
            }
            _ => inventory.malformed_rows += 1,
        }
    }
    Ok(out)
}

fn parse_seen_json(
    raw: &[u8],
    path: &Path,
    inventory: &mut LegacyInventory,
) -> Result<Vec<(String, i64)>> {
    let value = read_json(raw, path)?;
    let Some(map) = value.as_object() else {
        return Err(Error::Json(format!(
            "{}: seen.json must be an object",
            path.display()
        )));
    };
    let mut out = Vec::with_capacity(map.len());
    for (conv_id, ts) in map {
        if conv_id.is_empty() {
            inventory.malformed_rows += 1;
            continue;
        }
        let Some(ts) = as_i64(ts) else {
            inventory.malformed_rows += 1;
            continue;
        };
        inventory.seen_convs += 1;
        out.push((conv_id.clone(), ts));
    }
    Ok(out)
}

fn get_str<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn get_i64(value: &Value, key: &str) -> Option<i64> {
    value.get(key).and_then(as_i64)
}

fn as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number
                .as_f64()
                .filter(|float| float.is_finite())
                .map(|float| float as i64)
        }),
        Value::String(text) => text.parse::<i64>().ok(),
        _ => None,
    }
}

fn payload_of(envelope: &Value, path: &Path) -> Result<Vec<u8>> {
    serde_json::to_vec(envelope)
        .map_err(|err| Error::Json(format!("{}: envelope: {err}", path.display())))
}

/// 旧退避节奏（审计 §1.3：3/6/12/24/48/60s 封顶）。
fn backoff_ms(attempts: i64) -> i64 {
    const STEPS_MS: [i64; 6] = [3_000, 6_000, 12_000, 24_000, 48_000, 60_000];
    let index = attempts.clamp(0, (STEPS_MS.len() - 1) as i64) as usize;
    STEPS_MS[index]
}

// ─────────────────────────────────────────────────────────────────────────────
// 写库（事务内，全部幂等）
// ─────────────────────────────────────────────────────────────────────────────

fn write_bucket(
    tx: &Connection,
    data: &BucketData,
    opts: &MigrationOptions,
    report: &mut MigrationReport,
) -> Result<()> {
    // 1) outbox.json → outbox + outbox_targets
    for item in &data.outbox {
        let aggregate = item
            .targets
            .iter()
            .map(|(_, level)| *level)
            .min()
            .unwrap_or(item.ack_level);
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO outbox(msg_id, conv_id, kind, priority, payload, created_ms,
                                          ack_level, expires_ms, attempts, next_retry_ms)
             VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                item.msg_id,
                item.conv_id,
                item.kind.as_str(),
                item.priority,
                item.payload,
                item.created_ms,
                aggregate.as_i64(),
                item.expires_ms,
                item.attempts,
                item.next_retry_ms,
            ],
        )?;
        report.outbox_inserted += inserted;
        if inserted == 0 {
            report.skipped_duplicates += 1;
        }
        for (target, level) in &item.targets {
            let delivered_ms = if *level >= AckLevel::Delivered {
                Some(item.created_ms)
            } else {
                None
            };
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO outbox_targets(msg_id, target_device, delivered_ms, ack_level)
                 VALUES(?1, ?2, ?3, ?4)",
                params![item.msg_id, target, delivered_ms, level.as_i64()],
            )?;
            report.outbox_targets_inserted += inserted;
        }
    }

    // 2) <conv>.jsonl → conv_log + inbox
    for conv in &data.convs {
        for row in &conv.rows {
            let exists: Option<i64> = tx
                .query_row(
                    "SELECT seq FROM conv_log WHERE conv_id = ?1 AND msg_id = ?2",
                    params![conv.conv_id, row.msg_id],
                    |row| row.get(0),
                )
                .optional()?;
            if exists.is_some() {
                report.skipped_duplicates += 1;
                continue;
            }
            let seq = alloc_seq(tx, &conv.conv_id)?;
            // 2026-10-23：历史通知播种三态（重建不再清空 notice_state——真机实测 7/7/7 归零）
            if row.kind == MsgKind::Notice {
                tx.execute(
                    "INSERT INTO notice_state(notice_id, delivered_ms) VALUES(?1, ?2)
                     ON CONFLICT(notice_id) DO UPDATE SET delivered_ms = COALESCE(notice_state.delivered_ms, excluded.delivered_ms)",
                    params![row.msg_id, row.ts],
                )?;
            }
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO conv_log(conv_id, seq, msg_id, direction, payload, created_ms, kind, wire_kind)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    conv.conv_id,
                    seq,
                    row.msg_id,
                    row.direction.as_str(),
                    row.payload,
                    row.ts,
                    row.kind.as_str(),
                    row.wire_kind,
                ],
            )?;
            report.conv_log_inserted += inserted;
            if inserted == 0 {
                report.skipped_duplicates += 1;
                continue;
            }
            let inbox_inserted = tx.execute(
                "INSERT OR IGNORE INTO inbox(conv_id, msg_id, seq, sender_device, payload, recv_ms)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    conv.conv_id,
                    row.msg_id,
                    seq,
                    row.sender_device,
                    row.payload,
                    row.ts,
                ],
            )?;
            report.inbox_inserted += inbox_inserted;
        }
    }

    // 3) <conv>.meta.json → dedup（审计 §5.4；不写 jsonl 行）
    for meta in &data.metas {
        for (msg_id, ts) in &meta.ids {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO dedup(msg_id, conv_id, seen_ms) VALUES(?1, ?2, ?3)",
                params![msg_id, meta.conv_id, ts],
            )?;
            report.dedup_inserted += inserted;
        }
    }

    // 4) seen.json → cursors（时间水位 → seq 水位）
    for (conv_id, last_seen_ts) in &data.seen {
        let last_seq: i64 = tx.query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM conv_log WHERE conv_id = ?1 AND created_ms <= ?2",
            params![conv_id, last_seen_ts],
            |row| row.get(0),
        )?;
        tx.execute(
            "INSERT INTO cursors(device_id, conv_id, seq, updated_ms) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(device_id, conv_id) DO UPDATE SET
                 seq = CASE WHEN excluded.seq > cursors.seq THEN excluded.seq ELSE cursors.seq END,
                 updated_ms = CASE WHEN excluded.seq > cursors.seq THEN excluded.updated_ms ELSE cursors.updated_ms END",
            params![opts.device_id, conv_id, last_seq, opts.now_ms],
        )?;
        report.cursors_written += 1;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::msg::PRIORITY_P2;

    #[test]
    fn send_state_mapping_matches_task_book() {
        assert_eq!(map_send_state("sent"), AckLevel::Accepted);
        assert_eq!(map_send_state("sending"), AckLevel::Accepted);
        assert_eq!(map_send_state("delivered"), AckLevel::Delivered);
        assert_eq!(map_send_state("read"), AckLevel::Read);
        // failed 同时表示“待补发”和“彻底失败”，只能保守取 Accepted
        assert_eq!(map_send_state("failed"), AckLevel::Accepted);
        assert_eq!(map_send_state("queued"), AckLevel::Accepted);
        assert_eq!(map_send_state(""), AckLevel::Accepted);
    }

    #[test]
    fn per_target_ack_is_conservative_for_multi_target() {
        let targets = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        let delivered = vec!["a".to_string()];
        // 单目标的 sent 可信：继承 sendState
        assert_eq!(
            target_ack_level(&targets[..1], &[], AckLevel::Accepted, "a"),
            AckLevel::Accepted
        );
        // 多目标：只有拿到证据的 a 升级，b/c 仍是 Accepted
        assert_eq!(
            target_ack_level(&targets, &delivered, AckLevel::Delivered, "a"),
            AckLevel::Delivered
        );
        assert_eq!(
            target_ack_level(&targets, &delivered, AckLevel::Delivered, "b"),
            AckLevel::Accepted
        );
        // 多目标但完全没有 per-target 证据：旧 delivered 不平摊
        assert_eq!(
            target_ack_level(&targets, &[], AckLevel::Delivered, "a"),
            AckLevel::Accepted
        );
    }

    #[test]
    fn backoff_matches_legacy_schedule() {
        assert_eq!(backoff_ms(0), 3_000);
        assert_eq!(backoff_ms(3), 24_000);
        assert_eq!(backoff_ms(5), 60_000);
        assert_eq!(backoff_ms(500), 60_000);
        assert_eq!(PRIORITY_P2, MsgKind::Control.priority_hint());
    }
}
