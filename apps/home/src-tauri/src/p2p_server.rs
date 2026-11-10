//! p2p_server.rs — 第84轮：聊天 IPv6 直连服务器（消息本体不过服务器）。
//!
//! 从 env 的 direct_server.rs 移植核心（X-Myco-Auth 验签 + detect_ipv6_all +
//! Windows 防火墙提示 + 0.0.0.0 双栈绑定定案），职责换成 P2P 聊天数据面：
//!   GET  /p2p/ping          连通性探测（无签名；成功率脚本/手机 probe 用）
//!   POST /p2p/msg           收消息（设备钥验签 + 好友闸）→ 幂等落盘 → 前端事件
//!   POST /p2p/sync/digest   对账①：对方摘要进来，我回自己的摘要（双方各自对比 F）
//!   POST /p2p/sync/index    对账③：回指定会话的 msgId 索引
//!   POST /p2p/sync/batch    对账④：收 push 消息（幂等落盘）+ 回 want 的消息
//!   POST /p2p/media/chunk   第96轮：媒体分片上传（正文/媒体解耦；收齐组装校验 sha256）
//!   POST /p2p/media/fetch   第96轮：按需分片拉取（对账 want 媒体 / open_file re-fetch）
//!   POST /p2p/typing        瞬时打字信号（不落盘，emit 事件 3s 过期）
//!   GET  /p2p/tunnel        2026-10-09：P2P web 隧道（WS 承载的透明 TCP 字节流，
//!                           转发到本机白名单 loopback 端口——见 p2p_tunnel.rs）
//!
//! 另：本文件同时是多路径寻址的**采集侧**——`detect_local_candidates()` 给出
//! lan（私有 IPv4）/ publicV4（本机公网 IPv4）/ ipv6List（全球 IPv6）三类候选，
//! `urls_from_addrs()` 按 lan → publicV4 → ipv6 顺序构造候选 URL（实测选路在
//! p2p_client 侧逐地址试）。注册表发布点（presence 心跳）由集成侧接。
//!
//! 端口：默认 9100（MYCO_P2P_PORT 覆盖）。与 myco-env.exe 的 direct_server
//! （MYCO_DIRECT_PORT=9100）同机冲突时自动 +1 顺延（9101…），实际端口上报
//! presence（addrs.port）——双实例 E2E 也靠这个机制分离。
//!
//! 鉴权（比 env 版简化——聊天不需要授权表白名单）：X-Myco-Auth（did.ts.sig）
//! 设备钥签名，公钥从 DID 自派生（did:myco:<base58(pubkey)>，自证）；
//! 业务闸 = 发送方账号（from）必须是本机好友或本机账号（多设备自同步）。
//!
//! 第95轮安全修（P2P 身份伪造）：签名只证明"持有某把设备钥"，from 是自报字段——
//! 原闸不校验"签名设备真的属于 from 账号"，任何注册过设备钥的端都能伪造
//! from=受害者的任何好友。新增归属闸（移植 identity-svc msg.mjs 群管理消息的
//! root_device 归属校验思想，fail-closed）：签名设备的归属账号必须 == from，
//! 否则一律 403。归属查询通道的选择理由见 device_belongs_to_account 注释。

use axum::{
    body::Bytes,
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier as _, VerifyingKey};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::sync::Arc;
// 非 test 构建才引 Tauri `Emitter`：`p2p_router()` 会被**测试**引用
// （`p2p_tunnel::tunnel_tests::spawn_p2p_server` 起本机 p2p 服务），路由处理函数
// 里的 `.emit()` 于是把 tauri 的 webview 运行时（Wry → muda → 静态导入
// `comctl32.dll!TaskDialogIndirect`，v6 专属符号）锚进**没有 exe manifest** 的测试
// exe → 加载即 `0xC0000139`，`cargo test -p myco-home --lib` 全体起不来。
// 详见 `apps/home/src-tauri/build.rs` 顶部长注释（附最小复现与排除过的修法）。
#[cfg(not(test))]
use tauri::Emitter as _;

const AUTH_WINDOW_MS: u64 = 60_000;
/// 对账 batch 单批上限（每批 50 条 gzip 级；防单请求打爆）。
pub const SYNC_BATCH_MAX: usize = 200;

pub struct P2pState {}

impl Default for P2pState {
    fn default() -> Self { Self {} }
}

/// 启动 IPv6 直连 P2P 服务（axum；端口冲突顺延）。
/// AppHandle 存全局（p2p_client::APP_HANDLE）供事件发射；lib.rs setup 已先存。
pub async fn start_p2p_server(app: tauri::AppHandle) {
    if crate::p2p_client::current_app_handle().is_none() {
        *crate::p2p_client::APP_HANDLE.lock().unwrap() = Some(app);
    }
    start_p2p_server_for_test().await
}

/// 同上（无窗口形态——CLI/E2E 测试用；事件发射静默降级）。
pub async fn start_p2p_server_for_test() {
    crate::startup_trace::mark("p2p-enter");
    let port_base: u16 = std::env::var("MYCO_P2P_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(9100);

    // 2026-10-23 冷启动提速：ipconfig 探测与 netsh 防火墙检查都是**诊断/加固**，
    // 不参与监听，却在 bind 前后各挡一段（子进程几百 ms）。改为 bind 后丢后台线程：
    // 9100 的 LISTEN/accept 立刻可用，诊断日志晚一点写不影响任何协议。
    let state = Arc::new(P2pState {});
    let router = p2p_router_with_state(state);

    // 端口冲突顺延（myco-env direct_server / 双实例同机）：9100 起 +1 重试。
    // 绑定 [::] + IPV6_V6ONLY=0 双栈（E2E 实测 2026-09-28：0.0.0.0 只收 IPv4，
    // IPv6 直连 [240e:...]:port 打不通——P2P 主路径是 IPv6，必须 [::] 双栈）。
    for off in 0..10u16 {
        let port = port_base + off;
        match bind_dual_stack(port) {
            Ok(listener) => {
                let bound_addr = listener.local_addr().ok();
                P2P_PORT.store(port, std::sync::atomic::Ordering::Relaxed);
                // 统一端口档案（2026-10-14）：实际绑定口写进 ports.json 的 tunnel
                // 字段（冲突顺延后可能不是 9100——调用方从文件读实际值）。
                crate::ports_file::record("tunnel", port);
                crate::startup_trace::mark_detail("p2p-bound", &format!("port={port}"));
                std::thread::spawn(|| {
                    let ipv6 = detect_ipv6_all();
                    if ipv6.is_empty() {
                        eprintln!("[p2p] 未检测到全球 IPv6（直连将依赖 IPv4/LAN）");
                    } else {
                        eprintln!("[p2p] 本机 IPv6 = {:?}", ipv6);
                    }
                });
                std::thread::spawn(move || check_firewall(port));
                eprintln!("[p2p] listening on {:?}（冲突自动顺延）", bound_addr);
                crate::startup_trace::mark("p2p-serve-start");
                if let Err(e) = axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>()).await {
                    eprintln!("[p2p] serve error: {}", e);
                }
                return;
            }
            Err(e) => {
                eprintln!("[p2p] bind port {} failed ({}), 顺延端口", port, e);
            }
        }
    }
    eprintln!("[p2p] 9100-9109 全部绑定失败——P2P 服务器未启动");
}

/// 组装 P2P 路由（8 条数据面端点 + 1 条隧道端点；CORS/body limit 与产线同一份）。
/// 服务器与**隧道 E2E** 共用（测试在本机回环 socket 上直接 serve 它，不碰真机端口/防火墙）。
pub fn p2p_router() -> Router {
    p2p_router_with_state(Arc::new(P2pState {}))
}

fn p2p_router_with_state(state: Arc<P2pState>) -> Router {
    Router::new()
        .route("/p2p/ping", get(handle_ping))
        .route("/p2p/msg", post(handle_msg))
        .route("/p2p/sync/digest", post(handle_sync_digest))
        .route("/p2p/sync/index", post(handle_sync_index))
        .route("/p2p/sync/batch", post(handle_sync_batch))
        .route("/p2p/media/chunk", post(handle_media_chunk))
        .route("/p2p/media/fetch", post(handle_media_fetch))
        .route("/p2p/typing", post(handle_typing))
        // 2026-10-09：反射地址（我在公网看来是什么地址）——多路径寻址的"公网出口"来源。
        // 服务器按 TCP peer 观测源地址并回给签名设备（不引 STUN 外部依赖），
        // 见 `record_reflexive_observation` / `reflexive_addrs` 的语义与边界说明。
        .route("/p2p/reflect", post(handle_reflect))
        // 2026-10-09：P2P web 隧道（WS 承载透明 TCP；握手验签 + 端口白名单 + 审计，
        // 见 p2p_tunnel.rs）。GET + WebSocketUpgrade。
        .route("/p2p/tunnel", get(crate::p2p_tunnel::handle_tunnel))
        // CORS：手机 WebView / PWA 浏览器跨 origin 直连 PC（安全由设备签名保证，同 env 定案）。
        // 2026-10-07 修（三端互测矩阵 m4 实锤）：白名单缺 x-myco-attest /
        // x-myco-delegation —— 分身/具身态浏览器直连（transport.ts authHeaders 双证
        // 必带 X-Myco-Attest，委任状随行 X-Myco-Delegation）预检即被拒，直推全落空。
        .layer(
            tower_http::cors::CorsLayer::new()
                .allow_origin(tower_http::cors::Any)
                .allow_methods([axum::http::Method::GET, axum::http::Method::POST, axum::http::Method::OPTIONS])
                .allow_headers([
                    axum::http::header::CONTENT_TYPE,
                    axum::http::HeaderName::from_static("x-myco-auth"),
                    axum::http::HeaderName::from_static("x-myco-attest"),
                    axum::http::HeaderName::from_static("x-myco-delegation"),
                    // 隧道握手（设备签名的端口/账号信封，raw 串即签名载荷）
                    axum::http::HeaderName::from_static(crate::p2p_tunnel::TUNNEL_HANDSHAKE_HEADER),
                ]),
        )
        // 图片/文件 b64 内联：图片 2MB（b64~2.8MB）；第94轮任意文件 10MB（b64~14MB）
        // ——默认 2MB 不够，8MB 也不够，提到 16MB 留裕量
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024 * 1024))
        .with_state(state)
}

