//! offline_queue.rs — 第95轮：本地待发队列（纯本地 P2P 语义，无服务器信箱）。
//!
//! 背景（2026-09-29 用户实测）：对方不在线时 deliver 失败，消息虽落本地 jsonl
//! （对账最终能补），但①要等 60s 对账周期，无"对方一上线就补发"的即时性；
//! ②UI 无发送状态反馈，用户感知"消息发不出去"。本模块给出最小闭环：
//!
//! - deliver 失败（离线/网络不通）→ 信封入本地 persistent 队列
//!   （chat/outbox.json；重启/切账号后仍在——与 chat/ 目录同生命周期）。
//! - 触发重发：presence 轮询发现对方上线（chat_presence 新晋上线检测）/
//!   对账建立成功（sync_loop/chat_sync_now）→ 逐条重发；成功→出队 + 消息行
//!   sendState 翻 "sent"。重发保持原 envelope（msgId/ts 不变——接收端
//!   conv_append 按 msgId 幂等去重，重复收无害）。
//! - 队列有界：单会话 pending 上限 OUTBOX_MAX_PER_CONV（200）条；溢出消息
//!   不入队、sendState="failed"（"对方长期不在线，消息未送达"），UI 给手动
//!   重发按钮（chat_retry_msg 重建信封立即再试）。
//!
//! 存储：单文件 chat/outbox.json（数组整写——条数有界，性能无虞）。
//! 核心逻辑在 Outbox struct（路径注入，单测零全局态）；模块级 GLOBAL 是
//! 生产实例（config_dir/chat/outbox.json）。

use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Mutex;

/// 单会话待发上限（溢出=对方长期不在线，标失败态手动重发）。
pub const OUTBOX_MAX_PER_CONV: usize = 200;

/// 待发条目有效期：超过就不再自动补发（标 failed，保留给人看/手动重发）。
///
/// 2026-10-19 真案（评测基线采集时发现）：某「lost」账号 bucket 的 outbox 里躺着一条
/// `attempts: 5471` 的旧图消息；PC/笔记本重启后补发环把它和 10 天前的测试消息
/// （`ts-nested-e2e-1791523572789`）重新推给对端——**补发风暴**：消息重复出现、
/// 对端 chat-trace 出现 ms=894557578 的 recv，直接把 R1/R6 的评测数据污染成噪声。
/// 根因不是"离线队列该不该有"，而是**没有 TTL/次数上限**：对端永久不可达时无限重试。
pub const OUTBOX_TTL_MS: i64 = 6 * 3600_000;

/// 单条自动重试次数上限（0.5s~60s 退避下 ≈ 数小时；超过 = 对端长期不可达）。
pub const OUTBOX_MAX_ATTEMPTS: u32 = 300;

