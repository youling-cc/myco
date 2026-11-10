//! SQLite schema（T201）。
//!
//! 设计原则：
//! 1. **写死在代码里、随进程启动幂等执行**（`CREATE TABLE IF NOT EXISTS`），
//!    不引入外部迁移框架；`PRAGMA user_version` 记录 schema 版本。
//! 2. 每张表都有明确 owner：`outbox`/`outbox_targets` = 发送侧队列；
//!    `inbox`/`conv_log` = 会话日志与入库；`cursors` = 每设备读水位；
//!    `dedup` = 全局去重窗口；`notice_state` = 小灵/申诉本地送达已读。
//! 3. **时间一律 epoch 毫秒整数**（`INTEGER`），不做 TEXT 时间，避免时区/格式漂移。
//! 4. 关联完整性交给 SQLite 外键（连接级 `PRAGMA foreign_keys=ON`，见 `Store::finish`），
//!    `outbox_targets` 随 `outbox` 级联删除。

/// 当前 schema 版本（写入 `PRAGMA user_version` 与 `store_meta.schema_version`）。
pub const SCHEMA_VERSION: i64 = 1;

/// 完整 DDL。所有语句幂等（`IF NOT EXISTS`），每次 `Store::open` 都会执行一遍。
///
/// 与任务书 DDL 的三处**有意差异**（详见 README §4）：
/// 1. `conv_log` 主键从 `seq INTEGER PRIMARY KEY` 改为 `PRIMARY KEY(conv_id, seq)`：
///    任务要求“跨会话 seq 独立”，全局主键会直接让不同会话的 seq=1 互撞。
/// 2. `conv_log` 增加 `kind TEXT`：`sync_since` 返回 `MsgRow` 需要类别，而任务书
///    的 `conv_log` 列里没有 kind（审计 §5.3 明确要求映射 `kind`）。
/// 3. `conv_log` 增加 `wire_kind TEXT`：审计 §5.3 要求“保留 wire_kind”，
///    旧 kind 词表是回放/排障依据。
///
/// 另外补充了实现必需的两张内部表：
/// * `conv_seq`：per-conv 序号分配器（`assign_seq` 事务内 `+1`）；
/// * `counters` / `store_meta`：持久计数器（deduped/expired）与 schema 元数据。
pub const SCHEMA_SQL: &str = r#"
-- ── 发送队列：一条待发消息一行 ─────────────────────────────────────────────
-- ack_level 是**消息级聚合水位**（0 Accepted / 1 Durable / 2 Delivered / 3 Read），
-- 它等于 per-target 水位的最小值：群/多端只要还有一个目标没到，消息就不算到
-- （修审计发现 3“任一目标成功即整体成功”）。
CREATE TABLE IF NOT EXISTS outbox (
    msg_id        TEXT    PRIMARY KEY,              -- 全局幂等键，重发不改
    conv_id       TEXT    NOT NULL,                 -- 会话 id（did_safe 形态原样保留）
    kind          TEXT    NOT NULL,                 -- Chat|Notice|Task|Control
    priority      INTEGER NOT NULL,                 -- 0=P0 1=P1 2=P2，越小越先发
    payload       BLOB    NOT NULL,                 -- 上线字节（旧数据=完整 envelope JSON）
    created_ms    INTEGER NOT NULL,                 -- 入队/消息时间（epoch ms）
    ack_level     INTEGER NOT NULL DEFAULT 0,       -- 聚合 ACK 水位，只升不降
    expires_ms    INTEGER,                          -- TTL 边界；NULL=不过期
    attempts      INTEGER NOT NULL DEFAULT 0,       -- 已尝试投递次数
    next_retry_ms INTEGER NOT NULL DEFAULT 0        -- 下次可重试时刻（退避；0=立即可试）
);

-- 群消息/多端：每个目标设备一行，独立 ACK（修审计发现 3）
CREATE TABLE IF NOT EXISTS outbox_targets (
    msg_id        TEXT    NOT NULL REFERENCES outbox(msg_id) ON DELETE CASCADE,
    target_device TEXT    NOT NULL,                 -- 目标设备 did
    delivered_ms  INTEGER,                          -- 首次送达时刻（Read 不清空）
    ack_level     INTEGER NOT NULL DEFAULT 0,       -- 该目标自己的 ACK 水位
    PRIMARY KEY (msg_id, target_device)
);

-- ── 接收侧入库：一条已入库消息一行 ────────────────────────────────────────
-- 与 conv_log 双写：inbox 记“谁送来的”，conv_log 记“在会话里的位置”。
CREATE TABLE IF NOT EXISTS inbox (
    conv_id       TEXT    NOT NULL,
    msg_id        TEXT    NOT NULL,
    seq           INTEGER NOT NULL,                 -- 与 conv_log 同一序号
    sender_device TEXT,                             -- 旧 fromDevice
    payload       BLOB    NOT NULL,                 -- 业务 payload JSON
    recv_ms       INTEGER NOT NULL,                 -- 入库时刻（旧数据回填 ts）
    PRIMARY KEY (conv_id, msg_id)
);