/// legacy 模式双栈监听 [::]:port；vnet 模式只监听 IPv4 回环。
/// 两种模式必须使用匹配的 socket domain：不能用 IPv6 socket 绑 127.0.0.1。
fn bind_for_mode(
    port: u16,
    mode: crate::vnet_forward::TransportMode,
) -> std::io::Result<tokio::net::TcpListener> {
    use socket2::{Domain, Protocol, Socket, Type};
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

    let (domain, addr) = match mode {
        crate::vnet_forward::TransportMode::Vnet => (
            Domain::IPV4,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        ),
        crate::vnet_forward::TransportMode::Legacy => (
            Domain::IPV6,
            SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port),
        ),
    };
    let sock = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    if mode == crate::vnet_forward::TransportMode::Legacy {
        // Windows 默认 v6only=true（不映射 v4）；置 false 才是双栈。
        sock.set_only_v6(false)?;
    }
    sock.set_reuse_address(false)?;
    sock.bind(&addr.into())?;
    sock.listen(1024)?;
    sock.set_nonblocking(true)?;
    tokio::net::TcpListener::from_std(sock.into())
}

fn bind_dual_stack(port: u16) -> std::io::Result<tokio::net::TcpListener> {
    bind_for_mode(port, crate::vnet_forward::transport_mode())
}

#[cfg(test)]
mod bind_tests {
    use super::bind_for_mode;
    use crate::vnet_forward::TransportMode;
    use std::net::{Ipv6Addr, SocketAddr, SocketAddrV6, TcpStream};

    #[tokio::test]
    async fn vnet_binds_ipv4_loopback_and_accepts() {
        let listener = bind_for_mode(0, TransportMode::Vnet).expect("vnet 回环绑定必须成功");
        let addr = listener.local_addr().unwrap();
        assert!(addr.is_ipv4(), "vnet 必须是 IPv4 socket：{addr}");
        assert!(addr.ip().is_loopback(), "vnet 不得对外暴露：{addr}");
        TcpStream::connect(addr).expect("vnet 回环连接必须成功");
    }

    #[tokio::test]
    async fn legacy_binds_dual_stack_and_accepts_ipv6_loopback() {
        let listener = bind_for_mode(0, TransportMode::Legacy).expect("legacy 双栈绑定必须成功");
        let addr = listener.local_addr().unwrap();
        assert!(addr.is_ipv6(), "legacy 必须保留 IPv6 socket：{addr}");
        assert!(addr.ip().is_unspecified(), "legacy 保留 [::] 监听：{addr}");
        let loopback = SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::LOCALHOST, addr.port(), 0, 0));
        TcpStream::connect(loopback).expect("legacy IPv6 回环连接必须成功");
    }
}

/// 实际监听端口（0=未就绪）。presence 上报与发送端寻址用。
pub static P2P_PORT: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);

pub fn p2p_port() -> u16 {
    P2P_PORT.load(std::sync::atomic::Ordering::Relaxed)
}

// ══════ 验签（自证：DID 即公钥）——env direct_server 同款 ══════

/// did → 公钥（**canonical-only**，spec v0.3 §3.1）：`did:myco:z…` / `did:youling:z…`
/// （multibase 前缀 z + 0xed01 头 + 32B 公钥，载荷恒 34B）——委托 myco-core
/// [`myco_core::identity::did_pubkey_bytes`] 单一真源。
/// **legacy 裸 base58 已废止**（2026-10-10 系统拍板）：老版本客户端/存量 legacy did
/// 在连接闸门一律拒（验签失败返回 None），不再双形态放行。
fn pubkey_from_did(did: &str) -> Option<[u8; 32]> {
    myco_core::identity::did_pubkey_bytes(did)
}

/// 验 X-Myco-Auth（did.ts.sig，签 `did\nts\n<rawBody>`）→ Some(did)。
/// pub(crate)：隧道握手复用同一口径（签名载荷换成 x-myco-tunnel 头的 raw 串）。
pub(crate) fn verify_auth(headers: &HeaderMap, raw_body: &[u8]) -> Option<String> {
    // 2026-10-25：单一真源搬到 share_auth::verify_p2p_auth（CLI 变体也编译）。
    crate::share_auth::verify_p2p_auth(headers, raw_body)
}


// ══════ 第95轮：设备→账号归属闸（防伪造 from） ══════

/// 身份服务基址（名册归属查询用）。默认 TLS 域名——名册响应是验签依据，
/// 明文 IP 通道可被链路中间人伪造（防伪造修复不能以明文拉取防伪造依据）。
/// MYCO_DID_BASE 覆盖（E2E/本地 identity-svc 联调；与 p2p_client 同环境变量）。
fn identity_base() -> String {
    std::env::var("MYCO_DID_BASE").unwrap_or_else(|_| "https://myco.youling.cc/myco-id".into())
}

/// 名册缓存条（rootPubkeyB64 + 未吊销设备裸公钥列表）。
struct RosterEntry {
    root_pub: String,
    active: Vec<String>,
    fetched: std::time::Instant,
    /// 拉取失败/账号不存在——短 TTL 吸收突发（服务宕机时每条消息都 4s 超时会把处理器串死）。
    negative: bool,
}

static ROSTER_CACHE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, RosterEntry>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 正缓存 TTL（吊销传播的时滞上界；聊天/对账是低频流量，10min 足够密）。
const ROSTER_TTL_OK_SECS: u64 = 600;
/// 负缓存 TTL（网络抖动不锁死新设备——15s 后重试即可认领）。
const ROSTER_TTL_NEG_SECS: u64 = 15;

/// 解析 GET /root/:did 响应 → (rootPubkeyB64, 未吊销设备裸公钥列表)。纯函数（单测直击）。
/// 首设备（/root/create 入册、无 attestSig）也在 devices[] 里——不影响本解析。
fn parse_roster(v: &Value) -> Option<(String, Vec<String>)> {
    let data = v.get("data")?;
    let root_pub = data.get("rootPubkeyB64")?.as_str()?.to_string();
    let active = data
        .get("devices")?
        .as_array()?
        .iter()
        .filter(|d| d.get("revoked").and_then(|r| r.as_i64()).unwrap_or(1) == 0)
        .filter_map(|d| d.get("pubkeyB64").and_then(|p| p.as_str()).map(String::from))
        .collect();
    Some((root_pub, active))
}

/// 名册判定：设备裸公钥 ∈ 未吊销设备列表，或 == rootPubkeyB64（首设备=根钥场景，
/// 对齐 identity-server resolveDeviceRoots 的 root_account 兜底）。纯函数。
fn roster_allows(root_pub: &str, active: &[String], dev_pub_b64: &str) -> bool {
    active.iter().any(|p| p == dev_pub_b64) || root_pub == dev_pub_b64
}

/// 拉账号名册（带缓存）。None = 查不到/网络失败（调用方 fail-closed）。
async fn roster_devices(account: &str) -> Option<(String, Vec<String>)> {
    {
        let c = ROSTER_CACHE.lock().unwrap();
        if let Some(e) = c.get(account) {
            let ttl = if e.negative { ROSTER_TTL_NEG_SECS } else { ROSTER_TTL_OK_SECS };
            if e.fetched.elapsed().as_secs() < ttl {
                return if e.negative { None } else { Some((e.root_pub.clone(), e.active.clone())) };
            }
        }
    }
    let url = format!("{}/root/{}", identity_base(), account);
    let parsed: Option<(String, Vec<String>)> = async {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(4))
            .build()
            .ok()?;
        let resp = http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let v: Value = resp.json().await.ok()?;
        parse_roster(&v)
    }
    .await;
    let mut c = ROSTER_CACHE.lock().unwrap();
    let entry = match &parsed {
        Some((rp, act)) => RosterEntry { root_pub: rp.clone(), active: act.clone(), fetched: std::time::Instant::now(), negative: false },
        None => RosterEntry { root_pub: String::new(), active: vec![], fetched: std::time::Instant::now(), negative: true },
    };
    c.insert(account.to_string(), entry);
    parsed
}

/// 本机签发的委任状里是否覆盖该设备（同账号不同设备=委任状场景的本地凭据）。纯函数。
fn local_delegation_allows(
    recs: &[myco_core::delegation::DelegationRecord],
    from: &str,
    dev_pub_b64: &str,
) -> bool {
    recs.iter().any(|r| {
        // 前缀不敏感：旧委任状 account_did=did:myco:，信封 from 现行=did:youling:（同账号）
        !r.revoked && myco_core::identity::account_did_eq(&r.delegation.account_did, from) && r.delegation.device_pubkey_b64 == dev_pub_b64
    })
}

/// 测试钩子（cfg(test)）：直接种名册缓存（跳过网络）——chat_service 好友握手
/// 接收链（friend_ingest_msg 归属闸）的单测注入用。active=未吊销设备裸公钥 b64 列表。
#[cfg(test)]
pub(crate) fn test_seed_roster_cache(account: &str, active_pubkeys_b64: Vec<String>) {
    ROSTER_CACHE.lock().unwrap().insert(
        account.to_string(),
        RosterEntry {
            root_pub: String::new(),
            active: active_pubkeys_b64,
            fetched: std::time::Instant::now(),
            negative: false,
        },
    );
}