/// 补发节奏（纯函数，单测；2026-10-18 fast-ack，两端同式 phone outbox.ts retryDelayMs）：
/// 前台 3s 起指数退避（3/6/12/24/48s）封顶 60s；后台固定 60s（省电/省流量）。
pub fn retry_delay_ms(attempt: u32, foreground: bool) -> u64 {
    if !foreground {
        return 60_000;
    }
    let shift = attempt.min(5); // 3<<5 = 96s → 下面的 min 封 60s
    3_000u64.saturating_mul(1u64 << shift).min(60_000)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 待发条目：信封原样保留（重发=原 msgId 幂等）+ 扇出目标快照 + 状态。
#[derive(Clone, Debug)]
pub struct OutboxItem {
    pub msg_id: String,
    pub conv_id: String,         // 本地会话 id（sendState 回写/按会话清队用）
    pub targets: Vec<String>,    // deliver 目标账号 did（群=成员列表快照）
    pub envelope: Value,         // 完整 wire 信封（/p2p/msg 直推体）
    pub ts: i64,                 // 入队时刻（FIFO 序）
    pub attempts: u32,           // 已重发次数（观测用）
    pub status: String,          // "pending" | "failed"（failed=手动重发前不再自动）
    pub last_error: String,
}

impl OutboxItem {
    fn to_json(&self) -> Value {
        json!({
            "msgId": self.msg_id, "convId": self.conv_id, "targets": self.targets,
            "envelope": self.envelope, "ts": self.ts, "attempts": self.attempts,
            "status": self.status, "lastError": self.last_error,
        })
    }
    fn from_json(v: &Value) -> Option<Self> {
        let msg_id = v.get("msgId")?.as_str()?.to_string();
        if msg_id.is_empty() {
            return None;
        }
        Some(Self {
            msg_id,
            conv_id: v.get("convId").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            targets: v
                .get("targets")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
                .unwrap_or_default(),
            envelope: v.get("envelope").cloned().unwrap_or(json!({})),
            ts: v.get("ts").and_then(|x| x.as_i64()).unwrap_or(0),
            attempts: v.get("attempts").and_then(|x| x.as_u64()).unwrap_or(0) as u32,
            status: v.get("status").and_then(|x| x.as_str()).unwrap_or("pending").to_string(),
            last_error: v.get("lastError").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        })
    }
}

/// 入队结果。
#[derive(Debug, PartialEq)]
pub enum EnqueueOutcome {
    /// 新入队（或同 msgId 已在队——幂等视作成功）。
    Queued,
    /// 单会话 pending 已满——调用方把消息行标 sendState="failed"。
    Overflow,
}

/// 待发队列（路径注入；单测用临时目录实例，生产用 GLOBAL）。
pub struct Outbox {
    path: PathBuf,
    mu: Mutex<()>, // 文件读写互斥（同进程内多任务并发 flush/enqueue）
    /// 2026-10-18 fast-ack：pending 非空的内存提示（补发环 500ms 轮询用——避免每拍
    /// 解析可能很大的 outbox.json；只在 save/pending_accounts 时刷新）。保守初值
    /// true：启动时盘上可能有上次遗留的待发，先让补发环查一轮。
    pending_hint: std::sync::atomic::AtomicBool,
    /// 入队版本号（每次真的入队 +1）：补发环据此发现"有新失败消息入队"→ 立即重置
    /// 退避节奏（新消息的重试不该等上一轮长队退避到 48s 的窗口）。
    enqueue_seq: std::sync::atomic::AtomicU64,
}

impl Outbox {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            mu: Mutex::new(()),
            pending_hint: std::sync::atomic::AtomicBool::new(true),
            enqueue_seq: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// 入队版本号（补发环用：变了=有新 pending 进来，立即重置节奏）。
    pub fn enqueue_seq(&self) -> u64 {
        self.enqueue_seq.load(std::sync::atomic::Ordering::Relaxed)
    }

    fn load(&self) -> Vec<OutboxItem> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(OutboxItem::from_json)
            .collect()
    }

    fn save(&self, items: &[OutboxItem]) {
        if let Some(dir) = self.path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let arr: Vec<Value> = items.iter().map(|i| i.to_json()).collect();
        let _ = std::fs::write(&self.path, serde_json::to_string(&arr).unwrap_or_default());
        // 内存提示随每次落盘同步刷新（补发环热路径只读它）
        self.pending_hint.store(
            items.iter().any(|i| i.status == "pending"),
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// 补发环快路径：**是否有 pending 可能**（true 时再查 pending_accounts 精确枚举）。
    /// 内存位，不解析 outbox.json；任何落盘/枚举都会刷新它。
    pub fn has_pending_hint(&self) -> bool {
        self.pending_hint.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// 入队（幂等：msgId 已在队=Queued 不再重复）。单会话 pending 满 → Overflow。
    pub fn enqueue(&self, conv_id: &str, targets: Vec<String>, envelope: Value) -> EnqueueOutcome {
        let _g = self.mu.lock().unwrap();
        let msg_id = envelope.get("msgId").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if msg_id.is_empty() {
            return EnqueueOutcome::Overflow; // 无 msgId 无法幂等——拒收（调用方标失败）
        }
        let mut items = self.load();
        if items.iter().any(|i| i.msg_id == msg_id) {
            return EnqueueOutcome::Queued; // 幂等：重复入队视作成功
        }
        let pend_in_conv = items.iter().filter(|i| i.conv_id == conv_id && i.status == "pending").count();
        if pend_in_conv >= OUTBOX_MAX_PER_CONV {
            return EnqueueOutcome::Overflow;
        }
        items.push(OutboxItem {
            msg_id,
            conv_id: conv_id.to_string(),
            targets,
            envelope,
            ts: now_ms(),
            attempts: 0,
            status: "pending".into(),
            last_error: String::new(),
        });
        self.save(&items);
        self.enqueue_seq.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        EnqueueOutcome::Queued
    }

    /// 全部待发（含 failed——UI 状态展示/手动重发定位用）。
    pub fn list(&self) -> Vec<OutboxItem> {
        let _g = self.mu.lock().unwrap();
        self.load()
    }

    /// 某账号是否有待发（targets 命中 + status=pending）。
    pub fn has_pending_for_account(&self, account: &str) -> bool {
        let _g = self.mu.lock().unwrap();
        self.load().iter().any(|i| i.status == "pending" && i.targets.iter().any(|t| t == account))
    }

    /// 有待发的账号集合（sync_loop 兜底 flush 枚举用）。顺带刷新 pending 内存提示。
    pub fn pending_accounts(&self) -> Vec<String> {
        let _g = self.mu.lock().unwrap();
        let mut out: Vec<String> = vec![];
        for i in self.load().iter().filter(|i| i.status == "pending") {
            for t in &i.targets {
                if !out.contains(t) {
                    out.push(t.clone());
                }
            }
        }
        self.pending_hint
            .store(!out.is_empty(), std::sync::atomic::Ordering::Relaxed);
        out
    }

    /// 按会话清队（删好友/退群/被踢时调用）。
    pub fn remove_conv(&self, conv_id: &str) {
        let _g = self.mu.lock().unwrap();
        let items = self.load();
        let kept: Vec<_> = items.into_iter().filter(|i| i.conv_id != conv_id).collect();
        self.save(&kept);
    }

    /// 取出某条（手动重发定位；不删）。
    pub fn get(&self, msg_id: &str) -> Option<OutboxItem> {
        let _g = self.mu.lock().unwrap();
        self.load().into_iter().find(|i| i.msg_id == msg_id)
    }

    /// 标 failed（自动重发不再碰；UI 手动重发前提示"长期不在线"）。
    pub fn mark_failed(&self, msg_id: &str, err: &str) {
        let _g = self.mu.lock().unwrap();
        let mut items = self.load();
        if let Some(i) = items.iter_mut().find(|i| i.msg_id == msg_id) {
            i.status = "failed".into();
            i.last_error = err.to_string();
        }
        self.save(&items);
    }

    /// failed → pending（手动重发前复位）。
    pub fn requeue(&self, msg_id: &str) {
        let _g = self.mu.lock().unwrap();
        let mut items = self.load();
        if let Some(i) = items.iter_mut().find(|i| i.msg_id == msg_id) {
            i.status = "pending".into();
        }
        self.save(&items);
    }

    /// 对命中 account 的 pending 条目逐条重发（FIFO=入队序）。
    /// deliver(target, envelope) → 是否送达（注入——prod=deliver_to_account，
    /// 单测=mock）。成功条目出队并返回（调用方回写 sendState="sent"）。
    /// 全部目标送达其一即算成功（与 p2p_send_raw 的 delivered 语义一致）。
    pub async fn flush_account<F, Fut>(&self, account: &str, deliver: F) -> Vec<OutboxItem>
    where
        F: Fn(String, Value) -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        self.flush_account_inner(account, deliver, false, usize::MAX).await
    }

    /// 2026-10-18 fast-ack **限流补发**（前台 3s 补发环用）：FIFO 逐条重发，**遇第一条
    /// 全目标失败即停**（离线期长队不会把一轮补发拖成分钟级——3s 节奏才成立），最多
    /// `max_items` 条；成功条目照常出队。返回成功条目（调用方回写 sendState）。
    pub async fn flush_account_burst<F, Fut>(&self, account: &str, deliver: F, max_items: usize) -> Vec<OutboxItem>
    where
        F: Fn(String, Value) -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        self.flush_account_inner(account, deliver, true, max_items).await
    }

    async fn flush_account_inner<F, Fut>(
        &self,
        account: &str,
        deliver: F,
        stop_on_fail: bool,
        max_items: usize,
    ) -> Vec<OutboxItem>
    where
        F: Fn(String, Value) -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let batch: Vec<OutboxItem> = {
            let _g = self.mu.lock().unwrap();
            self.load()
                .into_iter()
                .filter(|i| i.status == "pending" && i.targets.iter().any(|t| t == account))
                .take(max_items.max(1))
                .collect()
        };
        let mut sent: Vec<OutboxItem> = vec![];
        let mut retired = 0usize;
        let now = now_ms();
        for item in batch {
            // 2026-10-21（真案：笔记本任务页没有 PC 的 DSH 卡）：**设备群任务卡**是账号级数据，
            // 对方设备可能几小时/几天不在线，普通消息的 6h TTL + 300 次上限会让它永久失效
            // （实测 PC outbox 里 attempts=300 的 task-share 卡，对方上线也永不补发）。
            // 对 `task-share` → `grp-dev-*` 条目放宽：TTL 7 天、尝试上限 20000（约每 60s 一轮）。
            let is_device_card = item.envelope.get("kind").and_then(|v| v.as_str()) == Some("task-share")
                && item.envelope.get("to").and_then(|v| v.as_str())
                    .map(|t| t.starts_with("grp-dev-")).unwrap_or(false);
            let (ttl_ms, max_attempts) = if is_device_card {
                (7 * 24 * 3600_000i64, 20_000u32)
            } else {
                (OUTBOX_TTL_MS, OUTBOX_MAX_ATTEMPTS)
            };
            // 过期/超次 → 停自动补发（标 failed 保留，不静默丢；防补发风暴，见常量注释）
            let too_old = now.saturating_sub(item.ts) > ttl_ms;
            let too_many = item.attempts >= max_attempts;
            if too_old || too_many {
                let _g = self.mu.lock().unwrap();
                let mut items = self.load();
                if let Some(i) = items.iter_mut().find(|i| i.msg_id == item.msg_id) {
                    i.status = "failed".into();
                    i.last_error = if too_many {
                        format!("重试 {} 次仍未送达（停自动补发，可手动重发）", i.attempts)
                    } else {
                        "超过离线补发有效期（停自动补发，可手动重发）".into()
                    };
                }
                self.save(&items);
                retired += 1;
                continue;
            }
            let mut ok = false;
            for t in &item.targets {
                // 任一 target 送达即算成功（与 p2p_send_raw 的 delivered 语义一致）——
                // 成功后不再扇其余目标（2026-10-18：群大列表离线时省掉无谓的串行等待，
                // 补发环一轮才够快）。
                if deliver(t.clone(), item.envelope.clone()).await {
                    ok = true;
                    break;
                }
            }
            let _g = self.mu.lock().unwrap();
            let mut items = self.load();
            if ok {
                items.retain(|i| i.msg_id != item.msg_id);
                sent.push(item.clone());
            } else if let Some(i) = items.iter_mut().find(|i| i.msg_id == item.msg_id) {
                i.attempts += 1;
                i.last_error = "对端不可达（仍离线或网络不通）".into();
            }
            self.save(&items);
            if !ok && stop_on_fail {
                break; // 限流补发：队头都不可达，后面必然同样不可达——本轮到此为止
            }
        }
        if retired > 0 {
            eprintln!(
                "[outbox] {account}: {retired} 条超过 TTL/重试上限 → 停自动补发（status=failed，可手动重发；设备群任务卡=T{}天/{}次）",
                7,
                20_000
            );
        }
        sent
    }

    /// 重发单条（手动重发/命令路径）。返回是否送达（出队）。
    pub async fn flush_one<F, Fut>(&self, msg_id: &str, deliver: F) -> bool
    where
        F: Fn(String, Value) -> Fut,
        Fut: std::future::Future<Output = bool>,
    {
        let item = {
            let _g = self.mu.lock().unwrap();
            self.load().into_iter().find(|i| i.msg_id == msg_id)
        };
        let Some(item) = item else { return false };
        let mut ok = false;
        for t in &item.targets {
            if deliver(t.clone(), item.envelope.clone()).await {
                ok = true;
            }
        }
        if ok {
            let _g = self.mu.lock().unwrap();
            let mut items = self.load();
            items.retain(|i| i.msg_id != msg_id);
            self.save(&items);
        }
        ok
    }
}

