//! vnet 端点租约层（L4）——task-vnet-endpoint-lease-20261025 §4/§7 的实现。
//!
//! ## 定位
//! 本地入口 `127.0.0.1:localPort` 的生命周期归 vnet 层统一管理（keeper 收归），
//! 不再靠每个应用（dsh_share / vnet_env / rdp 面）各自的守护逻辑拼凑。
//!
//! ## 键（§4 s_endpoint_lease）
//! `(consumer_device, service_kind, source_device, source_port, share_id)` 五元组。
//! 多张卡指向同一 `(source_device, source_port)` 时共享同一条隧道与同一个本地口——
//! 端口绑定按 `(device, port)` 唯一裁决，租约状态按五元组分别记录。
//!
//! ## 状态机（§7.1）
//! ```text
//! reserved ──开卡──▶ active ──上游断开──▶ degraded ──探测失败+退避重建──▶ recovering
//!                       ▲                    │                                │
//!                       └──────上游恢复──────┴────────────────────────────────┘
//! 任意非 closed ──revoked/expired/explicit_config──▶ closed（才允许释放端口）
//! ```
//! **禁止转移**：非 closed 租约因上游故障不得改变 `local_port`（只降级/恢复）。
//! 换口只有两道窄门：①同一张卡（非空且相同 share_id）由卡主显式换口；
//! ②route 已 stop 且同步 bind 明确 AddrInUse，由 route 层确定性迁移并记录事件。
//! 跨 share 异口仍明确 Err；任何路径都不得静默换随机口。活路由漂移只复用隧道，
//! 不改写可能代表浏览器入口的租约坐标。
//!
//! ## 持久化
//! `config_dir()/vnet-leases.json`（原子写）。**只存坐标与状态**：DID、端口、
//! state/health、时间戳、失败原因——mt/密钥等凭证绝不落本文件（I3：坐标≠凭证）。
//! 进程重启后 keeper 按 lease 表恢复同口绑定（E5）。
//!
//! ## listener 与上游健康分离（I7）
//! `listener_present`（本地口是否 LISTEN）与 `health`（上游是否可写）分开记录；
//! listener 在而上游死 = degraded，不是"活着"。

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

// ═══════════════════════════════════════════════════════════════════════
// 数据结构
// ═══════════════════════════════════════════════════════════════════════

/// 租约五元组键（camelCase 序列化，与 HTTP 面一致）。
#[derive(Clone, Debug, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseKey {
    /// 消费方设备 DID（本机开卡=本机 DID；无法确定时为空串）。
    pub consumer_device: String,
    /// dsh|rdp|ssh|http|adb|forward。
    pub kind: String,
    /// 源设备 DID（隧道目标）。
    pub device: String,
    /// 源端口（隧道目标端口）。
    pub port: u16,
    /// 分享/卡 id（非分享类转发为空串）。
    pub share_id: String,
}

/// 租约状态（§7.1 合法转移见 [`lease_transition`]）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseState {
    Reserved,
    Active,
    Degraded,
    Recovering,
    Closed,
}

impl LeaseState {
    pub fn as_str(self) -> &'static str {
        match self {
            LeaseState::Reserved => "reserved",
            LeaseState::Active => "active",
            LeaseState::Degraded => "degraded",
            LeaseState::Recovering => "recovering",
            LeaseState::Closed => "closed",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "reserved" => LeaseState::Reserved,
            "active" => LeaseState::Active,
            "degraded" => LeaseState::Degraded,
            "recovering" => LeaseState::Recovering,
            "closed" => LeaseState::Closed,
            _ => return None,
        })
    }
}

/// 上游健康（与 listener 存活分开；I7）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LeaseHealth {
    Unknown,
    Healthy,
    Degraded,
    Down,
}

impl LeaseHealth {
    pub fn as_str(self) -> &'static str {
        match self {
            LeaseHealth::Unknown => "unknown",
            LeaseHealth::Healthy => "healthy",
            LeaseHealth::Degraded => "degraded",
            LeaseHealth::Down => "down",
        }
    }
}

/// 允许释放的原因（§4 release_reason：只有这三种才允许 closed）。
pub fn release_reason_valid(reason: &str) -> bool {
    matches!(reason, "revoked" | "expired" | "explicit_config")
}

/// 一条租约记录（持久化形状 = API 形状；无凭证字段）。
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseRecord {
    #[serde(flatten)]
    pub key: LeaseKey,
    pub local_port: u16,
    pub state: LeaseState,
    pub health: LeaseHealth,
    /// 本地 listener 是否在（keeper 每拍更新）。
    pub listener_present: bool,
    /// 最近是否有活跃连接（`tunnel_in_use` 的布尔投影；keeper 更新）。
    pub recent_connections: bool,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub last_success_ms: Option<u64>,
    pub last_fail_ms: Option<u64>,
    /// 上次失败原因（人话；不含 mt/凭证）。
    pub fail_reason: Option<String>,
    pub release_reason: Option<String>,
}