/// 归属闸：签名设备（fromDevice）必须真的属于 from 账号。
/// 通道（快→慢）：
///   ① from==本机账号 且签名设备==本机设备 → 放行（无网也通；多设备自同步主路径）；
///   ② from==本机账号 且设备钥 ∈ 本机签发且未吊销的委任状（delegations.json）→ 放行
///     （手机被本 PC 授权=同账号不同设备，本地即有凭据）；
///   ③ 云名册 GET /root/{from}（公开读，供验签方查钥——root.mjs 路由注释定案）→
///     设备裸公钥 ∈ 未吊销设备 / == rootPubkeyB64 → 放行。
/// 为什么用 GET /root/:did 而不是 GET /device/:pubkeyB64 反查：反查要求 root_device 行
/// 带 attestSigB64，而首设备是 /root/create 直接入册（无 attestation）→ 反查 404，
/// 会把"好友主 PC 发来的消息"全部误杀；/root/:did 返回全名册含首设备。
/// 为什么不用 /presence/by-root：要 signed_post（重、依赖本机注册态），且名册数据同源。
/// 查不到/网络失败/名册缺失 → false（fail-closed，同 msg.mjs 名册缺失定案）。
/// 2026-10-07 好友去服务端化：chat_service::friend_ingest_msg 的名册归属闸复用
/// 本函数（防冒充三件套与 auth_gate 同链——单一逻辑源）。
pub(crate) async fn device_belongs_to_account(from_device: &str, from: &str) -> bool {
    if from_device.is_empty() || from.is_empty() {
        return false;
    }
    let dev_pub = match myco_core::identity::device_pubkey_from_did_or_b64(from_device) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let my = myco_core::identity::account_did().unwrap_or_default();
    if !my.is_empty() && myco_core::identity::account_did_eq(from, &my) {
        // ① 本机设备
        if myco_core::identity::device_identity().map(|(d, _)| d).unwrap_or_default() == from_device {
            return true;
        }
        // ② 本机签发且未吊销的委任状设备
        if local_delegation_allows(&myco_core::delegation::Delegations::load().list(), from, &dev_pub) {
            return true;
        }
    }
    // ③ 云名册（委任状设备经 DID 互换授权也会 /root/device/add 入册，与 ② 互补）
    match roster_devices(from).await {
        Some((root_pub, active)) => roster_allows(&root_pub, &active, &dev_pub),
        None => false,
    }
}

/// 闸门拒绝原因（单测可断言；一律 403——拒绝语义不泄给攻击者更多面）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateReject {
    /// fromDevice ≠ 签名设备（拿别人设备 did 签名伪造 from 的惯用手法）
    DeviceMismatch,
    /// from 非本机账号也非 ok 好友
    NotFriend,
    /// 签名设备不属于 from 账号（伪造身份）/名册不可查（fail-closed）
    Ownership,
}

impl GateReject {
    fn into_response(self) -> Response {
        let body = match self {
            GateReject::DeviceMismatch => json!({ "error": "fromDevice 与签名者不一致" }),
            GateReject::NotFriend => json!({ "error": "不是你的好友，拒收", "notFriend": true }),
            GateReject::Ownership => json!({ "error": "签名设备不属于声称的发送账号" }),
        };
        (StatusCode::FORBIDDEN, Json(body)).into_response()
    }
}

/// 纯决策（全部输入已备齐）——单测直击；auth_gate 的唯一逻辑源。
///
/// ★4（多归属共识 #4，2026-10-09）：`holds_delegation` = 本机持有「from 账号签给
/// 本设备钥」的有效委任状（成员设备面）。持凭据账号的来信视同"自家人"（self_sync
/// 同档）——不再因"from≠活动账号且非好友"被 NotFriend 403。只加判定分支，
/// fail-closed 基调不变：验签 / fromDevice 一致 / 归属闸全部照常。
fn gate_decision(
    signer: &str,
    from_device: &str,
    from: &str,
    my_account: &str,
    is_friend: bool,
    belongs: bool,
    holds_delegation: bool,
) -> Result<(), GateReject> {
    if from_device != signer {
        return Err(GateReject::DeviceMismatch);
    }
    let self_sync = !my_account.is_empty() && myco_core::identity::account_did_eq(from, my_account);
    // ★4：本机持 from 账号有效委任状 → 自家人来信（多归属成员面）
    let ours = self_sync || holds_delegation;
    if !ours && !is_friend {
        return Err(GateReject::NotFriend);
    }
    if !belongs {
        return Err(GateReject::Ownership);
    }
    Ok(())
}

/// 验签 + 业务闸 + 归属闸（输入已解析形态——测试可注入 my/is_friend 走全路径）。
async fn auth_gate_with(
    headers: &HeaderMap,
    raw_body: &[u8],
    body: &Value,
    my_account: &str,
    is_friend: bool,
    holds_delegation: bool,
) -> Result<(), Response> {
    let did = match verify_auth(headers, raw_body) {
        Some(d) => d,
        None => {
            return Err((
                StatusCode::FORBIDDEN,
                Json(json!({ "error": "auth failed（设备签名无效）" })),
            ).into_response())
        }
    };
    let from_device = body.get("fromDevice").and_then(|v| v.as_str()).unwrap_or("");
    let from = body.get("from").and_then(|v| v.as_str()).unwrap_or("");
    // 廉价闸先行（设备不一致/非好友直接 403）——过了才做归属解析（可能一次云名册
    // HTTP；垃圾流量不值得为它发名册请求）。
    if let Err(r) = gate_decision(&did, from_device, from, my_account, is_friend, true, holds_delegation) {
        return Err(r.into_response());
    }
    let belongs = device_belongs_to_account(from_device, from).await;
    gate_decision(&did, from_device, from, my_account, is_friend, belongs, holds_delegation)
        .map_err(GateReject::into_response)
}

/// 好友闸豁免判定：
///   · delegation-notify（2026-10-06 收编通知）：from=主设备账号，对成员设备不是
///     好友（收编前无任何关系）——不豁免则 NotFriend 误杀。通知本体只是"去取件"
///     提示，真授权凭证由成员取件链保证——伪通知最坏后果 = 多一轮无害轮询。
///   · friend-request/accept/remove（2026-10-07 好友去服务端化）：握手必然来自
///     非好友（加好友时双方还没有关系）——不豁免则握手永远进不了门。
/// 豁免仅限好友闸：验签 / fromDevice 一致 / 归属闸全保留；好友握手接收端
/// （chat_service::friend_ingest_msg）另做 payload.sig 验签（端到端防冒充——
/// 信箱路径服务器不校验 from 归属，接收端三件套是权威闸）。纯函数（单测直击）。
fn friend_gate_exempt_kind(kind: &str) -> bool {
    kind == "delegation-notify"
        || kind == "friend-request"
        || kind == "friend-accept"
        || kind == "friend-remove"
}

/// 验签 + 业务闸 + 归属闸。返回 Err(Response) = 拒绝。
async fn auth_gate(headers: &HeaderMap, raw_body: &[u8], body: &Value) -> Result<(), Response> {
    let my = myco_core::identity::account_did().unwrap_or_default();
    let from = body.get("from").and_then(|v| v.as_str()).unwrap_or("");
    let kind = body.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    // ★4：本机持 from 账号有效委任状（多归属成员面）→ 自家人来信，好友闸不适用
    let holds_delegation = crate::chat_service::holds_valid_delegation_for(from);
    // ★4-b：好友闸跟随**收件账号**——信封 to 指向本机持委任状的非活动账号时，
    // 查该账号桶的好友表（活动账号桶只是默认值）。
    let to = body.get("to").and_then(|v| v.as_str()).unwrap_or("");
    let is_friend = friend_gate_exempt_kind(kind) || match crate::chat_service::routed_chat_bucket(&my, to) {
        Some(acc) => crate::chat_service::is_ok_friend_in(&acc, from),
        None => crate::chat_service::is_ok_friend(from),
    };
    auth_gate_with(headers, raw_body, body, &my, is_friend, holds_delegation).await
}

// ══════ 端点 ══════

/// GET /p2p/ping — 无签名连通性探测（P2P 成功率脚本用；只回本机元数据不泄密）。
async fn handle_ping() -> Response {
    let my = myco_core::identity::account_did().unwrap_or_default();
    let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "myco-pc".into());
    Json(json!({ "ok": true, "kind": "pc", "p2p": true, "myDid": my, "name": name, "port": p2p_port() })).into_response()
}

/// POST /p2p/msg — 收一条消息：验签 → 幂等落盘 → emit chat-incoming。
///
/// 2026-10-09「同步回程」：请求方可以在 payload 里写 `syncReply: true` 要一份
/// **同步回包**（挂在本响应体里）——手机没有入站监听能力，推不回去；而这条 HTTP
/// 连接本来就开着在等响应，回车即得票。槽的开/关在 `chat_service`（见那里的块注释），
/// 这里只负责"过闸 → 开槽 → 入库 → 把槽里的回包放进响应体"。
async fn handle_msg(State(_state): State<Arc<P2pState>>, headers: HeaderMap, body: Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    let kind = v.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    if kind.is_empty() || kind == "typing" {
        return (StatusCode::BAD_REQUEST, "bad kind").into_response();
    }
    // 开槽（不是"要同步回包"的信封 → None，行为一个字不变）。
    let slot = crate::chat_service::open_sync_reply(&v);
    let res = crate::chat_service::ingest_p2p_opt(&v).await;
    // **无论成败都要关槽**（失败路径不关 = 表里长草、requestId 复用时会串包）。
    let reply = slot.as_deref().and_then(crate::chat_service::close_sync_reply);
    match res {
        Ok(kept) => Json(msg_ok_body(kept, reply)).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, format!("{e}")).into_response(),
    }
}

/// `/p2p/msg` 的成功响应体（**纯函数**——手机侧读的就是 `reply` 这个键，
/// 契约面在这里锁死：没有回包时**绝不出现空 reply 键**）。
fn msg_ok_body(kept: bool, reply: Option<Value>) -> Value {
    match reply {
        Some(r) => json!({ "ok": true, "kept": kept, "reply": r }),
        None => json!({ "ok": true, "kept": kept }),
    }
}

/// POST /p2p/sync/digest — 对账①：{myDid, deviceId, convs:{convId:{n,lastTs,F}}}
/// → 回本机【与请求方相关】会话的摘要（单聊=对方会话；群=共同群）。
async fn handle_sync_digest(
    State(_state): State<Arc<P2pState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    let from = v.get("from").and_then(|x| x.as_str()).unwrap_or("");
    let mut convs = serde_json::Map::new();
    for conv_id in crate::chat_service::shared_conv_ids(from) {
        let m = crate::p2p_sync::load_meta(&conv_id);
        convs.insert(conv_id, m.digest_json());
    }
    let name = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "myco-pc".into());
    Json(json!({ "ok": true, "deviceName": name, "convs": convs })).into_response()
}