// ══════════════ 生产实例（chat/<账号桶>/outbox.json——第96轮修复1 账号分桶） ══════════════

/// 第96轮（修复1）：outbox.json 跟随 chat 账号桶（chat/<safeDid>/outbox.json）——
/// 切账号后待发队列各归各账号（A 的待发不会在 B 登录时误发/误显）。按桶路径缓存
/// 实例：global() 随 account_did() 动态指向当前桶，切回旧账号其待发仍在可补发。
static INSTANCES: std::sync::LazyLock<Mutex<std::collections::HashMap<PathBuf, std::sync::Arc<Outbox>>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashMap::new()));

pub fn global() -> std::sync::Arc<Outbox> {
    let path = crate::chat_service::chat_dir().join("outbox.json");
    let mut m = INSTANCES.lock().unwrap();
    m.entry(path.clone())
        .or_insert_with(|| std::sync::Arc::new(Outbox::new(path)))
        .clone()
}

/// prod deliver 适配（p2p_client::deliver_to_account）。
pub async fn deliver_prod(target: String, envelope: Value) -> bool {
    // 2026-10-18 晚 验收实测：解锁后 36 条积压补发 × 每条 6s 预算 = 中继腿串行锁被
    // 长时间占住，前台连发 10 条全部等锁吃到 6s 超时（真实 relay 建好后单发仅
    // 95-162ms）。补发环用**紧预算 2.5s**：每条最多占锁 2.5s，前台投递在 fair 锁
    // 队列里最多等当前这一条，随后立刻拿到锁；补发不追求一次到齐（失败下轮再来）。
    deliver_to_account_with_budget(&target, &envelope, 2_500).await
}

