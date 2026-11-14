//! vnet_forward.rs — myco 层的 vnet 传输适配器 + 传输层统一入口
//!
//! 两件事：
//! 1. 把 vnet crate（UDP-first + P2P 打洞 + 中继兜底）接入 myco 的端口转发模型。
//!    每个 (device, port) 映射对应一个 vnet Connection 实例——协议不动、多实例并行。
//! 2. **收口**：myco 里所有"跨设备建/关/探隧道"的调用点统一走本文件末尾的
//!    [`route_open`] / [`route_close`] / [`route_live_local_port`] /
//!    [`route_listener_alive`] / [`route_local_port`]。legacy 模式下它们原样委托
//!    `p2p_tunnel`（零行为变化）；vnet 模式下先试新传输层，失败回退 legacy。
//!
//! 为什么必须收口（2026-11-05 真案）：`tunnel_acquire` 接上了 vnet 接缝，但
//! `/api/vnet/forward`、固定口 keeper（`vnet_lease`）、`vnet_env` 的环境卡打开
//! 仍然直接调 `p2p_tunnel::tunnel_open` —— 于是"新传输层回归"跑出来的全是旧
//! 路径（PC 日志里 `[vnet-forward]` 一条都没有），改造效果无法验证，也等于没切。
//!
//! MYCO_TUNNEL_TRANSPORT=vnet|legacy（默认 legacy；vnet = 新 UDP 传输）

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;