/// POST /p2p/sync/index — 对账③：{convId} → {ids: [[msgId,ts],...]}。
async fn handle_sync_index(
    State(_state): State<Arc<P2pState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    let from = v.get("from").and_then(|x| x.as_str()).unwrap_or("");
    let conv_id = v.get("convId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if !crate::chat_service::shared_conv_ids(from).contains(&conv_id) {
        return (StatusCode::FORBIDDEN, "无权访问该会话").into_response();
    }
    let m = crate::p2p_sync::load_meta(&conv_id);
    Json(json!({ "ok": true, "convId": conv_id, "ids": m.ids.iter().map(|(id, ts)| json!([id, ts])).collect::<Vec<_>>() })).into_response()
}

/// POST /p2p/sync/batch — 对账④：{convId, msgs:[wire...], want:[msgId...]}
/// → push 落盘（幂等）+ 回 want 对应的 wire 消息（媒体 media→b64 内联）。
async fn handle_sync_batch(
    State(_state): State<Arc<P2pState>>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    let from = v.get("from").and_then(|x| x.as_str()).unwrap_or("");
    let conv_id = v.get("convId").and_then(|x| x.as_str()).unwrap_or("").to_string();
    if !crate::chat_service::shared_conv_ids(from).contains(&conv_id) {
        return (StatusCode::FORBIDDEN, "无权访问该会话").into_response();
    }
    // ① 收 push（幂等落盘）
    let mut kept = 0usize;
    if let Some(msgs) = v.get("msgs").and_then(|x| x.as_array()) {
        if msgs.len() > SYNC_BATCH_MAX {
            return (StatusCode::PAYLOAD_TOO_LARGE, "单批超上限").into_response();
        }
        for m in msgs {
            if crate::chat_service::ingest_p2p_opt(m).await.unwrap_or(false) {
                kept += 1;
            }
        }
    }
    // ② 回 want（本地 wire 形态）
    let want: Vec<String> = v
        .get("want")
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let local = crate::chat_service::conv_load_raw(&conv_id);
    let out: Vec<Value> = local
        .iter()
        .filter(|m| {
            m.get("msgId")
                .and_then(|x| x.as_str())
                .map(|id| want.iter().any(|w| w == id))
                .unwrap_or(false)
        })
        .map(|m| crate::chat_service::wire_pack_msg(m))
        .collect();
    Json(json!({ "ok": true, "kept": kept, "msgs": out })).into_response()
}

/// POST /p2p/typing — 瞬时打字信号（不落盘；emit p2p-typing，前端 3.5s 过期）。
async fn handle_typing(State(_state): State<Arc<P2pState>>, headers: HeaderMap, body: Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    // cfg(not(test))：UI 事件通道，且本函数经 `p2p_router()` 对测试可达——不禁就会把
    // tauri 的 webview 运行时锚进测试 exe（见文件顶 `use tauri::Emitter` 上方注释）。
    #[cfg(not(test))]
    if let Some(app) = crate::p2p_client::current_app_handle() {
        let _ = app.emit(
        "p2p-typing",
        json!({
            "convId": v.get("convId").and_then(|x| x.as_str()).unwrap_or(""),
            "from": v.get("from").and_then(|x| x.as_str()).unwrap_or(""),
            "fromName": v.get("fromName").and_then(|x| x.as_str()).unwrap_or(""),
        }),
    );
    }
    Json(json!({ "ok": true })).into_response()
}

/// POST /p2p/media/chunk — 第96轮（修复3）：媒体分片上传。
/// body: {from, fromDevice, msgId, name, mime, sha256, idx, total, b64}（1MB/片 b64
/// JSON 信封——复用 X-Myco-Auth 签 raw body 链，二进制不另立通道）。收齐组装 +
/// sha256 校验在 chat_service::store_media_chunk；组装完成 emit chat-media-ready。
async fn handle_media_chunk(State(_state): State<Arc<P2pState>>, headers: HeaderMap, body: Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    let msg_id = v.get("msgId").and_then(|x| x.as_str()).unwrap_or("");
    let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("file");
    let mime = v.get("mime").and_then(|x| x.as_str()).unwrap_or("application/octet-stream");
    let sha = v.get("sha256").and_then(|x| x.as_str()).unwrap_or("");
    let idx = v.get("idx").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let total = v.get("total").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    let b64 = v.get("b64").and_then(|x| x.as_str()).unwrap_or("");
    if msg_id.is_empty() || sha.is_empty() || b64.is_empty() {
        return (StatusCode::BAD_REQUEST, "缺 msgId/sha256/b64").into_response();
    }
    let bytes = match base64::engine::general_purpose::STANDARD.decode(b64) {
        Ok(b) => b,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("b64 解码失败: {e}")).into_response(),
    };
    match crate::chat_service::store_media_chunk(msg_id, name, mime, sha, idx, total, &bytes) {
        Ok(assembled) => {
            if assembled {
                // cfg(not(test))：同 handle_typing——本函数对测试可达（p2p_router）。
                #[cfg(not(test))]
                if let Some(app) = crate::p2p_client::current_app_handle() {
                    let _ = app.emit("chat-media-ready", json!({ "msgId": msg_id }));
                }
            }
            Json(json!({ "ok": true, "assembled": assembled })).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, format!("{e}")).into_response(),
    }
}

/// POST /p2p/media/fetch — 第96轮（修复3）：按需分片拉取 {msgId, idx} → {b64, total}。
/// 无该媒体=404（调用方换设备/账号再试；open_file 提示"对端不在线"）。
async fn handle_media_fetch(State(_state): State<Arc<P2pState>>, headers: HeaderMap, body: Bytes) -> Response {
    let v: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return (StatusCode::BAD_REQUEST, format!("bad json: {e}")).into_response(),
    };
    if let Err(r) = auth_gate(&headers, &body, &v).await {
        return r;
    }
    let msg_id = v.get("msgId").and_then(|x| x.as_str()).unwrap_or("");
    let idx = v.get("idx").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
    match crate::chat_service::read_media_chunk(msg_id, idx) {
        Some((bytes, total)) => Json(json!({
            "ok": true, "idx": idx, "total": total,
            "b64": base64::engine::general_purpose::STANDARD.encode(bytes),
        })).into_response(),
        None => (StatusCode::NOT_FOUND, "本机无该媒体（或片号越界）").into_response(),
    }
}

// ══════ 工具（env direct_server 移植） ══════

/// Windows 下 spawn 子进程不弹控制台窗口。
#[cfg(windows)]
fn no_window(mut cmd: std::process::Command) -> std::process::Command {
    use std::os::windows::process::CommandExt as _;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}
#[cfg(not(windows))]
fn no_window(cmd: std::process::Command) -> std::process::Command {
    cmd
}

/// 探测本机全部全球 IPv6 地址（非 fe80；保持 ipconfig 顺序）。
/// 前缀轮换期会同时挂新旧前缀——全部上报，由对端逐个实测选路（direct_server 定案）。
pub fn detect_ipv6_all() -> Vec<String> {
    parse_ipv6_addrs(&ipconfig_text())
}

/// 单跑一次 ipconfig 拿全文（多路径采集共用一份，避免多次 spawn）。
fn ipconfig_text() -> String {
    match no_window(std::process::Command::new("ipconfig")).output() {
        Ok(o) => String::from_utf8_lossy(&o.stdout).to_string(),
        Err(_) => String::new(),
    }
}

/// ipconfig 文本 → 全部全球 IPv6（非 fe80/::1；`%zone` 后缀剥掉；去重保序）。纯函数。
fn parse_ipv6_addrs(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if (t.contains("IPv6") || t.contains("IPv6 地址")) && t.contains(':') {
            if let Some(addr_start) = t.rfind(": ") {
                let addr = t[addr_start + 2..].trim();
                if !addr.starts_with("fe80") && !addr.starts_with("::1") && addr.contains(':') {
                    let clean = addr.split('%').next().unwrap_or(addr);
                    if !out.iter().any(|x| x == clean) {
                        out.push(clean.to_string());
                    }
                }
            }
        }
    }
    out
}

// ══════ 多路径寻址候选（内网 IPv4 → 公网 IPv4 → IPv6） ══════
// 目标：p2p 建联不再只有 IPv6 一条路——同网段走 lan（内网直连）、本机有公网 IPv4 时
// 走 publicV4、都不同时回落到 ipv6。三类地址**全量上报**，选路由发起方逐地址实测
// （沿用 p2p_client 既有"先通先得"策略）。

/// IPv4 地址类别（`classify_v4` 的输出）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V4Class {
    /// 私有/非公网可达（10/8、172.16/12、192.168/16、100.64/10 CGNAT、保留段等）
    /// ——内网直连候选，同网段可达、跨网段不可达（实测自会跳过）。
    Lan,
    /// 本机网卡直接持有的公网 IPv4（无 NAT 前置）。
    Public,
}

/// 单个 IPv4 → 类别；None = 不进候选（环回/未指定/组播/广播/169.254 链路本地）。
/// 纯函数（单测直击）。"公网"判定 = 不是任何已知私网/保留段——NAT 后面的私网地址
/// 不会被误报成公网（本机只有私网时 publicV4 为空，与"至少一方有公网 IP"语义一致）。
pub fn classify_v4(ip: std::net::Ipv4Addr) -> Option<V4Class> {
    if ip.is_loopback() || ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
        return None;
    }
    let o = ip.octets();
    // APIPA 169.254/16：DHCP 失败时的自配置地址，既不可内网直连也不可达
    if o[0] == 169 && o[1] == 254 {
        return None;
    }
    let private = o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168);
    if private {
        return Some(V4Class::Lan);
    }
    // 其余"非公网可达"的保留/过渡段 → 归 lan 侧（不值得当公网候选广播；实测会跳过不通的）
    let non_public = (o[0] == 100 && (64..=127).contains(&o[1]))      // CGNAT 100.64/10
        || (o[0] == 192 && o[1] == 0)                                 // IETF 192.0.0/24 + TEST-NET-1
        || (o[0] == 198 && (18..=19).contains(&o[1]))                 // 基准测试 198.18/15
        || (o[0] == 192 && o[1] == 88 && o[2] == 99)                  // 6to4 relay anycast
        || o[0] >= 224;                                               // 保留/实验（组播已在上方挡掉）
    if non_public {
        return Some(V4Class::Lan);
    }
    Some(V4Class::Public)
}