/// 带显式中继预算的 prod deliver（补发环用紧预算，前台用 deliver_to_account）。
async fn deliver_to_account_with_budget(target: &str, envelope: &Value, budget_ms: u64) -> bool {
    crate::p2p_client::deliver_to_account_with(target, envelope, budget_ms).await
}

/// 紧预算 prod deliver（2026-10-18 fast-ack 补发环用）：4s 超时按未达（取消在飞
/// HTTP；接收端 msgId 幂等，重复投递无害）。宽预算的最终一致由 presence 上线触发
/// 的 flush_outbox_for / 60s 对账环补齐。
pub async fn deliver_prod_fast(target: String, envelope: Value) -> bool {
    tokio::time::timeout(
        std::time::Duration::from_millis(4_000),
        crate::p2p_client::deliver_to_account(&target, &envelope),
    )
    .await
    .unwrap_or(false)
}

/// 对某账号 flush（prod 路径）。返回成功出队的条目（消息行 sendState 回写
/// 由调用方做——在 chat_service 里统一封一层，避免本模块依赖消息存储细节）。
pub async fn flush_account_prod(account: &str) -> Vec<OutboxItem> {
    let sent = global().flush_account(account, deliver_prod).await;
    if !sent.is_empty() {
        eprintln!("[outbox] {account} 上线补发成功 {} 条", sent.len());
    }
    sent
}

