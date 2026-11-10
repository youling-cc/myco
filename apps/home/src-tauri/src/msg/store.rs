//! `Store`：SQLite 存储句柄与事务内原语（vendored from `store-proto/src/lib.rs`）。

use crate::msg::error::{Error, Result};
use crate::msg::ids::now_ms;
use crate::msg::schema::{
    self, COUNTER_DEDUP_PURGED, COUNTER_DEDUPED, COUNTER_EXPIRED, SCHEMA_VERSION,
};
use crate::msg::types::{
    AckLevel, DedupEntry, Direction, EnqueueOutcome, MsgKind as Kind, MsgRow, NoticeState, Stats,
    SyncQuery, TargetState, DEFAULT_DEDUP_WINDOW_MS,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Transaction};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// 链接进来的 SQLite 版本（`bundled` 特性下由 libsqlite3-sys 编译进来）。
///
/// 排障/对账用：不同 SQLite 版本的 UPSERT/索引行为一致，但把版本写进日志能省一次现场排查。
pub fn sqlite_version() -> &'static str {
    rusqlite::version()
}

/// 存储配置。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreConfig {
    /// 去重窗口（毫秒）。默认 7 天（R25/T203）。
    ///
    /// 窗口只影响 `dedup` 表的淘汰速度：窗口过后同一 msgId 仍会被
    /// `conv_log UNIQUE(conv_id,msg_id)` 挡住（长尾幂等），不会产生第二条会话记录。
    pub dedup_window_ms: i64,
}

impl Default for StoreConfig {
    fn default() -> Self {
        Self {
            dedup_window_ms: DEFAULT_DEDUP_WINDOW_MS,
        }
    }
}

/// SQLite 存储句柄。
///
/// 一个 `Store` 对应一个数据库文件（或一个内存库）。打开即建表（幂等），
/// 不做后台线程/定时器：TTL 清理由调用方调 [`Store::sweep_expired`] 驱动。
pub struct Store {
    conn: Mutex<Connection>,
    cfg: StoreConfig,
    path: Option<PathBuf>,
}

impl Store {
    // ── 打开/关闭 ────────────────────────────────────────────────────────