/// ipconfig 文本 → 全部 IPv4（网卡顺序、去重）。纯函数（单测直击）。
/// 只认标签里含 "IPv4" 的行——子网掩码/默认网关行不含 IPv4，天然排除；
/// 值带 `(Preferred)`/`(首选)` 后缀时按 `[0-9.]` 前缀截断。`自动配置 IPv4 地址`
/// （Autoconfiguration，169.254.x）由 classify_v4 挡掉，此处不做语言相关判断。
/// pub(crate)：p2p_tunnel 的单测直击（隧道寻址的多路径解析面）。
pub(crate) fn parse_ipv4_addrs(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        let Some((label, value)) = t.split_once(':') else { continue };
        if !label.to_ascii_lowercase().contains("ipv4") {
            continue;
        }
        let raw: String = value
            .trim()
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        if raw.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        if !out.iter().any(|x| x == &raw) {
            out.push(raw);
        }
    }
    out
}

/// 本机候选直连地址（三类）。注册表发布 + 隧道自检 + 寻址调试共用。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalCandidates {
    /// 私有 IPv4（内网/同网段直连；走双栈 socket 的 IPv4-mapped 面收）
    pub lan: Vec<String>,
    /// 本机网卡直接持有的公网 IPv4（无则空）
    pub public_v4: Vec<String>,
    /// 全球 IPv6（前缀轮换期多地址全报）
    pub ipv6: Vec<String>,
}

impl LocalCandidates {
    /// **选路顺序：lan → publicV4 → ipv6**（内网最快最稳；公网 v4 次之；v6 兜底）。
    pub fn ordered(&self) -> Vec<String> {
        let mut v = self.lan.clone();
        v.extend(self.public_v4.iter().cloned());
        v.extend(self.ipv6.iter().cloned());
        v
    }

    pub fn is_empty(&self) -> bool {
        self.lan.is_empty() && self.public_v4.is_empty() && self.ipv6.is_empty()
    }

    /// 注册表 addrs 载荷（**接口形状**——presence 心跳发布点直接塞进 payload["addrs"]）：
    /// `{lan, lanList, publicV4, publicV4List, ipv6, ipv6List, port}`（空类别整键省略；
    /// 单值键=该类首个地址，与既有 `ipv6`/`ipv6List` 双键口径一致）。
    pub fn addrs_json(&self, port: u16) -> Value {
        let mut m = serde_json::Map::new();
        let put = |m: &mut serde_json::Map<String, Value>, single: &str, list: &str, v: &[String]| {
            if !v.is_empty() {
                m.insert(list.to_string(), json!(v));
                m.insert(single.to_string(), json!(v[0]));
            }
        };
        put(&mut m, "lan", "lanList", &self.lan);
        put(&mut m, "publicV4", "publicV4List", &self.public_v4);
        put(&mut m, "ipv6", "ipv6List", &self.ipv6);
        m.insert("port".to_string(), json!(port));
        Value::Object(m)
    }
}

/// 采集本机候选地址（单次 ipconfig；IPv6 口径与 detect_ipv6_all 完全一致）。
pub fn detect_local_candidates() -> LocalCandidates {
    let text = ipconfig_text();
    let mut c = LocalCandidates { ipv6: parse_ipv6_addrs(&text), ..Default::default() };
    for s in parse_ipv4_addrs(&text) {
        match s.parse::<std::net::Ipv4Addr>().ok().and_then(classify_v4) {
            Some(V4Class::Lan) => c.lan.push(s),
            Some(V4Class::Public) => c.public_v4.push(s),
            None => {}
        }
    }
    c
}

/// `host:port` 记法（IPv6 走 `[addr]:port`，IPv4 原样）——与 p2p_client 的 URL 构造同口径。
pub fn format_host_port(addr: &str, port: u16) -> String {
    if addr.contains(':') {
        format!("[{}]:{}", addr, port)
    } else {
        format!("{}:{}", addr, port)
    }
}

/// 地址列表 → 候选 URL（**顺序即传入顺序**；调用方传 `LocalCandidates::ordered()` /
/// peer 的已排序地址即得 lan → publicV4 → ipv6）。纯函数（单测直击）。
pub fn urls_from_addrs(addrs: &[String], port: u16) -> Vec<String> {
    addrs.iter().map(|a| format!("http://{}", format_host_port(a, port))).collect()
}

/// 本机候选 URL（按 lan → publicV4 → ipv6；隧道自检/诊断用）。
pub fn local_candidate_urls(port: u16) -> Vec<String> {
    urls_from_addrs(&detect_local_candidates().ordered(), port)
}

// ══════ 反射地址（NAT 后方机器的"公网出口"，2026-10-09） ══════
// 问题：本机在 NAT 后面时，`detect_local_candidates()` 只能给出 `192.168.x.x`/CGNAT
// 这类**不可达**的私网地址——对端没有能拨的地址，"有一方有公网 IP 就能直连"落空。
// 做法（不引 STUN 外部依赖）：向**任意在线的 myco p2p 服务器**发一次签名 POST
// `/p2p/reflect`，服务器按 TCP `ConnectInfo` 回"我看到的你"（源 IP:源端口）。
// 设备把结果作为 `reflexive` 候选发布/参与赛跑。
//
// **语义（诚实标注，别过度承诺）**：
// * 服务器看到的是"我这次出网的 `IP:port`"——**NAT 的映射端口 ≠ 我监听的端口**。
//   对端能否拨通取决于 NAT 有没有做**端口映射**（或锥形 NAT 复用同端口）。
// * 所以 reflexive 是"**对端可能可达**"的候选，不是保证可达：本模块只负责把它
//   观测出来并发布，可达性由对端实测（赛跑）判定。
// * 双方都在 NAT 后且都没映射时**没有中继就打不通**（需 TURN 式中继，后续工作）。

/// 一条反射观测：`(观测点=服务器看到的源地址, 是否 IPv6, 观测时刻)`。
struct ReflexEntry {
    addr: String,
    v6: bool,
    at: std::time::Instant,
}

/// 反射观测表（键 = 被观测设备 DID；值 = 最近一次观测）。
static REFLEX: std::sync::LazyLock<std::sync::Mutex<std::collections::HashMap<String, ReflexEntry>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// 观测结果的新鲜期（对端注册表心跳周期同量级；过期的出口地址不参与寻址）。
const REFLEX_TTL: std::time::Duration = std::time::Duration::from_secs(120);

/// 记录一次反射观测（`handle_reflect` 调用；纯本地，无 IO）。
pub fn record_reflexive_observation(device_did: &str, observed: &str) {
    if device_did.is_empty() || observed.is_empty() {
        return;
    }
    let v6 = observed.contains('[') || observed.matches(':').count() > 1;
    let mut g = REFLEX.lock().unwrap();
    // 表小、TTL 短：不用清就顺手裁一下（防长跑进程无界增长）
    if g.len() > 128 {
        g.retain(|_, e| e.at.elapsed() < REFLEX_TTL);
    }
    g.insert(device_did.to_string(), ReflexEntry { addr: observed.to_string(), v6, at: std::time::Instant::now() });
}

/// 某设备的反射地址（`(addr, is_ipv6)`；过期=None）。隧道寻址/对端主动连我用。
pub fn reflexive_addrs(device_did: &str) -> Option<(String, bool)> {
    let g = REFLEX.lock().unwrap();
    g.get(device_did).and_then(|e| if e.at.elapsed() < REFLEX_TTL { Some((e.addr.clone(), e.v6)) } else { None })
}

/// 测试复位（避免用例间观测串味）。
#[cfg(test)]
pub(crate) fn clear_reflexive_observations() {
    REFLEX.lock().unwrap().clear();
}

/// 从"我方 p2p 服务器看到的 TCP peer 地址"提取反射地址文本。
/// IPv4 → 原样 `ip`（端口是 NAT 映射的临时端口，**不可达**——只报 IP 更有意义，
/// 见 `handle_reflect` 的载荷说明）；IPv6 → 原样 `ip`（全球单播 v6 无 NAT，端口也报）。
/// IPv4-mapped v6（双栈 socket 收 IPv4 LAN 会出这种形态）归一成 IPv4。
/// 纯函数（单测直击）。
pub(crate) fn reflexive_from_peer(peer: std::net::SocketAddr) -> Option<(String, bool)> {
    match peer {
        std::net::SocketAddr::V4(a) => Some((a.ip().to_string(), false)),
        std::net::SocketAddr::V6(a) => {
            let ip = a.ip();
            if let Some(v4) = ip.to_ipv4_mapped() {
                return Some((v4.to_string(), false));
            }
            Some((ip.to_string(), true))
        }
    }
}

/// 请求体形状：`{ "ports": [9100, 13911] }`（可选；用于说明"我希望被观测/发布哪些端口"）。
#[derive(Debug, Clone, Default, serde::Deserialize)]
pub struct ReflectRequest {
    #[serde(default)]
    pub ports: Vec<u16>,
}

/// `POST /p2p/reflect` 的纯逻辑：`(peer 观测地址, 设备 did, 期望端口) → 响应 JSON`。
/// 单测直击（不碰 socket）。`device` 为空（无签名）在 handler 层就已拒。
pub(crate) fn reflect_response_json(observed: Option<(String, bool)>, device: &str, ports: &[u16]) -> Value {
    match observed {
        Some((addr, v6)) => json!({
            "ok": true,
            "device": device,
            // observed = 服务器看到的本设备源 IP（IPv4 无端口：NAT 映射端口不可复用，
            // 报它只会误导；IPv6 无 NAT，报纯地址即可）
            "reflexive": addr,
            "reflexiveIsV6": v6,
            // 我声明要给对端发布的 p2p 端口（设备侧据此把 `reflexive` 候选补成 URL）
            "ports": ports,
            "ts": chrono::Utc::now().timestamp_millis(),
        }),
        None => json!({ "ok": false, "error": "无法从 TCP peer 解析反射地址" }),
    }
}