// ══════════════ 单测（临时目录实例 + mock deliver，零全局态零网络） ══════════════

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn tmp_outbox(tag: &str) -> Outbox {
        let dir = std::env::temp_dir().join(format!("myco-outbox-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Outbox::new(dir.join("outbox.json"))
    }

    fn env(msg_id: &str, text: &str) -> Value {
        json!({ "msgId": msg_id, "from": "did:youling:ME", "fromDevice": "did:myco:D",
                "to": "did:youling:PEER", "kind": "text", "payload": { "text": text }, "ts": 1000 })
    }

    /// 失败入队 → 持久化（模拟重启=新实例同路径重读仍在）。
    #[test]
    fn enqueue_persists_across_reload() {
        let ob = tmp_outbox("persist");
        let path = ob.path.clone();
        assert_eq!(ob.enqueue("conv1", vec!["did:youling:PEER".into()], env("m1", "在吗")), EnqueueOutcome::Queued);
        assert_eq!(ob.enqueue("conv1", vec!["did:youling:PEER".into()], env("m2", "第二条")), EnqueueOutcome::Queued);
        // 模拟重启：新实例同路径
        let ob2 = Outbox::new(path);
        let items = ob2.list();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].msg_id, "m1"); // FIFO 入队序
        assert_eq!(items[1].msg_id, "m2");
        assert_eq!(items[0].status, "pending");
        assert!(ob2.has_pending_for_account("did:youling:PEER"));
        assert!(!ob2.has_pending_for_account("did:youling:OTHER"));
    }

    /// 幂等：同 msgId 重复入队不重复（deliver 与 UI 重试双路径安全）。
    #[test]
    fn enqueue_idempotent_by_msgid() {
        let ob = tmp_outbox("idem");
        assert_eq!(ob.enqueue("c", vec!["a".into()], env("m1", "x")), EnqueueOutcome::Queued);
        assert_eq!(ob.enqueue("c", vec!["a".into()], env("m1", "x")), EnqueueOutcome::Queued);
        assert_eq!(ob.list().len(), 1);
        // 无 msgId 拒收
        assert_eq!(ob.enqueue("c", vec!["a".into()], json!({"kind":"text"})), EnqueueOutcome::Overflow);
    }

    /// 上线重发：mock deliver 全成功 → 逐条出队 + envelope 原样（msgId/ts 不变）。
    #[tokio::test]
    async fn flush_on_peer_online_resends_in_order() {
        let ob = tmp_outbox("flush");
        for i in 0..3 {
            ob.enqueue("c", vec!["did:youling:P".into()], env(&format!("m{i}"), &format!("消息{i}")), );
        }
        let seen = std::sync::Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let seen2 = seen.clone();
        let sent = ob
            .flush_account("did:youling:P", move |target, e| {
                let seen = seen2.clone();
                async move {
                    seen.lock().unwrap().push((target, e.get("msgId").and_then(|v| v.as_str()).unwrap_or("").to_string()));
                    true
                }
            })
            .await;
        let ids: Vec<&str> = sent.iter().map(|i| i.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m0", "m1", "m2"]); // FIFO 逐条
        assert!(ob.list().is_empty()); // 全部出队
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 3);
        assert_eq!(seen[0].0, "did:youling:P");
        assert_eq!(seen[1].1, "m1");
    }

    /// 部分送达：任一 target 成功即出队；全失败保留且 attempts+1。
    #[tokio::test]
    async fn flush_partial_delivery_semantics() {
        let ob = tmp_outbox("partial");
        ob.enqueue("c", vec!["tA".into(), "tB".into()], env("m-ok", "x"));
        ob.enqueue("c", vec!["tA".into()], env("m-fail", "y"));
        let sent = ob
            .flush_account("tA", |t, _e| async move { t == "tB" }) // 只有 tB 可达
            .await;
        let ids: Vec<&str> = sent.iter().map(|i| i.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m-ok"]); // m-ok 经 tB 送达
        let left = ob.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].msg_id, "m-fail");
        assert_eq!(left[0].attempts, 1);
        assert_eq!(left[0].status, "pending"); // 仍是 pending（下轮再试）
    }

    /// 容量溢出：单会话 200 条 pending 后第 201 条 Overflow（标失败态手动重发）。
    #[test]
    fn capacity_overflow_marks_failed() {
        let ob = tmp_outbox("overflow");
        for i in 0..OUTBOX_MAX_PER_CONV {
            assert_eq!(
                ob.enqueue("convX", vec!["a".into()], env(&format!("m{i}"), "x")),
                EnqueueOutcome::Queued
            );
        }
        assert_eq!(
            ob.enqueue("convX", vec!["a".into()], env("m-over", "溢出了")),
            EnqueueOutcome::Overflow
        );
        // 别的会话不受影响（按会话计数）
        assert_eq!(ob.enqueue("convY", vec!["a".into()], env("m-y", "y")), EnqueueOutcome::Queued);
        // failed 条目不占 pending 名额（标失败后可再入新消息）
        ob.mark_failed("m0", "对方长期不在线");
        assert_eq!(ob.enqueue("convX", vec!["a".into()], env("m-new", "新")), EnqueueOutcome::Queued);
    }

    /// failed → requeue → flush 再走（手动重发路径）。
    #[tokio::test]
    async fn failed_requeue_manual_retry() {
        let ob = tmp_outbox("retry");
        ob.enqueue("c", vec!["a".into()], env("m1", "x"));
        ob.mark_failed("m1", "对方长期不在线，消息未送达");
        assert!(!ob.has_pending_for_account("a")); // failed 不算 pending
        // failed 不被自动 flush 碰
        let sent = ob.flush_account("a", |_t, _e| async { true }).await;
        assert!(sent.is_empty());
        // 手动重发：requeue → flush_one
        ob.requeue("m1");
        assert!(ob.has_pending_for_account("a"));
        assert!(ob.flush_one("m1", |_t, _e| async { true }).await);
        assert!(ob.list().is_empty());
    }

    /// remove_conv：删好友/退群清队。
    #[test]
    fn remove_conv_clears_only_that_conv() {
        let ob = tmp_outbox("rmconv");
        ob.enqueue("c1", vec!["a".into()], env("m1", "x"));
        ob.enqueue("c2", vec!["a".into()], env("m2", "y"));
        ob.remove_conv("c1");
        let left = ob.list();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].conv_id, "c2");
    }

    /// pending_accounts：sync_loop 兜底枚举（去重、只算 pending）。
    #[test]
    fn pending_accounts_dedup_and_skip_failed() {
        let ob = tmp_outbox("accts");
        ob.enqueue("c1", vec!["did:A".into(), "did:B".into()], env("m1", "x"));
        ob.enqueue("c2", vec!["did:A".into()], env("m2", "y"));
        ob.enqueue("c3", vec!["did:C".into()], env("m3", "z"));
        ob.mark_failed("m3", "长期不在线");
        let accts: HashSet<String> = ob.pending_accounts().into_iter().collect();
        assert_eq!(accts, HashSet::from(["did:A".to_string(), "did:B".to_string()]));
    }

    /// flush 并发计数：N 条各 deliver 一次（不多发——attempts 语义验证）。
    #[tokio::test]
    async fn flush_delivers_each_pending_once() {
        let ob = tmp_outbox("count");
        for i in 0..5 {
            ob.enqueue("c", vec!["a".into()], env(&format!("m{i}"), "x"));
        }
        let n = std::sync::Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let sent = ob
            .flush_account("a", move |_t, _e| {
                let n = n2.clone();
                async move {
                    n.fetch_add(1, Ordering::Relaxed);
                    false // 全失败——留在队里
                }
            })
            .await;
        assert!(sent.is_empty());
        assert_eq!(n.load(Ordering::Relaxed), 5); // 每条恰好一次
        assert_eq!(ob.list().iter().map(|i| i.attempts).sum::<u32>(), 5);
    }

    /// 2026-10-18 fast-ack：补发节奏——前台 3s 起指数退避、60s 封顶；后台恒 60s。
    #[test]
    fn retry_delay_front_3s_then_exponential_cap_60s() {
        assert_eq!(retry_delay_ms(0, true), 3_000);
        assert_eq!(retry_delay_ms(1, true), 6_000);
        assert_eq!(retry_delay_ms(2, true), 12_000);
        assert_eq!(retry_delay_ms(3, true), 24_000);
        assert_eq!(retry_delay_ms(4, true), 48_000);
        assert_eq!(retry_delay_ms(5, true), 60_000); // 96s → 封顶 60s
        assert_eq!(retry_delay_ms(9, true), 60_000);
        // 后台一律 60s
        assert_eq!(retry_delay_ms(0, false), 60_000);
        assert_eq!(retry_delay_ms(3, false), 60_000);
    }

    /// 2026-10-18 fast-ack：限流补发（队头不可达即停，不在离线长队上烧预算）。
    #[tokio::test]
    async fn burst_flush_stops_at_first_unreachable_and_honors_max() {
        let ob = tmp_outbox("burst");
        for i in 0..5 {
            ob.enqueue("c", vec!["a".into()], env(&format!("m{i}"), "x"));
        }
        // 前两条可达、第三条不可达：第二次调用（限 10 条）应停在第三条，剩 2 条。
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let c2 = calls.clone();
        let sent = ob
            .flush_account_burst("a", move |_t, e| {
                let c = c2.clone();
                async move {
                    let n = c.fetch_add(1, Ordering::Relaxed);
                    let id = e.get("msgId").and_then(|v| v.as_str()).unwrap_or("");
                    n < 2 || id != "m2" // m0/m1 可达；m2 起不可达
                }
            }, 10)
            .await;
        let ids: Vec<&str> = sent.iter().map(|i| i.msg_id.as_str()).collect();
        assert_eq!(ids, vec!["m0", "m1"]); // 成功即继续
        assert_eq!(ob.list().len(), 3); // m2 失败即停（m3/m4 本轮没白试）
        assert_eq!(ob.list()[0].msg_id, "m2");
        assert_eq!(ob.list()[0].attempts, 1);
        // max_items 限额：只试队头 1 条
        let sent = ob
            .flush_account_burst("a", |_t, _e| async { false }, 1)
            .await;
        assert!(sent.is_empty());
    }

    /// 2026-10-18 fast-ack：pending 内存提示随入队/清空/枚举刷新（补发环热路径）。
    #[test]
    fn pending_hint_tracks_queue_state() {
        let ob = tmp_outbox("hint");
        // 构造初值 true（保守）→ 首次枚举确认为空后应翻 false
        let _ = ob.pending_accounts();
        assert!(!ob.has_pending_hint());
        ob.enqueue("c", vec!["a".into()], env("m1", "x"));
        assert!(ob.has_pending_hint());
        ob.remove_conv("c");
        assert!(!ob.has_pending_hint());
        // failed 不算 pending（不占补发节奏）
        ob.enqueue("c", vec!["a".into()], env("m2", "y"));
        ob.mark_failed("m2", "长期不在线");
        assert!(!ob.has_pending_hint());
    }
    /// 2026-10-19 补发风暴回归：**过期（TTL）或超次数**的待发条目不再自动补发，
    /// 标 failed 保留（可手动重发），且**根本不调 deliver**——否则对端永久不可达时
    /// 会无限重放（真案：attempts=5471 的旧图消息 + 10 天前的测试消息在重启后被重推，
    /// 对端 chat-trace 出现 ms=894557578 的 recv，评测数据被污染）。
    #[tokio::test]
    async fn flush_retires_expired_and_over_attempted_items_without_delivering() {
        let ob = tmp_outbox("ttl");
        for i in 0..3 {
            ob.enqueue("c", vec!["did:youling:P".into()], env(&format!("m{i}"), "x"));
        }
        // 直接改盘上数据：m0 = 7 小时前、m1 = 次数超限、m2 = 正常
        {
            let txt = std::fs::read_to_string(&ob.path).unwrap();
            let mut arr: Value = serde_json::from_str(&txt).unwrap();
            let now = now_ms();
            for it in arr.as_array_mut().unwrap() {
                let id = it.get("msgId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if id == "m0" { it["ts"] = json!(now - OUTBOX_TTL_MS - 60_000); }
                if id == "m1" { it["attempts"] = json!(OUTBOX_MAX_ATTEMPTS); }
            }
            std::fs::write(&ob.path, serde_json::to_string(&arr).unwrap()).unwrap();
        }
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let calls2 = calls.clone();
        let sent = ob
            .flush_account("did:youling:P", move |_t, _e| {
                let c = calls2.clone();
                async move { c.fetch_add(1, Ordering::SeqCst); false }
            })
            .await;
        assert!(sent.is_empty(), "全部未送达");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "只有 m2 该被真正尝试投递");
        let items = ob.list();
        let by_id = |id: &str| items.iter().find(|i| i.msg_id == id).cloned().unwrap();
        assert_eq!(by_id("m0").status, "failed", "过期条目停自动补发");
        assert!(by_id("m0").last_error.contains("有效期"), "{}", by_id("m0").last_error);
        assert_eq!(by_id("m1").status, "failed", "超次数条目停自动补发");
        assert!(by_id("m1").last_error.contains("重试"), "{}", by_id("m1").last_error);
        assert_eq!(by_id("m2").status, "pending", "正常条目继续排队");
        assert_eq!(by_id("m2").attempts, 1, "正常条目照常计一次重试");
    }

    /// 2026-10-21（真案：笔记本任务页没有 PC 的 DSH 卡）：**设备群任务卡**放宽重试——
    /// 普通消息到 300 次就停发，但 `task-share` → `grp-dev-*` 是账号级数据，必须继续等
    /// 对方上线（TTL 7 天/2 万次）；已超普通上限的卡仍要真正尝试一次投递。
    #[tokio::test]
    async fn device_group_task_card_gets_extended_retry_budget() {
        let ob = tmp_outbox("devcard");
        let mut card_env = env("card-1", "");
        card_env["kind"] = json!("task-share");
        card_env["to"] = json!("grp-dev-did:youling:ME");
        let mut text_env = env("text-1", "hi");
        text_env["to"] = json!("did:youling:PEER");
        ob.enqueue("grp-dev-did:youling:ME", vec!["did:youling:PEER".into()], card_env);
        ob.enqueue("did:youling:PEER", vec!["did:youling:PEER".into()], text_env);
        // 两条都打到旧的普通上限
        {
            let txt = std::fs::read_to_string(&ob.path).unwrap();
            let mut arr: Value = serde_json::from_str(&txt).unwrap();
            let now = now_ms();
            for it in arr.as_array_mut().unwrap() {
                it["attempts"] = json!(OUTBOX_MAX_ATTEMPTS);
                it["ts"] = json!(now - 60_000);
            }
            std::fs::write(&ob.path, serde_json::to_string(&arr).unwrap()).unwrap();
        }
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let calls2 = calls.clone();
        let sent = ob
            .flush_account("did:youling:PEER", move |_t, _e| {
                let c = calls2.clone();
                async move { c.fetch_add(1, Ordering::SeqCst); false }
            })
            .await;
        assert!(sent.is_empty(), "对端不可达，均未送达");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "只有设备群卡值得再试一次，普通消息直接退役");
        let items = ob.list();
        let card = items.iter().find(|i| i.msg_id == "card-1").expect("设备群卡仍在队列");
        assert_eq!(card.status, "pending", "设备群卡超普通上限仍应继续重试");
        assert_eq!(card.attempts, OUTBOX_MAX_ATTEMPTS + 1);
        let text = items.iter().find(|i| i.msg_id == "text-1").expect("普通消息退役但仍保留");
        assert_eq!(text.status, "failed", "普通消息超上限退役");
    }
}