impl LeaseRecord {
    fn new(key: LeaseKey, local_port: u16, now: u64) -> Self {
        LeaseRecord {
            key,
            local_port,
            state: LeaseState::Reserved,
            health: LeaseHealth::Unknown,
            listener_present: false,
            recent_connections: false,
            created_at_ms: now,
            updated_at_ms: now,
            last_success_ms: None,
            last_fail_ms: None,
            fail_reason: None,
            release_reason: None,
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 状态机判定核（纯函数；单测直击 §7.1 全矩阵）
// ═══════════════════════════════════════════════════════════════════════

/// 租约事件。
#[derive(Clone, Debug, PartialEq)]
pub enum LeaseEvent {
    /// 开卡/建链成功（携带实际本地口；口不变式在这里裁决）。
    Open(u16),
    /// 上游健康（读写/心跳/页面可用）。
    UpstreamOk,
    /// 上游断开（RST/不可写/协议探测失败）。
    UpstreamFail(String),
    /// 退避重建后的探测又失败（degraded → recovering）。
    ProbeFail(String),
    /// 释放（revoked|expired|explicit_config 之外一律拒绝）。
    Release(String),
}

/// 纯转移核：`(state, health) × event → (state, health)`；非法转移返回 Err（人话）。
pub fn lease_transition(
    state: LeaseState,
    health: LeaseHealth,
    port: u16,
    ev: &LeaseEvent,
) -> Result<(LeaseState, LeaseHealth, u16), String> {
    use LeaseEvent as E;
    use LeaseHealth as H;
    use LeaseState as S;
    match (state, ev) {
        // closed 是终态：只能被同键新租约替代（lease_open 新建），不再转移。
        (S::Closed, _) => Err("租约已 closed（终态）；重新开卡按新租约处理".into()),

        // 释放：只有三种合法原因（§4）。
        (_, E::Release(r)) if release_reason_valid(r) => Ok((S::Closed, health, port)),
        (_, E::Release(r)) => Err(format!(
            "非法释放原因「{r}」：只有 revoked/expired/explicit_config 允许释放（上游故障请走 degraded）"
        )),

        // 开卡/建链：口不变式。
        (S::Reserved, E::Open(p)) | (S::Active, E::Open(p)) | (S::Degraded, E::Open(p))
        | (S::Recovering, E::Open(p)) => {
            if *p != port {
                return Err(format!(
                    "端口租约冲突：该卡租约已固定在 127.0.0.1:{port}（{state:?}），租约期内不换口（本次请求 {p}）；请释放端口或先停止分享"
                ));
            }
            Ok((S::Active, H::Healthy, port))
        }

        // 上游健康：任何非 closed → active/healthy（recovering 恢复 = T-heal）。
        (_, E::UpstreamOk) => Ok((S::Active, H::Healthy, port)),

        // 上游断开：active → degraded（口不变）；已在 degraded/recovering 维持并记录。
        (S::Active, E::UpstreamFail(_)) => Ok((S::Degraded, H::Down, port)),
        (S::Degraded | S::Recovering, E::UpstreamFail(_)) => Ok((S::Recovering, H::Down, port)),
        (S::Reserved, E::UpstreamFail(_)) => Ok((S::Reserved, H::Down, port)),

        // 退避重建又失败：degraded/recovering → recovering（不用随机新口冒充恢复）。
        (S::Degraded | S::Recovering, E::ProbeFail(_)) => Ok((S::Recovering, H::Down, port)),
        (S::Active, E::ProbeFail(_)) => Ok((S::Degraded, H::Down, port)),
        (S::Reserved, E::ProbeFail(_)) => Ok((S::Reserved, H::Unknown, port)),
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 进程内表 + 持久化
// ═══════════════════════════════════════════════════════════════════════

struct LeaseStore {
    loaded: bool,
    leases: HashMap<String, LeaseRecord>,
}

static LEASES: LazyLock<Mutex<LeaseStore>> = LazyLock::new(|| {
    Mutex::new(LeaseStore { loaded: false, leases: HashMap::new() })
});

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn lease_key_string(k: &LeaseKey) -> String {
    format!("{}|{}|{}|{}|{}", k.consumer_device, k.kind, k.device, k.port, k.share_id)
}

fn leases_path() -> std::path::PathBuf {
    myco_core::config::config_dir().join("vnet-leases.json")
}

#[derive(serde::Serialize, serde::Deserialize)]
struct LeasesFile {
    leases: Vec<LeaseRecord>,
}

fn ensure_loaded() {
    let mut g = LEASES.lock().unwrap();
    if g.loaded {
        return;
    }
    if let Ok(s) = std::fs::read_to_string(leases_path()) {
        if let Ok(f) = serde_json::from_str::<LeasesFile>(&s) {
            for rec in f.leases {
                g.leases.insert(lease_key_string(&rec.key), rec);
            }
        } else {
            eprintln!("[vnet-lease] 租约文件损坏，按空重建（{}）", leases_path().display());
        }
    }
    g.loaded = true;
}

fn save_locked(g: &LeaseStore) {
    // 只保留最近 300 条；closed 且 7 天前的丢弃（防无限增长）。
    let now = now_ms();
    let mut recs: Vec<LeaseRecord> = g
        .leases
        .values()
        .filter(|r| r.state != LeaseState::Closed || now.saturating_sub(r.updated_at_ms) < 7 * 86_400_000)
        .cloned()
        .collect();
    if recs.len() > 300 {
        recs.sort_by_key(|r| r.updated_at_ms);
        recs.drain(..recs.len() - 300);
    }
    let f = LeasesFile { leases: recs };
    if let Ok(s) = serde_json::to_string_pretty(&f) {
        crate::p2p_tunnel::write_file_atomic(&leases_path(), &s);
    }
}

/// 测试钩子：清空内存表（模拟进程重启；磁盘档案保留）。
#[cfg(test)]
pub(crate) fn test_reset_lease_table() {
    let mut g = LEASES.lock().unwrap();
    g.loaded = false;
    g.leases.clear();
}

// ═══════════════════════════════════════════════════════════════════════
// API（状态机入口；全部同步、快——不碰网络）
// ═══════════════════════════════════════════════════════════════════════

/// 本机作为消费方的 DID（无法确定时空串——测试环境常见）。
pub fn self_consumer_device() -> String {
    crate::p2p_tunnel::self_did_for_loopback_filter().unwrap_or_default()
}

/// 开卡/建链成功 → 登记/推进租约到 active。
///
/// - 新键 → reserved→active；
/// - 同键同口 → 幂等推进（degraded/recovering 恢复也算 Open 的语义）；
/// - 同键同 share **异口**且非 closed → 视为卡主显式换口，旧租约由新口替换；
/// - 同 `(device, port)` 已有其它 share 的非 closed 租约占着**别的口** → 明确 Err
///   （同一隧道只能监听一个口；先到先得，后来者必须显式解除或改卡）；
/// - 上游故障/进程重启不属于显式换口，仍必须保持原口。
pub fn lease_open(key: &LeaseKey, local_port: u16) -> Result<(), String> {
    ensure_loaded();
    let now = now_ms();
    let mut g = LEASES.lock().unwrap();
    // 同 (device,port) 的口唯一性（跨 share_id）
    if local_port > 0 {
        let mut stale_same_share: Vec<String> = Vec::new();
        for (ks, r) in g.leases.iter() {
            if r.key.device == key.device
                && r.key.port == key.port
                && r.state != LeaseState::Closed
                && r.local_port != local_port
                && r.local_port > 0
            {
                // 2026-11-05 真案（用户截图）：同一张卡（share 相同）带着新固定口重开
                // ——这是卡主**显式换口**，不是别人抢口。若按"租约期内不换口"拒掉，
                // 用户端表现就是卡片永远打不开（旧的还 active、新的进不来）。
                // 语义：同 share = 同一意图 → 旧租约随之迁移到新口；
                //       跨 share 仍拒绝（先到先得，后来者必须显式解除或改卡）。
                if !key.share_id.is_empty() && r.key.share_id == key.share_id {
                    stale_same_share.push(ks.clone());
                    continue;
                }
                return Err(format!(
                    "端口租约冲突：{device}#{port} 已有租约固定在 127.0.0.1:{old}（{st}，share={sh}）；同一隧道租约期内不换口，本次 {local_port} 被拒。请先停止旧分享或复用该端口",
                    device = key.device,
                    port = key.port,
                    old = r.local_port,
                    st = r.state.as_str(),
                    sh = r.key.share_id,
                ));
            }
        }
        for ks in stale_same_share {
            if let Some(old) = g.leases.remove(&ks) {
                eprintln!(
                    "[vnet-lease] 同 share 换口：{}#{} 旧租约 :{} → 新口 :{local_port}（share={}）",
                    key.device, key.port, old.local_port, key.share_id
                );
            }
        }
    }
    let ks = lease_key_string(key);
    let entry = g.leases.remove(&ks).unwrap_or_else(|| LeaseRecord::new(key.clone(), local_port, now));
    let ev = LeaseEvent::Open(local_port);
    match lease_transition(entry.state, entry.health, entry.local_port, &ev) {
        Ok((st, h, port)) => {
            let mut rec = entry;
            rec.state = st;
            rec.health = h;
            rec.local_port = port;
            rec.last_success_ms = Some(now);
            rec.updated_at_ms = now;
            g.leases.insert(ks, rec);
            save_locked(&g);
            Ok(())
        }
        Err(e) => {
            g.leases.insert(ks, entry);
            Err(e)
        }
    }
}

/// 上游健康（读写成功/协议探测过/页面可用）。
pub fn lease_upstream_ok(key: &LeaseKey) {
    apply_event(key, LeaseEvent::UpstreamOk, true);
}

/// 上游断开/协议探测失败（→ degraded，口不变，绝不释放）。
pub fn lease_upstream_fail(key: &LeaseKey, reason: &str) {
    apply_event(key, LeaseEvent::UpstreamFail(sanitize_reason(reason)), false);
}

/// 退避重建后探测又失败（degraded → recovering）。
pub fn lease_probe_fail(key: &LeaseKey, reason: &str) {
    apply_event(key, LeaseEvent::ProbeFail(sanitize_reason(reason)), false);
}

/// 释放（只有 revoked/expired/explicit_config 合法）。
pub fn lease_release(key: &LeaseKey, reason: &str) -> Result<(), String> {
    ensure_loaded();
    let mut g = LEASES.lock().unwrap();
    let ks = lease_key_string(key);
    if let Some(entry) = g.leases.remove(&ks) {
        match lease_transition(entry.state, entry.health, entry.local_port, &LeaseEvent::Release(reason.to_string())) {
            Ok((st, h, port)) => {
                let mut rec = entry;
                rec.state = st;
                rec.health = h;
                rec.local_port = port;
                rec.release_reason = Some(reason.to_string());
                rec.updated_at_ms = now_ms();
                g.leases.insert(ks, rec);
                save_locked(&g);
                Ok(())
            }
            Err(e) => {
                g.leases.insert(ks, entry);
                Err(e)
            }
        }
    } else {
        Ok(()) // 不存在的键：幂等
    }
}

/// 按 share_id 释放全部租约（分享 revoke/kill 面调用；原因 revoked）。
pub fn lease_release_by_share(share_id: &str, reason: &str) -> usize {
    ensure_loaded();
    let mut g = LEASES.lock().unwrap();
    let now = now_ms();
    let mut n = 0;
    let keys: Vec<String> = g
        .leases
        .iter()
        .filter(|(_, r)| r.key.share_id == share_id && r.state != LeaseState::Closed)
        .map(|(k, _)| k.clone())
        .collect();
    for ks in keys {
        if let Some(mut rec) = g.leases.remove(&ks) {
            if let Ok((st, h, port)) = lease_transition(
                rec.state,
                rec.health,
                rec.local_port,
                &LeaseEvent::Release(reason.to_string()),
            ) {
                rec.state = st;
                rec.health = h;
                rec.local_port = port;
                rec.release_reason = Some(reason.to_string());
                rec.updated_at_ms = now;
                g.leases.insert(ks, rec);
                n += 1;
            } else {
                g.leases.insert(ks, rec);
            }
        }
    }
    if n > 0 {
        save_locked(&g);
    }
    n
}

/// I7 缺失观测统一入口：`tunnel_live_local_port=None`（隧道不存在/死条目）时，
/// keeper 必须把该 (device,port) 上非 closed 租约的 listenerPresent 明确清 false
/// （recent_connections 同步 false，无 listener 就不可能有真连接，不得伪造），
/// 然后才走 spawn_rebuild。kept 与非 kept 两个 None 分支共用本入口，避免漏写
/// 导致旧 listenerPresent=true 永不清除（live RED：laptop:3103 health=down
/// 但 listenerPresent=true、127.0.0.1:23104 实测无监听）。只动观测字段，
/// 不触碰 state/health 的合法转移，不换租约口。
pub(crate) fn observe_listener_missing(device: &str, port: u16) {
    for rec in leases_snapshot() {
        if rec.key.device == device && rec.key.port == port && rec.state != LeaseState::Closed {
            lease_observe(&rec.key, false, false);
        }
    }
}

/// keeper 每拍更新 listener/连接观测（不动状态机，只刷新观测字段）。
pub fn lease_observe(key: &LeaseKey, listener_present: bool, recent_connections: bool) {
    ensure_loaded();
    let mut g = LEASES.lock().unwrap();
    let ks = lease_key_string(key);
    if let Some(rec) = g.leases.get_mut(&ks) {
        if rec.listener_present != listener_present || rec.recent_connections != recent_connections {
            rec.listener_present = listener_present;
            rec.recent_connections = recent_connections;
            rec.updated_at_ms = now_ms();
            save_locked(&g);
        }
    }
}

/// 全量快照（API/诊断/keeper 用；按 updated_at 新→旧）。
pub fn leases_snapshot() -> Vec<LeaseRecord> {
    ensure_loaded();
    let g = LEASES.lock().unwrap();
    let mut out: Vec<LeaseRecord> = g.leases.values().cloned().collect();
    out.sort_by(|a, b| b.updated_at_ms.cmp(&a.updated_at_ms));
    out
}

/// 某 `(device, port)` 上所有非 closed 租约约定的口（应恰好 0 或 1 个）。
pub fn leased_local_port(device: &str, port: u16) -> Option<u16> {
    ensure_loaded();
    let g = LEASES.lock().unwrap();
    g.leases
        .values()
        .find(|r| r.key.device == device && r.key.port == port && r.state != LeaseState::Closed)
        .map(|r| r.local_port)
}

/// 同步一条 route 下仍明确记着 old 的非 closed 租约，不改 state/health。
/// `from=Some(old)` 是 EADDRINUSE 换口防误写闸；入口口与 route 口混用的历史租约不相等就不动。
fn rewrite_route_local_port(
    device: &str,
    port: u16,
    from: u16,
    to: u16,
    event: &str,
) -> usize {
    if to == 0 {
        return 0;
    }
    ensure_loaded();
    let mut g = LEASES.lock().unwrap();
    let now = now_ms();
    let mut changed = 0usize;
    for rec in g.leases.values_mut() {
        if rec.key.device != device
            || rec.key.port != port
            || rec.state == LeaseState::Closed
            || rec.local_port != from
            || rec.local_port == to
        {
            continue;
        }
        rec.local_port = to;
        // 新口尚未 bind 成功，旧口的 listener/连接观测不得随迁（I7）。
        rec.listener_present = false;
        rec.recent_connections = false;
        rec.updated_at_ms = now;
        changed += 1;
    }
    if changed > 0 {
        save_locked(&g);
        eprintln!(
            "[vnet-lease] event={event} route={device}:{port} from={from:?} new={to} leases={changed}"
        );
    }
    changed
}

/// 仅由 vnet_forward 在旧条目已 stop、同步 bind 明确 AddrInUse 后调用。
/// 普通 [`lease_open`] 的“非 closed 不得异口 Open”不变式不受影响。
pub(crate) fn lease_rebind_after_addr_in_use(
    device: &str,
    port: u16,
    old: u16,
    new: u16,
) -> usize {
    rewrite_route_local_port(device, port, old, new, "local-port-rebind-eaddrinuse")
}

fn apply_event(key: &LeaseKey, ev: LeaseEvent, is_ok: bool) {
    ensure_loaded();
    let mut g = LEASES.lock().unwrap();
    let ks = lease_key_string(key);
    let Some(mut rec) = g.leases.remove(&ks) else { return };
    match lease_transition(rec.state, rec.health, rec.local_port, &ev) {
        Ok((st, h, port)) => {
            rec.state = st;
            rec.health = h;
            rec.local_port = port;
            let now = now_ms();
            rec.updated_at_ms = now;
            if is_ok {
                rec.last_success_ms = Some(now);
                rec.fail_reason = None;
            } else {
                rec.last_fail_ms = Some(now);
                let reason = match &ev {
                    LeaseEvent::UpstreamFail(r) | LeaseEvent::ProbeFail(r) => r.clone(),
                    _ => String::new(),
                };
                rec.fail_reason = Some(reason);
            }
            g.leases.insert(ks, rec);
            save_locked(&g);
        }
        Err(_) => {
            g.leases.insert(ks, rec);
        }
    }
}

/// 失败原因净化：去掉任何疑似凭证的段落（防 mt 泄进状态文件/审计）。
fn sanitize_reason(r: &str) -> String {
    let mut s = r.to_string();
    // `?mt=…` / `mt=…` 段整体抹掉
    if let Some(i) = s.find("mt=") {
        let start = i;
        let end = s[start..].find(|c: char| c.is_whitespace()).map(|e| start + e).unwrap_or(s.len());
        s.replace_range(start..end, "mt=<redacted>");
    }
    if s.len() > 300 {
        s.truncate(300);
    }
    s
}

// ═══════════════════════════════════════════════════════════════════════
// L1-L4 netstate 快照（诊断/API 面）
// ═══════════════════════════════════════════════════════════════════════

/// L1-L4 网络状态快照（`GET /api/vnet/netstate`）。
///
/// - L1/L2：地址族 + 临时 IPv6 观测；
/// - L3：网络指纹 + 每设备上次成功路由（含 kind/RTT/失败/冷却），跨重启复用；
/// - L4：租约摘要（状态/口/健康，无凭证）。
pub fn netstate_snapshot() -> serde_json::Value {
    use serde_json::json;
    let (has_v4, has_v6) = crate::p2p_tunnel::local_address_families();
    let (cur_net, routes) = crate::p2p_tunnel::network_layer3_diag();
    let now = now_ms();
    let routes_json: Vec<serde_json::Value> = routes
        .into_iter()
        .map(|r| {
            json!({
                "networkId": r.network_id,
                "device": r.device,
                "candidate": r.preferred_base,
                "kind": r.kind,
                "rttBaselineMs": r.rtt_ms,
                "successCount": r.success_count,
                "failCount": r.fail_count,
                "cooldownUntilMs": r.cooldown_until,
                "coolingDown": r.cooldown_until > now,
                "lastUsedMs": r.last_used,
            })
        })
        .collect();
    let lease_json: Vec<serde_json::Value> = leases_snapshot()
        .into_iter()
        .map(|l| {
            json!({
                "consumerDevice": l.key.consumer_device,
                "kind": l.key.kind,
                "device": l.key.device,
                "port": l.key.port,
                "shareId": l.key.share_id,
                "localPort": l.local_port,
                "state": l.state.as_str(),
                "health": l.health.as_str(),
                "listenerPresent": l.listener_present,
                "recentConnections": l.recent_connections,
                "lastSuccessMs": l.last_success_ms,
                "lastFailMs": l.last_fail_ms,
                "failReason": l.fail_reason,
            })
        })
        .collect();
    let afs: Vec<&str> = [if has_v4 { Some("v4") } else { None }, if has_v6 { Some("v6") } else { None }]
        .into_iter()
        .flatten()
        .collect();
    json!({
        "networkId": cur_net,
        "l1l2": {
            "addressFamilies": afs,
            "note": "介质=出口地址族观测；ipv6_temporary 识别见 l3[].kind",
        },
        "l3": {
            "networkId": cur_net,
            "candidates": routes_json,
            "note": "上次成功的 network_id/route/candidate 优先探测；失败才扩大搜索",
        },
        "l4": {
            "leases": lease_json,
        },
        "ts": now,
    })
}

// ═══════════════════════════════════════════════════════════════════════
// vnet 层 keeper（GUI：守护 kept 转发 + 租约表；探活/重建收归本层）
// ═══════════════════════════════════════════════════════════════════════

/// 上游探活节流（I7）：lease_key_string → 上次探测时刻。
#[cfg(feature = "gui")]
static LAST_UPSTREAM_PROBE: LazyLock<Mutex<HashMap<String, u64>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
#[cfg(feature = "gui")]
const UPSTREAM_PROBE_INTERVAL_MS: u64 = 5_000;

/// I7 主动协议探活白名单。RDP 必须排除：X.224 Connection Request 会创建真实
/// RDP 连接；在 `fSingleSessionPerUser=1` 的 PC 上，多设备 lease probe 每 5s
/// 轮流打 3389，会把正在使用的会话挤掉（Windows reason code 5）。RDP 健康
/// 只做被动观测：listener 存活 + 真实用户连接成功/失败事件推进租约状态。
#[cfg(feature = "gui")]
fn upstream_probe_eligible(kind: &str) -> bool {
    matches!(kind, "dsh" | "http")
}

/// vnet 层统一守护环：250ms 一拍。
///
/// 职责（原 `dsh_share::start_vnet_forward_keeper` 整体迁入 + 租约簿记）：
/// 1. kept 转发（vnet-forwards.json）重建逻辑**原样保留**；
/// 2. 每拍把 listener 存活 / 最近连接观测写进租约表；
/// 3. 非 kept 来源的租约（env/open、rdp 面开的卡）：隧道缺失/漂移 → 按租约口重建
///    （`set_preferred_local` 保证 bind 失败明确报错，不落随机口）；重建失败 →
///    `lease_probe_fail`（recovering），成功 → `lease_upstream_ok`（T-heal）。
#[cfg(feature = "gui")]
pub fn start_vnet_keeper() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    tauri::async_runtime::spawn(async move {
        let opening: Arc<std::sync::Mutex<std::collections::HashSet<String>>> =
            Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            let kept = crate::dsh_share::vnet_load_kept();
            let kept_n = kept.len();
            for item in &kept {
                let device = item.get("device").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let port = item.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
                if device.is_empty() || port == 0 {
                    continue;
                }
                // 固定口契约每拍灌入（用户约定的 localPort 是契约）
                let kept_local = item.get("localPort").and_then(|v| v.as_u64()).map(|v| v as u16);
                if let Some(lp) = kept_local.filter(|p| *p > 0) {
                    crate::p2p_tunnel::set_preferred_local(&device, port, Some(lp));
                }
                if crate::p2p_tunnel::tunnel_fail_streak(&device, port) >= 3 {
                    crate::p2p_tunnel::tunnel_fail_clear(&device, port);
                    crate::vnet_forward::route_close(&device, port);
                    lease_event_source(&device, port, |k| crate::vnet_lease::lease_upstream_fail(&k, "conn-fail-streak>=3"));
                    eprintln!("[vnet-keeper] {device}:{port} 连续连接失败 → 强制重建隧道");
                    continue;
                }
                // I7 口径：listener 真活（accept 任务在跑）才算"隧道在"——死条目
                // （socket 已拆但 TUNNELS 还留着）视同缺失，走同口重建。
                if let Some(cur) = crate::vnet_forward::route_live_local_port(&device, port) {
                    if let Some(lp) = kept_local.filter(|p| *p > 0) {
                        if cur != lp {
                            // 2026-11-06 真案：想要的固定口被本进程另一个子系统占着
                            // （卡片 app-listener raw / 残留 listener）时，旧逻辑"关掉
                            // 现有隧道→重绑固定口"会 10048 失败→退避→再关再试，死循环
                            // 互踩。修法：约定口**绑不上就收编现状**——kept 记录改成
                            // 实际口，隧道继续用；只有约定口真的空闲才做漂移纠正。
                            // 2026-11-09 vnet 集成约定（H 段）：**一条 route = 一个固定口**，
                            // 「只有 stop() 之后、且当前口确实绑不上（EADDRINUSE）才换口」。
                            // 原来这里「约定口空闲就 close→下一拍重绑」= 自找的 close↔重建循环
                            // （笔记本蜂窝下每拍都判漂移，实测 :56497→:64979→:55445 循环）。
                            // 现在：**一律收编现状**（kept 记录跟随实际口），不主动 close。
                            eprintln!(
                                "[vnet-keeper] 固定口漂移 → 收编现状 :{cur}（不 close，避免重建循环）：{device}:{port}"
                            );
                            crate::dsh_share::vnet_keep_upsert(&device, port, Some(cur), None);
                            continue;
                        }
                    }
                    // 观测写进租约（listener 在；最近连接按 tunnel_in_use）
                    lease_observe_source(&device, port, cur);
                    continue;
                }
                // I7 缺失分支：listener 实际不存在 → 先如实清观测（false/false），
                // 再按固定口重建；否则旧 listenerPresent=true 永不清除。
                observe_listener_missing(&device, port);
                spawn_rebuild(opening.clone(), device.clone(), port, kept_local, None);
            }
            // ── 非 kept 的租约（env/open / rdp 卡）：同口重建 + 状态机推进 ──
            for rec in crate::vnet_lease::leases_snapshot() {
                if rec.state == crate::vnet_lease::LeaseState::Closed {
                    continue;
                }
                // kept 已在上面处理过的 (device,port) 跳过
                if kept.iter().any(|v| {
                    v.get("device").and_then(|d| d.as_str()) == Some(rec.key.device.as_str())
                        && v.get("port").and_then(|p| p.as_u64()) == Some(rec.key.port as u64)
                }) {
                    continue;
                }
                let cur = crate::vnet_forward::route_live_local_port(&rec.key.device, rec.key.port);
                match cur {
                    Some(p) if p == rec.local_port => {
                        // 隧道在且口=租约口：健康推进 + 观测
                        if crate::p2p_tunnel::tunnel_fail_streak(&rec.key.device, rec.key.port) >= 3 {
                            crate::p2p_tunnel::tunnel_fail_clear(&rec.key.device, rec.key.port);
                            crate::vnet_forward::route_close(&rec.key.device, rec.key.port);
                            crate::vnet_lease::lease_upstream_fail(&rec.key, "conn-fail-streak>=3（重建同口）");
                            continue;
                        }
                        // listenerPresent = 实测（本进程 accept 任务在跑），不再硬编码 true：
                        // 到这里的分支前提已是 live_local_port==租约口，正常恒 true，
                        // 但语义上由 tunnel_listener_alive 裁决（I7：listener 与上游健康分离）。
                        crate::vnet_lease::lease_observe(
                            &rec.key,
                            crate::vnet_forward::route_listener_alive(&rec.key.device, rec.key.port),
                            crate::vnet_forward::route_in_use(&rec.key.device, rec.key.port, 30_000),
                        );
                        // 注意：这里**不**推 health——listener 在 ≠ 上游可用（I7），
                        // 健康只由协议探活/真实流量成功推进（见下方探活环）。
                    }
                    Some(p) => {
                        // 旧实现主动 close 再重绑会制造端口 churn。这里只复用活路由；
                        // lease.local_port 可能是浏览器入口而非 raw 口，绝不能按 route 强写。
                        eprintln!(
                            "[vnet-keeper] event=live-route-reused route={}:{} 现监听 :{p}，租约坐标 :{} 保持（不 close）",
                            rec.key.device, rec.key.port, rec.local_port
                        );
                        lease_observe_source(&rec.key.device, rec.key.port, p);
                    }
                    None => {
                        // 隧道缺失：先如实清 listener 观测（同 kept 缺失分支口径），
                        // 再按租约口重建（bind 失败 = 明确报错进 fail_reason）
                        observe_listener_missing(&rec.key.device, rec.key.port);
                        spawn_rebuild(
                            opening.clone(),
                            rec.key.device.clone(),
                            rec.key.port,
                            None,
                            Some(rec.key.clone()),
                        );
                    }
                }
            }
            // ── I7 上游活性探测：listener 在 ≠ 上游可用 ──
            // 每 5s 对"listener 在"的非 closed 租约做一次协议级探活（dsh|http|rdp；
            // 其它 kind 无协议判据，维持流量失败驱动）。探活**不换口、不关隧道**，
            // 只推进租约 health（active→degraded；degraded/recovering→active=T-heal）。
            {
                let now = now_ms();
                let mut probe_due: Vec<LeaseRecord> = Vec::new();
                {
                    let mut g = LAST_UPSTREAM_PROBE.lock().unwrap();
                    g.retain(|_, t| now.saturating_sub(*t) < 300_000);
                    for rec in crate::vnet_lease::leases_snapshot() {
                        if rec.state == LeaseState::Closed || !rec.listener_present {
                            continue;
                        }
                        if !upstream_probe_eligible(rec.key.kind.as_str()) {
                            continue;
                        }
                        // 2026-11-09 负缓存自锁根修：租约记的口已死（隧道被拆/漂移，
                        // keeper 尚未按租约口重建完）时**跳过探活**——旧逻辑照打：秒失败
                        // ×2 → 120s 负缓存 → 重建被禁 → 死口永在 → 探活又秒败 → 无限
                        // 自锁（今晚 13911 四次「隧道消失」即此）。口活才探；死口交给
                        // keeper 重建，重建成功后下一轮探活自然恢复。
                        // 2026-11-10：判活不再 TCP connect（每次 connect 都会被 vnet
                        // 客户端 accept→SESSION_START→拨上游 = 假会话）；改由 route 的
                        // accept 存活裁决（route_live_local_port 内部不碰 TCP），
                        // 与下方 probe_lp 的取口口径一致。
                        if crate::vnet_forward::route_live_local_port(&rec.key.device, rec.key.port)
                            .is_none()
                        {
                            continue;
                        }
                        let ks = lease_key_string(&rec.key);
                        if now.saturating_sub(*g.get(&ks).unwrap_or(&0)) < UPSTREAM_PROBE_INTERVAL_MS {
                            continue;
                        }
                        g.insert(ks, now);
                        probe_due.push(rec);
                    }
                }
                for rec in probe_due {
                    let k = rec.key.clone();
                    let lp = rec.local_port;
                    // 2026-11-09 真案（隧道「起了又停」的根因）：lease 的 local_port 是
                    // **浏览器入口口**（跨设备时 = clean-proxy 口，如 41576），不是隧道口。
                    // 探活打 clean-proxy：它上游未就绪/或黑 → 探活失败 ×2 → 判「vnet 数据
                    // 黑洞」→ close 隧道 + 120s 禁 → env_open 重建 → 探活又失败 → 循环。
                    // 修：探活目标改为**隧道活口**（route_live_local_port），拿不到才回落 lp。
                    let probe_lp = crate::vnet_forward::route_live_local_port(&k.device, k.port)
                        .unwrap_or(lp);
                    tauri::async_runtime::spawn(async move {
                        // 2026-11-08 真案修正：探活预算 1500ms 对「经 vnet 隧道的完整 HTTP 往返」太紧——
                        // 笔记本→PC 13911(DSH 网关) 实测 2108/2126/3134ms（PC 本地同请求秒回 401）。
                        // 预算 1500ms < 实际 2100ms+ → 探活必失败 → degraded → 拆隧道 → 重建 → 负缓存
                        // 死循环（13911 一晚上的「连接失败（设备离线或网络不可达）」即此）。
                        // 外层 2000→5000、内层 1500→4500（留 500ms 余量）。
                        let ok = tokio::time::timeout(
                            std::time::Duration::from_millis(8000),
                            crate::vnet_env::probe_protocol(probe_lp, &k.kind, std::time::Duration::from_millis(4500)),
                        )
                        .await
                        .unwrap_or(false);
                        // 探活连续失败计数（vnet 隧道黑洞回退判定用）
                        static P2P_FAIL_STREAK: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, u32>>> =
                            std::sync::OnceLock::new();
                        let streaks = P2P_FAIL_STREAK.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
                        let ks = lease_key_string(&k);
                        if ok {
                            streaks.lock().unwrap().remove(&ks);
                            crate::vnet_lease::lease_upstream_ok(&k);
                            return;
                        }
                        let n = { let mut g = streaks.lock().unwrap(); let n = g.entry(ks).or_insert(0); *n += 1; *n };
                        eprintln!(
                            "[vnet-keeper] 上游探活失败 kind={} local={}（连续 {n}）：标 degraded",
                            k.kind, lp
                        );
                        crate::vnet_lease::lease_upstream_fail(&k, "upstream-probe-fail");
                        // **黑洞回退**：vnet 管的隧道连续 2 次探活失败 = "path 升到 P2P 但对端收不到"
                        // 的数据黑洞。此时不能只标 degraded 干等——设计是"允许先中继"：
                        // 负缓存 vnet + 拆这条隧道，keeper 下一拍重建即走 legacy 中继，
                        // 用户先恢复可用；负缓存 120s 过期后 vnet 自动再试直连。
                        // 2026-11-09：阈值 2→4。经 viewer 口的完整往返实测 2-3s，5s 预算下
                        // 2 次抖动就判「黑洞」会把隧道反复拆掉（笔记本「起→停」循环的一部分）。
                        // 2026-11-09 vnet 反馈：**笔记本当前在手机热点（移动蜂窝）**，RTT 86ms、
                        // 抖动 134ms——我们自造的「连续探活失败=黑洞」判据在这种链路上频繁误触发
                        // → 反复 close 隧道。阈值 4→8（≈40s 观察），负缓存 120s→30s（错了也能快速恢复）。
                        if n >= 8 && crate::vnet_forward::is_vnet_managed(&k.device, k.port) {
                            let (path, _) = crate::vnet_forward::vnet_path_info(&k.device, k.port)
                                .map(|(p, a)| (p, a))
                                .unwrap_or_else(|| ("-".into(), String::new()));
                            eprintln!(
                                "[vnet-keeper] vnet 隧道数据黑洞（path={path}，连续 {n} 次探活失败）→ 拆除并回退 legacy 中继，120s 后再试直连：{}#{}",
                                k.device, k.port
                            );
                            crate::vnet_forward::force_vnet_backoff(&k.device, k.port, 30_000);
                            crate::vnet_forward::route_close(&k.device, k.port);
                            streaks.lock().unwrap().remove(&lease_key_string(&k));
                        }
                    });
                }
            }
            // 冷启动观测：第一拍完成时间（与旧 keeper 同口径）。
            static FIRST_TICK: AtomicBool = AtomicBool::new(true);
            if FIRST_TICK.swap(false, Ordering::Relaxed) {
                crate::startup_trace::mark_detail("keeper-tick1", &format!("kept={kept_n}"));
            }
        }
    });
}

#[cfg(feature = "gui")]
fn lease_event_source(device: &str, port: u16, f: impl Fn(crate::vnet_lease::LeaseKey)) {
    for rec in crate::vnet_lease::leases_snapshot() {
        if rec.key.device == device && rec.key.port == port && rec.state != crate::vnet_lease::LeaseState::Closed {
            f(rec.key);
        }
    }
}

#[cfg(feature = "gui")]
fn lease_observe_source(device: &str, port: u16, _cur: u16) {
    // I7：listener 在不在由本进程 accept 任务的真实存活性裁决，不硬编码 true
    // （死条目/外部进程占口都伪造不了自己的 JoinHandle）。
    let alive = crate::vnet_forward::route_listener_alive(device, port);
    let in_use = crate::vnet_forward::route_in_use(device, port, 30_000);
    lease_event_source(device, port, |k| {
        crate::vnet_lease::lease_observe(&k, alive, in_use);
    });
}

#[cfg(feature = "gui")]
fn spawn_rebuild(
    opening: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    device: String,
    port: u16,
    kept_local: Option<u16>,
    lease_key: Option<crate::vnet_lease::LeaseKey>,
) {
    let key = format!("{device}#{port}");
    {
        let mut g = opening.lock().unwrap();
        if g.contains(&key) {
            return;
        }
        g.insert(key.clone());
    }
    tauri::async_runtime::spawn(async move {
        // 固定口契约：kept 记录优先；租约口次之（租约条目没有 kept_local，
        // 旧实现靠 p2p_tunnel 的进程内 preferred_local 兜，新传输层拿不到 →
        // 每拍开随机口 → 与租约口比对必然漂移 → 关旧重开 → 端口无限泄漏）。
        let want_local = kept_local.filter(|p| *p > 0).or_else(|| {
            lease_key
                .as_ref()
                .and_then(|k| crate::vnet_lease::leased_local_port(k.device.as_str(), k.port))
                .filter(|p| *p > 0)
        });
        if let Some(lp) = want_local {
            crate::p2p_tunnel::set_preferred_local(&device, port, Some(lp));
        }
        // 已把恢复口写入固定口档案；传 None 让 route_open 区分 keeper 恢复与
        // 用户本次显式换口，只有前者允许在 stop + AddrInUse 后迁移。
        match crate::vnet_forward::route_open(&device, port, None).await {
            Ok(local) => {
                eprintln!("[vnet-keeper] 转发重建成功 {device}:{port} → 127.0.0.1:{local}");
                crate::startup_trace::mark_detail(
                    "keeper-rebuild-ok",
                    &format!("device={device} port={port} local={local}"),
                );
                if let Some(lp) = kept_local.filter(|p| *p > 0) {
                    if local != lp {
                        eprintln!(
                            "[vnet-keeper] event=kept-port-adopted route={device}:{port} 原约定 :{lp} 实际 :{local}（仅 stop + EADDRINUSE 换口路径允许；下一拍收编 kept 记录）"
                        );
                    }
                }
                match &lease_key {
                    Some(k) => {
                        if local == k_port(k) {
                            crate::vnet_lease::lease_upstream_ok(k);
                        } else {
                            crate::vnet_lease::lease_probe_fail(
                                k,
                                &format!("重建口 {local} ≠ 租约口（绑定被占？）"),
                            );
                        }
                    }
                    None => lease_event_source(&device, port, |k| crate::vnet_lease::lease_upstream_ok(&k)),
                }
            }
            Err(e) => {
                eprintln!("[vnet-keeper] 转发重建失败 {device}:{port}：{e}");
                match lease_key {
                    Some(k) => crate::vnet_lease::lease_probe_fail(&k, e.as_str()),
                    None => lease_event_source(&device, port, |k| crate::vnet_lease::lease_probe_fail(&k, e.as_str())),
                }
            }
        }
        opening.lock().unwrap().remove(&key);
    });
}

#[cfg(feature = "gui")]
fn k_port(k: &crate::vnet_lease::LeaseKey) -> u16 {
    // 租约口快照读法（避免再借表锁：从 leased_local_port 取）
    crate::vnet_lease::leased_local_port(&k.device, k.port).unwrap_or(0)
}

// ═══════════════════════════════════════════════════════════════════════
// 单测（RED→GREEN：先固定契约行为，再由真机 eval 复跑）
// ═══════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    fn key(share: &str) -> LeaseKey {
        LeaseKey {
            consumer_device: "did:myco:CONSUMER".into(),
            kind: "dsh".into(),
            device: "did:myco:SOURCE".into(),
            port: 13911,
            share_id: share.into(),
        }
    }

    /// 2026-10-26 RDP 会话互踢事故：RDP 租约不得主动 X.224 探活。
    #[test]
    fn rdp_leases_are_excluded_from_active_upstream_probe() {
        assert!(upstream_probe_eligible("dsh"));
        assert!(upstream_probe_eligible("http"));
        assert!(
            !upstream_probe_eligible("rdp"),
            "RDP 主动探活会抢占真实会话；健康只能被动观测"
        );
        assert!(!upstream_probe_eligible("ssh"));
    }

    /// §7.1 合法转移全矩阵（正向）。
    #[test]
    fn transition_table_matches_contract() {
        use LeaseEvent as E;
        use LeaseHealth as H;
        use LeaseState as S;
        // reserved + 开卡 → active
        let (s, h, p) = lease_transition(S::Reserved, H::Unknown, 23911, &E::Open(23911)).unwrap();
        assert_eq!((s, h, p), (S::Active, H::Healthy, 23911));
        // active + 上游断开 → degraded，口不变
        let (s, h, p) = lease_transition(S::Active, H::Healthy, 23911, &E::UpstreamFail("rst".into())).unwrap();
        assert_eq!((s, h, p), (S::Degraded, H::Down, 23911));
        // degraded + 探测失败 → recovering
        let (s, _, p) = lease_transition(S::Degraded, H::Down, 23911, &E::ProbeFail("timeout".into())).unwrap();
        assert_eq!((s, p), (S::Recovering, 23911));
        // recovering 再失败 → 仍 recovering（不用随机新口冒充恢复）
        let (s, _, p) = lease_transition(S::Recovering, H::Down, 23911, &E::ProbeFail("again".into())).unwrap();
        assert_eq!((s, p), (S::Recovering, 23911));
        // recovering + 上游恢复 → active，同口
        let (s, h, p) = lease_transition(S::Recovering, H::Down, 23911, &E::UpstreamOk).unwrap();
        assert_eq!((s, h, p), (S::Active, H::Healthy, 23911));
        // 任意非 closed + revoked → closed
        let (s, _, _) = lease_transition(S::Active, H::Healthy, 23911, &E::Release("revoked".into())).unwrap();
        assert_eq!(s, S::Closed);
    }

    /// §7.1 禁止转移：租约期内换口 / 非法释放 / closed 终态。
    #[test]
    fn forbidden_transitions_rejected() {
        use LeaseEvent as E;
        use LeaseHealth as H;
        use LeaseState as S;
        // 异口 Open 一律拒绝（含 degraded/recovering 想换口的场景）
        for s in [S::Reserved, S::Active, S::Degraded, S::Recovering] {
            let e = lease_transition(s, H::Healthy, 23911, &E::Open(40001)).unwrap_err();
            assert!(e.contains("不换口"), "{s:?}: {e}");
        }
        // 非法释放原因
        let e = lease_transition(S::Degraded, H::Down, 23911, &E::Release("upstream-down".into())).unwrap_err();
        assert!(e.contains("非法释放原因"));
        // closed 是终态
        assert!(lease_transition(S::Closed, H::Unknown, 23911, &E::UpstreamOk).is_err());
    }

    /// I2 核心：上游断开/重启全链路里 local_port 一寸不让（表级）。
    #[test]
    fn upstream_down_never_changes_port() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let k = key("sh-lease-1");
        lease_open(&k, 24567).expect("open");
        lease_upstream_fail(&k, "Connection reset by peer");
        lease_probe_fail(&k, "重建失败：目标设备不在线");
        lease_probe_fail(&k, "again");
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert_eq!(rec.local_port, 24567, "上游故障链全走完，口不得变");
        assert_eq!(rec.state.as_str(), "recovering");
        assert_eq!(rec.health.as_str(), "down");
        // 恢复
        lease_upstream_ok(&k);
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert_eq!((rec.state.as_str(), rec.local_port), ("active", 24567));
    }