    /// 打开文件库（默认配置）。目录不存在会自动创建。
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with(path, StoreConfig::default())
    }

    /// 打开文件库并指定配置。
    pub fn open_with(path: impl AsRef<Path>, cfg: StoreConfig) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(&path)?;
        Self::finish(conn, cfg, Some(path))
    }

    /// 打开内存库（测试/影子对比用）。
    pub fn open_in_memory() -> Result<Self> {
        Self::open_in_memory_with(StoreConfig::default())
    }

    /// 打开内存库并指定配置。
    pub fn open_in_memory_with(cfg: StoreConfig) -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::finish(conn, cfg, None)
    }

    /// 以**只读**方式打开既有库（影子读 / 导出 / 对账用）。
    ///
    /// 与 [`Store::open`] 的区别是三条“绝不写”保证：
    /// * 不建目录、不建表：库或表不存在就直接报错，**不会悄悄创建一个空库**；
    /// * 不执行 `PRAGMA journal_mode=WAL` / `user_version` / `store_meta` 更新；
    /// * 连接级 `PRAGMA query_only=ON`：任何写语句（含误调用 `enqueue`/`advance_cursor`）
    ///   都会被 SQLite 以 `SQLITE_READONLY` 拒绝。
    ///
    /// 影子读阶段（`eval/vnet/task-messaging.md` §4.2 ②，“只读对比、只记录差异不改变行为”）
    /// 必须用这个入口打开线上库。WAL 的 `-wal/-shm` 由 SQLite 正常维护（这属于文件级锁，
    /// 不是数据写入）。
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let conn = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        // 多进程同库时不要立刻 SQLITE_BUSY；busy_timeout 是连接级设置，不落盘
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        // 双保险：即使有人误用写语句，也在连接层被拒绝
        conn.execute_batch("PRAGMA query_only = ON;")?;
        Ok(Self {
            conn: Mutex::new(conn),
            cfg: StoreConfig::default(),
            path: Some(path),
        })
    }

    /// 统一初始化：pragma → schema → 版本号。
    fn finish(conn: Connection, cfg: StoreConfig, path: Option<PathBuf>) -> Result<Self> {
        // 写等待上限：多进程/多线程写同一文件时不要立刻 SQLITE_BUSY
        conn.busy_timeout(std::time::Duration::from_millis(5_000))?;
        // WAL：读写不互斥（内存库会返回 "memory"，属正常）
        let _mode: String = conn.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
        // NORMAL：WAL 下的推荐档位（崩溃不丢已提交事务，掉电只可能丢最后几个事务）
        conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")?;
        conn.execute_batch(schema::SCHEMA_SQL)?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        conn.execute(
            "INSERT INTO store_meta(k, v) VALUES(?1, ?2)
             ON CONFLICT(k) DO UPDATE SET v = excluded.v",
            params![schema::SCHEMA_VERSION_KEY, SCHEMA_VERSION.to_string()],
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
            cfg,
            path,
        })
    }

    /// 数据库文件路径（内存库为 `None`）。
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// 当前日志模式（文件库应为 `wal`，内存库为 `memory`）。
    pub fn journal_mode(&self) -> Result<String> {
        let conn = self.conn()?;
        Ok(conn.query_row("PRAGMA journal_mode", [], |row| row.get(0))?)
    }

    /// 当前 `synchronous` 档位（0=OFF,1=NORMAL,2=FULL,3=EXTRA）。
    pub fn synchronous_level(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("PRAGMA synchronous", [], |row| row.get(0))?)
    }

    /// `PRAGMA user_version`（schema 版本）。
    pub fn schema_version(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("PRAGMA user_version", [], |row| row.get(0))?)
    }

    /// 配置的只读视图。
    pub fn config(&self) -> &StoreConfig {
        &self.cfg
    }

    fn conn(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| Error::Invalid("store mutex poisoned".to_string()))
    }

    /// 在一个 SQLite 事务里执行闭包：`Ok` 提交，`Err` 回滚。
    ///
    /// 这是唯一的“多语句原子性”入口：`enqueue_batch`、迁移、`mark_ack` 都走它。
    /// 生产集成时用它包住“写 outbox + 写 conv_log + 写 dedup”这类必须同时成功/失败的动作。
    pub fn transaction<T>(&self, f: impl FnOnce(&Transaction<'_>) -> Result<T>) -> Result<T> {
        let mut guard = self.conn()?;
        let tx = guard.transaction()?;
        let value = f(&tx)?;
        tx.commit()?;
        Ok(value)
    }

    // ── outbox：入队 ─────────────────────────────────────────────────────

    /// 入队一条消息（幂等：同 `msg_id` 不重复插入）。
    ///
    /// 一次事务内完成四件事：分配会话 `seq` → 写 `conv_log` → 写 `outbox` +
    /// `outbox_targets` → 写 `dedup`。重复 msgId 返回 `Ok(())`，被计入
    /// [`Stats::deduped`]。
    pub fn enqueue(&self, row: MsgRow) -> Result<()> {
        self.enqueue_row(row).map(|_| ())
    }

    /// 同 [`Store::enqueue`]，但返回是否真的插入（便于调度器/测试观察）。
    pub fn enqueue_row(&self, row: MsgRow) -> Result<EnqueueOutcome> {
        self.transaction(|tx| enqueue_tx(tx, &row))
    }

    /// 批量入队（单事务，性能用）。返回真正插入的条数。
    ///
    /// 任意一行非法（空 msgId、空 convId）→ 整批回滚，一条都不落库。
    pub fn enqueue_batch<I: IntoIterator<Item = MsgRow>>(&self, rows: I) -> Result<usize> {
        self.transaction(|tx| {
            let mut inserted = 0usize;
            for row in rows {
                if matches!(enqueue_tx(tx, &row)?, EnqueueOutcome::Inserted { .. }) {
                    inserted += 1;
                }
            }
            Ok(inserted)
        })
    }

    /// 入库一条收到的消息（幂等；写 `conv_log` + `inbox` + `dedup`，不写 outbox）。
    pub fn ingest(&self, row: MsgRow) -> Result<EnqueueOutcome> {
        self.transaction(|tx| ingest_tx(tx, &row))
    }

    /// 批量入库（单事务）。返回真正插入的条数。
    pub fn ingest_batch<I: IntoIterator<Item = MsgRow>>(&self, rows: I) -> Result<usize> {
        self.transaction(|tx| {
            let mut inserted = 0usize;
            for row in rows {
                if matches!(ingest_tx(tx, &row)?, EnqueueOutcome::Inserted { .. }) {
                    inserted += 1;
                }
            }
            Ok(inserted)
        })
    }

    /// **只写会话日志**（不建 outbox / inbox 行）——专门给"双写镜像"用。
    ///
    /// 为什么不能复用 `enqueue`：2026-10-23 真实运行发现——出站消息在旧栈里
    /// **投递成功就不会进 outbox**，而镜像若按 `enqueue` 写会凭空造出"待发"行：
    /// ① 影子读 outbox 永远 0/N 假失败；② 将来若误把 `store.outbox` 当重发源会重复发送。
    /// S2 口径（`eval/msg/DESIGN-t201-production.md` §2.3 D8）：outbox 仍由旧 `offline_queue`
    /// 独占，镜像只补会话日志 + 去重索引。
    pub fn conv_mirror(&self, row: MsgRow) -> Result<EnqueueOutcome> {
        self.transaction(|tx| conv_mirror_tx(tx, &row))
    }

    /// 读一条 outbox 行（不存在返回 `None`）。
    pub fn get_outbox(&self, msg_id: &str) -> Result<Option<MsgRow>> {
        let conn = self.conn()?;
        let row = conn
            .query_row(
                "SELECT msg_id, conv_id, kind, priority, payload, created_ms, ack_level, expires_ms, attempts
                 FROM outbox WHERE msg_id = ?1",
                params![msg_id],
                |row| Ok(msg_row_from_outbox(row)),
            )
            .optional()?;
        match row {
            Some(mut msg) => {
                msg.targets = target_devices(&conn, msg_id)?;
                Ok(Some(msg))
            }
            None => Ok(None),
        }
    }

    /// 取待投递候选：按优先级（P0 在前）+ 入队时间升序，跳过未到重试时刻的。
    ///
    /// 这是调度器的“取一批来发”接口；`limit` 由调用方按扇出预算给。
    pub fn pending(&self, now_ms: i64, limit: usize) -> Result<Vec<MsgRow>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT msg_id, conv_id, kind, priority, payload, created_ms, ack_level, expires_ms, attempts
             FROM outbox
             WHERE ack_level < ?1
               AND (expires_ms IS NULL OR expires_ms > ?2)
               AND next_retry_ms <= ?2
             ORDER BY priority ASC, created_ms ASC, msg_id ASC
             LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(
                params![AckLevel::Delivered.as_i64(), now_ms, limit as i64],
                |row| Ok(msg_row_from_outbox(row)),
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut out = Vec::with_capacity(rows.len());
        for mut msg in rows {
            msg.targets = target_devices(&conn, &msg.msg_id)?;
            out.push(msg);
        }
        Ok(out)
    }

    /// 按会话读 outbox 行（`created_ms` 升序，含 per-target 快照；只读）。
    ///
    /// 影子读/对账用：不按优先级出队、不跳过过期，原样把该会话的发送队列摊开，
    /// 让调用方自己判定“哪些还算待发”（例如 `ack_level < Delivered`）。
    pub fn outbox_rows(&self, conv_id: &str) -> Result<Vec<MsgRow>> {
        if conv_id.is_empty() {
            return Err(Error::Invalid("conv_id must not be empty".to_string()));
        }
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT msg_id, conv_id, kind, priority, payload, created_ms, ack_level, expires_ms, attempts
             FROM outbox WHERE conv_id = ?1
             ORDER BY created_ms ASC, msg_id ASC",
        )?;
        let rows = stmt
            .query_map(params![conv_id], |row| Ok(msg_row_from_outbox(row)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut out = Vec::with_capacity(rows.len());
        for mut msg in rows {
            msg.targets = target_devices(&conn, &msg.msg_id)?;
            out.push(msg);
        }
        Ok(out)
    }

    /// 某条消息的 per-target 状态（群/多端投递进度）。
    pub fn targets(&self, msg_id: &str) -> Result<Vec<TargetState>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT msg_id, target_device, ack_level, delivered_ms
             FROM outbox_targets WHERE msg_id = ?1 ORDER BY target_device ASC",
        )?;
        let rows = stmt
            .query_map(params![msg_id], |row| {
                Ok(TargetState {
                    msg_id: row.get(0)?,
                    target_device: row.get(1)?,
                    ack_level: AckLevel::from_i64(row.get::<_, i64>(2)?),
                    delivered_ms: row.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// 记录一次投递尝试：`attempts += 1` 并设置下次可重试时刻（退避）。
    pub fn record_attempt(&self, msg_id: &str, next_retry_ms: i64) -> Result<()> {
        let conn = self.conn()?;
        let changed = conn.execute(
            "UPDATE outbox SET attempts = attempts + 1, next_retry_ms = ?2 WHERE msg_id = ?1",
            params![msg_id, next_retry_ms],
        )?;
        if changed == 0 {
            return Err(Error::UnknownMessage(msg_id.to_string()));
        }
        Ok(())
    }

    // ── ACK ─────────────────────────────────────────────────────────────

    /// 推进 ACK 水位（`target=None` 时推进消息级；见 [`Store::mark_ack_at`]）。
    pub fn mark_ack(&self, msg_id: &str, level: AckLevel, target: Option<&str>) -> Result<()> {
        self.mark_ack_at(msg_id, level, target, now_ms())
    }

    /// 推进 ACK 水位（显式时间版）。
    ///
    /// 语义（与 channel-proto §5.4 一致，另加 per-target 维度）：
    /// * **只升不降**：`level < 当前` 返回 [`Error::AckRegression`]，状态不变；
    ///   同层重复 = 幂等 `Ok(())`。
    /// * `target=Some(dev)`：只动这一行的 `outbox_targets.ack_level`，并把
    ///   `delivered_ms` 在首次跨过 `Delivered` 时补上（`Read` 不会清空它）。
    ///   随后消息级 `outbox.ack_level` = 所有目标的最小值 —— 群里三个目标只送达
    ///   一个时，消息整体仍是 `Accepted`（修审计发现 3）。
    /// * `target=None`：没有目标行时直接写消息级水位；有目标行时扇出到所有目标
    ///   （“整体到达” = 每个目标都到达），已高于该层级的目不受影响。
    pub fn mark_ack_at(
        &self,
        msg_id: &str,
        level: AckLevel,
        target: Option<&str>,
        now_ms: i64,
    ) -> Result<()> {
        if msg_id.is_empty() {
            return Err(Error::Invalid("msg_id must not be empty".to_string()));
        }
        self.transaction(|tx| mark_ack_tx(tx, msg_id, level, target, now_ms))
    }

    // ── 序号 / 同步 / 游标 ───────────────────────────────────────────────

    /// 分配会话内单调序号（事务内执行，从 1 开始）。
    ///
    /// 每个会话独立计数：`conv-a` 与 `conv-b` 都从 1 开始，互不影响
    /// （修审计发现 2 的“没有信道序号”）。
    pub fn assign_seq(&self, conv_id: &str) -> Result<i64> {
        if conv_id.is_empty() {
            return Err(Error::Invalid("conv_id must not be empty".to_string()));
        }
        self.transaction(|tx| alloc_seq(tx, conv_id))
    }

    /// 增量同步：返回 `seq > cursor` 的行，按 `seq` 升序。
    ///
    /// 纯读，不推进 cursor；`device_id` 只用于语义归属（多设备各自维护自己的 cursor）。
    pub fn sync_since(&self, conv_id: &str, device_id: &str, cursor: i64) -> Result<Vec<MsgRow>> {
        if conv_id.is_empty() {
            return Err(Error::Invalid("conv_id must not be empty".to_string()));
        }
        if device_id.is_empty() {
            return Err(Error::Invalid("device_id must not be empty".to_string()));
        }
        let conn = self.conn()?;
        sync_tx(&conn, conv_id, cursor, None)
    }

    /// 用该设备已存的 cursor 做增量同步（等价于 `sync_since(conv, device, cursor(device, conv))`）。
    pub fn sync_incremental(&self, conv_id: &str, device_id: &str) -> Result<Vec<MsgRow>> {
        let cursor = self.cursor(device_id, conv_id)?;
        self.sync_since(conv_id, device_id, cursor)
    }

    /// 批量增量同步（单读事务 = 一致快照；性能用）。返回与查询一一对应的 `(conv_id, rows)`。
    pub fn sync_batch(&self, queries: &[SyncQuery]) -> Result<Vec<(String, Vec<MsgRow>)>> {
        self.transaction(|tx| {
            let mut out = Vec::with_capacity(queries.len());
            for query in queries {
                if query.conv_id.is_empty() || query.device_id.is_empty() {
                    return Err(Error::Invalid(
                        "sync_batch requires non-empty conv_id and device_id".to_string(),
                    ));
                }
                let rows = sync_tx(tx, &query.conv_id, query.cursor, query.limit)?;
                out.push((query.conv_id.clone(), rows));
            }
            Ok(out)
        })
    }

    /// 读整段会话日志（`seq` 升序，只读；不推进任何 cursor）。
    ///
    /// 与 [`Store::sync_since`] 的区别：不需要 device_id/cursor，供**影子读导出**
    /// 与迁移后对账使用（MSG-20 / T104）。`seq` 序就是新栈的会话顺序，
    /// 调用方不要在这里再按时间重排。
    pub fn conv_log_rows(&self, conv_id: &str) -> Result<Vec<MsgRow>> {
        if conv_id.is_empty() {
            return Err(Error::Invalid("conv_id must not be empty".to_string()));
        }
        let conn = self.conn()?;
        sync_tx(&conn, conv_id, 0, None)
    }

    /// 推进 per-device cursor（单调，低值被忽略，不会回退）。
    pub fn advance_cursor(&self, device_id: &str, conv_id: &str, seq: i64) -> Result<i64> {
        self.advance_cursor_at(device_id, conv_id, seq, now_ms())
    }

    /// 推进 per-device cursor（显式时间版）。
    pub fn advance_cursor_at(
        &self,
        device_id: &str,
        conv_id: &str,
        seq: i64,
        now_ms: i64,
    ) -> Result<i64> {
        if device_id.is_empty() || conv_id.is_empty() {
            return Err(Error::Invalid(
                "advance_cursor requires non-empty device_id and conv_id".to_string(),
            ));
        }
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO cursors(device_id, conv_id, seq, updated_ms) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(device_id, conv_id) DO UPDATE SET
                 seq = CASE WHEN excluded.seq > cursors.seq THEN excluded.seq ELSE cursors.seq END,
                 updated_ms = CASE WHEN excluded.seq > cursors.seq THEN excluded.updated_ms ELSE cursors.updated_ms END",
            params![device_id, conv_id, seq, now_ms],
        )?;
        Ok(conn.query_row(
            "SELECT seq FROM cursors WHERE device_id = ?1 AND conv_id = ?2",
            params![device_id, conv_id],
            |row| row.get(0),
        )?)
    }

    /// 读某设备在某会话的 cursor（无记录为 0）。
    pub fn cursor(&self, device_id: &str, conv_id: &str) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT seq FROM cursors WHERE device_id = ?1 AND conv_id = ?2",
                params![device_id, conv_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    // ── 去重 ────────────────────────────────────────────────────────────

    /// 查去重窗口（`None` = 不在窗口内）。
    pub fn dedup_entry(&self, msg_id: &str) -> Result<Option<DedupEntry>> {
        let conn = self.conn()?;
        dedup_lookup(&conn, msg_id)
    }

    /// 淘汰去重窗口中 `seen_ms <= now - window` 的行，返回淘汰条数。
    pub fn purge_dedup(&self, now_ms: i64) -> Result<usize> {
        let window = self.cfg.dedup_window_ms;
        self.transaction(|tx| purge_dedup_tx(tx, now_ms, window))
    }

    // ── TTL / 统计 ──────────────────────────────────────────────────────

    /// 清理 TTL 到期的 outbox 行（连同其 outbox_targets），返回清理条数。
    ///
    /// 同时做一次去重窗口淘汰（`dedup` 按 `seen_ms`）。**不动 `conv_log`**：
    /// 会话日志是长期记录，TTL 只约束投递队列（与 channel-proto §7.2 同口径）。
    pub fn sweep_expired(&self, now_ms: i64) -> Result<usize> {
        let window = self.cfg.dedup_window_ms;
        self.transaction(|tx| {
            let expired: i64 = tx.query_row(
                "SELECT COUNT(*) FROM outbox WHERE expires_ms IS NOT NULL AND expires_ms <= ?1",
                params![now_ms],
                |row| row.get(0),
            )?;
            if expired > 0 {
                tx.execute(
                    "DELETE FROM outbox_targets WHERE msg_id IN
                     (SELECT msg_id FROM outbox WHERE expires_ms IS NOT NULL AND expires_ms <= ?1)",
                    params![now_ms],
                )?;
                tx.execute(
                    "DELETE FROM outbox WHERE expires_ms IS NOT NULL AND expires_ms <= ?1",
                    params![now_ms],
                )?;
                counter_add(tx, COUNTER_EXPIRED, expired)?;
            }
            purge_dedup_tx(tx, now_ms, window)?;
            Ok(expired as usize)
        })
    }

    /// 统计（用系统当前时间判定过期）。
    pub fn stats(&self) -> Result<Stats> {
        self.stats_at(now_ms())
    }

    /// 统计（显式时间版）。
    pub fn stats_at(&self, now_ms: i64) -> Result<Stats> {
        let conn = self.conn()?;
        let (total, durable, delivered, read): (i64, i64, i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN ack_level >= 1 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN ack_level >= 2 THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN ack_level >= 3 THEN 1 ELSE 0 END), 0)
             FROM outbox",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )?;

        let mut by_priority: Vec<(i32, i64)> = Vec::new();
        {
            let mut stmt = conn.prepare(
                "SELECT priority, COUNT(*) FROM outbox
                 WHERE ack_level < 2 AND (expires_ms IS NULL OR expires_ms > ?1)
                 GROUP BY priority ORDER BY priority ASC",
            )?;
            let rows = stmt.query_map(params![now_ms], |row| {
                Ok((row.get::<_, i64>(0)? as i32, row.get::<_, i64>(1)?))
            })?;
            for row in rows {
                by_priority.push(row?);
            }
        }
        let pending: i64 = by_priority.iter().map(|(_, count)| *count).sum();

        let (targets_total, targets_delivered): (i64, i64) = conn.query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN ack_level >= 2 THEN 1 ELSE 0 END), 0)
             FROM outbox_targets",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let dedup_rows: i64 = conn.query_row("SELECT COUNT(*) FROM dedup", [], |row| row.get(0))?;

        Ok(Stats {
            pending,
            durable,
            delivered,
            read,
            deduped: counter_get(&conn, COUNTER_DEDUPED)?,
            dedup_rows,
            expired: counter_get(&conn, COUNTER_EXPIRED)?,
            by_priority,
            total_outbox: total,
            targets_total,
            targets_delivered,
        })
    }

    // ── 小灵 / 申诉通知 ─────────────────────────────────────────────────

    /// 登记一条通知（幂等）。返回是否首次登记。
    ///
    /// `conv_id` 用于把通知挂到会话（小灵会话/系统会话），同时写一条 `dedup`
    /// 记录——审计 §2.3 的现状正是“通知以 `msgId = noticeId` 落在小灵会话里”，
    /// 因此通知 id 与消息 id 共用同一去重窗口，重复投递天然幂等。
    pub fn enqueue_notice(&self, notice_id: &str, conv_id: &str) -> Result<bool> {
        self.enqueue_notice_at(notice_id, conv_id, now_ms())
    }

    /// 登记通知（显式时间版）。
    pub fn enqueue_notice_at(&self, notice_id: &str, conv_id: &str, now_ms: i64) -> Result<bool> {
        if notice_id.is_empty() || conv_id.is_empty() {
            return Err(Error::Invalid(
                "enqueue_notice requires non-empty notice_id and conv_id".to_string(),
            ));
        }
        self.transaction(|tx| {
            let inserted = tx.execute(
                "INSERT OR IGNORE INTO notice_state(notice_id) VALUES(?1)",
                params![notice_id],
            )?;
            dedup_upsert(tx, notice_id, conv_id, now_ms)?;
            Ok(inserted == 1)
        })
    }

    /// 标记通知已落地（幂等：保留首次 `delivered_ms`）。
    ///
    /// 2026-10-23 修复：**先 upsert 再标记**——迁移来的历史通知只有 conv_log 行、
    /// 没有 notice_state 行，直接 UPDATE 会 `UnknownNotice` 被静默跳过（真机实测
    /// 回填 0 条）。现在缺行时先 `INSERT OR IGNORE` 登记，再标记（语义：见过即登记）。
    pub fn mark_notice_delivered(&self, notice_id: &str, now_ms: i64) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO notice_state(notice_id) VALUES(?1)",
            params![notice_id],
        )?;
        let changed = conn.execute(
            "UPDATE notice_state SET delivered_ms = COALESCE(delivered_ms, ?2) WHERE notice_id = ?1",
            params![notice_id, now_ms],
        )?;
        if changed == 0 {
            return Err(Error::UnknownNotice(notice_id.to_string()));
        }
        Ok(())
    }

    /// 标记通知已读（幂等：保留首次 `read_ms`；已读隐含已送达）。
    ///
    /// 2026-10-23 修复：同 [`Store::mark_notice_delivered`]——历史通知（迁移而来）
    /// 没有 notice_state 行，先 upsert 再标记，避免 `UnknownNotice` 静默丢失。
    pub fn mark_notice_read(&self, notice_id: &str, now_ms: i64) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT OR IGNORE INTO notice_state(notice_id) VALUES(?1)",
            params![notice_id],
        )?;
        let changed = conn.execute(
            "UPDATE notice_state
             SET read_ms = COALESCE(read_ms, ?2),
                 delivered_ms = COALESCE(delivered_ms, ?2)
             WHERE notice_id = ?1",
            params![notice_id, now_ms],
        )?;
        if changed == 0 {
            return Err(Error::UnknownNotice(notice_id.to_string()));
        }
        Ok(())
    }

    /// 对账 outbox：删除**旧侧已不在待发集合**里的行（迁移快照后旧栈送达并清账，
    /// DB 若不跟随会积累假 pending——2026-10-23 真机实测 0/30）。
    /// 返回删除条数。S2 口径：outbox 归旧栈独占，DB 侧仅报表（设计 §2.3 D2/D8）。
    pub fn reconcile_outbox(&self, keep_msg_ids: &[String]) -> Result<usize> {
        self.transaction(|tx| {
            let all: Vec<String> = {
                let mut stmt = tx.prepare("SELECT msg_id FROM outbox")?;
                let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
                let mut v = Vec::new();
                for r in rows {
                    v.push(r?);
                }
                v
            };
            let keep: std::collections::HashSet<&String> = keep_msg_ids.iter().collect();
            let mut removed = 0usize;
            for id in all {
                if !keep.contains(&id) {
                    tx.execute("DELETE FROM outbox_targets WHERE msg_id = ?1", params![id])?;
                    tx.execute("DELETE FROM outbox WHERE msg_id = ?1", params![id])?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
    }

    /// 播种历史通知三态（迁移用）：notice_id 登记 + delivered=旧 ts（历史消息确实收到过；
    /// read 留空——读态是设备本地的，打开会话时回填）。幂等：已存在的行不动。
    pub fn seed_notice_delivered(&self, notice_id: &str, delivered_ms: i64) -> Result<()> {
        let conn = self.conn()?;
        conn.execute(
            "INSERT INTO notice_state(notice_id, delivered_ms) VALUES(?1, ?2)
             ON CONFLICT(notice_id) DO UPDATE SET delivered_ms = COALESCE(notice_state.delivered_ms, excluded.delivered_ms)",
            params![notice_id, delivered_ms],
        )?;
        Ok(())
    }

    /// 该 msgId 是否已在库里（去重表或会话日志任一命中）——启动对账用。
    pub fn contains_msg(&self, msg_id: &str) -> Result<bool> {
        let conn = self.conn()?;
        let hit: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM dedup WHERE msg_id = ?1
                 UNION ALL
                 SELECT 1 FROM conv_log WHERE msg_id = ?1
                 LIMIT 1",
                params![msg_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(hit.is_some())
    }

    /// 通知三态计数：`(total, delivered, read)`（S4 验收/状态面用）。
    pub fn notice_stats(&self) -> Result<(i64, i64, i64)> {
        let conn = self.conn()?;
        Ok(conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE WHEN delivered_ms IS NOT NULL THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN read_ms IS NOT NULL THEN 1 ELSE 0 END), 0)
             FROM notice_state",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?)
    }

    /// 列出全部游标行 `(device_id, conv_id, seq)`（未读汇总用）。
    pub fn cursors_all(&self) -> Result<Vec<(String, String, i64)>> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT device_id, conv_id, seq FROM cursors ORDER BY conv_id")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// 某会话的最大 seq（无消息返回 0）。
    pub fn conv_max_seq(&self, conv_id: &str) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT COALESCE(MAX(seq), 0) FROM conv_log WHERE conv_id = ?1",
                params![conv_id],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or(0))
    }

    /// 读通知状态（不存在返回 `None`）。
    pub fn notice_state(&self, notice_id: &str) -> Result<Option<NoticeState>> {
        let conn = self.conn()?;
        Ok(conn
            .query_row(
                "SELECT notice_id, delivered_ms, read_ms FROM notice_state WHERE notice_id = ?1",
                params![notice_id],
                |row| {
                    Ok(NoticeState {
                        notice_id: row.get(0)?,
                        delivered_ms: row.get(1)?,
                        read_ms: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    // ── 计数（迁移对账 / 运维核对用）────────────────────────────────────

    /// outbox 行数。
    pub fn outbox_len(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))?)
    }

    /// outbox_targets 行数。
    pub fn outbox_targets_len(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM outbox_targets", [], |row| row.get(0))?)
    }

    /// conv_log 行数（`conv_id=None` 为全库）。
    pub fn conv_log_len(&self, conv_id: Option<&str>) -> Result<i64> {
        let conn = self.conn()?;
        match conv_id {
            Some(conv) => Ok(conn.query_row(
                "SELECT COUNT(*) FROM conv_log WHERE conv_id = ?1",
                params![conv],
                |row| row.get(0),
            )?),
            None => Ok(conn.query_row("SELECT COUNT(*) FROM conv_log", [], |row| row.get(0))?),
        }
    }

    /// inbox 行数（`conv_id=None` 为全库）。
    pub fn inbox_len(&self, conv_id: Option<&str>) -> Result<i64> {
        let conn = self.conn()?;
        match conv_id {
            Some(conv) => Ok(conn.query_row(
                "SELECT COUNT(*) FROM inbox WHERE conv_id = ?1",
                params![conv],
                |row| row.get(0),
            )?),
            None => Ok(conn.query_row("SELECT COUNT(*) FROM inbox", [], |row| row.get(0))?),
        }
    }

    /// dedup 行数。
    pub fn dedup_len(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM dedup", [], |row| row.get(0))?)
    }

    /// cursors 行数。
    pub fn cursor_len(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM cursors", [], |row| row.get(0))?)
    }

    /// notice_state 行数。
    pub fn notice_len(&self) -> Result<i64> {
        let conn = self.conn()?;
        Ok(conn.query_row("SELECT COUNT(*) FROM notice_state", [], |row| row.get(0))?)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 事务内原语（migrate 模块复用；都要求调用方已在事务里）
// ─────────────────────────────────────────────────────────────────────────────

/// 分配会话内序号（`conv_seq` +1 后读取；调用方负责事务）。
pub(crate) fn alloc_seq(conn: &Connection, conv_id: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO conv_seq(conv_id, next_seq) VALUES(?1, 0) ON CONFLICT(conv_id) DO NOTHING",
        params![conv_id],
    )?;
    conn.execute(
        "UPDATE conv_seq SET next_seq = next_seq + 1 WHERE conv_id = ?1",
        params![conv_id],
    )?;
    Ok(conn.query_row(
        "SELECT next_seq FROM conv_seq WHERE conv_id = ?1",
        params![conv_id],
        |row| row.get(0),
    )?)
}

/// 查 `conv_log` 里某个 msg_id 的序号（长尾幂等兜底）。
pub(crate) fn conv_log_seq_of(conn: &Connection, conv_id: &str, msg_id: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT seq FROM conv_log WHERE conv_id = ?1 AND msg_id = ?2",
            params![conv_id, msg_id],
            |row| row.get(0),
        )
        .optional()?)
}

/// 查去重窗口。
pub(crate) fn dedup_lookup(conn: &Connection, msg_id: &str) -> Result<Option<DedupEntry>> {
    Ok(conn
        .query_row(
            "SELECT msg_id, conv_id, seen_ms FROM dedup WHERE msg_id = ?1",
            params![msg_id],
            |row| {
                Ok(DedupEntry {
                    msg_id: row.get(0)?,
                    conv_id: row.get(1)?,
                    seen_ms: row.get(2)?,
                })
            },
        )
        .optional()?)
}

/// 写/刷新去重记录（保留首次的 conv_id，只刷新 seen_ms）。
pub(crate) fn dedup_upsert(
    conn: &Connection,
    msg_id: &str,
    conv_id: &str,
    seen_ms: i64,
) -> Result<()> {
    conn.execute(
        "INSERT INTO dedup(msg_id, conv_id, seen_ms) VALUES(?1, ?2, ?3)
         ON CONFLICT(msg_id) DO UPDATE SET seen_ms = excluded.seen_ms",
        params![msg_id, conv_id, seen_ms],
    )?;
    Ok(())
}

/// 读计数器。
pub(crate) fn counter_get(conn: &Connection, name: &str) -> Result<i64> {
    Ok(conn
        .query_row(
            "SELECT value FROM counters WHERE name = ?1",
            params![name],
            |row| row.get(0),
        )
        .optional()?
        .unwrap_or(0))
}

/// 累加计数器（不存在则从 delta 开始）。
pub(crate) fn counter_add(conn: &Connection, name: &str, delta: i64) -> Result<()> {
    conn.execute(
        "INSERT INTO counters(name, value) VALUES(?1, ?2)
         ON CONFLICT(name) DO UPDATE SET value = counters.value + excluded.value",
        params![name, delta],
    )?;
    Ok(())
}

/// 淘汰去重窗口（调用方负责事务）。返回淘汰条数。
pub(crate) fn purge_dedup_tx(conn: &Connection, now_ms: i64, window_ms: i64) -> Result<usize> {
    let cutoff = now_ms.saturating_sub(window_ms.max(0));
    let removed = conn.execute("DELETE FROM dedup WHERE seen_ms <= ?1", params![cutoff])?;
    if removed > 0 {
        counter_add(conn, COUNTER_DEDUP_PURGED, removed as i64)?;
    }
    Ok(removed)
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────────────────────

fn validate_row(row: &MsgRow) -> Result<()> {
    if row.msg_id.is_empty() {
        return Err(Error::Invalid("msg_id must not be empty".to_string()));
    }
    if row.conv_id.is_empty() {
        return Err(Error::Invalid("conv_id must not be empty".to_string()));
    }
    Ok(())
}

fn enqueue_tx(conn: &Connection, row: &MsgRow) -> Result<EnqueueOutcome> {
    validate_row(row)?;
    // 1) 去重窗口命中：直接幂等返回
    if dedup_lookup(conn, &row.msg_id)?.is_some() {
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate {
            seq: conv_log_seq_of(conn, &row.conv_id, &row.msg_id)?,
        });
    }
    // 2) 窗口已过期但会话日志里还在：刷新窗口，不重复写（长尾幂等）
    if let Some(seq) = conv_log_seq_of(conn, &row.conv_id, &row.msg_id)? {
        dedup_upsert(conn, &row.msg_id, &row.conv_id, row.created_ms.max(0))?;
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate { seq: Some(seq) });
    }
    // 3) 正常写入
    let seq = alloc_seq(conn, &row.conv_id)?;
    let inserted = insert_conv_log(conn, row, seq)?;
    if inserted == 0 {
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate {
            seq: conv_log_seq_of(conn, &row.conv_id, &row.msg_id)?,
        });
    }
    conn.execute(
        "INSERT INTO outbox(msg_id, conv_id, kind, priority, payload, created_ms,
                            ack_level, expires_ms, attempts, next_retry_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0)",
        params![
            row.msg_id,
            row.conv_id,
            row.kind.as_str(),
            row.priority,
            row.payload,
            row.created_ms,
            row.ack_level.as_i64(),
            row.expires_ms,
            row.attempts.max(0),
        ],
    )?;
    insert_targets(conn, row, row.ack_level, row.created_ms)?;
    dedup_upsert(conn, &row.msg_id, &row.conv_id, row.created_ms.max(0))?;
    Ok(EnqueueOutcome::Inserted { seq })
}