/// `POST /p2p/reflect`（设备签名）：把"服务器看到的源地址"回给设备（反射地址发现）。
/// 闸门：X-Myco-Auth 验签（设备钥自证）——**只有签名设备能问自己的出口地址**，
/// 且响应只含它自己的观测值（不泄漏别人的），body 不参与判定（签名载荷=空串）。
/// 服务器也顺手把观测记进 [`REFLEX`]（同机/同账号对端经 `/p2p/reflect` 之外的
/// `reflexive_addrs` 读取，见 p2p_tunnel 的候选构造）。
pub async fn handle_reflect(
    State(_state): State<Arc<P2pState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(device) = verify_auth(&headers, &body) else {
        return (StatusCode::FORBIDDEN, Json(json!({ "error": "auth failed（设备签名无效）" }))).into_response();
    };
    // body 是签名载荷，但反射结果是"我看到的你"——解析失败不拒（只是一份声明）
    let req: ReflectRequest = serde_json::from_slice(&body).unwrap_or_default();
    let observed = reflexive_from_peer(peer);
    if let Some((addr, _)) = observed.clone() {
        record_reflexive_observation(&device, &addr);
        eprintln!("[p2p-reflect] device={device} peer={peer} → reflexive={addr}");
    }
    Json(reflect_response_json(observed, &device, &req.ports)).into_response()
}


/// 防火墙规则名（第95轮：端口维度——原按定名 myco-p2p 查重，端口顺延（9101+）时
/// 老规则已存在直接跳过、新端口 inbound 全死。规则名带端口后查重与端口一一对应）。
fn firewall_rule_name(port: u16) -> String {
    format!("myco-p2p-{port}")
}

/// netsh show rule 输出 → 规则是否真实存在（纯函数）。
/// 陷阱：无匹配时 netsh 往 **stdout** 打"没有与指定标准相匹配的规则。"/"No rules match..."，
/// 按"非空 stdout 即存在"判会永真（原实现的隐藏 bug：中文 Windows 上规则永远"已存在"，
/// 从不补建）——退出码 + 否定文案双重判。
fn netsh_show_rule_found(status_success: bool, stdout: &str) -> bool {
    if !status_success {
        return false;
    }
    let t = stdout.trim();
    if t.is_empty() {
        return false;
    }
    !(t.contains("No rules match") || t.contains("没有与指定标准相匹配"))
}

/// netsh verbose 输出里 LocalPort/本地端口 行是否覆盖指定端口（纯函数；
/// 中英输出、Any/任何、逗号列表、范围（9100-9110）都认）。
fn netsh_rule_covers_port(verbose_output: &str, port: u16) -> bool {
    for line in verbose_output.lines() {
        let t = line.trim();
        if !(t.starts_with("LocalPort") || t.starts_with("本地端口")) {
            continue;
        }
        let v = t.splitn(2, ':').nth(1).map(str::trim).unwrap_or("");
        if v.eq_ignore_ascii_case("any") || v == "任何" {
            return true;
        }
        for part in v.split(',') {
            let p = part.trim();
            if let Some((a, b)) = p.split_once('-') {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<u16>(), b.trim().parse::<u16>()) {
                    if a <= port && port <= b {
                        return true;
                    }
                }
            } else if p.parse::<u16>() == Ok(port) {
                return true;
            }
        }
    }
    false
}

/// 防火墙规则检查/自动添加（第95轮：端口级规则名 myco-p2p-{port}，独立于 env 的 myco-direct）。
/// 每次成功绑定端口后校验对应规则存在：端口级规则已在 → 静默；老版定名规则覆盖本端口
/// （verbose 解析 LocalPort）→ 静默；否则补建。权限不足时优雅降级（netsh 失败不 panic，
/// eprintln 给出手动命令）。
fn check_firewall(port: u16) {
    let name = firewall_rule_name(port);
    let check = no_window(std::process::Command::new("netsh"))
        .args(["advfirewall", "firewall", "show", "rule", &format!("name={name}")])
        .output();
    if check
        .map(|o| netsh_show_rule_found(o.status.success(), &String::from_utf8_lossy(&o.stdout)))
        .unwrap_or(false)
    {
        return;
    }
    // 老版定名规则（myco-p2p，首轮部署可能已建）覆盖本端口也算已覆盖——避免无管理员
    // 权限时每次启动都刷屏提示（老规则已放行，没必要打扰）。
    let legacy = no_window(std::process::Command::new("netsh"))
        .args(["advfirewall", "firewall", "show", "rule", "name=myco-p2p", "verbose"])
        .output();
    if let Ok(o) = legacy {
        if o.status.success() && netsh_rule_covers_port(&String::from_utf8_lossy(&o.stdout), port) {
            return;
        }
    }
    let add = no_window(std::process::Command::new("netsh"))
        .args([
            "advfirewall", "firewall", "add", "rule",
            &format!("name={name}"), "dir=in", "action=allow",
            "protocol=TCP", &format!("localport={}", port),
        ])
        .output();
    match add {
        Ok(o) if o.status.success() => eprintln!("[p2p] 防火墙规则 {name} 已自动添加（端口 {port}）"),
        _ => eprintln!(
            "[p2p] ⚠️ 自动添加防火墙规则失败（可能权限不足），请管理员运行：netsh advfirewall firewall add rule name=\"{name}\" dir=in action=allow protocol=TCP localport={port}"
        ),
    }
}

// ══════════════ 第95轮：归属闸 + 防火墙端口级规则 单测 ══════════════

#[cfg(test)]
mod auth_fix_tests {
    use super::*;
    use ed25519_dalek::Signer as _;

    /// 测试设备（确定性密钥——tag 即种子；did=公钥自派生与产线同法）。
    struct TestDevice {
        did: String,
        sk: ed25519_dalek::SigningKey,
    }