    /// 同 share 显式换口允许迁移；跨 share 抢口必须明确报错。
    #[test]
    fn port_conflicts_are_explicit() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let k = key("sh-lease-2");
        lease_open(&k, 24568).expect("open");
        // 同一张卡由卡主显式换口：旧租约迁移，不能误当抢口。
        lease_open(&k, 40001).expect("同 share 显式换口应迁移");
        let rows = leases_snapshot();
        let migrated = rows.iter().find(|r| r.key == k).expect("迁移后的租约");
        assert_eq!(migrated.local_port, 40001);
        assert_eq!(
            rows.iter().filter(|r| r.key.device == k.device && r.key.port == k.port).count(),
            1,
            "旧口记录必须被替换，不能留下两份同隧道租约"
        );
        // 同 (device,port) 另一张卡异口仍拒绝。
        let k2 = key("sh-lease-2b");
        let e = lease_open(&k2, 40002).unwrap_err();
        assert!(e.contains("端口租约冲突"), "{e}");
        // 同 (device,port) 同口 → 允许（多卡共享隧道）。
        lease_open(&k2, 40001).expect("同口多卡共享应放行");
    }

    /// 释放原因闸 + 撤销面按 share 批量释放。
    #[test]
    fn release_requires_valid_reason_and_by_share_works() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let k = key("sh-lease-3");
        lease_open(&k, 24569).expect("open");
        assert!(lease_release(&k, "端口被占").is_err(), "网络原因不得释放");
        lease_release(&k, "revoked").expect("revoked 合法");
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert_eq!(rec.state.as_str(), "closed");
        assert_eq!(rec.release_reason.as_deref(), Some("revoked"));

        let k2 = key("sh-lease-4");
        lease_open(&k2, 24570).expect("open");
        assert_eq!(lease_release_by_share("sh-lease-4", "revoked"), 1);
    }

    /// E5/进程重启：租约表从 vnet-leases.json 读回，口与状态保留；文件无凭证。
    #[test]
    fn lease_state_survives_process_restart_and_hides_secrets() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let k = key("sh-restart");
        lease_open(&k, 24571).expect("open");
        lease_upstream_fail(&k, "upstream?mt=SECRETMTVALUE reset");
        let raw = std::fs::read_to_string(leases_path()).expect("落盘必须存在");
        assert!(!raw.contains("SECRETMTVALUE"), "mt 不得明文入状态文件: {raw}");
        assert!(!raw.to_lowercase().contains("private"), "密钥字段不得入状态文件");
        // 模拟进程重启：内存表清空，从盘读回
        test_reset_lease_table();
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).expect("重启后租约仍在");
        assert_eq!(rec.local_port, 24571, "重启后同口");
        assert_eq!(rec.state.as_str(), "degraded", "重启后状态保留");
        // 重启后同口 Open 幂等恢复 active；另一张卡异口抢口仍拒绝。
        lease_open(&k, 24571).expect("同口恢复");
        let other = key("sh-restart-other");
        assert!(lease_open(&other, 40003).is_err(), "跨 share 抢口不改变原租约");
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert_eq!(rec.local_port, 24571, "重启与跨 share 冲突均不得换口");
    }

    /// 失败原因净化：mt 段被抹。
    #[test]
    fn fail_reason_sanitized() {
        let s = sanitize_reason("gw reject 401 url=/gw/x/?mt=abcdef0123456789&x=1 tail");
        assert!(!s.contains("abcdef0123456789"));
        assert!(s.contains("<redacted>"));
    }

    /// L2 分类纯函数。
    #[test]
    fn candidate_kind_classification() {
        assert_eq!(crate::p2p_tunnel::classify_candidate_kind("http://192.168.1.39:9100"), "lan_v4");
        assert_eq!(crate::p2p_tunnel::classify_candidate_kind("http://10.1.2.3:9100"), "lan_v4");
        assert_eq!(crate::p2p_tunnel::classify_candidate_kind("http://203.0.113.99:9100"), "public_v4");
        assert_eq!(crate::p2p_tunnel::classify_candidate_kind("http://[3fff:390:a95::1]:9100"), "ipv6_stable");
        assert_eq!(crate::p2p_tunnel::classify_candidate_kind("http://127.0.0.1:9100"), "loopback");
        assert_eq!(crate::p2p_tunnel::classify_candidate_kind("relay://r1.example.com:443"), "relay");
    }

    /// I7（2026-10-25 live RED 配套）：`lease_observe` 必须如实记录 listener 缺席
    /// （false 持久化、不被后续事件翻回 true），且观测字段与状态机互不越界——
    /// 上游失败不碰 listener_present，观测也不改 state/health。
    /// live RED：laptop:3103 租约 recovering/down 而 listenerPresent=true、
    /// 127.0.0.1:23104 实测无监听（keeper 旧代码硬编码 true）。
    #[test]
    fn observe_records_listener_absence_faithfully() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let k = key("sh-no-listener");
        lease_open(&k, 23104).expect("open");
        // keeper 观测：隧道死条目（socket 已拆）→ listener_present=false
        lease_observe(&k, false, false);
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert!(!rec.listener_present, "无 listener 必须记 false（不得硬编码 true）");
        assert!(!rec.recent_connections);
        assert_eq!(rec.state.as_str(), "active", "观测不动状态机");
        // 上游失败（down 链）也不得把 listenerPresent 翻成 true 或清掉 false
        lease_upstream_fail(&k, "upstream reset");
        lease_probe_fail(&k, "重建失败");
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert!(!rec.listener_present, "事件推进不得篡改 listener 观测");
        assert_eq!(rec.state.as_str(), "recovering");
        assert_eq!(rec.health.as_str(), "down");
        assert_eq!(rec.local_port, 23104);
        // listener 回来（同口重建成功）→ 观测翻 true；health 仍由事件推进
        lease_observe(&k, true, false);
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert!(rec.listener_present);
        assert_eq!(rec.health.as_str(), "down", "listener 在 ≠ 上游可用（I7 分离）");
    }

    /// 2026-10-25 生产 bug 修复（keeper 调用路径）：kept/非 kept 的
    /// `tunnel_live_local_port=None` 分支共用 `observe_listener_missing`，
    /// 必须把陈旧的 listenerPresent=true 清成 false（recent_connections 同清），
    /// 不停留在只测 lease_observe(false) 本身。
    #[test]
    fn keeper_missing_branch_clears_stale_listener_present() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let k = key("sh-stale-true");
        lease_open(&k, 23104).expect("open");
        // 前一拍：listener 在且刚有连接 → true/true（live bug 里的陈旧状态）
        lease_observe(&k, true, true);
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert!(rec.listener_present && rec.recent_connections, "前置：旧观测为 true");
        // 本拍：tunnel_live_local_port=None → keeper（kept 与非 kept None 分支）
        // 调用的正是 observe_listener_missing，不是裸 lease_observe
        observe_listener_missing(&k.device, k.port);
        let rec = leases_snapshot().into_iter().find(|r| r.key == k).unwrap();
        assert!(!rec.listener_present, "缺失分支必须清 false（不得残留 true）");
        assert!(!rec.recent_connections, "无 listener 不得伪造 recentConnections");
        assert_eq!(rec.state.as_str(), "active", "缺失观测不动状态机");
        assert_eq!(rec.local_port, 23104, "缺失观测不换租约口");
        // 多卡共享同 (device,port)：缺失观测须覆盖该口下全部非 closed 租约
        let k2 = key("sh-stale-true-b");
        lease_open(&k2, 23104).expect("同口多卡");
        lease_observe(&k2, true, true);
        observe_listener_missing(&k.device, k.port);
        for rec in leases_snapshot().into_iter().filter(|r| r.key.port == k.port) {
            assert!(!rec.listener_present && !rec.recent_connections, "同口多卡全清");
        }
    }

    /// stop + AddrInUse 是租约迁移的专用窄门；活路由收编只同步事实，不动状态机。
    #[test]
    fn route_port_rebind_is_narrow_and_preserves_lease_state() {
        let _g = crate::test_env_lock::test_env_lock();
        test_reset_lease_table();
        let _ = std::fs::remove_file(leases_path());
        let mut k1 = key("sh-fixed-23911-a");
        let mut k2 = key("sh-fixed-23911-b");
        let mut closed = key("sh-fixed-23911-closed");
        k1.kind = "forward".into();
        k2.kind = "forward".into();
        closed.kind = "forward".into();
        lease_open(&k1, 23911).expect("open a");
        lease_open(&k2, 23911).expect("同 route 同口共享");
        lease_open(&closed, 23911).expect("open closed fixture");
        lease_upstream_fail(&k1, "upstream reset");
        lease_observe(&k1, true, true);
        lease_observe(&k2, true, true);
        lease_release(&closed, "revoked").expect("close fixture");

        assert_eq!(
            lease_rebind_after_addr_in_use(&k1.device, k1.port, 24000, 25001),
            0,
            "原口不匹配时不得误写"
        );
        assert_eq!(
            lease_rebind_after_addr_in_use(&k1.device, k1.port, 23911, 25001),
            2,
            "只迁移该 route 的非 closed 租约"
        );
        let rows = leases_snapshot();
        let migrated = rows.iter().find(|r| r.key == k1).unwrap();
        assert_eq!(migrated.local_port, 25001);
        assert_eq!(migrated.state, LeaseState::Degraded);
        assert_eq!(migrated.health, LeaseHealth::Down);
        assert!(!migrated.listener_present && !migrated.recent_connections);
        let migrated_b = rows.iter().find(|r| r.key == k2).unwrap();
        assert_eq!(migrated_b.local_port, 25001);
        assert!(!migrated_b.listener_present && !migrated_b.recent_connections);
        assert_eq!(
            rows.iter().find(|r| r.key == closed).unwrap().local_port,
            23911,
            "closed 历史不被重写"
        );

        assert_eq!(
            lease_rebind_after_addr_in_use(&k1.device, k1.port, 25001, 0),
            0,
            "租约口同样禁止写成 0"
        );
    }
}