/// 镜像专用：只写 `conv_log` + `dedup`（不建 outbox/inbox）。
fn conv_mirror_tx(conn: &Connection, row: &MsgRow) -> Result<EnqueueOutcome> {
    validate_row(row)?;
    if dedup_lookup(conn, &row.msg_id)?.is_some() {
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate {
            seq: conv_log_seq_of(conn, &row.conv_id, &row.msg_id)?,
        });
    }
    if let Some(seq) = conv_log_seq_of(conn, &row.conv_id, &row.msg_id)? {
        dedup_upsert(conn, &row.msg_id, &row.conv_id, row.created_ms.max(0))?;
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate { seq: Some(seq) });
    }
    let seq = alloc_seq(conn, &row.conv_id)?;
    let inserted = insert_conv_log(conn, row, seq)?;
    if inserted == 0 {
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate {
            seq: conv_log_seq_of(conn, &row.conv_id, &row.msg_id)?,
        });
    }
    dedup_upsert(conn, &row.msg_id, &row.conv_id, row.created_ms.max(0))?;
    Ok(EnqueueOutcome::Inserted { seq })
}

fn ingest_tx(conn: &Connection, row: &MsgRow) -> Result<EnqueueOutcome> {
    validate_row(row)?;
    if dedup_lookup(conn, &row.msg_id)?.is_some() {
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate {
            seq: conv_log_seq_of(conn, &row.conv_id, &row.msg_id)?,
        });
    }
    if let Some(seq) = conv_log_seq_of(conn, &row.conv_id, &row.msg_id)? {
        dedup_upsert(conn, &row.msg_id, &row.conv_id, row.created_ms.max(0))?;
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate { seq: Some(seq) });
    }
    let seq = alloc_seq(conn, &row.conv_id)?;
    let inserted = insert_conv_log(conn, row, seq)?;
    if inserted == 0 {
        counter_add(conn, COUNTER_DEDUPED, 1)?;
        return Ok(EnqueueOutcome::Duplicate {
            seq: conv_log_seq_of(conn, &row.conv_id, &row.msg_id)?,
        });
    }
    // 入向通知（官方通知走 ingest 路径）：登记 + delivered=接收时间
    if row.kind == Kind::Notice {
        conn.execute(
            "INSERT INTO notice_state(notice_id, delivered_ms) VALUES(?1, ?2)
             ON CONFLICT(notice_id) DO UPDATE SET delivered_ms = COALESCE(notice_state.delivered_ms, excluded.delivered_ms)",
            params![row.msg_id, row.created_ms],
        )?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO inbox(conv_id, msg_id, seq, sender_device, payload, recv_ms)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            row.conv_id,
            row.msg_id,
            seq,
            row.sender_device,
            row.payload,
            row.created_ms,
        ],
    )?;
    dedup_upsert(conn, &row.msg_id, &row.conv_id, row.created_ms.max(0))?;
    Ok(EnqueueOutcome::Inserted { seq })
}