    fn test_device(tag: u8) -> TestDevice {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[tag; 32]);
        // 与产线同法派生 canonical 设备 did（spec v0.3 multibase）
        let did = myco_core::identity::did_from_public(&sk.verifying_key().to_bytes());
        TestDevice { did, sk }
    }

    fn pub_b64(dev: &TestDevice) -> String {
        base64::engine::general_purpose::STANDARD.encode(dev.sk.verifying_key().to_bytes())
    }

    /// 与产线 p2p_auth 同法构造 X-Myco-Auth 头（真签名——走 verify_auth 全路径）。
    fn sign_headers(dev: &TestDevice, raw: &str) -> HeaderMap {
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let sig = dev.sk.sign(format!("{}\n{}\n{}", dev.did, ts, raw).as_bytes());
        let auth = format!("{}.{}.{}", dev.did, ts, base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()));
        let mut h = HeaderMap::new();
        h.insert("x-myco-auth", auth.parse().unwrap());
        h
    }

    fn msg_body(from: &str, from_device: &str) -> Value {
        json!({ "msgId": "m-t1", "from": from, "fromDevice": from_device, "to": "did:myco:Someone", "kind": "text", "payload": { "text": "hi" }, "ts": 1 })
    }

    fn seed_roster(account: &str, root_pub: &str, active: Vec<String>) {
        ROSTER_CACHE.lock().unwrap().insert(
            account.to_string(),
            RosterEntry {
                root_pub: root_pub.to_string(),
                active,
                fetched: std::time::Instant::now(),
                negative: false,
            },
        );
    }

    // ── 纯决策真值表 ──

    #[test]
    fn gate_decision_truth_table() {
        let (dev_a, acc_friend, acc_me) = ("did:myco:DevA", "did:myco:Friend", "did:myco:Me");
        // 伪造场景核心：签名设备与 fromDevice 一致、from 是好友、但设备不属于 from → Ownership
        assert_eq!(
            gate_decision(dev_a, dev_a, acc_friend, acc_me, true, false, false),
            Err(GateReject::Ownership)
        );
        // fromDevice ≠ 签名者 → DeviceMismatch（即使归属 ok 也先挡）
        assert_eq!(
            gate_decision(dev_a, "did:myco:DevB", acc_friend, acc_me, true, true, false),
            Err(GateReject::DeviceMismatch)
        );
        // 非好友非自己 → NotFriend
        assert_eq!(
            gate_decision(dev_a, dev_a, "did:myco:Stranger", acc_me, false, true, false),
            Err(GateReject::NotFriend)
        );
        // 好友 + 归属通过 → 放行
        assert_eq!(gate_decision(dev_a, dev_a, acc_friend, acc_me, true, true, false), Ok(()));
        // 自己 + 自己的设备（多设备自同步）→ 放行
        assert_eq!(gate_decision(dev_a, dev_a, acc_me, acc_me, false, true, false), Ok(()));
        // 未登录（my 空）时空 from 不误判成自同步（is_friend=true 才走到这）
        assert_eq!(gate_decision(dev_a, dev_a, "", "", true, true, false), Ok(()));
        // ★4：非好友非活动账号，但本机持该账号有效委任状（多归属成员面）→ 放行
        assert_eq!(
            gate_decision(dev_a, dev_a, "did:myco:DelegatedAcc", acc_me, false, true, true),
            Ok(())
        );
        // ★4 反向守卫：委任状分支不豁免归属闸（设备不属于 from 照样拒）
        assert_eq!(
            gate_decision(dev_a, dev_a, "did:myco:DelegatedAcc", acc_me, false, false, true),
            Err(GateReject::Ownership)
        );
    }

    // ── 名册解析/判定 ──

    /// 真实 GET /root/:did 响应形态（2026-09-28 实测抓取）：首设备 attestSigB64 为空、revoked=0。
    #[test]
    fn parse_roster_real_shape() {
        let v = json!({
            "data": {
                "rootDid": "did:myco:7S2Y", "rootPubkeyB64": "ROOTPUB=", "name": "cjfan",
                "devices": [
                    { "pubkeyB64": "FIRSTDEV=", "name": "DESKTOP", "addedAt": 1, "revoked": 0, "attestSigB64": "", "isEmbodiment": 1 },
                    { "pubkeyB64": "PHONE=", "name": "honor", "addedAt": 2, "revoked": 0, "attestSigB64": "sig" },
                    { "pubkeyB64": "OLD=", "name": "old", "addedAt": 3, "revoked": 1, "attestSigB64": "sig" }
                ]
            }
        });
        let (root_pub, active) = parse_roster(&v).unwrap();
        assert_eq!(root_pub, "ROOTPUB=");
        // 首设备（无 attestSig）必须在册；吊销设备必须剔除
        assert_eq!(active, vec!["FIRSTDEV=".to_string(), "PHONE=".to_string()]);
        // 判定：在册设备 / rootPubkey 兜底（首设备=根钥场景）放行；吊销/外人拒绝
        assert!(roster_allows(&root_pub, &active, "FIRSTDEV="));
        assert!(roster_allows(&root_pub, &active, "ROOTPUB="));
        assert!(!roster_allows(&root_pub, &active, "OLD="));
        assert!(!roster_allows(&root_pub, &active, "ATTACKER="));
        // 坏响应 → None（fail-closed 由调用方保证）
        assert!(parse_roster(&json!({ "error": "root not found" })).is_none());
        assert!(parse_roster(&json!({ "data": { "rootDid": "x" } })).is_none());
    }

    // ── 委任状本地快路（同账号不同设备=手机被本 PC 授权） ──

    #[test]
    fn delegation_local_fast_path() {
        let account = "did:myco:AccForDelegation";
        let dev_pub = base64::engine::general_purpose::STANDARD.encode([42u8; 32]);
        let d = myco_core::delegation::issue(&[9u8; 32], account, &dev_pub, "myco-phone", None);
        let recs = vec![myco_core::delegation::DelegationRecord { delegation: d.clone(), revoked: false, last_renewed: 0 }];
        assert!(local_delegation_allows(&recs, account, &dev_pub));
        // 吊销 → 不放行
        let revoked = vec![myco_core::delegation::DelegationRecord { delegation: d.clone(), revoked: true, last_renewed: 0 }];
        assert!(!local_delegation_allows(&revoked, account, &dev_pub));
        // 签给别的账号 → 不放行
        assert!(!local_delegation_allows(&recs, "did:myco:OtherAcc", &dev_pub));
        // 别的设备 → 不放行
        let other_pub = base64::engine::general_purpose::STANDARD.encode([43u8; 32]);
        assert!(!local_delegation_allows(&recs, account, &other_pub));
    }

    // ── 全路径（真签名 + auth_gate_with + 名册缓存注入，无网络） ──

    /// 缺陷1 回归：攻击者用自己注册过的设备钥签名，伪造 from=受害者的好友 → 必须 403。
    /// （修复前此请求三连过：验签✓ fromDevice==签名者✓ from 是好友✓ → 放行。）
    #[tokio::test]
    async fn forged_from_friend_rejected() {
        let attacker = test_device(11);
        let friend_real_dev = test_device(12);
        let friend_account = "did:myco:T1FriendAccount";
        let victim_account = "did:myco:T1VictimAccount";
        // 好友名册里只有好友的真设备——攻击者设备不在其中
        seed_roster(friend_account, "", vec![pub_b64(&friend_real_dev)]);
        let body = msg_body(friend_account, &attacker.did);
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&attacker, &raw);
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, victim_account, true, false).await;
        assert!(r.is_err(), "伪造 from=受害者好友 必须被归属闸拒绝");
    }

    /// 好友的真设备发信（设备在好友名册）→ 放行（防误杀回归）。
    #[tokio::test]
    async fn legit_friend_device_passes() {
        let friend_dev = test_device(21);
        let friend_account = "did:myco:T2FriendAccount";
        let victim_account = "did:myco:T2VictimAccount";
        seed_roster(friend_account, "", vec![pub_b64(&friend_dev)]);
        let body = msg_body(friend_account, &friend_dev.did);
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&friend_dev, &raw);
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, victim_account, true, false).await;
        assert!(r.is_ok(), "好友真设备的消息不该被误杀");
    }

    /// 同账号合法委任状设备（手机被 PC 授权、已入云名册）+ from=自己 → 放行。
    #[tokio::test]
    async fn self_account_delegated_device_passes() {
        let phone = test_device(31);
        let my_account = "did:myco:T3SelfAccount";
        // 手机经 DID 互换授权入册（/root/device/add）——名册里有它
        seed_roster(my_account, "", vec![pub_b64(&phone)]);
        let body = msg_body(my_account, &phone.did);
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&phone, &raw);
        // is_friend=false：from==my 自同步不依赖好友表
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, my_account, false, false).await;
        assert!(r.is_ok(), "同账号委任状设备（名册在册）必须放行");
    }

    /// 名册查无此设备（攻击者凭空塞设备）→ 403。
    #[tokio::test]
    async fn unknown_device_of_friend_rejected() {
        let ghost = test_device(41);
        let friend_account = "did:myco:T4FriendAccount";
        let victim_account = "did:myco:T4VictimAccount";
        seed_roster(friend_account, "SOMEONEELSE_ROOTPUB=", vec!["UNRELATED=".to_string()]);
        let body = msg_body(friend_account, &ghost.did);
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&ghost, &raw);
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, victim_account, true, false).await;
        assert!(r.is_err());
    }

    // ── 2026-10-06：收编通知（delegation-notify）闸门语义 ──

    /// 豁免判定只认 delegation-notify + 好友握手三 kind（2026-10-07 去服务端化：
    /// 握手来自非好友是常态）——其他 kind（含 typing/文本）好友语义不变。
    #[test]
    fn friend_gate_exempt_covers_handshake_and_notify() {
        assert!(friend_gate_exempt_kind("delegation-notify"));
        assert!(friend_gate_exempt_kind("friend-request"));
        assert!(friend_gate_exempt_kind("friend-accept"));
        assert!(friend_gate_exempt_kind("friend-remove"));
        assert!(!friend_gate_exempt_kind("text"));
        assert!(!friend_gate_exempt_kind("group-create"));
        assert!(!friend_gate_exempt_kind("group-msg"));
        assert!(!friend_gate_exempt_kind(""));
    }

    /// 好友握手过闸全路径（非好友 + 豁免 + 归属在册 → 放行；归属不在册 → 403）。
    /// 握手一定来自非好友（加好友前无关系）——豁免表是它进门的唯一通路。
    #[tokio::test]
    async fn friend_handshake_nonfriend_passes_gate_with_ownership() {
        let stranger_dev = test_device(61);
        let stranger_account = "did:myco:T7StrangerAccount";
        let me = "did:myco:T7MeAccount";
        // 名册在册：陌生人真设备
        seed_roster(stranger_account, "", vec![pub_b64(&stranger_dev)]);
        let mut body = msg_body(stranger_account, &stranger_dev.did);
        body["kind"] = json!("friend-request");
        body["payload"] = json!({ "to": me, "nonce": "n", "sig": "s" });
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&stranger_dev, &raw);
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, me, friend_gate_exempt_kind("friend-request"), false).await;
        assert!(r.is_ok(), "非好友的好友握手（归属在册）必须放行: {r:?}");
        // 伪造：设备不在陌生人名册 → 403（豁免不豁免归属闸）
        let ghost = test_device(62);
        let mut forged = msg_body(stranger_account, &ghost.did);
        forged["kind"] = json!("friend-request");
        let raw2 = serde_json::to_string(&forged).unwrap();
        let headers2 = sign_headers(&ghost, &raw2);
        let r2 = auth_gate_with(&headers2, raw2.as_bytes(), &forged, me, friend_gate_exempt_kind("friend-request"), false).await;
        assert!(r2.is_err(), "归属不在册的握手必须 403");
    }

    /// 收编通知链路：from=主设备账号对成员非好友（is_friend 已被 auth_gate 豁免
    /// 置 true）+ 签名设备 ∈ 主账号名册（归属闸）→ 放行。成员未登录（my=""）也过。
    #[tokio::test]
    async fn delegation_notify_nonfriend_with_ownership_passes() {
        let master_dev = test_device(51);
        let master_account = "did:myco:T5MasterAccount";
        seed_roster(master_account, "", vec![pub_b64(&master_dev)]);
        let mut body = msg_body(master_account, &master_dev.did);
        body["kind"] = json!("delegation-notify");
        body["payload"] = json!({ "rootDid": master_account, "accountName": "Fan" });
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&master_dev, &raw);
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, "", true, false).await;
        assert!(r.is_ok(), "收编通知（归属在册）必须放行: {r:?}");
    }

    /// 收编通知安全面：签名设备不在 from 名册（伪造主设备）→ 403。
    /// 豁免只松好友闸——归属闸对通知照常生效。
    #[tokio::test]
    async fn delegation_notify_without_ownership_rejected() {
        let ghost = test_device(52);
        let master_account = "did:myco:T6MasterAccount";
        seed_roster(master_account, "SOMEONE_ROOTPUB=", vec!["UNRELATED=".to_string()]);
        let mut body = msg_body(master_account, &ghost.did);
        body["kind"] = json!("delegation-notify");
        body["payload"] = json!({ "rootDid": master_account });
        let raw = serde_json::to_string(&body).unwrap();
        let headers = sign_headers(&ghost, &raw);
        let r = auth_gate_with(&headers, raw.as_bytes(), &body, "", true, false).await;
        assert!(r.is_err(), "归属不在册的收编通知必须 403");
    }

    // ── 缺陷2：防火墙端口级规则 ──

    #[test]
    fn firewall_rule_name_carries_port() {
        assert_eq!(firewall_rule_name(9100), "myco-p2p-9100");
        assert_eq!(firewall_rule_name(9101), "myco-p2p-9101");
        // 不同端口不同名——查重不再互相吞（顺延坑的根修）
        assert_ne!(firewall_rule_name(9100), firewall_rule_name(9101));
    }

    #[test]
    fn netsh_show_rule_found_handles_negative_text() {
        // 中文 Windows 实测（2026-09-28）：无匹配时 exit=1 且 stdout 打否定文案——
        // 按"非空即存在"判会永真（原实现隐藏 bug）
        assert!(!netsh_show_rule_found(false, "\n没有与指定标准相匹配的规则。\n"));
        assert!(!netsh_show_rule_found(true, "No rules match the specified criteria."));
        assert!(!netsh_show_rule_found(true, ""));
        // 真存在：退出码 0 + 规则详情
        assert!(netsh_show_rule_found(true, "规则名称:                            myco-p2p-9100\nLocalPort:  9100"));
    }

    #[test]
    fn netsh_rule_covers_port_parses_verbose() {
        let en = "Rule Name:   myco-p2p\nLocalPort:                       9100\nProtocol:  TCP";
        assert!(netsh_rule_covers_port(en, 9100));
        assert!(!netsh_rule_covers_port(en, 9101)); // 顺延端口不被老规则误覆盖（缺陷2 本坑）
        let cn = "规则名称:   myco-p2p\n本地端口:                         9100\n协议:  TCP";
        assert!(netsh_rule_covers_port(cn, 9100));
        assert!(!netsh_rule_covers_port(cn, 9102));
        // Any / 任何 全端口放行
        assert!(netsh_rule_covers_port("LocalPort:  Any", 9105));
        assert!(netsh_rule_covers_port("本地端口:  任何", 9105));
        // 逗号列表与范围
        assert!(netsh_rule_covers_port("LocalPort:  8080, 9101, 9200", 9101));
        assert!(netsh_rule_covers_port("LocalPort:  9100-9110", 9105));
        assert!(!netsh_rule_covers_port("LocalPort:  9100-9110", 9200));
        // 无关输出不误判
        assert!(!netsh_rule_covers_port("Rule Name: myco-p2p\nProtocol: TCP", 9100));
    }
}