/// 传输模式
pub fn transport_mode() -> TransportMode {
    match std::env::var("MYCO_TUNNEL_TRANSPORT").as_deref() {
        Ok("vnet") => TransportMode::Vnet,
        _ => TransportMode::Legacy,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransportMode {
    Legacy,
    Vnet,
}

/// peer_id：**整个 u32 都是哈希**，不再有 4-bit slot 语义。
///
/// 2026-11-05 方案变更（vnet 会话定稿）：旧的 `SHA256(...)>>4 | slot` 把低 4 位当
/// 实例号、且 slot 取 `port % 16`，导致同一设备上 `3389 % 16 == 5037 % 16 == 13`
/// 两个服务端口撞同一个 peer_id —— 一个设备最多服务 16 个端口，且差 16 的端口互斥。
/// 新的 Rust 中继默认关闭了"peer_id↔DID 派生校验"（`VNET_STRICT_PEER_ID=1` 才开），
/// 安全性改由「签名注册 + 身份服务注册表 + peer 归属表」三层保证（同一 peer_id 被
/// 别的 DID 注册会被拒），所以 peer_id 可以直接取满 32 位哈希。
fn hash32(seed: &str) -> u32 {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(seed.as_bytes());
    let d = h.finalize();
    u32::from_be_bytes([d[0], d[1], d[2], d[3]])
}

/// 服务端的 peer_id：由「设备 DID + 被服务端口」确定，客户端按同样算法算出来找它。
/// server = SHA256("vnet-peer" || did || ":server:" || port) 低 32 位
pub fn server_peer_id_for(device_did: &str, target_port: u16) -> u32 {
    hash32(&format!("vnet-peer{device_did}:server:{target_port}"))
}

/// 显式 opt-in；默认 false 时所有既有单转发路径保持原样。
fn multi_forward_enabled() -> bool {
    std::env::var("MYCO_VNET_MULTI_FORWARD").as_deref() == Ok("1")
}

/// multi-forward 的设备级 server peer：与首个 target 无关，旧 server 不会碰巧接住 targeted 流。
fn multi_server_peer_id_for(device_did: &str) -> u32 {
    hash32(&format!("vnet-peer{device_did}:server:multi-forward-v1"))
}

// ── 客户端拨号口径：multi 还是 per-port（2026-11-12 手机 5555 真案）──────────────
//
// 事故：PC 对手机 `POST /api/vnet/forward {port:5555}` 返回 ok，日志
// `[vnet-mf] …:5555 → :15556（sharedConnection=true）`，但 adb connect 15556 恒 offline；
// 同时 `[A_lookup_peer] peer=2270166732 no_answer`，而 2270166732 =
// `hash32("vnet-peer{did}:server:multi-forward-v1")` —— PC 拨了**手机从未注册**的 multi peer。
//
// 根因三层（缺一不会发生）：
// ① `start_vnet_forward_selected` 只看**进程级** `MYCO_VNET_MULTI_FORWARD`，
//    `target_port` 仅进 ForwardSpec，**不参与 peer 选择**；
// ② 本该兜底的 `mf_caps_check(remote_net_status)` 在 `version==0`（还没收到对端 NetStatus
//    公告）时直接放行（legacy compat），而手机 JNI 是单口 server、**从不公告** ⇒ 检查恒跳过；
// ③ peer id 必须在建 Connection 之前决定 ⇒ "先连上再问 caps"这条路走不通，只能靠设备类判。
//
// 修法（最小、确定性、零额外延迟）：**multi 只给能跑 multi 的设备类**。
// 手机/平板（JNI 单口 server；契约 ADB-SHARE-TASK.md「PC 按 `:server:<port>` 找手机」）
// 恒走 per-port；其余维持现行为（未知/拿不到 kind 也维持 multi，不扩大改动面）。

/// 设备 kind 是否属于"只有单口 vnet server"的移动端（JNI，无 multi FFI）。
pub(crate) fn is_mobile_only_kind(kind: &str) -> bool {
    matches!(
        kind.trim().to_ascii_lowercase().as_str(),
        "phone" | "tablet" | "android" | "ios"
    )
}

/// **端口语义兜底**：契约上只有手机能当这些端口的单口 server。
///
/// 为什么必须有（2026-11-12 复核）：`cached_device_kind` 是 presence 缓存，**冷缓存**
/// （进程刚起、presence 还没拉到）返回 `None` ⇒ kind 未知 ⇒ 退回 multi ⇒ 手机上 5555
/// 的黑洞原样复现。出包重启后立刻验收必然撞上这个窗口。5555 是当前唯一"对端必是单口
/// server"的口（ADB，见 ADB-SHARE-TASK.md），按端口语义兜底不会误伤 PC↔PC。
const SINGLE_PORT_ONLY_TARGET_PORTS: &[u16] = &[5555];

/// 该 target 端口是否"对端一定是单口 server"（与 kind 无关的硬语义）。
pub(crate) fn is_single_port_only_target(port: u16) -> bool {
    SINGLE_PORT_ONLY_TARGET_PORTS.contains(&port)
}

/// peer 选择口径（纯函数，单测直击）：`true` = 拨 multi，`false` = 拨 per-port。
///
/// 三条同时成立才走 multi：① 全局开关开；② 设备类不是移动端单口；③ 端口语义不是单口。
pub(crate) fn forward_use_multi(multi_enabled: bool, mobile_only: bool, target_port: u16) -> bool {
    multi_enabled && !mobile_only && !is_single_port_only_target(target_port)
}

/// 按口径算该拨的 peer id（纯函数，单测直击）。
///
/// 这是唯一一处把「设备类 × 全局开关 × 端口语义」翻译成 peer id 的地方——回归测试对它
/// 锁死公式，避免再次出现"5555 也走 multi"的走样。
pub(crate) fn forward_peer_id_for(device: &str, port: u16, multi_enabled: bool, kind: Option<&str>) -> u32 {
    let mobile_only = kind.map(is_mobile_only_kind).unwrap_or(false);
    if forward_use_multi(multi_enabled, mobile_only, port) {
        multi_server_peer_id_for(device)
    } else {
        server_peer_id_for(device, port)
    }
}

#[derive(Clone)]
struct SharedVnetConnection {
    conn: Arc<crate::vnet::Connection>,
    client_peer_id: u32,
}

static VNET_MF_CONNECTIONS: std::sync::LazyLock<Mutex<HashMap<String, SharedVnetConnection>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
static VNET_MF_OPEN: std::sync::LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn multi_forward_lock(device: &str) -> Arc<Mutex<()>> {
    VNET_MF_OPEN
        .lock()
        .unwrap()
        .entry(device.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

// ── myco 现有设备身份 → vnet per-peer AUTH ─────────────────────────────────

fn peer_identity_enabled() -> bool {
    std::env::var("MYCO_PEER_IDENTITY").as_deref() == Ok("1")
}

fn resolve_authorized_peer_from(
    records: &[crate::share_auth::AuthorizedDevice],
    key_id: &str,
) -> Option<(String, ed25519_dalek::VerifyingKey)> {
    use base64::Engine as _;
    for record in records {
        if record.auth_state != crate::share_auth::AuthState::Allowed
            || record.auth_expires_at.map(|exp| exp <= now_ms()).unwrap_or(false)
        {
            continue;
        }
        // DID 与公钥必须同源；pubkeyB64 缺省可从 canonical DID 恢复，无缓存/坏缓存直接拒。
        let Some(did_key) = myco_core::identity::did_pubkey_bytes(&record.did) else {
            continue;
        };
        let key = if record.pubkey_b64.trim().is_empty() {
            did_key
        } else {
            let Ok(decoded) = base64::engine::general_purpose::STANDARD
                .decode(record.pubkey_b64.trim())
            else {
                continue;
            };
            let Ok(key): Result<[u8; 32], _> = decoded.try_into() else {
                continue;
            };
            if key != did_key {
                continue;
            }
            key
        };
        let Ok(verifying) = ed25519_dalek::VerifyingKey::from_bytes(&key) else {
            continue;
        };
        if crate::vnet::identity::key_id_of(&verifying) == key_id {
            // AUTH 端用精确字符串比较；授权表里的 did:youling 等价写法统一归一为设备 DID。
            return Some((myco_core::identity::did_from_public(&key), verifying));
        }
    }
    None
}

fn resolve_authorized_peer(key_id: &str) -> Option<(String, ed25519_dalek::VerifyingKey)> {
    let records = crate::share_auth::shared().list();
    resolve_authorized_peer_from(&records, key_id)
}

fn peer_allowed_in_records(
    records: &[crate::share_auth::AuthorizedDevice],
    peer: &crate::vnet::identity::PeerIdentity,
) -> bool {
    resolve_authorized_peer_from(records, &peer.key_id)
        .map(|(canonical_did, _)| canonical_did == peer.did)
        .unwrap_or(false)
}

fn validate_device_seed_did(did: &str, seed: &[u8; 32]) -> Result<(), String> {
    let signing = ed25519_dalek::SigningKey::from_bytes(seed);
    let expected_did = myco_core::identity::did_from_public(&signing.verifying_key().to_bytes());
    if did != expected_did {
        return Err("现有设备 DID 与 device.key 不同源".into());
    }
    Ok(())
}

fn import_existing_peer_identity() -> Result<String, String> {
    use base64::Engine as _;
    let (did, seed_b64) = myco_core::identity::device_identity()
        .map_err(|e| format!("读取现有设备身份失败：{e}"))?;
    let seed = base64::engine::general_purpose::STANDARD
        .decode(seed_b64)
        .map_err(|e| format!("现有设备 seed 解码失败：{e}"))?;
    let seed: [u8; 32] = seed
        .try_into()
        .map_err(|_| "现有设备 seed 长度不是 32B".to_string())?;
    validate_device_seed_did(&did, &seed)?;
    let seed_hex: String = seed.iter().map(|b| format!("{b:02x}")).collect();
    let key_id = crate::vnet::identity::set_local_identity_from_seed(&did, &seed_hex)
        .ok_or_else(|| "vnet 导入现有设备 seed 失败".to_string())?;
    // resolver 可覆写；闭包本身实时读授权表，所以设备/key 轮换不需要重启。
    crate::vnet::identity::set_peer_resolver(Box::new(resolve_authorized_peer));
    // server 缓存只证明“曾经验签”；每条新流仍实时检查当前授权/key，撤销不等 AUTH TTL。
    crate::vnet::identity::set_inbound_auth_hook(Box::new(|ctx| {
        let records = crate::share_auth::shared().list();
        if peer_allowed_in_records(&records, ctx.peer) {
            crate::vnet::identity::AuthDecision::Allow
        } else {
            crate::vnet::identity::AuthDecision::Deny {
                code: "AUTH_REVOKED",
                reason: "设备当前非 Allowed、已过期或 key 已轮换".into(),
            }
        }
    }));
    Ok(key_id)
}

fn ensure_peer_identity() -> Result<(), String> {
    if !peer_identity_enabled() {
        return Ok(());
    }
    let key_id = import_existing_peer_identity()?;
    eprintln!("[vnet-identity] MYCO_PEER_IDENTITY=1，已复用现有设备身份（key_id={key_id}）");
    Ok(())
}

/// 客户端的 peer_id：只要求"在该中继上唯一"，不参与对端寻址
/// （服务端回包用的是 DATA 载荷里携带的 sender_id，中继原样搬）。
/// 掺入本地 DID + 目标 DID + 本地口，保证：
///   · 本机既服务 :13911 又连对端 :13911 时两个 id 不同（旧算法两者相同，中继映射互抢）
///   · 同一设备连不同对端 / 不同本地口互不覆盖
///
/// **2026-11-09 真案（笔记本反复 offline 的根因，vnet 13:03 实测给出）**：relay 对
/// 「同一 peer id 立即重注册」有冷却——kill 后立刻用同 id 重连，relay 连续不回
/// REGISTER_ACK → 建链全失败 → 我方负缓存自锁 120s 循环 → 用户侧「设备离线」。
/// 当时修法：每次建链递增 seq（换新 id 立即注册成功）+ 进程启动随机盐。
///
/// **2026-11-10 churn 收敛（本文件三项修复之三）**：每次递增 seq 的代价是
/// 「换口循环/keeper 重建每转一圈就往 relay 铸一个新 id」——旧 id 全留在 relay
/// 的 peer 表里直到超时，纯粹的 churn。改为**每 (target_did, target_port) 一个
/// 稳定 seq**：同路由同口重建复用同一 id；只有**明确换口**（同 key 但
/// local_port 变化）才 seq+1。跨进程仍由启动随机盐错开。
///
/// ⚠️ 与 2026-11-09 的「同 id 立即重注册冷却」存在张力：stop 后马上同 id 重建
/// 可能吃一次冷却。兜底：①换口/报错路径已先探 bind 再注册（AddrInUse 不再
/// 注册，本 churn 修复的主体）；②Connection 注册自带 1s..16s×5 退避重试；
/// ③失败进 60s 负缓存后自动再试。真机 eval 需观察 stop→重建 是否被冷却卡住。
static CLIENT_PEER_SALT: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
/// (target_did, target_port) → (分配该 seq 时的 local_port, seq)。
/// multi-forward 的 Connection 归整个设备共享，用 target_port=0 作设备级作用域键。
static CLIENT_PEER_SEQS: std::sync::LazyLock<Mutex<HashMap<(String, u16), (u16, u32)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn client_peer_id_for(
    local_did: &str,
    target_did: &str,
    target_port: u16,
    local_port: u16,
) -> u32 {
    let salt = *CLIENT_PEER_SALT.get_or_init(rand::random);
    let key = (target_did.to_string(), target_port);
    let mut seqs = CLIENT_PEER_SEQS.lock().unwrap();
    let seq = match seqs.get_mut(&key) {
        // 同路由同口：复用 seq（id 不变）——churn 重建不再铸新 id。
        Some((port, seq)) if *port == local_port => *seq,
        // 明确换口：seq+1（新口必须配新 id，防止 relay 旧映射串流）。
        Some((port, seq)) => {
            crate::p2p_tunnel::elog!(
                "[vnet-forward] client peer seq 换口递增：{target_did}:{target_port} 口 {port}→{local_port}"
            );
            *port = local_port;
            *seq += 1;
            *seq
        }
        None => {
            seqs.insert(key, (local_port, 0));
            0
        }
    };
    drop(seqs);
    hash32(&format!(
        "vnet-peer{local_did}#client#{target_did}:{target_port}#port:{local_port}#{salt}#{seq}"
    ))
}

/// 一个 vnet 转发条目：本地口 → (对端 DID, 目标口)
pub struct VnetForwardEntry {
    pub local_port: u16,
    pub target_device_did: String,
    pub target_port: u16,
    pub secret: Option<String>,
    pub relay_addr: String,
}

/// 全局 vnet 转发注册表（key = (device_did, target_port)）
static VNET_FORWARDS: std::sync::LazyLock<Mutex<HashMap<(String, u16), VnetForwardHandle>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

pub struct VnetForwardHandle {
    pub local_port: u16,
    pub target_did: String,
    pub target_port: u16,
    /// 本连接的客户端 peer_id —— 用来定位 vnet 自己写的状态文件
    /// （`vnet-status-client-<peer>.txt`，里面有 `path=` / `p2p_peer=`）。
    client_peer_id: u32,
    /// vnet 的客户端 Connection。`stop()` 之后 accept 循环会在 20ms 内退出并
    /// drop listener → 本地口立即释放（vnet 2026-11-05 修复后的语义）。
    conn: Option<Arc<crate::vnet::Connection>>,
    stop_flag: Arc<std::sync::atomic::AtomicBool>,
    /// 本 route 的 accept 线程生命周期；防止把外部进程抢占的同口 listener 误认成活路由。
    accept_alive: Arc<std::sync::atomic::AtomicBool>,
    /// true 时 conn 由同设备多条 route 共享，stop 只 remove 自己的 forward。
    multi_forward: bool,
}

struct AcceptAliveGuard(Arc<std::sync::atomic::AtomicBool>);
impl Drop for AcceptAliveGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

impl VnetForwardHandle {
    pub fn stop(&self) {
        use std::sync::atomic::Ordering;
        self.accept_alive.store(false, Ordering::Relaxed);
        let first_stop = !self.stop_flag.swap(true, Ordering::Relaxed);
        let Some(c) = &self.conn else { return };
        if !self.multi_forward {
            c.stop();
            return;
        }
        if !first_stop {
            return;
        }
        // 与同设备 add_forward/首建互斥，防止“最后一个 remove”与“新 route clone”交错。
        let open_lock = multi_forward_lock(&self.target_did);
        let _open = open_lock.lock().unwrap();
        if let Err(e) = c.remove_forward(self.local_port) {
            crate::p2p_tunnel::elog!("[vnet-mf] remove_forward :{} 失败：{e:#}", self.local_port);
        }
        if c.forwards().is_empty() {
            c.stop();
            let mut shared = VNET_MF_CONNECTIONS.lock().unwrap();
            if shared
                .get(&self.target_did)
                .map(|s| Arc::ptr_eq(&s.conn, c))
                .unwrap_or(false)
            {
                shared.remove(&self.target_did);
            }
        }
    }

    fn listener_alive(&self) -> bool {
        if !self.accept_alive.load(std::sync::atomic::Ordering::Relaxed) {
            return false;
        }
        if !self.multi_forward {
            return true;
        }
        self.conn
            .as_ref()
            .and_then(|c| {
                c.forwards()
                    .into_iter()
                    .find(|f| f.local_port == self.local_port)
                    .map(|f| f.listening)
            })
            .unwrap_or(false)
    }
}

impl Drop for VnetForwardHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

/// 默认中继地址（运维的 100Mbps 专用机）
pub fn default_relay() -> String {
    std::env::var("MYCO_VNET_RELAY")
        .unwrap_or_else(|_| "myco.youling.cc:28322".to_string())
}

/// 默认 PSK/token
pub fn default_secret() -> Option<String> {
    std::env::var("MYCO_VNET_SECRET").ok().or(Some("acc-test".to_string()))
}

/// 给 vnet 的**首选** UDP 端口（可空 = 让 vnet 自己先试 9100 再退随机口）。
///
/// 为什么需要：myco 一条进程里同时跑 legacy p2p 服务端（占 `[::]:9100`）和多个
/// vnet server/client 实例（2026-11-05 vnet 会话加了 `with_secret_and_port` /
/// `start_server_full` 的正规口子）。宿主显式给口，才不会各实例互相抢。
/// 语义由 vnet 保证：优先绑它，绑不上退随机口，**永远公告真实绑定端口**。
pub fn preferred_p2p_port() -> Option<u16> {
    std::env::var("MYCO_VNET_P2P_PORT").ok().and_then(|v| v.parse().ok())
}

fn vnet_key(device: &str, target_port: u16) -> (String, u16) {
    (device.to_string(), target_port)
}

// ── 固定本地口分配 ────────────────────────────────────────────────────────
// 普通 route 不再吃 OS 随机口：无既有记录时在独立的小区间内确定性派生。
// route_open_ephemeral 是 raw 上游的显式例外，仍走下面的 OS 临时口。
//
// 2026-11-10 churn 收敛：SPAN 1000 → 20。旧值让 EADDRINUSE 换口循环最多可试
// 1000 个口（每试一次 = 一次 Connection 注册 + 3 UDP + punch 池）；20 个候选
// 足够覆盖「同进程内口被自己人占住」的正常场景，外部大面积占口属于配置错误，
// 应该快速如实报错而不是扫描全网段。SPAN 同时就是换口循环的尝试上限。
const STABLE_LOCAL_PORT_BASE: u16 = 25_000;
const STABLE_LOCAL_PORT_SPAN: u16 = 20;

fn fnv1a32(seed: &str) -> u32 {
    let mut hash = 2_166_136_261u32;
    for b in seed.as_bytes() {
        hash ^= u32::from(*b);
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn stable_local_port_in_range(port: u16) -> bool {
    (STABLE_LOCAL_PORT_BASE..STABLE_LOCAL_PORT_BASE + STABLE_LOCAL_PORT_SPAN).contains(&port)
}

fn stable_local_port_next(port: u16) -> u16 {
    if !stable_local_port_in_range(port) {
        return STABLE_LOCAL_PORT_BASE;
    }
    STABLE_LOCAL_PORT_BASE
        + (port - STABLE_LOCAL_PORT_BASE + 1) % STABLE_LOCAL_PORT_SPAN
}

fn derived_local_port_base(device: &str, target_port: u16) -> u16 {
    STABLE_LOCAL_PORT_BASE
        + (fnv1a32(&format!("{device}|{target_port}")) % u32::from(STABLE_LOCAL_PORT_SPAN))
            as u16
}

fn probe_stable_local_port(
    start: u16,
    occupied: &std::collections::HashSet<u16>,
) -> Result<u16, String> {
    let start = if stable_local_port_in_range(start) {
        start
    } else {
        STABLE_LOCAL_PORT_BASE
    };
    for offset in 0..STABLE_LOCAL_PORT_SPAN {
        let candidate = STABLE_LOCAL_PORT_BASE
            + (start - STABLE_LOCAL_PORT_BASE + offset) % STABLE_LOCAL_PORT_SPAN;
        if !occupied.contains(&candidate) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "vnet 固定本地口区间 {STABLE_LOCAL_PORT_BASE}..{} 已全部分配",
        STABLE_LOCAL_PORT_BASE + STABLE_LOCAL_PORT_SPAN - 1
    ))
}

fn select_stable_local_port(
    device: &str,
    target_port: u16,
    explicit: Option<u16>,
    registered: Option<u16>,
    preferred: Option<u16>,
    leased: Option<u16>,
    occupied: &std::collections::HashSet<u16>,
) -> Result<u16, String> {
    for port in [explicit, registered, preferred, leased].into_iter().flatten() {
        if port > 0 {
            return Ok(port);
        }
    }
    probe_stable_local_port(derived_local_port_base(device, target_port), occupied)
}

fn rebind_stable_local_port(
    device: &str,
    target_port: u16,
    current: u16,
    occupied: &std::collections::HashSet<u16>,
) -> Result<u16, String> {
    let start = if stable_local_port_in_range(current) {
        stable_local_port_next(current)
    } else {
        derived_local_port_base(device, target_port)
    };
    probe_stable_local_port(start, occupied)
}

fn rebind_allowed(
    allow_pins: bool,
    explicit: Option<u16>,
    error: &StartForwardError,
) -> bool {
    allow_pins
        && explicit.filter(|p| *p > 0).is_none()
        && matches!(error, StartForwardError::AddrInUse(_))
}

// ── 启动固定口宽限（2026-11-11 RDP 三连断事故 §3）──────────────────────────────
//
// 事故：笔记本在 20:54/20:58 两次重启后，keeper 每拍判「固定口漂移」并把实际口
// **收编现状**写回 kept（实测 301 次），用户约定的固定口（如 :23389）根本没被
// 恢复；`%APPDATA%\youling\vnet-forwards.json` 的 mtime 长时间不动 = 收编多数
// 没有落盘生效。
//
// 根因不在"收编"分支本身，而在它上游：进程刚起来时约定口可能还绑不上
// （旧实例 listener 残留 / socket 释放竞态），`route_open` 遇到一次 EADDRINUSE
// 就线性换到下一个稳定口 → keeper 下一拍看到"活路由口 ≠ 约定口" → 收编。
//
// 修法两道闸（缺一不可）：
// 1. 本文件：**启动宽限期内**固定口 bind 失败时，先在约定口上退避重试，超时才换口；
// 2. `vnet_lease` keeper：宽限期内看到"活路由口 ≠ 约定口"**不写 kept 记录**，
//    而是 close + 按约定口重建一次（每 route 整段宽限期只试一次）。
//
// 数值依据（不是"看起来合理"）：
// · ≥3s：用户定调的「从 myco 启动到刷新重连好 ≤3s」是既有契约（见
//   `p2p_tunnel::restore_remembered_tunnels` 文档注释原文），宽限期必须覆盖它；
// · <5s：keeper 探活周期 `vnet_lease::UPSTREAM_PROBE_INTERVAL_MS = 5s`——宽限期
//   一旦超过一个探活周期，首轮健康判定会被整体推后、观察窗口变形；
// · 取自表 500+750+1000+1250 = 3500ms，落在 [3s,5s]；首跳 500ms 的依据是
//   `Connection::stop()` 的既有契约"accept 循环约 20ms 内退出并释放端口"
//   （见本文件 route_open_inner 里 stopped_port_pending 的 20ms 注释），
//   500ms 足够覆盖两轮完整释放；后三跳收紧到 1.25s，总预算不越过探活周期。
pub(crate) const STARTUP_FIXED_PORT_RETRY_DELAYS_MS: [u64; 4] = [500, 750, 1_000, 1_250];

/// 启动宽限期总长 = 重试表之和（3500ms）。
pub(crate) fn startup_grace_ms() -> u64 {
    STARTUP_FIXED_PORT_RETRY_DELAYS_MS.iter().sum()
}

/// 进程启动时刻的兜底（`startup_trace` 未 init 时用：测试/CLI 变体）。
static PROCESS_STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// 进程 uptime（ms）。优先用 `startup_trace` 的 t=0（`main()` 第一行 init 的真
/// 进程起点），否则退化为本模块首次调用时刻——两条都比"当前时刻"更接近真相。
pub(crate) fn process_uptime_ms() -> u64 {
    let traced = crate::startup_trace::elapsed_ms();
    if traced > 0 {
        return u64::try_from(traced).unwrap_or(u64::MAX);
    }
    PROCESS_STARTED
        .get_or_init(std::time::Instant::now)
        .elapsed()
        .as_millis() as u64
}

/// 是否处于启动宽限期（固定口 bind 失败时先重试、不换口）。
pub(crate) fn startup_grace_active(uptime_ms: u64) -> bool {
    uptime_ms < startup_grace_ms()
}

/// 第 `attempt`（0 起）次"约定口重试"前该等多久；`None` = 宽限期已过或次数用尽 → 换口。
pub(crate) fn startup_fixed_port_retry_delay(uptime_ms: u64, attempt: usize) -> Option<u64> {
    if !startup_grace_active(uptime_ms) {
        return None;
    }
    STARTUP_FIXED_PORT_RETRY_DELAYS_MS.get(attempt).copied()
}

/// keeper 用：宽限期内是否该"按约定口收回"（true）而不是"收编现状"（false）。
pub(crate) fn startup_reclaim_allowed(uptime_ms: u64, already_tried: bool) -> bool {
    !already_tried && startup_grace_active(uptime_ms)
}

// 选口 + 写回首选口必须在同一临界区，避免两个新 route 同时派生到同口。
static LOCAL_PORT_ALLOC: Mutex<()> = Mutex::new(());

fn reserved_local_ports() -> std::collections::HashSet<u16> {
    let mut occupied = std::collections::HashSet::new();
    occupied.extend(
        VNET_FORWARDS
            .lock()
            .unwrap()
            .values()
            .map(|h| h.local_port)
            .filter(|p| *p > 0),
    );
    occupied.extend(
        crate::p2p_tunnel::PREFERRED_LOCAL
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .values()
            .copied()
            .filter(|p| *p > 0),
    );
    occupied.extend(
        crate::vnet_lease::leases_snapshot()
            .into_iter()
            .filter(|r| r.state != crate::vnet_lease::LeaseState::Closed)
            .map(|r| r.local_port)
            .filter(|p| *p > 0),
    );
    occupied
}

/// 同步分配一个空闲本地口（绑一下就释放，交给 vnet 正式绑）
fn ephemeral_local_port() -> Result<u16, String> {
    let l = std::net::TcpListener::bind("127.0.0.1:0")
        .map_err(|e| format!("vnet 本地口分配失败：{e}"))?;
    let p = l
        .local_addr()
        .map_err(|e| format!("vnet 本地口读取失败：{e}"))?
        .port();
    drop(l);
    Ok(p)
}

// （2026-11-10 churn 修复之二）原 `local_port_alive`（TCP connect 探本地口）已删除：
// 每次 connect 都会被 vnet 客户端 accept → SESSION_START → 拨上游，keeper 250ms
// 一拍 = 每路由每秒 4 条假会话（server 侧纯开销）。liveness 一律改由
// [`VnetForwardHandle::listener_alive`]（accept 线程存活 + multi 的
// `forwards().listening`）裁决——accept_alive 是本 route 私有的 AtomicBool，
// 外部进程的同口 listener 伪造不了它，原「TCP connect 防外部抢口误判」的
// 意图由它覆盖。

/// 正在建链的 key（同一 (device,port) 并发只允许一个在建，后到者等结果）。
static VNET_INFLIGHT: std::sync::LazyLock<Mutex<std::collections::HashSet<(String, u16)>>> =
    std::sync::LazyLock::new(|| Mutex::new(std::collections::HashSet::new()));

/// vnet 失败的负缓存：(device,port) → 到该时刻（ms）之前不再试 vnet。
/// 没有它，keeper 每拍都会等满 3s 注册超时再回退，把运行时和日志一起拖垮。
static VNET_FAIL_UNTIL: std::sync::LazyLock<Mutex<HashMap<(String, u16), u64>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 设备级黑洞证据：(device) → (黑过的**端口集合**, 窗口起点 ms)。
///
/// 2026-11-05 原设计：对端**根本没跑 vnet server** 的设备（手机旧 APK / ECS），
/// 每个端口都要"vnet 建链成功 → 数据黑洞 → 探活失败 → 拆 → 回退"走一遍全流程。
/// 黑满 2 次（次数计）直接整设备进负缓存，避免逐端口试错。
///
/// 2026-11-07 真案修正（次数 → **去重端口数**）：单端口的数据面瞬断（64KB 窗口
/// 死锁、中继注册瞬断）也会烧满旧计数，把"一次传输失败"放大成"整设备 10 分钟
/// 拒绝一切**新**隧道"（已建隧道不受影响，但重建/诊断/新卡全被锁；排障期间
/// 反复被锁 600s）。改为跨端口证据：真没 server 的设备**所有端口**都会黑，
/// 2 个不同端口很快凑齐（原意图保留）；单端口抖动永远锁不了设备。
static VNET_DEVICE_BLACKHOLES: std::sync::LazyLock<Mutex<HashMap<String, (std::collections::HashSet<u16>, u64)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

const VNET_FAIL_BACKOFF_MS: u64 = 60_000;
/// 设备级负缓存时长与升级阈值
const VNET_DEVICE_BACKOFF_MS: u64 = 600_000;
/// 升级阈值 = 同一窗口内 **2 个不同端口**黑洞（同端口重复失败不再累计）
const VNET_DEVICE_BLACKHOLE_PORTS: usize = 2;
const VNET_DEVICE_WINDOW_MS: u64 = 600_000;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// vnet 负缓存是否生效（`(device,port)` 或设备级）。
///
/// `pub(crate)`：keeper 的离线退避要能分辨"这次重建失败是**新证据**（对端不可达 → 升级退避）
/// 还是只是我们自己的 60s 负缓存还没到点（不该升级，否则一次 60s 负缓存会被放大成 10min 静默）"。
pub(crate) fn vnet_backoff_active(device: &str, target_port: u16) -> bool {
    let now = now_ms();
    let m = VNET_FAIL_UNTIL.lock().unwrap();
    // 设备级优先（没跑 vnet server 的设备整设备停 10 分钟）
    if m.get(&vnet_key(device, 0)).map(|t| now < *t).unwrap_or(false) {
        return true;
    }
    m.get(&vnet_key(device, target_port)).map(|t| now < *t).unwrap_or(false)
}

/// 记一次端口级黑洞证据；**≥2 个不同端口**同窗口黑洞才升级整设备负缓存。
/// 返回是否触发了设备级停用。
fn vnet_device_blackhole(device: &str, port: u16) -> bool {
    let now = now_ms();
    let mut g = VNET_DEVICE_BLACKHOLES.lock().unwrap();
    let e = g
        .entry(device.to_string())
        .or_insert_with(|| (std::collections::HashSet::new(), now));
    if now.saturating_sub(e.1) > VNET_DEVICE_WINDOW_MS {
        *e = (std::collections::HashSet::new(), now); // 窗口过期重计
    }
    e.0.insert(port);
    if e.0.len() >= VNET_DEVICE_BLACKHOLE_PORTS {
        VNET_FAIL_UNTIL
            .lock()
            .unwrap()
            .insert(vnet_key(device, 0), now + VNET_DEVICE_BACKOFF_MS);
        let ports: Vec<String> = e.0.iter().map(|p| p.to_string()).collect();
        crate::p2p_tunnel::elog!(
            "[vnet-route] {device} 已有 {} 个不同端口数据黑洞（{ports:?}，对端多半没跑 vnet server）→ 整设备 {}s 内不再建新 vnet 隧道",
            e.0.len(), VNET_DEVICE_BACKOFF_MS / 1000
        );
        return true;
    }
    false
}

#[derive(Debug)]
enum StartForwardError {
    /// 同步 bind 已明确证明原口被占；只有这一类错误允许隐式 route 换口。
    AddrInUse(String),
    Other(String),
}

impl StartForwardError {
    fn into_message(self) -> String {
        match self {
            Self::AddrInUse(message) | Self::Other(message) => message,
        }
    }
}

/// 启动一个 vnet 客户端转发：本地 local_port → 对端 DID 的 target_port
///
/// 2026-11-05 两次踩坑后的正确姿势：
/// · 注册（`Connection::with_secret`）同步做，失败当场 Err，上层才能回退 legacy；
/// · accept 用 `start_client_detached`（vnet 新 API：先绑口校验、再丢独立线程），
///   **绝不可**用 `start_client` —— 旧版它是阻塞 accept 且不可中断，在 async
///   上下文里调用会把 tokio worker 全吃掉，管理面 HTTP 全部超时、进程假死。
///
/// 成功后**自己登记**进 [`VNET_FORWARDS`]（调用方不需要再插一遍）。
pub fn start_vnet_forward(entry: VnetForwardEntry) -> Result<u16, String> {
    start_vnet_forward_selected(entry).map_err(StartForwardError::into_message)
}

fn start_vnet_forward_selected(entry: VnetForwardEntry) -> Result<u16, StartForwardError> {
    if let Err(e) = ensure_peer_identity() {
        return Err(StartForwardError::Other(e));
    }
    // 2026-11-12 手机 5555 真案：multi 只给能跑 multi 的设备类；手机/平板（JNI 单口 server）
    // 恒走 per-port（`:server:<port>`）。kind 取同步缓存（presence 刷新时落表），
    // **冷缓存/未知时还有端口语义兜底**（5555 恒 per-port），否则重启后第一次验收又撞黑洞。
    let kind = crate::p2p_client::cached_device_kind(&entry.target_device_did);
    let mobile_only = kind.as_deref().map(is_mobile_only_kind).unwrap_or(false);
    let port_only = is_single_port_only_target(entry.target_port);
    if forward_use_multi(multi_forward_enabled(), mobile_only, entry.target_port) {
        start_vnet_forward_multi(entry)
    } else {
        if mobile_only || port_only {
            crate::p2p_tunnel::elog!(
                "[vnet-mf] multi 不适用（kind={} single-port-port={}）→ 改用 per-port peer :server:{}：…{}",
                kind.as_deref().unwrap_or("<unknown>"),
                port_only,
                entry.target_port,
                &entry.target_device_did[entry.target_device_did.len().saturating_sub(12)..]
            );
        }
        start_vnet_forward_inner(entry)
    }
}

fn start_vnet_forward_inner(entry: VnetForwardEntry) -> Result<u16, StartForwardError> {
    if entry.local_port == 0 {
        return Err(StartForwardError::Other(
            "vnet 本地口必须是非零固定口；0 只能由 route_open_ephemeral 先解析成 OS 临时口".into(),
        ));
    }
    let server_peer_id = server_peer_id_for(&entry.target_device_did, entry.target_port);
    let local_did = myco_core::identity::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    if local_did.is_empty() {
        return Err(StartForwardError::Other(
            "本机设备身份不可用（拿不到 DID）".to_string(),
        ));
    }
    let local_port = entry.local_port;

    // ① 先探 bind，后建 Connection（2026-11-10 churn 修复之一）：本地口绑不上
    //    直接走换口/报错路径——不铸 peer_id、不向 relay REGISTER（旧顺序是先
    //    注册再探活，AddrInUse 失败时新 id 已经进了 relay 的 peer 表，纯 churn）。
    //    注意这里只做「能否绑」的裁决，立刻 drop，正式 listener 由 ③ 的 accept
    //    线程绑定（与 multi-forward 路径的同步预检同构）。
    if let Err(e) = std::net::TcpListener::bind(("127.0.0.1", local_port)) {
        let message = format!("vnet 本地口 :{local_port} 绑定失败（注册前预检）：{e}");
        return Err(if e.kind() == std::io::ErrorKind::AddrInUse {
            StartForwardError::AddrInUse(message)
        } else {
            StartForwardError::Other(message)
        });
    }
    let client_peer_id = client_peer_id_for(
        &local_did,
        &entry.target_device_did,
        entry.target_port,
        local_port,
    );

    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let relay = entry.relay_addr.clone();
    let secret = entry.secret.clone();
    let target_port = entry.target_port;
    let did_tail: String = entry
        .target_device_did
        .chars()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    // ② 同步段：注册（中继 REGISTER_ACK 上限 3s）——失败直接 Err，让上层回退 legacy
    crate::vnet::init(); // Windows 定时器精度 → 1ms
    let conn = Arc::new(
        crate::vnet::Connection::with_secret_and_port(
            &relay,
            client_peer_id,
            server_peer_id,
            secret.as_deref(),
            preferred_p2p_port(),
        )
        .map_err(|e| {
            crate::p2p_tunnel::elog!("[vnet-forward] Connection 注册失败（{relay}, peer={client_peer_id:#010x}）: {e}");
            StartForwardError::Other(format!("vnet Connection 注册失败：{e}"))
        })?,
    );

    // ③ accept + 打洞
    //
    // **不要用 `start_client_detached`**（2026-11-05 真案）：它只 bind + spawn accept
    // 循环，**没有**起接收线程 / keepalive / 探测循环 —— 而探测循环正是打洞与
    // `vnet-status-client-*.txt` 的写入点。用它跑出来的客户端永远
    // `path=Relay`、`p2p_peer=-`、连状态文件都不生成（表现就是"vnet 生效但全中继"）。
    //
    // 正确姿势：完整版 `start_client` 是"注册全部后台线程 + 阻塞 accept 主循环"，
    // 放进独立线程跑即可——accept 现在会轮询 `running`，`stop()` 能在 20ms 内退出
    // 并释放端口，所以线程不会泄漏。
    //
    // 注册窗口竞态护栏：① 的预检到此处可能隔了最长 ~3s 的 REGISTER_ACK 等待，
    // 期间本地口可能被别的进程抢走——注册后再探一次 bind，失败仍按 AddrInUse
    // 走换口路径（此时 Connection 已注册，必须 stop 掉）。
    let probe = match std::net::TcpListener::bind(("127.0.0.1", local_port)) {
        Ok(listener) => listener,
        Err(e) => {
            // bind 失败也必须停掉刚注册的 Connection；调用方仅在 AddrInUse 时才换口重试。
            conn.stop();
            let message = format!("vnet 本地口 :{local_port} 绑定失败：{e}");
            return Err(if e.kind() == std::io::ErrorKind::AddrInUse {
                StartForwardError::AddrInUse(message)
            } else {
                StartForwardError::Other(message)
            });
        }
    };
    drop(probe);
    let accept_conn = conn.clone();
    let accept_alive = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let accept_alive_thread = accept_alive.clone();
    if let Err(e) = std::thread::Builder::new()
        .name(format!("vnet-client-{local_port}"))
        .spawn(move || {
            let _alive = AcceptAliveGuard(accept_alive_thread);
            if let Err(e) = accept_conn.start_client(local_port) {
                crate::p2p_tunnel::elog!("[vnet-forward] start_client({local_port}) 退出：{e}");
            }
        })
    {
        conn.stop();
        return Err(StartForwardError::Other(format!(
            "vnet accept 线程启动失败：{e}"
        )));
    }

    crate::p2p_tunnel::elog!(
        "[vnet-forward] 本地 :{local_port} → 对端 …{did_tail}/{server_peer_id:#010x}:{target_port} 已启动（relay={relay}, client={client_peer_id:#010x}）"
    );

    let handle = VnetForwardHandle {
        local_port,
        target_did: entry.target_device_did.clone(),
        target_port,
        client_peer_id,
        conn: Some(conn),
        stop_flag: stop_flag.clone(),
        accept_alive,
        multi_forward: false,
    };
    VNET_FORWARDS
        .lock()
        .unwrap()
        .insert(vnet_key(&entry.target_device_did, target_port), handle);

    // ── 异步段：只管生命周期（stop 信号）──
    std::thread::spawn(move || {
        while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        crate::p2p_tunnel::elog!("[vnet-forward] :{local_port} 已停止");
    });

    Ok(local_port)
}

/// opt-in multi-forward：一对设备共享 Connection，每个 target 一个严格绑定 listener。
fn start_vnet_forward_multi(entry: VnetForwardEntry) -> Result<u16, StartForwardError> {
    if entry.local_port == 0 {
        return Err(StartForwardError::Other(
            "multi-forward 本地口必须非零；由 myco 固定口分配层先解析".into(),
        ));
    }
    let local_port = entry.local_port;
    let target_port = entry.target_port;
    let device = entry.target_device_did.clone();
    let local_did = myco_core::identity::device_identity()
        .map(|(d, _)| d)
        .unwrap_or_default();
    if local_did.is_empty() {
        return Err(StartForwardError::Other(
            "本机设备身份不可用（拿不到 DID）".into(),
        ));
    }

    // 与 legacy 相同的同步预检；只有这里明确 AddrInUse 才允许上层换口。
    if let Err(e) = std::net::TcpListener::bind(("127.0.0.1", local_port)) {
        let message = format!("vnet multi-forward 本地口 :{local_port} 绑定失败：{e}");
        return Err(if e.kind() == std::io::ErrorKind::AddrInUse {
            StartForwardError::AddrInUse(message)
        } else {
            StartForwardError::Other(message)
        });
    }

    // 同设备首建串行；不在此锁里拿 VNET_FORWARDS，避免与 handle Drop 形成逆序。
    let open_lock = multi_forward_lock(&device);
    let _open = open_lock.lock().unwrap();
    let existing = VNET_MF_CONNECTIONS.lock().unwrap().get(&device).cloned();
    let (shared, created) = match existing {
        Some(shared) => (shared, false),
        None => {
            // multi 的 Connection 归整个设备共享（与首个 target 无关）：target 维度
            // 传 0 作设备级作用域键，seq/口变更判定只对「该设备的共享连接」生效。
            let client_peer_id = client_peer_id_for(&local_did, &device, 0, local_port);
            let server_peer_id = multi_server_peer_id_for(&device);
            let relay = entry.relay_addr.clone();
            crate::vnet::init();
            let conn = Arc::new(
                crate::vnet::Connection::with_secret_and_port(
                    &relay,
                    client_peer_id,
                    server_peer_id,
                    entry.secret.as_deref(),
                    preferred_p2p_port(),
                )
                .map_err(|e| {
                    StartForwardError::Other(format!("vnet multi-forward Connection 注册失败：{e}"))
                })?,
            );
            conn.enable_multi_forward();
            // 2026-11-12 vendored 同步改名：start_multi_forward → start_client_multi
            // （apps/vnet 356a63db 的命名，语义一致：只起后台线程不建 legacy listener）。
            conn.start_client_multi().map_err(|e| {
                conn.stop();
                StartForwardError::Other(format!("vnet multi-forward 后台启动失败：{e}"))
            })?;
            (SharedVnetConnection { conn, client_peer_id }, true)
        }
    };

    let info = match shared.conn.add_forward(crate::vnet::forward::ForwardSpec {
        local_port,
        target_port,
    }) {
        Ok(info) => info,
        Err(e) => {
            if created {
                shared.conn.stop();
            }
            return Err(StartForwardError::Other(format!(
                "multi-forward add_forward :{local_port} → target :{target_port} 失败：{e:#}"
            )));
        }
    };
    if info.local_port != local_port {
        let _ = shared.conn.remove_forward(info.local_port);
        if created {
            shared.conn.stop();
        }
        return Err(StartForwardError::Other(format!(
            "multi-forward 实际口漂移：请求 {local_port}，实际 {}",
            info.local_port
        )));
    }
    if created {
        VNET_MF_CONNECTIONS
            .lock()
            .unwrap()
            .insert(device.clone(), shared.clone());
    }
    // 路由表替换可能 Drop 旧 handle 并再次进入 stop；必须先释放生命周期锁。
    // 新 forward 已入表，此时末路由 remove 不会误停正在接管的 Connection。
    drop(_open);

    let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let handle = VnetForwardHandle {
        local_port,
        target_did: device.clone(),
        target_port,
        client_peer_id: shared.client_peer_id,
        conn: Some(shared.conn.clone()),
        stop_flag: stop_flag.clone(),
        accept_alive: Arc::new(std::sync::atomic::AtomicBool::new(true)),
        multi_forward: true,
    };
    VNET_FORWARDS
        .lock()
        .unwrap()
        .insert(vnet_key(&device, target_port), handle);
    std::thread::spawn(move || {
        while !stop_flag.load(std::sync::atomic::Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_secs(1));
        }
        crate::p2p_tunnel::elog!("[vnet-mf] :{local_port} 已移除");
    });
    crate::p2p_tunnel::elog!(
        "[vnet-mf] {device}:{target_port} → :{local_port}（sharedConnection=true, forwards={}）",
        shared.conn.forwards().len()
    );
    Ok(local_port)
}

/// 停止一个 vnet 转发（按 device+port）。vnet 修复后 stop() 20ms 内释放本地口。
pub fn stop_vnet_forward(device: &str, target_port: u16) -> bool {
    let handle = {
        VNET_FORWARDS
            .lock()
            .unwrap()
            .remove(&vnet_key(device, target_port))
    };
    if let Some(h) = handle {
        h.stop();
        true
    } else {
        false
    }
}

/// 列出活跃的 vnet 转发
pub fn list_vnet_forwards() -> Vec<(u16, String, u16)> {
    let m = VNET_FORWARDS.lock().unwrap();
    m.values().map(|h| (h.local_port, h.target_did.clone(), h.target_port)).collect()
}

/// vnet 侧登记的本地口（不管死活）
pub fn vnet_local_port(device: &str, target_port: u16) -> Option<u16> {
    VNET_FORWARDS
        .lock()
        .unwrap()
        .get(&vnet_key(device, target_port))
        .map(|h| h.local_port)
}

/// 读这条 vnet 隧道的**实际数据路径**（vnet 自己写的状态文件里就有）。
///
/// 返回 `(path, p2p_peer)`：`path` 形如 `P2P IPv6` / `P2P UDP` / `Relay`。
/// 为什么需要：用户的目标是"手机/笔记本直连 PC"，中继只算兜底；光看"能连上"
/// 分不出走的是哪条腿（中继一样能连上）。验收必须能读到这一个字段。
pub fn vnet_path_info(device: &str, target_port: u16) -> Option<(String, String)> {
    let peer = {
        let m = VNET_FORWARDS.lock().unwrap();
        m.get(&vnet_key(device, target_port)).map(|h| h.client_peer_id)?
    };
    let path = crate::vnet::status_file_path_for("client", peer);
    let body = std::fs::read_to_string(path).ok()?;
    let mut p = String::new();
    let mut peer_addr = String::new();
    for line in body.lines() {
        if let Some(v) = line.strip_prefix("path=") {
            p = v.trim().to_string();
        } else if let Some(v) = line.strip_prefix("p2p_peer=") {
            peer_addr = v.trim().to_string();
        }
    }
    if p.is_empty() {
        None
    } else {
        Some((p, peer_addr))
    }
}

/// (path, peer_addr, rtt_ms)：vnet_path_info 的 RTT 增强版。
/// RTT 来源：P2P pipe 的 `pipe_v6=v=true ... rtt=Some(3)` / `pipe_v4 ... rtt=Some(N)`，
/// 无 P2P 管道时退 `relay_rtt_ms=N`。都没写 = None（连接刚建/诊断不可用）。
pub fn vnet_path_info_rtt(device: &str, target_port: u16) -> Option<(String, String, Option<u64>)> {
    let peer = {
        let m = VNET_FORWARDS.lock().unwrap();
        m.get(&vnet_key(device, target_port)).map(|h| h.client_peer_id)?
    };
    let path = crate::vnet::status_file_path_for("client", peer);
    let body = std::fs::read_to_string(path).ok()?;
    let mut p = String::new();
    let mut peer_addr = String::new();
    let mut rtt: Option<u64> = None;
    let mut relay_rtt: Option<u64> = None;
    for line in body.lines() {
        let l = line.trim();
        if let Some(v) = l.strip_prefix("path=") {
            p = v.to_string();
        } else if let Some(v) = l.strip_prefix("p2p_peer=") {
            peer_addr = v.to_string();
        } else if let Some(v) = l.strip_prefix("relay_rtt_ms=") {
            relay_rtt = v.parse().ok();
        } else if (l.starts_with("pipe_v4=") || l.starts_with("pipe_v6=")) && rtt.is_none() {
            // pipe_v6=v=true req=2164 rep=5402 fr=0 ack=0.00 rtt=Some(3)
            if let Some(pos) = l.find("rtt=Some(") {
                let rest = &l[pos + 9..];
                if let Some(end) = rest.find(')') {
                    rtt = rest[..end].parse().ok();
                }
            }
        }
    }
    if p.is_empty() {
        None
    } else {
        let final_rtt = rtt.or(relay_rtt);
        Some((p, peer_addr, final_rtt))
    }
}

/// 这条 vnet 隧道是否**直连**（P2P），而不是走中继。
pub fn vnet_is_direct(device: &str, target_port: u16) -> bool {
    vnet_path_info(device, target_port)
        .map(|(p, _)| p.to_ascii_uppercase().contains("P2P"))
        .unwrap_or(false)
}

/// (device,port) 当前是否由 vnet 传输层在管（keeper 探活回退判定用）。
pub fn is_vnet_managed(device: &str, target_port: u16) -> bool {
    VNET_FORWARDS.lock().unwrap().contains_key(&vnet_key(device, target_port))
}

/// 强制进入 vnet 负缓存（下一次重建直接走 legacy 中继）。
///
/// 2026-11-05 真案：vnet 客户端把 `path` 升到 P2P 后，若对端实际收不到
/// （笔记本多个 v6 临时源地址 + 家宽有状态 v6 过滤），**数据整条黑洞**——
/// 本地监听在、上游也在，但协议探活全超时。设计是"允许先中继"，所以必须能退：
/// keeper 连续探活失败时调本函数 + [`route_close`]，下一拍重建即走 legacy 中继，
/// 用户侧先恢复可用；负缓存过期后 vnet 会再试直连（修好后自动升级回来）。
pub fn force_vnet_backoff(device: &str, target_port: u16, ms: u64) {
    VNET_FAIL_UNTIL
        .lock()
        .unwrap()
        .insert(vnet_key(device, target_port), now_ms() + ms);
    // 设备级证据：没跑 vnet server 的设备（手机旧 APK / ECS）每个端口都要黑一次
    // 才回退太慢——同窗口 ≥2 个**不同端口**黑洞直接整设备停 vnet（单端口瞬断
    // 不再烧满计数，2026-11-07 修正）。
    vnet_device_blackhole(device, target_port);
}

/// 清除某 (device, port) 的负缓存与设备黑洞（前台 heal 专用）。
///
/// 语义（2026-11-09）：负缓存的目的是抑制**后台无脑重试**，不是拦住「用户请求
/// 正在等」的显式重建。clean-proxy 首次上游失败即触发 heal——heal 的重建若撞
/// 负缓存墙则连环 502（用户看到转圈+重试叠加的 5s+）。heal 前清账是正确语义。
pub fn clear_vnet_backoff(device: &str, target_port: u16) {
    VNET_FAIL_UNTIL
        .lock()
        .unwrap()
        .remove(&vnet_key(device, target_port));
    VNET_DEVICE_BLACKHOLES.lock().unwrap().remove(device);
}

/// 把 vnet 活跃转发并进"活跃隧道"列表（统一状态面用）。
/// legacy 的 key 是 (device, port)；同一 key 上 vnet 优先（vnet 模式下它就是当家的那条腿）。
pub fn merge_into_live_snapshot(
    live: &mut Vec<(String, u16, u16)>,
) {
    for (local, dev, port) in list_vnet_forwards() {
        live.retain(|(d, p, _)| !(*d == dev && *p == port));
        live.push((dev, port, local));
    }
}

// ── 传输层统一入口（route_*）────────────────────────────────────────────────
//
// 所有"跨设备建/关/探隧道"的调用点都走这组函数。之所以不是把 dispatch 塞进
// `p2p_tunnel::tunnel_open`：本文件失败回退时正好要调 `p2p_tunnel::tunnel_open`，
// 放进去会递归。

/// 建隧道（统一入口）。`preferred_local` = 调用方要求固定本地口（远程桌面/SSH
/// 这类"配置里地址不能变"的用途）；给 None 则依次复用路由/keep/租约口，无记录时
/// 确定性派生。只有显式临时口入口 [`route_open_ephemeral`] 才让 OS 挑口。
pub async fn route_open(
    device: &str,
    target_port: u16,
    preferred_local: Option<u16>,
) -> Result<u16, String> {
    route_open_inner(device, target_port, preferred_local, true).await
}

/// 建一条**强制临时口**的隧道：**不继承** keep/租约里的固定口。
///
/// 为什么必须有（2026-11-06 笔记本 DSH 真案）：分享应用（dsh）的浏览器入口口归
/// 代签代理（卡上 `localPort`，如 23911），raw 上游必须让位随机口。若 raw 走
/// `route_open(None)`，它会从租约读到 23911 并抢先注册：
///   · 代理随后 bind 23911 抢先成功 → vnet 客户端 `start_client(23911)` 报
///     `os error 10048`（raw 监听实际没起来）；
///   · 代理的 upstream 又按登记的 raw 口 = 23911 → **指回自己**，请求自环，
///     页面永久 502/超时（日志 `upstream :23911` + `start_client(23911) 退出`）。
/// 把 raw 钉到 OS 临时口即可根治，与"入口口稳定"的契约不冲突。
pub async fn route_open_ephemeral(device: &str, target_port: u16) -> Result<u16, String> {
    route_open_inner(device, target_port, None, false).await
}

/// `route_open` / `route_open_ephemeral` 的共用实现。
/// `allow_pins=false` ⇒ 显式要求"别用固定口约定"（keep / 租约都不继承）。
async fn route_open_inner(
    device: &str,
    target_port: u16,
    preferred_local: Option<u16>,
    allow_pins: bool,
) -> Result<u16, String> {
    // 2026-11-06 用户令：legacy 退役——本入口**只做 vnet**，不再按模式分流、
    // 不再回退 WS。vnet 的中继腿（path=Relay）就是兜底；失败=如实失败。
    let explicit_local = if allow_pins {
        preferred_local.filter(|p| *p > 0)
    } else {
        None
    };
    if allow_pins && preferred_local == Some(0) {
        crate::p2p_tunnel::elog!(
            "[vnet-route] event=invalid-local-port {device}:{target_port} requested=0 action=stable-derive"
        );
    }
    // ephemeral 不继承这个口，但死条目仍须先 stop（保持旧清理语义）。
    let registered_local = vnet_local_port(device, target_port).filter(|p| *p > 0);
    let preferred_record = if allow_pins {
        crate::p2p_tunnel::preferred_local(device, target_port).filter(|p| *p > 0)
    } else {
        None
    };
    let lease_record = if allow_pins {
        crate::vnet_lease::leased_local_port(device, target_port).filter(|p| *p > 0)
    } else {
        None
    };
    let existing_local = explicit_local
        .or(registered_local)
        .or(preferred_record)
        .or(lease_record);

    // ① 已有活隧道 → 直接复用；活路由的现有口优先，绝不为纠正记录而主动 close。
    if let Some(lp) = route_live_local_port(device, target_port) {
        if let Some(p) = existing_local {
            if p != lp {
                crate::p2p_tunnel::elog!(
                    "[vnet-route] {device}:{target_port} 已有活隧道 :{lp}，复用（忽略请求口 {p}）"
                );
            }
        }
        return Ok(lp);
    }
    // 死条目先 stop 再重建；registered_local 已在上一步保存，所以 stop 不会把口忘掉。
    if registered_local.is_some() {
        crate::p2p_tunnel::elog!("[vnet-route] {device}:{target_port} 旧 vnet 条目已死 → stop 后同口重建");
        stop_vnet_forward(device, target_port);
    }

    // ② 负缓存期内如实失败。
    if vnet_backoff_active(device, target_port) {
        return Err(format!("vnet 负缓存中（刚失败过）：{device}:{target_port}"));
    }

    // ③ 并发去重：同一 key 只允许一个在建，后到者等它出结果。
    let key = vnet_key(device, target_port);
    let leader = VNET_INFLIGHT.lock().unwrap().insert(key.clone());
    if !leader {
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            if let Some(lp) = route_live_local_port(device, target_port) {
                return Ok(lp);
            }
            if !VNET_INFLIGHT.lock().unwrap().contains(&key) {
                break;
            }
        }
        if let Some(lp) = route_live_local_port(device, target_port) {
            return Ok(lp);
        }
        return Err(format!("vnet 建链未完成或 listener 已退出：{device}:{target_port}"));
    }

    // ④ 普通 route 固定非零口；raw 专用入口保留 OS 临时口语义。
    let mut local_port = if allow_pins {
        let selected = {
            let _allocation = LOCAL_PORT_ALLOC.lock().unwrap();
            let occupied = reserved_local_ports();
            select_stable_local_port(
                device,
                target_port,
                explicit_local,
                registered_local,
                preferred_record,
                lease_record,
                &occupied,
            )
            .map(|port| {
                // 派生/复用结果都写回同一份固定口档案，重启和 keeper 不再换口。
                crate::p2p_tunnel::set_preferred_local(device, target_port, Some(port));
                port
            })
        };
        match selected {
            Ok(port) => port,
            Err(e) => {
                VNET_INFLIGHT.lock().unwrap().remove(&key);
                return Err(format!("{e}（{device}:{target_port}）"));
            }
        }
    } else {
        match ephemeral_local_port() {
            Ok(p) => p,
            Err(e) => {
                VNET_INFLIGHT.lock().unwrap().remove(&key);
                return Err(format!("{e}（{device}:{target_port}）"));
            }
        }
    };

    // 注册是阻塞 UDP 往返，必须离开 async worker。显式固定口保持旧契约：占用即 Err；
    // 只有继承/派生的隐式口在同步 bind 明确 AddrInUse 后才线性换口。
    let mut rebind_count = 0u16;
    let mut stopped_port_pending = registered_local;
    // 是不是"隐式约定的固定口"（kept/lease/上次登记口）：只有它值得在启动宽限期内
    // 死等。两个明确排除：
    // · 派生口（无 pin）不是契约，绑不上就换；
    // · **显式指定**口（env_open / keep 的 localPort 参数）保持既有契约「占用即 Err」，
    //   用户当场要结果，不能替他把请求挂 3.5s（那条路径没有"漂移收编"问题）。
    let pin_local = if allow_pins && explicit_local.is_none() {
        existing_local
    } else {
        None
    };
    let mut startup_retries = 0usize;
    let res = loop {
        let entry = VnetForwardEntry {
            local_port,
            target_device_did: device.to_string(),
            target_port,
            secret: default_secret(),
            relay_addr: default_relay(),
        };
        let attempt = tokio::task::spawn_blocking(move || start_vnet_forward_selected(entry))
            .await
            .unwrap_or_else(|e| {
                Err(StartForwardError::Other(format!(
                    "vnet 建链任务异常：{e}"
                )))
            });
        // ① 自身 stop 的释放窗口（既有契约：accept 循环约 20ms 内退出）。
        // 先吃掉这一种，别把它算成"外部占用"消耗宽限次数。
        if matches!(&attempt, Err(StartForwardError::AddrInUse(_)))
            && stopped_port_pending == Some(local_port)
        {
            stopped_port_pending = None;
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            continue;
        }
        // ② 启动宽限（2026-11-11 §3）：进程刚起来时约定口可能还绑不上（旧实例残留 /
        //    释放竞态）。此时**先在约定口上退避重试**，别一次 EADDRINUSE 就换口——
        //    换了口 keeper 下一拍就会把"漂移"收编进 kept（笔记本实测 301 次）。
        //    预算 3500ms（见 STARTUP_FIXED_PORT_RETRY_DELAYS_MS 的数值依据），用尽
        //    或宽限期已过才继续走下面的换口/失败路径。
        if let Err(StartForwardError::AddrInUse(message)) = &attempt {
            if pin_local.is_some() {
                if let Some(delay) = startup_fixed_port_retry_delay(process_uptime_ms(), startup_retries)
                {
                    startup_retries += 1;
                    crate::p2p_tunnel::elog!(
                        "[vnet-route] event=startup-port-grace route={device}:{target_port} 约定口 :{local_port} 仍被占（{message}）→ {delay}ms 后重试（宽限期第 {startup_retries}/{} 次，总预算 {}ms）",
                        STARTUP_FIXED_PORT_RETRY_DELAYS_MS.len(),
                        startup_grace_ms()
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    continue;
                }
            }
        }
        match attempt {
            Err(e) if rebind_count < STABLE_LOCAL_PORT_SPAN
                && rebind_allowed(allow_pins, explicit_local, &e) =>
            {
                let next = {
                    let _allocation = LOCAL_PORT_ALLOC.lock().unwrap();
                    let occupied = reserved_local_ports();
                    rebind_stable_local_port(device, target_port, local_port, &occupied)
                        .map(|port| {
                            crate::p2p_tunnel::set_preferred_local(
                                device,
                                target_port,
                                Some(port),
                            );
                            port
                        })
                };
                let next = match next {
                    Ok(port) => port,
                    Err(allocation_error) => {
                        break Err(StartForwardError::Other(format!(
                            "{}；{allocation_error}",
                            e.into_message()
                        )));
                    }
                };
                crate::p2p_tunnel::elog!(
                    "[vnet-route] event=local-port-rebind reason=EADDRINUSE route={device}:{target_port} old={local_port} new={next} failedConnectionStopped=true"
                );
                crate::vnet_lease::lease_rebind_after_addr_in_use(
                    device,
                    target_port,
                    local_port,
                    next,
                );
                local_port = next;
                rebind_count += 1;
            }
            _ => break attempt,
        }
    };
    VNET_INFLIGHT.lock().unwrap().remove(&key);

    match res {
        Ok(lp) => {
            VNET_FAIL_UNTIL.lock().unwrap().remove(&key);
            Ok(lp)
        }
        Err(e) => {
            let e = e.into_message();
            VNET_FAIL_UNTIL
                .lock()
                .unwrap()
                .insert(key, now_ms() + VNET_FAIL_BACKOFF_MS);
            crate::p2p_tunnel::elog!(
                "[vnet-route] vnet 失败（{e}）：{device}:{target_port}（{VNET_FAIL_BACKOFF_MS}ms 后重试，不回落 legacy）"
            );
            Err(e)
        }
    }
}

/// 关隧道（统一入口）：vnet 条目与 legacy 条目都关（各自幂等）。
pub fn route_close(device: &str, target_port: u16) {
    let had_vnet = stop_vnet_forward(device, target_port);
    let _ = crate::p2p_tunnel::tunnel_close(device, target_port);
    if had_vnet {
        crate::p2p_tunnel::elog!("[vnet-route] close {device}:{target_port}");
    }
}

/// 当前本地口（统一入口）：**vnet-only**——只看 vnet 登记，不再回落 legacy。
/// 2026-11-06 用户令：legacy 退役。残留 legacy 隧道不再被复用，防止"连上但走老路"。
pub fn route_local_port(device: &str, target_port: u16) -> Option<u16> {
    vnet_local_port(device, target_port)
}

/// 当前**活着**的本地口（统一入口）：**vnet-only**——只看 vnet，不再回落 legacy。
/// keeper 靠它判"隧道在不在"，vnet 条目必须答得上来。
pub fn route_live_local_port(device: &str, target_port: u16) -> Option<u16> {
    let registered = VNET_FORWARDS
        .lock()
        .unwrap()
        .get(&vnet_key(device, target_port))
        .map(|h| {
            (
                h.local_port,
                h.listener_alive(),
            )
        });
    if let Some((lp, alive)) = registered {
        // liveness = accept 线程存活（multi 另查 forwards().listening），不再
        // TCP connect 二次确认——connect 本身就会制造假会话（keeper 每秒 4 次/路由），
        // 而 accept_alive 是本 route 私有标志，外部进程的同口 listener 伪造不了。
        if alive {
            return Some(lp);
        }
        crate::p2p_tunnel::elog!(
            "[vnet-route] {device}:{target_port} 本地口 :{lp} 已死（acceptAlive=false，视同隧道缺失）"
        );
    }
    None
}

/// listener 是否在（统一入口）
pub fn route_listener_alive(device: &str, target_port: u16) -> bool {
    crate::p2p_tunnel::tunnel_listener_alive(device, target_port)
        || route_live_local_port(device, target_port).is_some()
}

/// 最近是否有流量（统一入口）。vnet 侧暂无 per-tunnel 流量统计 → 保守 false
/// （只影响"空闲回收"和租约观测里的 inUse 提示，不影响连通性）。
pub fn route_in_use(device: &str, target_port: u16, idle_ms: u64) -> bool {
    crate::p2p_tunnel::tunnel_in_use(device, target_port, idle_ms)
}

// ── dsh_share::tunnel_provider 接缝（MYCO_TUNNEL_TRANSPORT=vnet 时走这里）──

/// tunnel_acquire 调用：建隧道，返回本地口（不要求固定本地口）。
pub async fn vnet_tunnel_open(device: &str, target_port: u16) -> Result<u16, String> {
    let lp = route_open(device, target_port, None).await?;
    crate::p2p_tunnel::elog!("[vnet-forward] tunnel_open {device}:{target_port} → 本地 :{lp}");
    Ok(lp)
}

/// tunnel_close 调用：停这条隧道。
pub fn vnet_tunnel_close(device: &str, target_port: u16) {
    route_close(device, target_port);
}

// ── 服务端启动（被其他设备连接）───────────────────────────────────────────────

/// 服务端实例句柄
static VNET_SERVERS: std::sync::LazyLock<Mutex<HashMap<u16, std::thread::JoinHandle<()>>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

/// 启动一个 vnet 服务端（监听来自其他设备的连接，转发到本地 target_port）。
/// 阻塞式（vnet 的主循环），调用方应 spawn。
/// 端口协调由 vnet 内部处理（占用自动回退随机口 + 公告真实端口）。
pub fn start_vnet_server(target_port: u16) -> Result<(), String> {
    ensure_peer_identity()?;
    let multi = multi_forward_enabled();
    {
        let servers = VNET_SERVERS.lock().unwrap();
        if (multi && !servers.is_empty()) || servers.contains_key(&target_port) {
            return Ok(()); // multi 每设备一个 server；legacy 每 target 一个
        }
    }
    // 2026-11-08 真案撤销（我（DSH协议应用）在 6d0a5870 加的端口占用预检是错的）：
    //   vnet server 不绑定 target_port，它把隧道来的连接**转发到** 127.0.0.1:target_port。
    //   所以"target_port 被服务占用"恰恰是**正常且必需**的前置条件（RDP 3389 被
    //   TermService 占着才是对的状态）。预检把它当冲突跳过 → 3389/13911 等端口
    //   完全没有 vnet server → 对端隧道 alive（relay 注册成功）但数据无人接 = 黑洞。
    //   实证：部署预检后 PC 的 in 方向 server 列表里 3389 缺席（25999 在），
    //   笔记本 23389 隧道 alive 但 X.224 0/8、echo 4KB 超时；而 25999（启动时
    //   echo 服务恰好没起→预检放行）echo 4KB sha256 一致 = 数据面本来好的。
    //   端口协调由 vnet 内部处理（占用自动回退随机口 + 公告真实端口），不需要这里预检。
    let (did, _) = myco_core::identity::device_identity()
        .map_err(|e| format!("设备身份不可用：{e}"))?;
    let peer_id = if multi {
        multi_server_peer_id_for(&did)
    } else {
        server_peer_id_for(&did, target_port)
    };
    let relay = default_relay();
    let secret = default_secret();
    let relay_display = relay.clone();

    let handle = std::thread::Builder::new()
        .name(format!("vnet-server-{target_port}"))
        .spawn(move || {
            crate::vnet::init();
            let secret_str = secret.as_deref();
            match crate::vnet::start_server_full(
                &relay,
                peer_id,
                target_port,
                secret_str,
                preferred_p2p_port(),
            ) {
                Ok(_running) => crate::p2p_tunnel::elog!("[vnet-server] :{target_port} 正常退出"),
                Err(e) => crate::p2p_tunnel::elog!("[vnet-server] :{target_port} 异常退出：{e}"),
            }
        })
        .map_err(|e| format!("vnet server 线程启动失败：{e}"))?;

    VNET_SERVERS.lock().unwrap().insert(target_port, handle);
    crate::p2p_tunnel::elog!(
        "[vnet-server] :{target_port} 已启动（peer_id={peer_id:#010x}, relay={relay_display}, multiForward={multi}；multi 的其它 target 由 VNET_TARGET_PORTS 白名单显式授权）"
    );
    // 2026-11-12 真案（手机→PC 3389 黑洞）沉淀：把 server 侧**实际生效的 target 白名单**
    // 一行打进 stderr（带时间戳）。事故当天排查走了弯路——判定逻辑
    // （`vnet/connection.rs::mf_target_allowed` = `--target-port` ∪ `VNET_TARGET_PORTS`，
    // 启动时 OnceLock 读一次）与**每次拨号明细**（`[srv] STREAM_OPEN … -> 127.0.0.1:<target> OK/FAIL`）
    // 都只走 `tracelog!`→`println!`（**stdout**：`%TEMP%\myco-stdout.log`），grep stderr 一片空，
    // 于是被误读成"server 从未拨号"。这一行 + 下面这句指路，把这个案子压到一次 grep。
    crate::p2p_tunnel::elog!(
        "[vnet-server] target 白名单（multi-forward）：{}；拨号明细在 stdout 的 `[srv] STREAM_OPEN … -> 127.0.0.1:<target> OK/FAIL` 与 `MF_TARGET_DENIED`（Windows: %TEMP%\\myco-stdout.log）",
        multi_forward_targets_summary(target_port, std::env::var("VNET_TARGET_PORTS").ok().as_deref())
    );
    Ok(())
}

/// multi-forward **实际生效**的 target 白名单摘要（纯函数，单测直击）。
///
/// 口径与 `vnet/connection.rs::mf_target_allowed` 一致：
/// `default_port`（本 server 的 `--target-port`）∪ `VNET_TARGET_PORTS`（逗号分隔，启动时读一次）。
/// 唯一有意的差异：**0 被剔除**——它不是合法 target（拨 `127.0.0.1:0` 必失败），
/// 摘要里列进 `allowed` 只会误导读日志的人（vnet 侧解析不过滤 0，但永远拨不通）。
/// 目的：一行回答"3389 到底允不允许"，不必再去翻环境变量/加打印。
pub(crate) fn multi_forward_targets_summary(default_target: u16, env_raw: Option<&str>) -> String {
    let mut extra: Vec<u16> = env_raw
        .map(|s| {
            s.split(',')
                .filter_map(|x| x.trim().parse::<u16>().ok())
                .filter(|p| *p != 0)
                .collect()
        })
        .unwrap_or_default();
    extra.sort_unstable();
    extra.dedup();
    let env_disp = match env_raw.map(str::trim) {
        Some(s) if !s.is_empty() => s.to_string(),
        _ => "<unset>".to_string(),
    };
    let mut allowed = extra.clone();
    if default_target != 0 && !allowed.contains(&default_target) {
        allowed.push(default_target);
        allowed.sort_unstable();
    }
    format!(
        "default={default_target} VNET_TARGET_PORTS={env_disp} extra={extra:?} allowed={allowed:?}"
    )
}

/// 停止全部 vnet 服务端
pub fn stop_vnet_servers() {
    let mut m = VNET_SERVERS.lock().unwrap();
    m.clear();
    crate::p2p_tunnel::elog!("[vnet-server] 全部停止（进程退出时生效）");
}

/// 列出运行中的 vnet 服务端口
pub fn list_vnet_server_ports() -> Vec<u16> {
    VNET_SERVERS.lock().unwrap().keys().copied().collect()
}

/// 按隧道端口白名单**全量**起 vnet 服务端。
///
/// 2026-11-05 真案：原实现只给 `[13911, 3389]` 起了 vnet server，其余白名单端口
/// （22/9000/8787/8790/9100/5037/3103…）在对端**没有 vnet server** —— vnet 客户端
/// 建链"成功"（本地监听在），但数据永远到不了对端（无人接）＝黑洞，只能等
/// keeper 探活失败后回落 legacy。全量起 server 后这些端口同样走 vnet/P2P。
pub fn start_vnet_servers_for_allowed() -> Vec<u16> {
    let mut ports: Vec<u16> = Vec::new();
    for p in crate::p2p_tunnel::tunnel_allowed_ports_snapshot() {
        if p != 0 && !ports.contains(&p) {
            ports.push(p);
        }
    }
    for p in [13911u16, 3389u16] {
        if !ports.contains(&p) {
            ports.push(p);
        }
    }
    if multi_forward_enabled() {
        // 第一个口只是 legacy default；其余 target 必须由 VNET_TARGET_PORTS 显式授权。
        let Some(default_target) = ports.first().copied() else {
            return Vec::new();
        };
        return match start_vnet_server(default_target) {
            Ok(()) => vec![default_target],
            Err(e) => {
                crate::p2p_tunnel::elog!("[vnet-server] multi-forward default :{default_target} 启动失败：{e}");
                Vec::new()
            }
        };
    }
    let mut started = Vec::new();
    for p in ports {
        match start_vnet_server(p) {
            Ok(()) => started.push(p),
            Err(e) => crate::p2p_tunnel::elog!("[vnet-server] :{p} 启动失败：{e}"),
        }
    }
    crate::p2p_tunnel::elog!(
        "[vnet-server] 按白名单全量启动：{:?}（共 {}）",
        started,
        started.len()
    );
    started
}

#[cfg(test)]
mod local_port_tests {
    use super::*;

    #[test]
    fn fnv1a_matches_standard_vector() {
        assert_eq!(fnv1a32("hello"), 0x4f9f2cab);
    }

    #[test]
    fn multi_forward_peer_is_device_scoped_and_distinct_from_legacy() {
        let device = "did:myco:multi-peer";
        assert_eq!(multi_server_peer_id_for(device), multi_server_peer_id_for(device));
        assert_ne!(
            multi_server_peer_id_for(device),
            server_peer_id_for(device, 13911),
            "独立 multi peer 防止旧 server 忽略 target 后误路由"
        );
        assert_ne!(
            multi_server_peer_id_for(device),
            server_peer_id_for(device, 3389)
        );
    }

    fn authorized_peer_fixture(tag: u8) -> crate::share_auth::AuthorizedDevice {
        use base64::Engine as _;
        let signing = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        let public = signing.verifying_key().to_bytes();
        crate::share_auth::AuthorizedDevice {
            did: myco_core::identity::did_from_public(&public),
            name: format!("peer-{tag}"),
            pubkey_b64: base64::engine::general_purpose::STANDARD.encode(public),
            added_at: 0,
            last_seen: 0,
            last_addr: None,
            owner_root_did: None,
            auth_state: crate::share_auth::AuthState::Allowed,
            client_ip: None,
            auth_expires_at: None,
            scopes: Vec::new(),
            origin: None,
            issued_by: None,
        }
    }

    #[test]
    fn authorized_resolver_fails_closed_and_follows_rotation() {
        let a = authorized_peer_fixture(11);
        let b = authorized_peer_fixture(12);
        assert!(validate_device_seed_did(&a.did, &[11; 32]).is_ok());
        assert!(validate_device_seed_did(&b.did, &[11; 32]).is_err());
        let a_key = ed25519_dalek::VerifyingKey::from_bytes(
            &myco_core::identity::did_pubkey_bytes(&a.did).unwrap(),
        )
        .unwrap();
        let a_kid = crate::vnet::identity::key_id_of(&a_key);
        let resolved = resolve_authorized_peer_from(std::slice::from_ref(&a), &a_kid)
            .expect("Allowed canonical DID+pubkey 应可解析");
        assert_eq!(resolved.0, a.did);
        assert_eq!(resolved.1.to_bytes(), a_key.to_bytes());
        assert!(resolve_authorized_peer_from(&[a.clone()], "unknown").is_none());
        assert!(resolve_authorized_peer_from(&[], &a_kid).is_none());
        let mut equivalent_prefix = a.clone();
        equivalent_prefix.did = a.did.replace("did:myco:", "did:youling:");
        assert_eq!(
            resolve_authorized_peer_from(&[equivalent_prefix], &a_kid)
                .unwrap()
                .0,
            a.did,
            "授权表 did:youling 等价前缀须归一为 canonical did:myco"
        );

        let mut denied = a.clone();
        denied.auth_state = crate::share_auth::AuthState::Denied;
        assert!(resolve_authorized_peer_from(&[denied], &a_kid).is_none());
        let mut pending = a.clone();
        pending.auth_state = crate::share_auth::AuthState::Pending;
        assert!(resolve_authorized_peer_from(&[pending], &a_kid).is_none());
        let mut without_cached_pub = a.clone();
        without_cached_pub.pubkey_b64.clear();
        assert!(resolve_authorized_peer_from(&[without_cached_pub], &a_kid).is_some());
        let mut mismatched = a.clone();
        mismatched.pubkey_b64 = b.pubkey_b64.clone();
        assert!(resolve_authorized_peer_from(&[mismatched], &a_kid).is_none());

        // 同一 resolver 实读新表：B 替换 A 后旧 key 立即失效，新 key 可用。
        let b_key = ed25519_dalek::VerifyingKey::from_bytes(
            &myco_core::identity::did_pubkey_bytes(&b.did).unwrap(),
        )
        .unwrap();
        let b_kid = crate::vnet::identity::key_id_of(&b_key);
        assert!(resolve_authorized_peer_from(&[b.clone()], &a_kid).is_none());
        assert_eq!(resolve_authorized_peer_from(&[b.clone()], &b_kid).unwrap().0, b.did);

        let peer_a = crate::vnet::identity::PeerIdentity {
            did: a.did.clone(),
            key_id: a_kid,
            peer_id: 1,
            verified_at: 0,
        };
        assert!(peer_allowed_in_records(&[a.clone()], &peer_a));
        let mut revoked = a.clone();
        revoked.auth_state = crate::share_auth::AuthState::Denied;
        assert!(!peer_allowed_in_records(&[revoked], &peer_a));
        let mut expired = a.clone();
        expired.auth_expires_at = Some(now_ms().saturating_sub(1));
        assert!(!peer_allowed_in_records(&[expired], &peer_a));
        assert!(!peer_allowed_in_records(&[b], &peer_a), "轮换后旧 key 新流立即拒绝");
    }

    #[test]
    fn explicit_and_recorded_ports_keep_their_priority() {
        let occupied = std::collections::HashSet::new();
        assert_eq!(
            select_stable_local_port(
                "did:myco:peer",
                13911,
                Some(23911),
                Some(24001),
                Some(24002),
                Some(24003),
                &occupied,
            )
            .unwrap(),
            23911,
            "显式约定口必须原样保留"
        );
        assert_eq!(
            select_stable_local_port(
                "did:myco:peer",
                13911,
                None,
                Some(24001),
                Some(24002),
                Some(24003),
                &occupied,
            )
            .unwrap(),
            24001,
            "路由表现有口优先于持久化首选口和租约"
        );
        assert_eq!(
            select_stable_local_port(
                "did:myco:peer",
                13911,
                None,
                None,
                Some(24002),
                Some(24003),
                &occupied,
            )
            .unwrap(),
            24002,
            "持久化首选口优先于租约"
        );
        assert_eq!(
            select_stable_local_port(
                "did:myco:peer",
                13911,
                Some(0),
                None,
                None,
                Some(23911),
                &occupied,
            )
            .unwrap(),
            23911,
            "0 不是可绑定约定；过滤后仍须复用租约口"
        );
    }

    #[test]
    fn derived_port_is_stable_and_linearly_probed() {
        let device = "did:myco:stable-port-test";
        let target_port = 13911;
        let base = derived_local_port_base(device, target_port);
        assert_eq!(
            base,
            derived_local_port_base(device, target_port),
            "同一 route 派生结果必须稳定"
        );
        assert!(base >= STABLE_LOCAL_PORT_BASE
            && base < STABLE_LOCAL_PORT_BASE + STABLE_LOCAL_PORT_SPAN);
        assert_eq!(
            select_stable_local_port(
                device,
                target_port,
                Some(0),
                None,
                None,
                None,
                &std::collections::HashSet::new(),
            )
            .unwrap(),
            base,
            "Some(0) 必须派生非零固定口，不能交给 bind(:0)"
        );
        let occupied = [base, stable_local_port_next(base)].into_iter().collect();
        assert_eq!(
            select_stable_local_port(
                device,
                target_port,
                None,
                None,
                None,
                None,
                &occupied,
            )
            .unwrap(),
            stable_local_port_next(stable_local_port_next(base))
        );
    }

    #[test]
    fn probing_wraps_and_reports_a_fully_reserved_range() {
        let last = STABLE_LOCAL_PORT_BASE + STABLE_LOCAL_PORT_SPAN - 1;
        let occupied = [last].into_iter().collect();
        assert_eq!(probe_stable_local_port(last, &occupied).unwrap(), STABLE_LOCAL_PORT_BASE);
        assert_eq!(
            rebind_stable_local_port("did:myco:peer", 13911, last, &occupied).unwrap(),
            STABLE_LOCAL_PORT_BASE,
            "EADDRINUSE 换口也在同一固定区间内回绕"
        );
        let all = (STABLE_LOCAL_PORT_BASE
            ..STABLE_LOCAL_PORT_BASE + STABLE_LOCAL_PORT_SPAN)
            .collect();
        assert!(probe_stable_local_port(STABLE_LOCAL_PORT_BASE, &all).is_err());
    }

    #[test]
    fn dead_accept_thread_never_claims_an_external_listener() {
        let external = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = external.local_addr().unwrap().port();
        let device = format!("did:myco:stale-accept-{}", std::process::id());
        let target_port = 13911;
        VNET_FORWARDS.lock().unwrap().insert(
            vnet_key(&device, target_port),
            VnetForwardHandle {
                local_port: port,
                target_did: device.clone(),
                target_port,
                client_peer_id: 0,
                conn: None,
                stop_flag: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                accept_alive: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                multi_forward: false,
            },
        );
        // 前置（一次性、测试专用）：外部 listener 确实可连接——生产路径已不
        // 用 TCP connect 探活（假会话），这里内联 connect 只作 fixture 断言。
        assert!(
            std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                std::time::Duration::from_millis(300),
            )
            .is_ok(),
            "前置：外部 listener 确实可连接"
        );
        assert_eq!(
            route_live_local_port(&device, target_port),
            None,
            "本 route accept 已死时，外部同口不得伪装成活隧道"
        );
        assert!(stop_vnet_forward(&device, target_port));
    }

    #[test]
    fn client_peer_id_is_stable_per_route_and_changes_only_on_port_change() {
        // 2026-11-10 churn 收敛：seq 按 (target_did, target_port) 稳定分配——
        // 同路由同口重建必须复用同一 id（relay 不再累积新 id）；只有明确换口
        // 才 +1。跨进程唯一性仍由启动随机盐保证（不在此测）。
        let local = format!("did:myco:local-{}", std::process::id());
        let target = format!("did:myco:peer-{}", std::process::id());
        let first = client_peer_id_for(&local, &target, 13911, 23911);
        let second = client_peer_id_for(&local, &target, 13911, 23911);
        assert_eq!(
            first, second,
            "同路由同口重建必须复用同一 client peer_id（churn 收敛的核心不变式）"
        );
        // 明确换口 → 新 id。
        let rebound = client_peer_id_for(&local, &target, 13911, 23912);
        assert_ne!(first, rebound, "换口必须换 id（防 relay 旧映射串流）");
        // 换回原口 → 再递增一次，仍不与最初的 id 重复（seq 单调）。
        let back = client_peer_id_for(&local, &target, 13911, 23911);
        assert_ne!(first, back, "同口来回换也必须每次 +1，不得回滚到旧 id");
        // 不同 target_port → 不同 id（不同路由不共用）。
        let other_route = client_peer_id_for(&local, &target, 3389, 23911);
        assert_ne!(first, other_route, "同设备不同 target 是不同路由");
    }

    #[test]
    fn start_rejects_zero_before_identity_or_network_access() {
        let result = start_vnet_forward_inner(VnetForwardEntry {
            local_port: 0,
            target_device_did: "did:myco:unused".into(),
            target_port: 13911,
            secret: None,
            relay_addr: "127.0.0.1:1".into(),
        });
        assert!(matches!(
            result,
            Err(StartForwardError::Other(message)) if message.contains("非零固定口")
        ));
    }

    /// 2026-11-10 churn 修复之一的回归闸：本地口被占时，**注册前预检**必须当场
    /// 以 AddrInUse 失败——不碰 relay（旧顺序先 Connection 注册再探 bind：用
    /// 不可达 relay 的话会先花 ~30s 重试注册、失败后返回 Other，且新 peer_id
    /// 已铸进 relay 的 peer 表）。断言错误类型 + 消息里的"注册前预检"锚点。
    #[test]
    fn occupied_port_fails_fast_before_any_registration() {
        let _g = crate::test_env_lock::test_env_lock();
        let external = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = external.local_addr().unwrap().port();
        let result = start_vnet_forward_inner(VnetForwardEntry {
            local_port: port,
            target_device_did: "did:myco:occupied-port-target".into(),
            target_port: 13911,
            secret: None,
            relay_addr: "127.0.0.1:1".into(),
        });
        match result {
            Err(StartForwardError::AddrInUse(message)) => {
                assert!(message.contains("注册前预检"), "锚点缺失：{message}");
            }
            other => panic!("口被占必须在注册前以 AddrInUse 快速失败，得到 {other:?}"),
        }
    }

    #[test]
    fn only_implicit_addr_in_use_may_rebind() {
        let in_use = StartForwardError::AddrInUse("os error 10048".into());
        let other = StartForwardError::Other("register timeout".into());
        assert!(rebind_allowed(true, None, &in_use));
        assert!(rebind_allowed(true, Some(0), &in_use));
        assert!(!rebind_allowed(true, Some(23911), &in_use));
        assert!(!rebind_allowed(true, None, &other));
        assert!(!rebind_allowed(false, None, &in_use));
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 观测面（2026-11-06）——`myco vnet peers|relay` 的唯一数据源
//
// 口径（与 lead 对齐，写死在契约里）：
//   · **键只用设备 DID（did:myco）**；did:youling 是账号层，不进 vnet 契约；
//   · `name` 只是本地名册（authorized-dids）的展示名：可能空/重复/过期，
//     查不到就**省略**，绝不作键、不参与匹配；
//   · 入站方向（direction=in）通常拿不到对端 DID（server 只从中间人学到
//     peer_id/地址）→ `device: null`，给 `peerId`/`addr`，**不猜**。
// ═══════════════════════════════════════════════════════════════════════

fn kv_str(kv: &[(String, String)], key: &str) -> Option<String> {
    kv.iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn kv_num(kv: &[(String, String)], key: &str) -> Option<u64> {
    kv_str(kv, key).and_then(|v| v.parse::<u64>().ok())
}

/// 状态文件里的 `updated_at` 是 epoch 秒 → 距今年龄毫秒（时钟回拨给 0）。
fn kv_age_ms(kv: &[(String, String)]) -> Option<u64> {
    let secs = kv_num(kv, "updated_at")?;
    let now = now_ms() / 1000;
    Some(now.saturating_sub(secs).saturating_mul(1000))
}

/// 本地名册里的设备显示名（authorized-dids 备注名；空名视为没有）。
///
/// **只用于展示**：`peers` 的机器契约以 device DID 为键，名字缺失/重复都不影响判定。
fn local_device_name(want_did: &str) -> Option<String> {
    crate::share_auth::shared()
        .list()
        .iter()
        .find(|d| myco_core::identity::did_equiv(&d.did, want_did))
        .map(|d| d.name.trim().to_string())
        .filter(|n| !n.is_empty())
}

/// `GET /api/vnet/peers` 的实现（纯读快照，不动任何隧道状态）。
///
/// out = 本机发起的 client 隧道（`VNET_FORWARDS` + 各自状态文件）；
/// in  = 本机 vnet server 的入站视图（状态文件 `role=server` + 进程内入站表）。
pub fn peers_snapshot() -> serde_json::Value {
    let mut peers: Vec<serde_json::Value> = Vec::new();

    // ── out：本机发起的隧道 ──
    // alive 取 accept 存活（不 TCP connect——那会在观测面上也造假会话）。
    let clients: Vec<(String, u16, u16, u32, bool)> = {
        let m = VNET_FORWARDS.lock().unwrap();
        m.iter()
            .map(|((dev, port), h)| {
                (dev.clone(), *port, h.local_port, h.client_peer_id, h.listener_alive())
            })
            .collect()
    };
    for (device, target_port, local_port, peer_id, alive) in clients {
        let kv = crate::vnet::connection::read_status_file("client", peer_id).unwrap_or_default();
        let mut v = serde_json::json!({
            "direction": "out",
            "device": device,
            "peerId": peer_id,
            "targetPort": target_port,
            "localPort": local_port,
            "alive": alive,
            "backoff": vnet_backoff_active(&device, target_port),
        });
        if let Some(name) = local_device_name(&device) {
            v["name"] = serde_json::json!(name);
        }
        if let Some(p) = kv_str(&kv, "path") {
            v["path"] = serde_json::json!(p);
        }
        if let Some(p) = kv_str(&kv, "p2p_peer").filter(|s| s != "-") {
            v["p2pPeer"] = serde_json::json!(p);
        }
        if let Some(n) = kv_num(&kv, "last_rtt_ms") {
            v["rttMs"] = serde_json::json!(n);
        }
        for (key, out) in [
            ("probe_rounds", "probeRounds"),
            ("candidates", "candidates"),
            ("path_switches", "pathSwitches"),
            ("threads_alive", "threadsAlive"),
            ("probe_req_rx", "probeReqRx"),
            ("probe_reply_rx", "probeReplyRx"),
            ("listen_rx", "listenRx"),
        ] {
            if let Some(n) = kv_num(&kv, key) {
                v[out] = serde_json::json!(n);
            }
        }
        for (key, out) in [
            ("filtering", "filtering"),
            ("inbound_fw", "inboundFw"),
            // NetStatus v2（4FB319EF）：状态文件新增当前推荐策略
            ("strategy", "strategy"),
        ] {
            if let Some(s) = kv_str(&kv, key) {
                v[out] = serde_json::json!(s);
            }
        }
        if let Some(age) = kv_age_ms(&kv) {
            v["ageMs"] = serde_json::json!(age);
        }
        peers.push(v);
    }

    // ── in：本机 server 的入站视图 ──
    // 状态文件 5s 粒度；进程内入站表更实时（30s 窗口），两者合并去重。
    // 陈旧状态文件（旧进程残留，temp 目录不会自动清）会让 `peers` 里堆几十条
    // "in (未知)" 噪音——超过 120s 未刷新的实例一律不展示（真在跑的 server 每 5s 刷新）。
    const IN_STALE_MS: u64 = 120_000;
    let inbound = crate::vnet::connection::p2p_inbound_snapshot();
    for (path, kv) in crate::vnet::connection::list_status_snapshots() {
        if kv_str(&kv, "role").as_deref() != Some("server") {
            continue;
        }
        let Some(peer_id) = kv_num(&kv, "my_peer_id") else {
            continue;
        };
        let age = kv_age_ms(&kv);
        if age.map(|a| a > IN_STALE_MS).unwrap_or(true) {
            continue; // 陈旧/无法判断 → 不展示（宁缺勿噪）
        }
        let mut v = serde_json::json!({
            "direction": "in",
            "device": serde_json::Value::Null,
            "peerId": peer_id,
            "targetPort": kv_num(&kv, "target_port"),
            "clientsSeen": kv_num(&kv, "clients_seen"),
            "statusFile": path.file_name().map(|s| s.to_string_lossy().to_string()),
        });
        let addrs: Vec<String> = kv_str(&kv, "inbound_p2p")
            .map(|s| {
                s.split(',')
                    .map(str::trim)
                    .filter(|x| !x.is_empty())
                    .map(String::from)
                    .collect()
            })
            .unwrap_or_default();
        if !addrs.is_empty() {
            v["inbound"] = serde_json::json!(addrs);
        }
        if let Some(age) = age {
            v["ageMs"] = serde_json::json!(age);
        }
        peers.push(v);
    }
    if !inbound.is_empty() {
        let live: Vec<serde_json::Value> = inbound
            .iter()
            .map(|(addr, age)| serde_json::json!({ "addr": addr, "ageMs": age }))
            .collect();
        // 进程内实时入站表单独一节：状态文件可能还没刷新到最新。
        return serde_json::json!({
            "ok": true, "schema": 1,
            "serverPorts": list_vnet_server_ports(),
            "peers": peers,
            "liveInbound": live,
        });
    }
    serde_json::json!({
        "ok": true, "schema": 1,
        "serverPorts": list_vnet_server_ports(),
        "peers": peers,
    })
}
/// `GET /api/vnet/relay` 的实现：中继地址 + 本端实例 + 负缓存 + 黑洞计数。
///
/// 之所以要有它：`vnet` 的注册失败/负缓存/黑洞目前只出现在 stderr 里，
/// 排障时只能翻日志；这里把它们变成一份可 diff 的快照。
pub fn relay_snapshot() -> serde_json::Value {
    let clients: Vec<serde_json::Value> = {
        let m = VNET_FORWARDS.lock().unwrap();
        m.iter()
            .map(|((dev, port), h)| {
                let kv =
                    crate::vnet::connection::read_status_file("client", h.client_peer_id)
                        .unwrap_or_default();
                let mut v = serde_json::json!({
                    "device": dev,
                    "peerId": h.client_peer_id,
                    "targetPort": port,
                    "localPort": h.local_port,
                    "path": kv_str(&kv, "path"),
                    // accept 存活（不 TCP connect，避免观测面造假会话）
                    "alive": h.listener_alive(),
                });
                if let Some(age) = kv_age_ms(&kv) {
                    v["ageMs"] = serde_json::json!(age);
                }
                v
            })
            .collect()
    };
    // 负缓存：(device, port) → 到点毫秒；port=0 表示整设备级
    let negative: Vec<serde_json::Value> = {
        let m = VNET_FAIL_UNTIL.lock().unwrap();
        let now = now_ms();
        m.iter()
            .filter(|(_, until)| **until > now)
            .map(|((dev, port), until)| {
                serde_json::json!({
                    "device": dev,
                    "port": port,
                    "scope": if *port == 0 { "device" } else { "port" },
                    "untilMs": until,
                    "remainingMs": until.saturating_sub(now),
                })
            })
            .collect()
    };
    let blackholes: Vec<serde_json::Value> = {
        let m = VNET_DEVICE_BLACKHOLES.lock().unwrap();
        let now = now_ms();
        m.iter()
            .map(|(dev, (ports, start))| {
                serde_json::json!({
                    "device": dev,
                    "count": ports.len(),
                    "ports": ports.iter().collect::<Vec<&u16>>(),
                    "windowStartMs": start,
                    "windowAgeMs": now.saturating_sub(*start),
                })
            })
            .collect()
    };
    serde_json::json!({
        "ok": true, "schema": 1,
        "relay": default_relay(),
        "clients": clients,
        "negativeCache": negative,
        "blackholes": blackholes,
        "portBackoffMs": VNET_FAIL_BACKOFF_MS,
        "deviceBackoffMs": VNET_DEVICE_BACKOFF_MS,
        "blackholePorts": VNET_DEVICE_BLACKHOLE_PORTS,
    })
}

/// 2026-11-07 黑障升级口径回归：**去重端口数**（非次数）。
///
/// 真案：单端口数据面瞬断（64KB 窗口死锁/注册瞬断）连续触发探活失败，
/// 旧计数法 2 次即把整设备锁 600s——"一次传输失败"放大成"全设备不可建新隧道"。
#[cfg(test)]
mod blackhole_tests {
    use super::*;

    /// 同一端口反复黑洞（哪怕 10 次）不得升级设备级、不得连坐其它端口。
    #[test]
    fn single_port_storm_never_locks_device() {
        let dev = format!("did:myco:test-bh-single-{}", std::process::id());
        for _ in 0..10 {
            assert!(
                !vnet_device_blackhole(&dev, 13911),
                "同端口重复黑洞不得升级设备级"
            );
        }
        assert!(!vnet_backoff_active(&dev, 0), "设备级键不应存在");
        assert!(!vnet_backoff_active(&dev, 23389), "其它端口不应被连坐");
        VNET_DEVICE_BLACKHOLES.lock().unwrap().remove(&dev);
        VNET_FAIL_UNTIL.lock().unwrap().remove(&vnet_key(&dev, 0));
    }

    /// 两个**不同**端口黑洞 → 升级设备级（保留"对端没 vnet server 快速回退"原意图）。
    #[test]
    fn two_distinct_ports_escalate_device() {
        let dev = format!("did:myco:test-bh-two-{}", std::process::id());
        assert!(!vnet_device_blackhole(&dev, 3389), "第一个端口只记证据");
        assert!(
            vnet_device_blackhole(&dev, 13911),
            "第二个不同端口应触发设备级"
        );
        assert!(vnet_backoff_active(&dev, 0));
        assert!(vnet_backoff_active(&dev, 9100), "设备级生效后任意新端口被拒");
        VNET_DEVICE_BLACKHOLES.lock().unwrap().remove(&dev);
        VNET_FAIL_UNTIL.lock().unwrap().remove(&vnet_key(&dev, 0));
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 启动固定口宽限（2026-11-11 RDP 三连断事故 §3）—— 纯函数契约测试
//
// 事故：笔记本重启后 301 次「固定口漂移 → 收编现状」。上游第一因是约定口
// 刚起来绑不上（旧实例残留 / 释放竞态）→ 一次 EADDRINUSE 就换口 → keeper 下
// 一拍把"漂移"当事实收编。这里钉住两道闸的数值与边界。
// ═══════════════════════════════════════════════════════════════════════
#[cfg(test)]
mod startup_grace_tests {
    use super::*;

    /// 宽限期必须落在 [3s, 5s]：下界 = "从 myco 启动到刷新重连好 ≤3s" 的既有契约，
    /// 上界 = keeper 探活周期（5s）。两个数任何一个变了，先改契约再来改这里。
    #[test]
    fn startup_grace_window_stays_between_three_and_five_seconds() {
        let total = startup_grace_ms();
        assert_eq!(total, 3_500, "宽限期 = 重试表之和 500+750+1000+1250");
        assert!(
            (3_000..=5_000).contains(&total),
            "宽限期必须 ≥3s（重启重连契约）且 ≤5s（探活周期）：{total}"
        );
        assert_eq!(STARTUP_FIXED_PORT_RETRY_DELAYS_MS.iter().sum::<u64>(), total);
        // 每一跳单调不减：不许"先等 2s 再等 100ms"这种抖动
        let mut prev = 0u64;
        for d in STARTUP_FIXED_PORT_RETRY_DELAYS_MS {
            assert!(d >= prev, "重试间隔必须单调不减：{STARTUP_FIXED_PORT_RETRY_DELAYS_MS:?}");
            prev = d;
        }
        assert!(startup_grace_active(0), "进程刚起来就在宽限期内");
        assert!(startup_grace_active(total - 1), "宽限期最后一毫秒仍有效");
        assert!(!startup_grace_active(total), "宽限期到点即失效");
        assert!(!startup_grace_active(60_000));
    }

    /// 宽限期内：约定口连续 4 次 EADDRINUSE 都"再等等"（绝不换口）；
    /// 第 5 次才允许换口。宽限期外一次都不等（恢复旧行为）。
    #[test]
    fn fixed_port_retries_only_inside_grace_and_only_four_times() {
        for attempt in 0..STARTUP_FIXED_PORT_RETRY_DELAYS_MS.len() {
            assert_eq!(
                startup_fixed_port_retry_delay(0, attempt),
                Some(STARTUP_FIXED_PORT_RETRY_DELAYS_MS[attempt]),
                "宽限期内第 {attempt} 跳必须重试约定口（不换口）"
            );
        }
        assert_eq!(
            startup_fixed_port_retry_delay(0, STARTUP_FIXED_PORT_RETRY_DELAYS_MS.len()),
            None,
            "宽限期内重试次数用尽 → 允许换口"
        );
        assert_eq!(startup_fixed_port_retry_delay(0, 99), None);
        // 宽限期外（例如用户 30s 后自己开卡）：不等待，直接换口/如实报错
        for attempt in 0..STARTUP_FIXED_PORT_RETRY_DELAYS_MS.len() {
            assert_eq!(
                startup_fixed_port_retry_delay(30_000, attempt),
                None,
                "宽限期外不得为固定口拖时间"
            );
        }
    }

    /// keeper 侧闸门：宽限期内 + 该 route 还没试过 → 按约定口收回；
    /// 否则（宽限期外 / 已试过）→ 回到收编现状。
    #[test]
    fn reclaim_gate_is_grace_bounded_and_try_once() {
        assert!(startup_reclaim_allowed(0, false));
        assert!(startup_reclaim_allowed(startup_grace_ms() - 1, false));
        assert!(
            !startup_reclaim_allowed(0, true),
            "同一 route 整段宽限期只收一次（防 close↔重建互踩）"
        );
        assert!(
            !startup_reclaim_allowed(startup_grace_ms(), false),
            "宽限期外不再收回，回到收编现状"
        );
        assert!(!startup_reclaim_allowed(60_000, false));
    }

    /// uptime 必须单调不减（来源是 `startup_trace` 的 t=0，不受系统时钟调整影响）。
    #[test]
    fn process_uptime_is_monotonic() {
        let a = process_uptime_ms();
        let b = process_uptime_ms();
        assert!(b >= a, "uptime 必须单调：{a} → {b}");
    }

    // ═══════════════════════════════════════════════════════════════════
    // 2026-11-12 手机 5555 真案：客户端拨号口径（multi vs per-port）
    // ═══════════════════════════════════════════════════════════════════

    /// 现场 DID（手机）与两个公式值必须对得上——回归锁死「拨错 peer id」这个走样点。
    #[test]
    fn phone_5555_dials_per_port_peer_not_multi() {
        let phone = "did:myco:z6MknpnC";
        // 公式自检：multi 与 per-port 是两个不同 peer id（混用即黑洞）
        assert_ne!(server_peer_id_for(phone, 5555), multi_server_peer_id_for(phone));
        // 手机（单口 server）→ 必须 per-port
        for kind in ["phone", "tablet", "android", "ios", " Phone "] {
            assert_eq!(
                forward_peer_id_for(phone, 5555, true, Some(kind)),
                server_peer_id_for(phone, 5555),
                "kind={kind} 必须拨 :server:5555"
            );
        }
        // **冷缓存兜底**（2026-11-12 复核）：kind 未知 + 5555 → 仍必须 per-port，
        // 否则进程刚起、presence 还没拉到时第一次验收又撞黑洞。
        assert_eq!(
            forward_peer_id_for(phone, 5555, true, None),
            server_peer_id_for(phone, 5555),
            "kind 未知 + 5555（单口语义）必须 per-port"
        );
        // 非移动端 / 未知 kind 且非单口端口 → 维持现行为（multi）
        assert_eq!(
            forward_peer_id_for(phone, 13911, true, Some("pc")),
            multi_server_peer_id_for(phone),
            "pc 维持 multi（不改变 PC↔PC 现状）"
        );
        assert_eq!(
            forward_peer_id_for(phone, 13911, true, None),
            multi_server_peer_id_for(phone),
            "拿不到 kind + 非单口端口 = 未知 → 维持现行为"
        );
        // multi 总开关关掉时，任何设备都 per-port
        for kind in [Some("pc"), Some("phone"), None] {
            assert_eq!(
                forward_peer_id_for(phone, 13911, false, kind),
                server_peer_id_for(phone, 13911),
                "MYCO_VNET_MULTI_FORWARD 未开 → per-port（kind={kind:?}）"
            );
        }
    }

    /// 非 5555 的目标（PC 侧 15200/13911/9100 等）行为不变：kind=pc/未知 仍走 multi。
    #[test]
    fn pc_targets_keep_multi_peer_selection() {
        let pc = "did:myco:z6MkuyFr";
        for port in [15200u16, 13911, 9100, 3389] {
            assert_eq!(
                forward_peer_id_for(pc, port, true, Some("pc")),
                multi_server_peer_id_for(pc),
                "PC 目标 :{port} 维持 multi"
            );
            // kind 未知也维持 multi（老客户端不报 kind），但这些端口不是"单口语义"
            assert_eq!(forward_peer_id_for(pc, port, true, None), multi_server_peer_id_for(pc));
        }
    }

    /// kind 分类边界 + 端口语义 + 口径函数三维。
    #[test]
    fn mobile_only_kind_classification() {
        for k in ["phone", "PHONE", "tablet", "android", "ios", " phone "] {
            assert!(is_mobile_only_kind(k), "{k} 应判为移动端单口");
        }
        for k in ["pc", "desktop", "laptop", "", "unknown", "server"] {
            assert!(!is_mobile_only_kind(k), "{k} 不应判为移动端单口");
        }
        // 端口语义：目前只有 ADB 5555 是"对端必单口"
        assert!(is_single_port_only_target(5555));
        for p in [15200u16, 13911, 9100, 3389, 22, 5037, 3103] {
            assert!(!is_single_port_only_target(p), "{p} 不是单口语义端口");
        }
        // 口径函数：multi 开关 × 设备类 × 端口语义
        assert!(forward_use_multi(true, false, 13911));
        assert!(!forward_use_multi(true, true, 13911), "移动端恒 per-port");
        assert!(!forward_use_multi(true, false, 5555), "5555 恒 per-port（冷缓存兜底）");
        assert!(!forward_use_multi(false, false, 13911));
        assert!(!forward_use_multi(false, true, 5555));
    }

    // ═══════════════════════════════════════════════════════════════════
    // 2026-11-12 真案（手机→PC 3389 黑洞）：server 侧 target 白名单摘要
    //
    // 事故里"3389 不拨"的第一层判据就是"它在不在 allowed 里"。口径必须与
    // `vnet/connection.rs::mf_target_allowed`（default ∪ VNET_TARGET_PORTS）逐字一致，
    // 否则这行日志会把人带偏——比没有日志更糟。
    // ═══════════════════════════════════════════════════════════════════

    /// 现场环境：`VNET_TARGET_PORTS=15200,13911,3389,9100`，server 的 default=22。
    #[test]
    fn multi_forward_summary_lists_production_whitelist_including_3389() {
        let s = multi_forward_targets_summary(22, Some("15200,13911,3389,9100"));
        assert!(s.contains("default=22"), "{s}");
        assert!(s.contains("VNET_TARGET_PORTS=15200,13911,3389,9100"), "原样透出：{s}");
        assert!(s.contains("extra=[3389, 9100, 13911, 15200]"), "解析+排序+去重：{s}");
        assert!(s.contains("allowed=[22, 3389, 9100, 13911, 15200]"), "default 并入且去重：{s}");
        // 关键断言：3389 必须在 allowed 里 —— 若这行显示不在，才轮到"白名单拒"这条线索
        assert!(s.contains("3389"), "3389 必须出现在摘要里：{s}");
    }

    /// 未设/空/含垃圾项：不能把"没配"误报成"配了"。
    #[test]
    fn multi_forward_summary_handles_unset_and_malformed_env() {
        assert!(
            multi_forward_targets_summary(9100, None).contains("VNET_TARGET_PORTS=<unset>"),
            "未设必须显式标 <unset>"
        );
        let empty = multi_forward_targets_summary(9100, Some("   "));
        assert!(empty.contains("extra=[]"), "{empty}");
        assert!(empty.contains("allowed=[9100]"), "只有 default：{empty}");
        // 垃圾项（非数字/0/超范围）一律丢弃，不能变成"允许 0 号端口"
        let junk = multi_forward_targets_summary(22, Some("abc, 3389 ,,0,70000,13911"));
        assert!(junk.contains("extra=[3389, 13911]"), "只留合法项：{junk}");
        assert!(!junk.contains("[0"), "0 不得入白名单：{junk}");
        // default 已在 extra 里 → 不重复
        let dup = multi_forward_targets_summary(3389, Some("3389"));
        assert!(dup.contains("allowed=[3389]"), "去重：{dup}");
    }
}