-- ── 会话日志：每会话单调序号（修审计发现 2“没有信道序号”）───────────────
CREATE TABLE IF NOT EXISTS conv_log (
    conv_id     TEXT    NOT NULL,
    seq         INTEGER NOT NULL,                   -- 每会话独立，从 1 开始单调递增
    msg_id      TEXT    NOT NULL,
    direction   TEXT    NOT NULL,                   -- out|in
    payload     BLOB    NOT NULL,                   -- 业务 payload JSON
    created_ms  INTEGER NOT NULL,                   -- 消息时间（旧 ts；不依赖本地时钟排新数据）
    kind        TEXT    NOT NULL,                   -- Chat|Notice|Task|Control
    wire_kind   TEXT,                               -- 旧 wire kind（迁移/回放用，新数据可为 NULL）
    PRIMARY KEY (conv_id, seq),
    UNIQUE (conv_id, msg_id)                        -- 去重窗口过期后的长尾幂等兜底
);

-- ── per-device cursor（修审计发现 2“没有 per-device cursor”）──────────────
CREATE TABLE IF NOT EXISTS cursors (
    device_id  TEXT    NOT NULL,
    conv_id    TEXT    NOT NULL,
    seq        INTEGER NOT NULL DEFAULT 0,          -- 该设备在该会话已消费到的 seq
    updated_ms INTEGER NOT NULL,                    -- 最后推进时刻
    PRIMARY KEY (device_id, conv_id)
);

-- ── 去重窗口（T203：全局 msgId，≥7 天窗口）────────────────────────────────
CREATE TABLE IF NOT EXISTS dedup (
    msg_id  TEXT    PRIMARY KEY,                    -- 全局唯一，跨会话生效
    conv_id TEXT    NOT NULL,                       -- 首次出现的会话
    seen_ms INTEGER NOT NULL                        -- 首次入库时刻（窗口淘汰依据）
);

-- ── 小灵/申诉通知的本地送达已读（修审计 §2.5“本地无通知级状态”）──────────
CREATE TABLE IF NOT EXISTS notice_state (
    notice_id    TEXT PRIMARY KEY,                  -- msgId = noticeId
    delivered_ms INTEGER,                           -- 首次落地时刻（幂等保留）
    read_ms      INTEGER                            -- 首次已读时刻（幂等保留）
);

-- ── 内部表（不对外承诺，但 schema 注解写清用途）──────────────────────────
-- per-conv 序号分配器：避免每次 assign_seq 都 MAX(seq) 全表扫
CREATE TABLE IF NOT EXISTS conv_seq (
    conv_id  TEXT    PRIMARY KEY,
    next_seq INTEGER NOT NULL
);

-- 持久计数器：deduped/expired 等跨进程累计值
CREATE TABLE IF NOT EXISTS counters (
    name  TEXT    PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

-- 元数据：schema_version 等
CREATE TABLE IF NOT EXISTS store_meta (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
);

-- ── 索引（按真实查询路径补，不做无用索引）────────────────────────────────
-- 发送调度：按优先级出队、按 TTL 清理、按退避取候选
CREATE INDEX IF NOT EXISTS idx_outbox_queue   ON outbox (priority, created_ms);
CREATE INDEX IF NOT EXISTS idx_outbox_retry   ON outbox (next_retry_ms);
CREATE INDEX IF NOT EXISTS idx_outbox_expiry  ON outbox (expires_ms) WHERE expires_ms IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_outbox_conv    ON outbox (conv_id);

-- per-target 反查（“这台设备还欠哪些消息”）
CREATE INDEX IF NOT EXISTS idx_targets_device ON outbox_targets (target_device, ack_level);

-- 增量同步：conv_log 按 (conv, seq) 已是主键；补 created_ms 供迁移/seen→seq 回填
CREATE INDEX IF NOT EXISTS idx_conv_log_time  ON conv_log (conv_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_conv_log_msg   ON conv_log (msg_id);
CREATE INDEX IF NOT EXISTS idx_inbox_seq      ON inbox (conv_id, seq);

-- 去重窗口淘汰
CREATE INDEX IF NOT EXISTS idx_dedup_seen     ON dedup (seen_ms);
"#;

/// `store_meta` 中记录 schema 版本的 key。
pub const SCHEMA_VERSION_KEY: &str = "schema_version";

/// 计数器名：累计被幂等闸挡下的入队次数。
pub const COUNTER_DEDUPED: &str = "deduped";
/// 计数器名：累计被 TTL 清理的消息数。
pub const COUNTER_EXPIRED: &str = "expired";
/// 计数器名：累计被去重窗口淘汰的 dedup 行数。
pub const COUNTER_DEDUP_PURGED: &str = "dedup_purged";