// ══════════════ 同步回程 + 隧道端口白名单（2026-10-09「点卡就进」收口） 单测 ══════════════

#[cfg(test)]
mod sync_reply_http_tests {
    use super::*;

    /// `POST /p2p/msg` 的响应体契约（**手机侧读的就是这个 `reply` 键**）。
    #[test]
    fn msg_ok_body_carries_reply_only_when_present() {
        let plain = msg_ok_body(true, None);
        assert_eq!(plain, json!({ "ok": true, "kept": true }));
        assert!(plain.get("reply").is_none(), "没有回包时绝不出现空 reply 键（老客户端解析不受影响）");

        let grant = json!({ "shareId": "sh-1", "requestId": "ser-1", "ok": true, "mt": "MT", "gwPort": 13911 });
        let with = msg_ok_body(true, Some(grant.clone()));
        assert_eq!(with["ok"], json!(true));
        assert_eq!(with["kept"], json!(true));
        assert_eq!(with["reply"], grant, "回包原样挂在响应体里（零新通道）");
    }

    /// **管理面端口 3102 绝不在隧道白名单里**（真机验证时靠 `MYCO_P2P_TUNNEL_PORTS`
    /// 临时放通过——那等于把整个本地管理面交给隧道，不能当正式方案）。
    ///
    /// 三层都断言：默认表、env 之外的纯判定、以及运行态 `tunnel_port_allowed`
    /// （测试期先清掉 env，避免机器上恰好设过而假绿）。
    #[test]
    fn tunnel_whitelist_never_contains_management_port_3102() {
        assert!(
            !crate::p2p_tunnel::TUNNEL_DEFAULT_PORTS.contains(&3102),
            "3102（本地管理面）绝不进默认白名单：{:?}",
            crate::p2p_tunnel::TUNNEL_DEFAULT_PORTS
        );
        assert!(
            !crate::p2p_tunnel::tunnel_port_allowed_in(3102, &[]),
            "3102 不加额外白名单时必须为 false"
        );
        // 运行态判定（env 的运维级追加是唯一的开口；这里显式确认没有它）
        let saved = std::env::var("MYCO_P2P_TUNNEL_PORTS").ok();
        std::env::remove_var("MYCO_P2P_TUNNEL_PORTS");
        let live = crate::p2p_tunnel::tunnel_port_allowed(3102);
        if let Some(v) = saved {
            std::env::set_var("MYCO_P2P_TUNNEL_PORTS", v);
        }
        assert!(
            !live,
            "tunnel_port_allowed(3102) 必须为 false（默认表里只有分享网关与 p2p 数据面）"
        );
    }

    /// **端到端（真 HTTP + 真路由 + 真闸 + 真 ingest）**：同账号设备请求 grant →
    /// 回包**同步**落在这条 HTTP 连接的响应体里。
    ///
    /// 这条用例不需要第二台设备在场，也不需要任何出网：请求方 = **本机设备**
    /// （归属闸走"本机设备"通道，不打云名册），账号 = 本机账号（同账号 → 好友闸豁免）。
    /// 正是真机上"同账号时 grant 被投回 PC 自己 → 无等待者 → 静默丢弃"的那条路径。
    ///
    /// 断言落在**回程**本身（旧行为下这里 `reply` 根本不存在）：请求方拿到的
    /// 是源设备针对**这次请求**的答复（requestId/shareId 逐字对得上），
    /// 要么是现签的票，要么是人话拒绝——两种都证明"回得来"。
    ///
    /// 隔离：走进程级 `test_env_lock`（与其它模块同一把锁 + 同一临时配置目录），
    /// 用例结束把**本用例新建的文件**清掉，不给后续用例留状态。
    #[tokio::test]
    async fn same_account_request_gets_sync_reply_in_http_body() {
        use ed25519_dalek::Signer as _;
        let _g = crate::test_env_lock::test_env_lock();
        let dir = std::path::PathBuf::from(std::env::var("MYCO_CONFIG_DIR").expect("test_env_lock 必须已置隔离目录"));
        let snapshot = dir_snapshot(&dir);

        let sk = ed25519_dalek::SigningKey::from_bytes(&[0x7bu8; 32]);
        let account = myco_core::identity::did_from_public(&sk.verifying_key().to_bytes())
            .replacen("did:myco:", "did:youling:", 1);
        std::fs::create_dir_all(dir.join("accounts")).unwrap();
        std::fs::write(dir.join("accounts").join("active.txt"), &account).unwrap();

        let my_dev = match myco_core::identity::device_identity() {
            Ok((d, seed_b64)) => {
                // 签名必须是**本机设备钥**（验签自证：DID 即公钥）——账号钥签不出来
                let raw_seed = base64::engine::general_purpose::STANDARD.decode(&seed_b64).unwrap_or_default();
                match <[u8; 32]>::try_from(raw_seed.as_slice()) {
                    Ok(s) => (d, ed25519_dalek::SigningKey::from_bytes(&s)),
                    Err(_) => {
                        eprintln!("[test] 设备种子长度异常——跳过同步回程 HTTP 端到端");
                        cleanup_new_files(&dir, &snapshot);
                        return;
                    }
                }
            }
            Err(e) => {
                // 身份存储不可用的机器上不假绿：明确跳过（并在输出里留痕）
                eprintln!("[test] 本机身份不可用（{e}）——跳过同步回程 HTTP 端到端");
                cleanup_new_files(&dir, &snapshot);
                return;
            }
        };
        let (my_dev, dev_sk) = my_dev;

        let request_id = "ser-0123456789abcdef01234567";
        let body = json!({
            "msgId": "se-http-1", "from": account, "fromName": "我",
            "fromDevice": my_dev, "fromDeviceName": "myco-phone",
            "to": account, "kind": "share-entry-request",
            "payload": {
                "shareId": "sh-sync-http", "requestId": request_id,
                "requesterDevice": my_dev, "requesterAccount": account,
                "syncReply": true,
            },
            "ts": 1,
        });
        // 签名载荷 = 逐字发出去的那份字节
        let raw = body.to_string();
        let ts = chrono::Utc::now().timestamp_millis() as u64;
        let sig = dev_sk.sign(format!("{my_dev}\n{ts}\n{raw}").as_bytes());
        let auth = format!(
            "{my_dev}.{ts}.{}",
            base64::engine::general_purpose::STANDARD.encode(sig.to_bytes())
        );

        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = axum::serve(l, p2p_router().into_make_service_with_connect_info::<SocketAddr>()).await;
        });

        let resp = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{port}/p2p/msg"))
            .header("Content-Type", "application/json")
            .header("X-Myco-Auth", auth)
            .body(raw)
            .send()
            .await
            .expect("本地回环请求必须成功");
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        cleanup_new_files(&dir, &snapshot);

        assert_eq!(status, reqwest::StatusCode::OK, "过闸必须放行（同账号 + 本机设备）：{text}");
        // 取证（`--nocapture` 可见）：这条响应体就是手机侧要解析的东西
        eprintln!("[test] POST /p2p/msg 响应体 = {text}");
        let v: Value = serde_json::from_str(&text).expect("响应必须是 JSON");
        assert_eq!(v["ok"], json!(true), "{text}");
        let reply = v.get("reply").unwrap_or_else(|| panic!("★ 旧行为下这里没有 reply（回程断了）：{text}"));
        assert_eq!(reply["requestId"], json!(request_id), "回包必须是针对这次请求的：{text}");
        assert_eq!(reply["shareId"], json!("sh-sync-http"), "{text}");
        assert!(reply["ok"].is_boolean(), "回包必须带明确结论：{text}");
        if reply["ok"] == json!(true) {
            assert!(!reply["mt"].as_str().unwrap_or("").is_empty(), "签了票就必须给 mt：{text}");
            assert!(reply["gwPort"].as_u64().unwrap_or(0) > 0, "签了票就必须给网关端口：{text}");
        } else {
            assert!(
                !reply["error"].as_str().unwrap_or("").is_empty(),
                "拒绝也必须是**人话**（给用户看的）：{text}"
            );
        }
    }

    /// 目录内容快照（相对路径集合；递归）。
    fn dir_snapshot(root: &std::path::Path) -> std::collections::HashSet<std::path::PathBuf> {
        let mut out = std::collections::HashSet::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(rd) = std::fs::read_dir(&d) else { continue };
            for e in rd.flatten() {
                let p = e.path();
                out.insert(p.clone());
                if p.is_dir() {
                    stack.push(p);
                }
            }
        }
        out
    }

    /// 删掉本用例期间**新建**的文件/目录（既有内容一个不动）。
    fn cleanup_new_files(root: &std::path::Path, before: &std::collections::HashSet<std::path::PathBuf>) {
        let after = dir_snapshot(root);
        let mut new: Vec<_> = after.difference(before).cloned().collect();
        // 深的先删
        new.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
        for p in new {
            let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
        }
    }
}