fn insert_conv_log(conn: &Connection, row: &MsgRow, seq: i64) -> Result<usize> {
    Ok(conn.execute(
        "INSERT OR IGNORE INTO conv_log(conv_id, seq, msg_id, direction, payload, created_ms, kind, wire_kind)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            row.conv_id,
            seq,
            row.msg_id,
            row.direction.as_str(),
            row.payload,
            row.created_ms,
            row.kind.as_str(),
            row.wire_kind,
        ],
    )?)
}

fn insert_targets(
    conn: &Connection,
    row: &MsgRow,
    ack_level: AckLevel,
    delivered_ms: i64,
) -> Result<()> {
    if row.targets.is_empty() {
        return Ok(());
    }
    let delivered = if ack_level >= AckLevel::Delivered {
        Some(delivered_ms)
    } else {
        None
    };
    for target in &row.targets {
        conn.execute(
            "INSERT OR IGNORE INTO outbox_targets(msg_id, target_device, delivered_ms, ack_level)
             VALUES(?1, ?2, ?3, ?4)",
            params![row.msg_id, target, delivered, ack_level.as_i64()],
        )?;
    }
    Ok(())
}

fn mark_ack_tx(
    conn: &Connection,
    msg_id: &str,
    level: AckLevel,
    target: Option<&str>,
    now_ms: i64,
) -> Result<()> {
    let current: Option<i64> = conn
        .query_row(
            "SELECT ack_level FROM outbox WHERE msg_id = ?1",
            params![msg_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(current) = current else {
        return Err(Error::UnknownMessage(msg_id.to_string()));
    };
    let current = AckLevel::from_i64(current);

    if let Some(target_device) = target {
        let target_current: Option<i64> = conn
            .query_row(
                "SELECT ack_level FROM outbox_targets WHERE msg_id = ?1 AND target_device = ?2",
                params![msg_id, target_device],
                |row| row.get(0),
            )
            .optional()?;
        let Some(target_current) = target_current else {
            return Err(Error::UnknownTarget {
                msg_id: msg_id.to_string(),
                target: target_device.to_string(),
            });
        };
        let target_current = AckLevel::from_i64(target_current);
        if level < target_current {
            return Err(Error::AckRegression {
                from: target_current,
                to: level,
            });
        }
        if level > target_current {
            if level >= AckLevel::Delivered {
                conn.execute(
                    "UPDATE outbox_targets
                     SET ack_level = ?3, delivered_ms = COALESCE(delivered_ms, ?4)
                     WHERE msg_id = ?1 AND target_device = ?2",
                    params![msg_id, target_device, level.as_i64(), now_ms],
                )?;
            } else {
                conn.execute(
                    "UPDATE outbox_targets SET ack_level = ?3 WHERE msg_id = ?1 AND target_device = ?2",
                    params![msg_id, target_device, level.as_i64()],
                )?;
            }
        }
        refresh_aggregate(conn, msg_id)?;
        return Ok(());
    }

    // 消息级：先取所有目标的当前水位（用于回退判定），再扇出
    let targets: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT ack_level FROM outbox_targets WHERE msg_id = ?1")?;
        let rows = stmt
            .query_map(params![msg_id], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    if targets.is_empty() {
        if level < current {
            return Err(Error::AckRegression {
                from: current,
                to: level,
            });
        }
        if level > current {
            conn.execute(
                "UPDATE outbox SET ack_level = ?2 WHERE msg_id = ?1",
                params![msg_id, level.as_i64()],
            )?;
        }
        return Ok(());
    }

    let min_target = targets
        .into_iter()
        .map(AckLevel::from_i64)
        .min()
        .unwrap_or(AckLevel::Accepted);
    if level < min_target {
        return Err(Error::AckRegression {
            from: min_target,
            to: level,
        });
    }
    if level >= AckLevel::Delivered {
        conn.execute(
            "UPDATE outbox_targets
             SET ack_level = ?2, delivered_ms = COALESCE(delivered_ms, ?3)
             WHERE msg_id = ?1 AND ack_level < ?2",
            params![msg_id, level.as_i64(), now_ms],
        )?;
    } else {
        conn.execute(
            "UPDATE outbox_targets SET ack_level = ?2 WHERE msg_id = ?1 AND ack_level < ?2",
            params![msg_id, level.as_i64()],
        )?;
    }
    refresh_aggregate(conn, msg_id)?;
    Ok(())
}

/// 消息级 ACK = 所有目标的最小水位，只升不降。
fn refresh_aggregate(conn: &Connection, msg_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE outbox
         SET ack_level = (SELECT MIN(ack_level) FROM outbox_targets WHERE msg_id = ?1)
         WHERE msg_id = ?1
           AND ack_level < (SELECT MIN(ack_level) FROM outbox_targets WHERE msg_id = ?1)",
        params![msg_id],
    )?;
    Ok(())
}

fn sync_tx(
    conn: &Connection,
    conv_id: &str,
    cursor: i64,
    limit: Option<usize>,
) -> Result<Vec<MsgRow>> {
    let limit = limit.map(|n| n as i64).unwrap_or(-1);
    let mut stmt = conn.prepare(
        "SELECT c.seq, c.msg_id, c.conv_id, c.direction, c.payload, c.created_ms,
                c.kind, c.wire_kind,
                o.priority, o.ack_level, o.expires_ms, o.attempts, i.sender_device
         FROM conv_log c
         LEFT JOIN outbox o ON o.msg_id = c.msg_id
         LEFT JOIN inbox  i ON i.conv_id = c.conv_id AND i.msg_id = c.msg_id
         WHERE c.conv_id = ?1 AND c.seq > ?2
         ORDER BY c.seq ASC
         LIMIT ?3",
    )?;
    let raw = stmt
        .query_map(params![conv_id, cursor, limit], |row| {
            let direction_raw: String = row.get(3)?;
            let kind_raw: String = row.get(6)?;
            let kind = Kind::parse(&kind_raw).unwrap_or(Kind::Control);
            let priority: Option<i64> = row.get(8)?;
            Ok(MsgRow {
                seq: row.get(0)?,
                msg_id: row.get(1)?,
                conv_id: row.get(2)?,
                direction: Direction::parse(&direction_raw),
                payload: row.get(4)?,
                created_ms: row.get(5)?,
                kind,
                wire_kind: row.get(7)?,
                priority: priority.map(|p| p as i32).unwrap_or_else(|| kind.priority_hint()),
                ack_level: AckLevel::from_i64(row.get::<_, Option<i64>>(9)?.unwrap_or(0)),
                expires_ms: row.get(10)?,
                attempts: row.get::<_, Option<i64>>(11)?.unwrap_or(0),
                sender_device: row.get(12)?,
                targets: Vec::new(),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    // 只给 outbox 里存在的消息补 targets（收到的消息没有 outbox 行）
    let mut out = Vec::with_capacity(raw.len());
    for mut msg in raw {
        let in_outbox = conn
            .query_row(
                "SELECT 1 FROM outbox WHERE msg_id = ?1",
                params![msg.msg_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if in_outbox {
            msg.targets = target_devices(conn, &msg.msg_id)?;
        }
        out.push(msg);
    }
    Ok(out)
}

fn target_devices(conn: &Connection, msg_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT target_device FROM outbox_targets WHERE msg_id = ?1 ORDER BY target_device ASC",
    )?;
    let rows = stmt
        .query_map(params![msg_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn msg_row_from_outbox(row: &rusqlite::Row<'_>) -> MsgRow {
    let kind_raw: String = row.get(2).unwrap_or_default();
    let kind = Kind::parse(&kind_raw).unwrap_or(Kind::Control);
    MsgRow {
        msg_id: row.get(0).unwrap_or_default(),
        conv_id: row.get(1).unwrap_or_default(),
        kind,
        priority: row.get::<_, i64>(3).unwrap_or(0) as i32,
        payload: row.get(4).unwrap_or_default(),
        created_ms: row.get(5).unwrap_or(0),
        ack_level: AckLevel::from_i64(row.get::<_, i64>(6).unwrap_or(0)),
        expires_ms: row.get(7).unwrap_or(None),
        attempts: row.get(8).unwrap_or(0),
        seq: 0,
        sender_device: None,
        direction: Direction::Out,
        targets: Vec::new(),
        wire_kind: None,
    }
}
